import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CreateTokenCommand,
  RegisterClientCommand,
  SSOOIDCClient,
  StartDeviceAuthorizationCommand,
} from '@aws-sdk/client-sso-oidc';
import type { SsoProfile } from './aws-sso.js';

/** The device-authorization grant's outcome for one `CreateToken` poll. */
export type TokenPoll =
  | { readonly kind: 'pending' }
  | { readonly kind: 'slow_down' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'denied' }
  | {
      readonly kind: 'ok';
      readonly accessToken: string;
      readonly refreshToken: string | null;
      readonly expiresIn: number;
    };

export interface RegisteredClient {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

/** IAM Identity Center's OIDC service, behind an interface so the flow is testable without AWS. */
export interface SsoOidc {
  registerClient(input: { scopes: readonly string[] }): Promise<RegisteredClient>;
  startDeviceAuthorization(input: {
    client: RegisteredClient;
    startUrl: string;
  }): Promise<DeviceAuthorization>;
  createToken(input: { client: RegisteredClient; deviceCode: string }): Promise<TokenPoll>;
}

const required = (value: string | number | undefined, what: string): string | number => {
  if (value === undefined) throw new Error(`AWS returned no ${what}`);
  return value;
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : '');

export const sdkSsoOidc = (region: string): SsoOidc => {
  const client = new SSOOIDCClient({ region });
  return {
    registerClient: async ({ scopes }) => {
      const r = await client.send(
        new RegisterClientCommand({
          clientName: 'slop',
          clientType: 'public',
          scopes: [...scopes],
        }),
      );
      return {
        clientId: String(required(r.clientId, 'client ID')),
        clientSecret: String(required(r.clientSecret, 'client secret')),
        expiresAt: Number(required(r.clientSecretExpiresAt, 'client expiry')),
      };
    },
    startDeviceAuthorization: async ({ client: c, startUrl }) => {
      const r = await client.send(
        new StartDeviceAuthorizationCommand({
          clientId: c.clientId,
          clientSecret: c.clientSecret,
          startUrl,
        }),
      );
      return {
        deviceCode: String(required(r.deviceCode, 'device code')),
        userCode: String(required(r.userCode, 'user code')),
        verificationUri: String(required(r.verificationUri, 'verification URL')),
        verificationUriComplete: String(required(r.verificationUriComplete, 'verification URL')),
        expiresIn: Number(required(r.expiresIn, 'expiry')),
        interval: r.interval ?? 5,
      };
    },
    createToken: async ({ client: c, deviceCode }) => {
      try {
        const r = await client.send(
          new CreateTokenCommand({
            clientId: c.clientId,
            clientSecret: c.clientSecret,
            deviceCode,
            grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        );
        return {
          kind: 'ok',
          accessToken: String(required(r.accessToken, 'access token')),
          refreshToken: r.refreshToken ?? null,
          expiresIn: Number(required(r.expiresIn, 'token expiry')),
        };
      } catch (error) {
        switch (errorName(error)) {
          case 'AuthorizationPendingException':
            return { kind: 'pending' };
          case 'SlowDownException':
            return { kind: 'slow_down' };
          case 'ExpiredTokenException':
            return { kind: 'expired' };
          case 'AccessDeniedException':
            return { kind: 'denied' };
          default:
            throw error;
        }
      }
    },
  };
};

/** What the board may see of a flow: never the device code or the client secret. */
export type SignInStatus =
  | { readonly state: 'idle' }
  | {
      readonly state: 'waiting';
      readonly verificationUri: string;
      readonly verificationUriComplete: string;
      readonly userCode: string;
      readonly expiresAt: string;
    }
  | { readonly state: 'done' }
  | { readonly state: 'failed'; readonly message: string };

export interface SignInDeps {
  readonly oidc: SsoOidc;
  readonly profile: SsoProfile;
  /** The home directory holding `.aws/sso/cache`. */
  readonly home: string;
  /** After the token is written: checks Bedrock again so its state (and the banner) follows. */
  readonly onSignedIn: () => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
}

/** The AWS CLI's token cache file for an sso-session: sha1 of the session name. */
export const tokenCachePath = (home: string, session: string): string =>
  join(home, '.aws', 'sso', 'cache', `${createHash('sha1').update(session).digest('hex')}.json`);

const SLOW_DOWN_SECONDS = 5;

/**
 * Signs the server's AWS SSO profile in again with the OIDC device flow, like `aws sso login` but
 * driven from the board. One flow at a time; the token goes where the CLI keeps it, so the SDK's
 * credential chain picks it up on its next call without a restart.
 */
export class AwsSignIn {
  private status_: SignInStatus = { state: 'idle' };
  private flow: Promise<void> | null = null;
  private starting: Promise<SignInStatus> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: SignInDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  status(): SignInStatus {
    return this.status_;
  }

  /** Resolves when the running flow has ended (for tests and shutdown). */
  settled(): Promise<void> {
    return this.flow ?? Promise.resolve();
  }

  /** Begins a flow, or returns the one in flight. Fails (as a status) when AWS can't start one. */
  start(): Promise<SignInStatus> {
    if (this.status_.state === 'waiting' || this.flow !== null)
      return Promise.resolve(this.status_);
    // Two requests before AWS answers share one flow.
    this.starting ??= this.begin().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async begin(): Promise<SignInStatus> {
    try {
      const client = await this.deps.oidc.registerClient({ scopes: this.deps.profile.scopes });
      const auth = await this.deps.oidc.startDeviceAuthorization({
        client,
        startUrl: this.deps.profile.startUrl,
      });
      const deadline = this.now() + auth.expiresIn * 1000;
      this.status_ = {
        state: 'waiting',
        verificationUri: auth.verificationUri,
        verificationUriComplete: auth.verificationUriComplete,
        userCode: auth.userCode,
        expiresAt: new Date(deadline).toISOString(),
      };
      this.flow = this.poll(client, auth, deadline).finally(() => {
        this.flow = null;
      });
    } catch (error) {
      this.deps.log?.(`aws sign-in could not start: ${errorName(error)}`);
      this.status_ = { state: 'failed', message: 'AWS would not start a sign-in' };
    }
    return this.status_;
  }

  private async poll(
    client: RegisteredClient,
    auth: DeviceAuthorization,
    deadline: number,
  ): Promise<void> {
    let interval = auth.interval;
    try {
      while (this.now() < deadline) {
        await this.sleep(interval * 1000);
        const poll = await this.deps.oidc.createToken({ client, deviceCode: auth.deviceCode });
        if (poll.kind === 'pending') continue;
        if (poll.kind === 'slow_down') {
          interval += SLOW_DOWN_SECONDS;
          continue;
        }
        if (poll.kind === 'ok') {
          await this.writeCache(client, poll);
          // The token is in place whatever the probe finds (a missing Bedrock permission shows as its own banner).
          await this.deps
            .onSignedIn()
            .catch((error: unknown) =>
              this.deps.log?.(`aws sign-in follow-up failed: ${errorName(error)}`),
            );
          this.status_ = { state: 'done' };
          return;
        }
        this.status_ = {
          state: 'failed',
          message:
            poll.kind === 'denied'
              ? 'The sign-in was denied in the browser'
              : 'The sign-in code expired',
        };
        return;
      }
      this.status_ = { state: 'failed', message: 'The sign-in code expired' };
    } catch (error) {
      this.deps.log?.(`aws sign-in failed: ${errorName(error)}`);
      this.status_ = { state: 'failed', message: 'The sign-in failed' };
    }
  }

  private async writeCache(
    client: RegisteredClient,
    token: Extract<TokenPoll, { kind: 'ok' }>,
  ): Promise<void> {
    const path = tokenCachePath(this.deps.home, this.deps.profile.session);
    const dir = join(this.deps.home, '.aws', 'sso', 'cache');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const body = {
      startUrl: this.deps.profile.startUrl,
      region: this.deps.profile.region,
      accessToken: token.accessToken,
      expiresAt: new Date(this.now() + token.expiresIn * 1000).toISOString(),
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      registrationExpiresAt: new Date(client.expiresAt * 1000).toISOString(),
      ...(token.refreshToken === null ? {} : { refreshToken: token.refreshToken }),
    };
    // Write beside it and rename, so a reader never sees half a file.
    const temp = `${path}.${String(process.pid)}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(body), { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      // Don't leave the token behind in a temp file.
      await rm(temp, { force: true });
      throw error;
    }
  }
}
