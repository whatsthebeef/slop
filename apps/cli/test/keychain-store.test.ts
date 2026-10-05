import { describe, expect, it } from 'vitest';
import { SlopError } from '../src/errors.js';
import {
  createSecurityExec,
  KeychainTokenStore,
  MAX_INTERACTIVE_LINE_BYTES,
  type ExecResult,
  type SecurityExec,
} from '../src/token-store.js';
import { SLOP_URL } from './support.js';

interface ExecCall {
  readonly args: readonly string[];
  readonly input: string | undefined;
}

function fakeExec(reply: (call: ExecCall) => Partial<ExecResult>): {
  exec: SecurityExec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: SecurityExec = (args, input) => {
    const call = { args, input };
    calls.push(call);
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', ...reply(call) });
  };
  return { exec, calls };
}

/** Base64url-ish text of the given length, like a Cognito JWT segment. */
function tokenOf(length: number, seed: string): string {
  return `${seed}.`.padEnd(length, 'aZ0-_.');
}

const ACCESS = tokenOf(1200, 'secretaccess');
const REFRESH = tokenOf(1800, 'secretrefresh');
const TOKENS = { access_token: ACCESS, refresh_token: REFRESH, expires_at: 1_800_000_000 };
const ACCESS_ACCOUNT = `${SLOP_URL}#access`;

/** A fake `security` holding items in a map, as the real one would. */
function fakeKeychain(): { exec: SecurityExec; calls: ExecCall[]; items: Map<string, string> } {
  const items = new Map<string, string>();
  const { exec, calls } = fakeExec(({ args, input }) => {
    const [command] = args;
    const account = args[args.indexOf('-a') + 1] ?? '';
    if (command === 'find-generic-password') {
      const value = items.get(account);
      return value === undefined ? { exitCode: 44 } : { stdout: `${value}\n` };
    }
    if (command === 'delete-generic-password') {
      return items.delete(account) ? {} : { exitCode: 44 };
    }
    const added = /^add-generic-password -U -s "slop-cli" -a "([^"]+)" -w "([^"]+)"\n$/.exec(
      input ?? '',
    );
    if (command !== '-i' || added?.[1] === undefined || added[2] === undefined) {
      return { exitCode: 1 };
    }
    items.set(added[1], added[2]);
    return {};
  });
  return { exec, calls, items };
}

describe('KeychainTokenStore', () => {
  it('saves a real-sized login as two items, one short `security -i` line each', async () => {
    const { exec, calls, items } = fakeKeychain();
    await new KeychainTokenStore(exec).save(SLOP_URL, TOKENS);

    expect(calls.map((call) => call.args)).toEqual([['-i'], ['-i']]);
    for (const call of calls) {
      expect(Buffer.byteLength(call.input ?? '', 'utf8')).toBeLessThan(MAX_INTERACTIVE_LINE_BYTES);
      expect(call.input?.split('\n')).toHaveLength(2); // one command, newline-terminated
    }
    expect(calls.flatMap((call) => call.args).join(' ')).not.toContain('secret');
    expect(items.get(SLOP_URL)).toBe(REFRESH);
    expect(items.get(ACCESS_ACCOUNT)).toBe(`1800000000.${ACCESS}`);
  });

  it('reads back what it saved', async () => {
    const { exec } = fakeKeychain();
    const store = new KeychainTokenStore(exec);
    await store.save(SLOP_URL, TOKENS);
    expect(await store.load(SLOP_URL)).toEqual(TOKENS);
    expect(await store.load('https://other.test')).toBeUndefined();
  });

  it('reads a missing refresh item (exit 44) as signed out', async () => {
    const { exec, items } = fakeKeychain();
    items.set(ACCESS_ACCOUNT, `1.${ACCESS}`);
    expect(await new KeychainTokenStore(exec).load(SLOP_URL)).toBeUndefined();
  });

  it('reads a missing or damaged access item as needing a refresh', async () => {
    const { exec, items } = fakeKeychain();
    const store = new KeychainTokenStore(exec);
    items.set(SLOP_URL, REFRESH);
    const needsRefresh = { access_token: '', refresh_token: REFRESH, expires_at: 0 };
    expect(await store.load(SLOP_URL)).toEqual(needsRefresh);
    items.set(ACCESS_ACCOUNT, 'not-an-expiry');
    expect(await store.load(SLOP_URL)).toEqual(needsRefresh);
  });

  it('treats any other failure (a locked Keychain) as an error, not as signed out', async () => {
    const { exec } = fakeExec(() => ({ exitCode: 36, stderr: 'User interaction is not allowed.' }));
    await expect(new KeychainTokenStore(exec).load(SLOP_URL)).rejects.toThrow(
      new SlopError(
        'could not read the slop login from the Keychain: User interaction is not allowed.',
      ),
    );
  });

  it('refuses an oversized token without writing anything', async () => {
    const { exec, calls } = fakeKeychain();
    const failure = new KeychainTokenStore(exec).save(SLOP_URL, {
      ...TOKENS,
      access_token: tokenOf(MAX_INTERACTIVE_LINE_BYTES, 'secretaccess'),
    });
    await expect(failure).rejects.toThrow('a token is too long for the Keychain tool');
    await expect(failure).rejects.not.toThrow(/secret/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a token with characters that would need quoting, without writing', async () => {
    const { exec, calls } = fakeKeychain();
    const failure = new KeychainTokenStore(exec).save(SLOP_URL, {
      ...TOKENS,
      refresh_token: 'secret" ; delete-keychain',
    });
    await expect(failure).rejects.toThrow('the token has unexpected characters');
    await expect(failure).rejects.not.toThrow(/secret/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a slop URL that security -i could not quote, without writing', async () => {
    const { exec, calls } = fakeKeychain();
    await expect(new KeychainTokenStore(exec).save('https://a.test/"x', TOKENS)).rejects.toThrow(
      SlopError,
    );
    expect(calls).toHaveLength(0);
  });

  it('reports a failed save without the tokens', async () => {
    const { exec } = fakeExec((call) => ({ exitCode: 1, stderr: `failed: ${call.input ?? ''}` }));
    const failure = new KeychainTokenStore(exec).save(SLOP_URL, TOKENS);
    await expect(failure).rejects.toThrow(
      'could not save the slop login to the Keychain (security exited 1)',
    );
    await expect(failure).rejects.not.toThrow(/secret/);
  });

  it('drops an older refresh token when a login without one is saved', async () => {
    const { exec, items } = fakeKeychain();
    items.set(SLOP_URL, REFRESH);
    await new KeychainTokenStore(exec).save(SLOP_URL, { access_token: ACCESS, expires_at: 5 });
    expect(items.has(SLOP_URL)).toBe(false);
    expect(items.get(ACCESS_ACCOUNT)).toBe(`5.${ACCESS}`);
  });

  it('logout deletes both items, treating missing ones as already signed out', async () => {
    const { exec, calls, items } = fakeKeychain();
    const store = new KeychainTokenStore(exec);
    await store.save(SLOP_URL, TOKENS);
    await store.delete(SLOP_URL);
    expect(items.size).toBe(0);
    expect(calls.slice(-2).map((call) => call.args)).toEqual([
      ['delete-generic-password', '-s', 'slop-cli', '-a', SLOP_URL],
      ['delete-generic-password', '-s', 'slop-cli', '-a', ACCESS_ACCOUNT],
    ]);
    await store.delete(SLOP_URL);
    const locked = fakeExec(() => ({ exitCode: 51, stderr: 'locked' }));
    await expect(new KeychainTokenStore(locked.exec).delete(SLOP_URL)).rejects.toThrow('locked');
  });
});

describe('createSecurityExec', () => {
  it('passes stdin and returns the exit code and output', async () => {
    const result = await createSecurityExec('cat')([], 'hello');
    expect(result).toEqual({ exitCode: 0, stdout: 'hello', stderr: '' });
    expect((await createSecurityExec('false')([])).exitCode).toBe(1);
  });

  it('gives up on a command that hangs', async () => {
    await expect(createSecurityExec('sleep', 50)(['5'])).rejects.toThrow(/did not finish/);
  });

  it('reports a command that cannot run', async () => {
    await expect(createSecurityExec('/nonexistent/security')([])).rejects.toThrow(/could not run/);
  });
});
