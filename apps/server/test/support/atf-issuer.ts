import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { boundedFetcher } from '../../src/atf-oidc.js';
import type { BoundedFetchOptions, DocumentFetcher } from '../../src/atf-oidc.js';

export type Alg = 'RS256' | 'ES256';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const newKey = (alg: Alg): { privateKey: KeyObject; publicKey: KeyObject } =>
  alg === 'RS256'
    ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : generateKeyPairSync('ec', { namedCurve: 'P-256' });

/** Signs a compact JWT with node's crypto: no JWT library in the tests either. */
export const signJwt = (
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
): string => {
  const input = `${b64(header)}.${b64(payload)}`;
  const signature =
    header['alg'] === 'ES256'
      ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
      : sign('sha256', Buffer.from(input), key);
  return `${input}.${signature.toString('base64url')}`;
};

/**
 * A local OIDC issuer: serves a discovery document and a JWKS over plain http, and signs tokens. The issuer URL the tokens
 * carry is `https://<name>.test`; `fetcher()` maps that origin onto the local server so the verifier sees an https issuer.
 */
export interface TestIssuer {
  readonly issuer: string;
  readonly kid: string;
  readonly privateKey: KeyObject;
  /** What the JWKS path does: serve the key, hang, or redirect to a copy of the key. */
  jwks: 'ok' | 'hang' | 'redirect' | 'huge';
  /** How many times each path was asked for. */
  readonly hits: Map<string, number>;
  token(
    claims: Record<string, unknown>,
    options?: { alg?: Alg; key?: KeyObject; header?: Record<string, unknown> },
  ): string;
  fetcher(options?: BoundedFetchOptions): DocumentFetcher;
  close(): Promise<void>;
}

export const startIssuer = async (name: string, alg: Alg = 'RS256'): Promise<TestIssuer> => {
  const { privateKey, publicKey } = newKey(alg);
  const kid = `${name}-key-1`;
  const issuer = `https://${name}.test`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' };
  const hits = new Map<string, number>();
  let port = 0;
  const state: { jwks: TestIssuer['jwks'] } = { jwks: 'ok' };
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/.well-known/openid-configuration') {
      json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` });
    } else if (path === '/.well-known/jwks.json') {
      if (state.jwks === 'hang') return;
      if (state.jwks === 'redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${String(port)}/copy/jwks.json` });
        res.end();
        return;
      }
      if (state.jwks === 'huge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk], pad: 'x'.repeat(400_000) }));
        return;
      }
      json({ keys: [jwk] });
    } else if (path === '/copy/jwks.json') {
      json({ keys: [jwk] });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('The test issuer has no port');
  port = address.port;
  return {
    issuer,
    kid,
    privateKey,
    get jwks() {
      return state.jwks;
    },
    set jwks(value) {
      state.jwks = value;
    },
    hits,
    token: (claims, options = {}) =>
      signJwt(
        { alg: options.alg ?? alg, kid, typ: 'JWT', ...options.header },
        {
          iss: issuer,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
          ...claims,
        },
        options.key ?? privateKey,
      ),
    fetcher: (options = {}) => {
      const inner = boundedFetcher({ allowHttp: true, ...options });
      return {
        fetch: (uri) => inner.fetch(uri.replace(issuer, `http://127.0.0.1:${String(port)}`)),
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
