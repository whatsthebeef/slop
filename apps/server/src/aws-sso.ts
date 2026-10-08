import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CreateTokenCommand,
  RegisterClientCommand,
  SSOOIDCClient,
  StartDeviceAuthorizationCommand,
} from '@aws-sdk/client-sso-oidc';

/** The `sso-session` an AWS profile points at (`~/.aws/config`): where to sign in, and the cache entry's name. */
export interface SsoSession {
  readonly name: string;
  readonly startUrl: string;
  readonly region: string;
  readonly scopes: readonly string[];
}

/** The `[section]`s of an AWS config file as key/value maps, keyed by their header ("profile x", "sso-session y"). */
const parseIni = (text: string): Map<string, Map<string, string>> => {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      current = new Map();
      sections.set((header[1] ?? '').trim().replace(/\s+/g, ' '), current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current !== null && eq > 0) current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return sections;
};

/** The profile's `sso-session`, or null when there is no profile or it doesn't use one (production runs on an IAM role). */
export const readSsoSession = async (
  profile: string | undefined,
  configFile = process.env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'),
): Promise<SsoSession | null> => {
  if (profile === undefined || profile === '') return null;
  let text: string;
  try {
    text = await readFile(configFile, 'utf8');
  } catch {
    return null;
  }
  const sections = parseIni(text);
  const name = (sections.get(`profile ${profile}`) ?? (profile === 'default' ? sections.get('default') : undefined))?.get('sso_session');
  if (name === undefined) return null;
  const session = sections.get(`sso-session ${name}`);
  const startUrl = session?.get('sso_start_url');
  const region = session?.get('sso_region');
  if (startUrl === undefined || region === undefined) return null;
  const scopes = (session?.get('sso_registration_scopes') ?? 'sso:account:access').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return { name, startUrl, region, scopes };
};

/** The SDK's SSO token cache file for a session: `~/.aws/sso/cache/<sha1 of the session name>.json`. */
export const ssoCacheFile = (session: SsoSession, dir = join(homedir(), '.aws', 'sso', 'cache')): string =>
  join(dir, `${createHash('sha1').update(session.name).digest('hex')}.json`);

/** The three SSO OIDC calls the device sign-in makes, so tests can stand in for AWS. */
export interface SsoOidc {
  registerClient(region: string, scopes: readonly string[]): Promise<{ clientId: string; clientSecret: string; expiresAt: number }>;
  startDeviceAuthorization(input: {
    region: string;
    clientId: string;
    clientSecret: string;
    startUrl: string;
  }): Promise<{ deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number; interval: number }>;
  /** Null while the person hasn't approved yet; throws on denial or expiry. */
  createToken(input: {
    region: string;
    clientId: string;
    clientSecret: string;
    deviceCode: string;
  }): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number } | 'pending' | 'slow_down'>;
}

export class AwsSsoOidc implements SsoOidc {
  private client = (region: string) => new SSOOIDCClient({ region, credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });

  async registerClient(region: string, scopes: readonly string[]) {
    const out = await this.client(region).send(new RegisterClientCommand({ clientName: 'slop', clientType: 'public', scopes: [...scopes] }));
    return { clientId: out.clientId ?? '', clientSecret: out.clientSecret ?? '', expiresAt: out.clientSecretExpiresAt ?? 0 };
  }

  async startDeviceAuthorization(input: { region: string; clientId: string; clientSecret: string; startUrl: string }) {
    const out = await this.client(input.region).send(
      new StartDeviceAuthorizationCommand({ clientId: input.clientId, clientSecret: input.clientSecret, startUrl: input.startUrl }),
    );
    return {
      deviceCode: out.deviceCode ?? '',
      userCode: out.userCode ?? '',
      verificationUri: out.verificationUri ?? '',
      verificationUriComplete: out.verificationUriComplete ?? out.verificationUri ?? '',
      expiresIn: out.expiresIn ?? 600,
      interval: out.interval ?? 5,
    };
  }

  async createToken(input: { region: string; clientId: string; clientSecret: string; deviceCode: string }) {
    try {
      const out = await this.client(input.region).send(
        new CreateTokenCommand({
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          deviceCode: input.deviceCode,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      );
      return { accessToken: out.accessToken ?? '', refreshToken: out.refreshToken ?? null, expiresIn: out.expiresIn ?? 3600 };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'AuthorizationPendingException') return 'pending' as const;
      if (name === 'SlowDownException') return 'slow_down' as const;
      throw error;
    }
  }
}

export type SignInState =
  | { readonly state: 'idle' }
  | { readonly state: 'waiting'; readonly verificationUri: string; readonly userCode: string; readonly expiresAt: string }
  | { readonly state: 'done' }
  | { readonly state: 'failed'; readonly message: string };

interface SignInDeps {
  readonly session: SsoSession;
  readonly oidc: SsoOidc;
  readonly cacheFile: string;
  /** After the token is cached: probe Bedrock so the banner clears and the pipeline resumes. */
  readonly onSignedIn: () => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The IAM Identity Center device sign-in, run from the server for local development: registers a
 * client, starts the device authorization, and polls for the token in the background while the
 * board shows the link and code. The token goes into the SDK's SSO cache in the format `aws sso
 * login` writes, so the credential provider picks it up on its next call, with no restart. One
 * sign-in at a time; starting again while one waits returns the one in flight.
 */
export class AwsSignIn {
  private current: SignInState = { state: 'idle' };
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: SignInDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  status(): SignInState {
    return this.current;
  }

  /** Starts the sign-in (or returns the one waiting); resolves once the link and code are known. Tests await `finished()`. */
  async start(): Promise<SignInState> {
    if (this.current.state === 'waiting') return this.current;
    const { session, oidc } = this.deps;
    try {
      const client = await oidc.registerClient(session.region, session.scopes);
      const device = await oidc.startDeviceAuthorization({ region: session.region, ...client, startUrl: session.startUrl });
      const deadline = this.now() + device.expiresIn * 1000;
      this.current = {
        state: 'waiting',
        verificationUri: device.verificationUriComplete,
        userCode: device.userCode,
        expiresAt: new Date(deadline).toISOString(),
      };
      this.running = this.poll(client, device, deadline).catch((error: unknown) => {
        const denied = error instanceof Error && error.name === 'AccessDeniedException';
        this.current = { state: 'failed', message: denied ? 'The sign-in was denied' : 'The sign-in failed' };
      });
    } catch {
      this.current = { state: 'failed', message: "Couldn't start the AWS sign-in; check the profile's sso-session settings" };
    }
    return this.current;
  }

  finished(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async poll(
    client: { clientId: string; clientSecret: string; expiresAt: number },
    device: { deviceCode: string; interval: number },
    deadline: number,
  ): Promise<void> {
    const { session, oidc } = this.deps;
    let interval = device.interval;
    while (this.now() < deadline) {
      await this.sleep(interval * 1000);
      const token = await oidc.createToken({ region: session.region, clientId: client.clientId, clientSecret: client.clientSecret, deviceCode: device.deviceCode });
      if (token === 'slow_down') interval += 5;
      if (typeof token === 'string') continue;
      await this.writeCache(client, token);
      this.current = { state: 'done' };
      await this.deps.onSignedIn().catch(() => undefined);
      return;
    }
    this.current = { state: 'failed', message: 'The sign-in link expired before it was approved' };
  }

  private async writeCache(
    client: { clientId: string; clientSecret: string; expiresAt: number },
    token: { accessToken: string; refreshToken: string | null; expiresIn: number },
  ): Promise<void> {
    const { session, cacheFile } = this.deps;
    const entry = {
      startUrl: session.startUrl,
      region: session.region,
      accessToken: token.accessToken,
      expiresAt: new Date(this.now() + token.expiresIn * 1000).toISOString(),
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      registrationExpiresAt: new Date(client.expiresAt * 1000).toISOString(),
      ...(token.refreshToken === null ? {} : { refreshToken: token.refreshToken }),
    };
    await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
    // Write beside the target and rename, so a reader never sees half a file; the token is private to the user.
    const temp = `${cacheFile}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(entry), { mode: 0o600 });
    await rename(temp, cacheFile);
  }
}
