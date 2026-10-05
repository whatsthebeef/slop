import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import { requireSetting, type Settings } from './config.js';
import { SlopError } from './errors.js';
import { HTTP_TIMEOUT_MS, type Fetch } from './http.js';
import type { StoredTokens, TokenStore } from './token-store.js';
import { describeError, parseJsonOrUndefined } from './util.js';

export const CALLBACK_PORT = 7780;
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
export const LOGIN_SCOPE = 'openid email profile slop/mcp';
/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_S = 60;

// ---------------------------------------------------------------------------
// PKCE

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** The S256 code challenge for a verifier (RFC 7636 section 4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createPkce(): Pkce {
  // 64 random bytes give an 86-character verifier, inside RFC 7636's 43-128.
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

// ---------------------------------------------------------------------------
// OAuth endpoints

const metadataSchema = z.object({
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
});
export type OAuthMetadata = z.infer<typeof metadataSchema>;

/** Cognito's endpoints as slop publishes them (Cognito's own discovery omits PKCE support). */
export async function fetchOAuthMetadata(slopUrl: string, fetch: Fetch): Promise<OAuthMetadata> {
  const url = `${slopUrl}/.well-known/oauth-authorization-server`;
  let body: unknown;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!response.ok) throw new SlopError(`could not read ${url}: HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    if (error instanceof SlopError) throw error;
    throw new SlopError(`could not read ${url}: ${describeError(error)}`);
  }
  const parsed = metadataSchema.safeParse(body);
  if (!parsed.success) throw new SlopError(`could not read ${url}: unexpected metadata`);
  return parsed.data;
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});
type TokenResponse = z.infer<typeof tokenResponseSchema>;

const tokenErrorSchema = z.object({ error: z.string() });

export async function requestTokens(
  tokenEndpoint: string,
  fields: Readonly<Record<string, string>>,
  fetch: Fetch,
): Promise<TokenResponse> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw new SlopError(`could not reach ${tokenEndpoint}: ${describeError(error)}`);
  }
  const body = parseJsonOrUndefined(text);
  if (response.status === 200) {
    const tokens = tokenResponseSchema.safeParse(body);
    // Never echo a 200 body: it holds the tokens.
    if (!tokens.success) throw new SlopError('sign-in failed: unexpected token response');
    return tokens.data;
  }
  const failure = tokenErrorSchema.safeParse(body);
  const reason = failure.success ? failure.data.error : text.slice(0, 200);
  throw new SlopError(`sign-in failed (${response.status}): ${reason}`);
}

/** What is kept: Cognito doesn't rotate refresh tokens, so a refresh keeps the previous one. */
export function toStoredTokens(
  tokens: TokenResponse,
  previousRefreshToken: string | undefined,
  nowMs: number,
): StoredTokens {
  const refreshToken = tokens.refresh_token ?? previousRefreshToken;
  return {
    access_token: tokens.access_token,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    expires_at: Math.floor(nowMs / 1000) + (tokens.expires_in ?? 3600),
  };
}

// ---------------------------------------------------------------------------
// Sign-in

export interface AuthDeps {
  readonly settings: Settings;
  readonly store: TokenStore;
  readonly fetch: Fetch;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** Whether a missing login may start the browser sign-in (an interactive terminal). */
  readonly canPrompt: boolean;
  readonly openBrowser: (url: string) => void;
  /** Progress messages for the person signing in. */
  readonly log: (message: string) => void;
  readonly callbackPort?: number;
  readonly loginTimeoutMs?: number;
}

interface CallbackResult {
  readonly code?: string;
  readonly error?: string;
}

/**
 * Waits for the authorization redirect on a one-shot local server. Resolves with the code (or
 * Cognito's error) once a request with the right state arrives, or with a timeout error.
 */
async function awaitCallback(
  port: number,
  state: string,
  timeoutMs: number,
  onListening: () => void,
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let isSettled = false;
    const server = createServer((request, response) => {
      const url = parseRequestUrl(request.url, port);
      if (url?.pathname !== '/callback' || url.searchParams.get('state') !== state) {
        response.writeHead(400).end();
        return;
      }
      const result = {
        ...optional('code', url.searchParams.get('code')),
        ...optional(
          'error',
          url.searchParams.get('error_description') ?? url.searchParams.get('error'),
        ),
      };
      // Settle at once so a dropped connection can't lose the code; settle() stops accepting
      // connections, and this one is cut only after the page has gone out (or the browser left).
      response.on('close', () => server.closeAllConnections());
      settle(() => resolve(result), { keepConnections: true });
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('You are signed in to slop. You can close this tab.\n');
    });
    const timer = setTimeout(() => {
      settle(() => resolve({ error: 'timed out waiting for the sign-in' }));
    }, timeoutMs);
    function settle(outcome: () => void, options = { keepConnections: false }): void {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      server.close();
      if (!options.keepConnections) server.closeAllConnections();
      outcome();
    }
    server.on('error', (error) => {
      settle(() =>
        reject(
          new SlopError(
            `could not listen on port ${port} for the sign-in redirect: ${describeError(error)}`,
          ),
        ),
      );
    });
    server.listen(port, 'localhost', () => {
      try {
        onListening();
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new SlopError(String(error))));
      }
    });
  });
}

/** The request target as a URL, or undefined when it is malformed. */
function parseRequestUrl(target: string | undefined, port: number): URL | undefined {
  try {
    return new URL(target ?? '/', `http://localhost:${port}`);
  } catch {
    // A malformed target is answered with 400 by the caller.
    return undefined;
  }
}

/** Authorization code with PKCE through the browser; saves and returns the new tokens. */
export async function login(deps: AuthDeps): Promise<StoredTokens> {
  const slopUrl = requireSetting(deps.settings, 'SLOP_URL');
  const clientId = requireSetting(deps.settings, 'SLOP_CLIENT_ID');
  const metadata = await fetchOAuthMetadata(slopUrl, deps.fetch);
  const port = deps.callbackPort ?? CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}/callback`;
  const pkce = createPkce();
  const state = randomBytes(16).toString('base64url');
  const authorizeUrl = new URL(metadata.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: LOGIN_SCOPE,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  })) {
    authorizeUrl.searchParams.set(key, value);
  }
  const result = await awaitCallback(port, state, deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS, () => {
    deps.log(`Opening the slop sign-in page. If it does not open, visit:\n  ${authorizeUrl.href}`);
    deps.openBrowser(authorizeUrl.href);
  });
  if (result.code === undefined) throw new SlopError(result.error ?? 'the sign-in was refused');
  const tokens = await requestTokens(
    metadata.token_endpoint,
    {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: result.code,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
    },
    deps.fetch,
  );
  const stored = toStoredTokens(tokens, undefined, deps.now());
  await deps.store.save(slopUrl, stored);
  return stored;
}

export async function logout(deps: Pick<AuthDeps, 'settings' | 'store'>): Promise<void> {
  await deps.store.delete(requireSetting(deps.settings, 'SLOP_URL'));
}

/**
 * A bearer token for slop: `dev:<email>` against a dev server, else the stored access token,
 * refreshed when it is about to expire (or always, with forceRefresh).
 */
export async function accessToken(deps: AuthDeps, forceRefresh = false): Promise<string> {
  const devEmail = deps.settings.SLOP_DEV_EMAIL;
  if (devEmail !== undefined) return `dev:${devEmail}`;
  const slopUrl = requireSetting(deps.settings, 'SLOP_URL');
  let tokens = await deps.store.load(slopUrl);
  if (tokens?.refresh_token === undefined) {
    if (!deps.canPrompt) throw new SlopError('not signed in to slop: run `slop login`');
    tokens = await login(deps);
    // A fresh login's access token is good; no need to refresh it straight away.
    if (!forceRefresh) return tokens.access_token;
  }
  if (!forceRefresh && tokens.expires_at > deps.now() / 1000 + REFRESH_MARGIN_S) {
    return tokens.access_token;
  }
  const refreshToken = tokens.refresh_token;
  if (refreshToken === undefined) {
    throw new SlopError('the slop login cannot be refreshed: run `slop login`');
  }
  let refreshed: TokenResponse;
  try {
    const metadata = await fetchOAuthMetadata(slopUrl, deps.fetch);
    refreshed = await requestTokens(
      metadata.token_endpoint,
      {
        grant_type: 'refresh_token',
        client_id: requireSetting(deps.settings, 'SLOP_CLIENT_ID'),
        refresh_token: refreshToken,
      },
      deps.fetch,
    );
  } catch (error) {
    if (!(error instanceof SlopError)) throw error;
    throw new SlopError(`${error.message}; run \`slop login\` to sign in again`);
  }
  const stored = toStoredTokens(refreshed, refreshToken, deps.now());
  await deps.store.save(slopUrl, stored);
  return stored.access_token;
}

/**
 * Opens a URL in the default browser on macOS and Linux. Elsewhere it does nothing: the URL is
 * printed too, and Windows' `start` would pass it through cmd.exe's parser (`&` splits commands).
 */
export function openInBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (command === undefined) return;
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // No browser launcher: the person follows the printed URL instead.
  });
  child.unref();
}

function optional<K extends string>(key: K, value: string | null): Partial<Record<K, string>> {
  const entry: Partial<Record<K, string>> = {};
  if (value !== null) entry[key] = value;
  return entry;
}
