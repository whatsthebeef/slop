import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SlopError } from './errors.js';
import { parseJsonOrUndefined } from './util.js';

const storedTokensSchema = z.object({
  access_token: z.string(),
  // Absent only if the sign-in response carried none; such a login can't be refreshed.
  refresh_token: z.string().optional(),
  /** Seconds since the epoch. */
  expires_at: z.number(),
});
export type StoredTokens = z.infer<typeof storedTokensSchema>;

/** Where the slop login is kept, one entry per slop URL. */
export interface TokenStore {
  load(slopUrl: string): Promise<StoredTokens | undefined>;
  save(slopUrl: string, tokens: StoredTokens): Promise<void>;
  delete(slopUrl: string): Promise<void>;
}

function parseStoredTokens(value: unknown): StoredTokens | undefined {
  const parsed = storedTokensSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const KEYCHAIN_SERVICE = 'slop-cli';
export const SECURITY_TIMEOUT_MS = 60_000;
/** `security`'s exit code for "The specified item could not be found in the keychain". */
const ITEM_NOT_FOUND = 44;

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `security` with these arguments and stdin; rejects only if it can't run or times out. */
export type SecurityExec = (args: readonly string[], input?: string) => Promise<ExecResult>;

export function createSecurityExec(
  command = 'security',
  timeoutMs: number = SECURITY_TIMEOUT_MS,
): SecurityExec {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        reject(new SlopError(`could not run ${command}: ${error.message}`));
      });
      child.on('close', (code, signal) => {
        if (code === null) {
          reject(
            new SlopError(
              `${command} did not finish (${signal ?? 'killed'}); is the Keychain locked?`,
            ),
          );
          return;
        }
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      child.stdin.on('error', () => {
        // The child exited before reading its input; its exit code reports the failure.
      });
      child.stdin.end(input ?? '');
    });
}

/**
 * `security -i` reads each command line into a buffer of about 4 KB and runs whatever overflows
 * as a further command, so every line must stay well under that.
 */
export const MAX_INTERACTIVE_LINE_BYTES = 3900;
/** What Cognito's tokens (JWTs, base64url) and the expiry are made of: nothing to quote. */
const SAFE_VALUE = /^[A-Za-z0-9._-]+$/;
const ACCESS_SUFFIX = '#access';

/**
 * The macOS Keychain, through the `security` tool. The tokens never go on a command line (where
 * `ps` shows them): they are written to `security -i` on stdin. A login is two items so each line
 * stays short: the refresh token under the slop URL, and `<expires_at>.<access token>` under
 * `<slop URL>#access`.
 */
export class KeychainTokenStore implements TokenStore {
  constructor(
    private readonly exec: SecurityExec = createSecurityExec(),
    private readonly service: string = KEYCHAIN_SERVICE,
  ) {}

  async load(slopUrl: string): Promise<StoredTokens | undefined> {
    const refreshToken = await this.find(slopUrl);
    if (refreshToken === undefined) return undefined;
    const access = /^(\d+)\.(.+)$/.exec((await this.find(slopUrl + ACCESS_SUFFIX)) ?? '');
    const [, expiresAt, accessToken] = access ?? [];
    if (expiresAt === undefined || accessToken === undefined) {
      // No usable access token: an expired placeholder makes the caller refresh it.
      return { access_token: '', refresh_token: refreshToken, expires_at: 0 };
    }
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Number(expiresAt),
    };
  }

  async save(slopUrl: string, tokens: StoredTokens): Promise<void> {
    // Build and check every line before writing any, so a refused login leaves nothing half saved.
    const accessLine = this.addLine(
      slopUrl + ACCESS_SUFFIX,
      `${Math.floor(tokens.expires_at)}.${tokens.access_token}`,
    );
    const refreshLine =
      tokens.refresh_token === undefined ? undefined : this.addLine(slopUrl, tokens.refresh_token);
    // `-i` reports only the last command's status, so each command gets its own run.
    for (const line of [refreshLine, accessLine]) {
      if (line === undefined) continue;
      const saved = await this.exec(['-i'], line);
      if (saved.exitCode !== 0) {
        // Only the exit code: `security -i` may echo its input, which holds the tokens.
        throw new SlopError(
          `could not save the slop login to the Keychain (security exited ${saved.exitCode})`,
        );
      }
    }
    // A login without a refresh token can't be kept; drop any older one rather than mix the two.
    if (refreshLine === undefined) await this.remove(slopUrl);
  }

  async delete(slopUrl: string): Promise<void> {
    await this.remove(slopUrl);
    await this.remove(slopUrl + ACCESS_SUFFIX);
  }

  /** The item's value, or undefined when there is none (exit 44); other failures throw. */
  private async find(account: string): Promise<string | undefined> {
    const found = await this.exec([
      'find-generic-password',
      '-s',
      this.service,
      '-a',
      account,
      '-w',
    ]);
    if (found.exitCode === ITEM_NOT_FOUND) return undefined;
    if (found.exitCode !== 0) {
      // A locked or unreachable Keychain is an error, not "signed out": no browser login for it.
      throw new SlopError(`could not read the slop login from the Keychain: ${detail(found)}`);
    }
    const value = found.stdout.trim();
    return value === '' ? undefined : value;
  }

  private async remove(account: string): Promise<void> {
    const deleted = await this.exec(['delete-generic-password', '-s', this.service, '-a', account]);
    if (deleted.exitCode !== 0 && deleted.exitCode !== ITEM_NOT_FOUND) {
      throw new SlopError(`could not remove the slop login from the Keychain: ${detail(deleted)}`);
    }
  }

  private addLine(account: string, value: string): string {
    if (!SAFE_VALUE.test(value)) {
      throw new SlopError('cannot save the slop login: the token has unexpected characters');
    }
    const line = `add-generic-password -U -s ${quote(this.service)} -a ${quote(account)} -w ${quote(value)}\n`;
    if (Buffer.byteLength(line, 'utf8') >= MAX_INTERACTIVE_LINE_BYTES) {
      throw new SlopError('cannot save the slop login: a token is too long for the Keychain tool');
    }
    return line;
  }
}

/** Quotes a value for `security -i`'s command line; refuses what that parser can't carry. */
function quote(value: string): string {
  if (/["\\\s]/.test(value)) {
    throw new SlopError(`cannot store a Keychain entry for ${JSON.stringify(value)}`);
  }
  return `"${value}"`;
}

function detail(result: ExecResult): string {
  return result.stderr.trim() || `security exited ${result.exitCode}`;
}

const tokenFileSchema = z.record(z.string(), z.unknown());

/** A JSON file readable only by its owner (0600), for systems without the Keychain. */
export class FileTokenStore implements TokenStore {
  constructor(readonly path: string) {}

  async load(slopUrl: string): Promise<StoredTokens | undefined> {
    return parseStoredTokens((await this.readAll())[slopUrl]);
  }

  async save(slopUrl: string, tokens: StoredTokens): Promise<void> {
    await this.writeAll({ ...(await this.readAll()), [slopUrl]: tokens });
  }

  async delete(slopUrl: string): Promise<void> {
    const all = await this.readAll();
    if (!(slopUrl in all)) return;
    await this.writeAll(Object.fromEntries(Object.entries(all).filter(([url]) => url !== slopUrl)));
  }

  private async readAll(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
      throw error;
    }
    const parsed = tokenFileSchema.safeParse(parseJsonOrUndefined(text));
    return parsed.success ? parsed.data : {};
  }

  private async writeAll(all: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // A new 0600 file renamed over the old one: never readable by others, never half written.
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export function tokenFilePath(home: string = homedir()): string {
  return join(home, '.config', 'slop', 'tokens.json');
}

export async function hasKeychain(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await access('/usr/bin/security', constants.X_OK);
    return true;
  } catch {
    // No `security` tool on this Mac: fall back to the file.
    return false;
  }
}

export async function defaultTokenStore(): Promise<TokenStore> {
  return (await hasKeychain()) ? new KeychainTokenStore() : new FileTokenStore(tokenFilePath());
}
