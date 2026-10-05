import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { accessToken, login, logout, pkceChallenge, type AuthDeps } from '../src/auth.js';
import { SlopError } from '../src/errors.js';
import type { Fetch } from '../src/http.js';
import {
  AUTHORIZE_ENDPOINT,
  fakeAuthFetch,
  freePort,
  MemoryTokenStore,
  SLOP_URL,
} from './support.js';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

function deps(overrides: Partial<AuthDeps> & { fetch: Fetch }): AuthDeps {
  return {
    settings: { SLOP_URL, SLOP_CLIENT_ID: 'client-1' },
    store: new MemoryTokenStore(),
    now: () => NOW_MS,
    canPrompt: false,
    openBrowser: () => {
      throw new Error('the browser should not open');
    },
    log: () => undefined,
    ...overrides,
  };
}

/** Sends raw bytes to the port and returns the first chunk of the reply. */
function rawRequest(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, 'localhost', () => socket.write(bytes));
    socket.once('data', (chunk) => {
      resolve(chunk.toString('utf8'));
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

const unusedFetch: Fetch = (input) => Promise.reject(new Error(`unexpected request to ${input}`));

describe('accessToken', () => {
  it('uses dev:<email> when SLOP_DEV_EMAIL is set, without a login', async () => {
    const token = await accessToken(
      deps({ fetch: unusedFetch, settings: { SLOP_URL, SLOP_DEV_EMAIL: 'ann@x.test' } }),
    );
    expect(token).toBe('dev:ann@x.test');
  });

  it('returns the stored access token while more than a minute is left', async () => {
    const store = new MemoryTokenStore();
    store.entries.set(SLOP_URL, {
      access_token: 'a1',
      refresh_token: 'r1',
      expires_at: NOW_S + 61,
    });
    expect(await accessToken(deps({ fetch: unusedFetch, store }))).toBe('a1');
    expect(store.saves).toBe(0);
  });

  it('refreshes within a minute of expiry and keeps the refresh token Cognito does not rotate', async () => {
    const store = new MemoryTokenStore();
    store.entries.set(SLOP_URL, {
      access_token: 'a1',
      refresh_token: 'r1',
      expires_at: NOW_S + 60,
    });
    const { fetch, tokenRequests } = fakeAuthFetch(() =>
      Response.json({ access_token: 'a2', expires_in: 3600 }),
    );

    expect(await accessToken(deps({ fetch, store }))).toBe('a2');
    expect(tokenRequests.map((request) => request.fields)).toEqual([
      { grant_type: 'refresh_token', client_id: 'client-1', refresh_token: 'r1' },
    ]);
    expect(store.entries.get(SLOP_URL)).toEqual({
      access_token: 'a2',
      refresh_token: 'r1',
      expires_at: NOW_S + 3600,
    });
  });

  it('refreshes a still-valid token when forced (after a 401)', async () => {
    const store = new MemoryTokenStore();
    store.entries.set(SLOP_URL, {
      access_token: 'a1',
      refresh_token: 'r1',
      expires_at: NOW_S + 3000,
    });
    const { fetch, tokenRequests } = fakeAuthFetch(() =>
      Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 600 }),
    );
    expect(await accessToken(deps({ fetch, store }), true)).toBe('a2');
    expect(tokenRequests).toHaveLength(1);
    expect(store.entries.get(SLOP_URL)?.refresh_token).toBe('r2');
  });

  it('follows the clock: the same login is refreshed once time moves past the margin', async () => {
    const store = new MemoryTokenStore();
    store.entries.set(SLOP_URL, {
      access_token: 'a1',
      refresh_token: 'r1',
      expires_at: NOW_S + 600,
    });
    let nowMs = NOW_MS;
    const { fetch, tokenRequests } = fakeAuthFetch(() =>
      Response.json({ access_token: 'a2', expires_in: 3600 }),
    );
    const auth = deps({ fetch, store, now: () => nowMs });

    expect(await accessToken(auth)).toBe('a1');
    nowMs += 540_001;
    expect(await accessToken(auth)).toBe('a2');
    expect(tokenRequests).toHaveLength(1);
  });

  it('asks for `slop login` when the refresh is refused', async () => {
    const store = new MemoryTokenStore();
    store.entries.set(SLOP_URL, { access_token: 'a1', refresh_token: 'r1', expires_at: 0 });
    const { fetch } = fakeAuthFetch(() =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    );
    await expect(accessToken(deps({ fetch, store }))).rejects.toThrow(
      'sign-in failed (400): invalid_grant; run `slop login` to sign in again',
    );
  });

  it('never echoes a 200 token response that fails validation', async () => {
    const store = new MemoryTokenStore();
    store.entries.set(SLOP_URL, { access_token: 'a1', refresh_token: 'r1', expires_at: 0 });
    const { fetch } = fakeAuthFetch(() =>
      Response.json({ access_token: 'secret-token', expires_in: 'x' }),
    );
    const failure = accessToken(deps({ fetch, store }));
    await expect(failure).rejects.toThrow('sign-in failed: unexpected token response');
    await expect(failure).rejects.not.toThrow(/secret-token/);
  });

  it('refuses to sign in without a terminal', async () => {
    await expect(accessToken(deps({ fetch: unusedFetch }))).rejects.toThrow(
      new SlopError('not signed in to slop: run `slop login`'),
    );
  });
});

describe('login', () => {
  it('signs in with PKCE through the local callback and stores the tokens', async () => {
    const port = await freePort();
    const store = new MemoryTokenStore();
    let callbackStatus = 0;
    const { fetch, tokenRequests } = fakeAuthFetch(() =>
      Response.json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }),
    );
    let authorizeUrl: URL | undefined;
    let callbackDone: Promise<void> = Promise.resolve();
    const openBrowser = (url: string): void => {
      authorizeUrl = new URL(url);
      const state = authorizeUrl.searchParams.get('state') ?? '';
      callbackDone = (async () => {
        // A request with the wrong state is turned away and doesn't end the wait.
        const wrong = await globalThis.fetch(
          `http://localhost:${port}/callback?code=evil&state=nope`,
        );
        expect(wrong.status).toBe(400);
        const wrongPath = await globalThis.fetch(
          `http://localhost:${port}/other?code=evil&state=${encodeURIComponent(state)}`,
        );
        expect(wrongPath.status).toBe(400);
        expect(await rawRequest(port, 'GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n')).toMatch(
          /^HTTP\/1\.1 400/,
        );
        const right = await globalThis.fetch(
          `http://localhost:${port}/callback?code=code-1&state=${encodeURIComponent(state)}`,
        );
        callbackStatus = right.status;
      })();
    };

    const tokens = await login(deps({ fetch, store, openBrowser, callbackPort: port }));
    await callbackDone;

    expect(callbackStatus).toBe(200);
    expect(`${authorizeUrl?.origin ?? ''}${authorizeUrl?.pathname ?? ''}`).toBe(AUTHORIZE_ENDPOINT);
    const params = Object.fromEntries(authorizeUrl?.searchParams ?? []);
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: `http://localhost:${port}/callback`,
      scope: 'openid email profile slop/mcp',
      code_challenge_method: 'S256',
    });
    const request = tokenRequests[0]?.fields;
    expect(request).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'client-1',
      code: 'code-1',
      redirect_uri: `http://localhost:${port}/callback`,
    });
    expect(pkceChallenge(request?.code_verifier ?? '')).toBe(params.code_challenge);
    expect(tokens).toEqual({ access_token: 'a1', refresh_token: 'r1', expires_at: NOW_S + 3600 });
    expect(store.entries.get(SLOP_URL)).toEqual(tokens);
    await expect(globalThis.fetch(`http://localhost:${port}/callback`)).rejects.toThrow();
  });

  it('keeps the code when the browser drops the connection straight away', async () => {
    const port = await freePort();
    const { fetch, tokenRequests } = fakeAuthFetch(() =>
      Response.json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }),
    );
    const openBrowser = (url: string): void => {
      const state = new URL(url).searchParams.get('state') ?? '';
      const socket = connect(port, 'localhost', () => {
        socket.end(`GET /callback?code=code-2&state=${state} HTTP/1.1\r\nHost: x\r\n\r\n`);
        socket.destroy();
      });
      socket.on('error', () => undefined);
    };
    await login(deps({ fetch, openBrowser, callbackPort: port, loginTimeoutMs: 2000 }));
    expect(tokenRequests[0]?.fields.code).toBe('code-2');
  });

  it('closes the callback server when opening the browser fails', async () => {
    const port = await freePort();
    const { fetch } = fakeAuthFetch(() => Response.json({}));
    const openBrowser = (): void => {
      throw new Error('no browser');
    };
    await expect(login(deps({ fetch, openBrowser, callbackPort: port }))).rejects.toThrow(
      'no browser',
    );
    await expect(globalThis.fetch(`http://localhost:${port}/callback`)).rejects.toThrow();
  });

  it('times out when no redirect arrives', async () => {
    const port = await freePort();
    const { fetch } = fakeAuthFetch(() => Response.json({}));
    await expect(
      login(deps({ fetch, openBrowser: () => undefined, callbackPort: port, loginTimeoutMs: 50 })),
    ).rejects.toThrow('timed out waiting for the sign-in');
  });

  it('reports the error Cognito redirects with', async () => {
    const port = await freePort();
    const { fetch } = fakeAuthFetch(() => Response.json({}));
    const openBrowser = (url: string): void => {
      const state = new URL(url).searchParams.get('state') ?? '';
      void globalThis.fetch(
        `http://localhost:${port}/callback?error=access_denied&error_description=Denied&state=${state}`,
      );
    };
    await expect(login(deps({ fetch, openBrowser, callbackPort: port }))).rejects.toThrow('Denied');
  });
});

describe('logout', () => {
  it('forgets the stored login', async () => {
    const store = new MemoryTokenStore();
    store.entries.set(SLOP_URL, { access_token: 'a', refresh_token: 'r', expires_at: 0 });
    await logout({ settings: { SLOP_URL }, store });
    expect(store.entries.size).toBe(0);
  });
});
