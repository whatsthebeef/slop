import { generateKeyPairSync } from 'node:crypto';
import { AtfRunnerService } from '@slop/core';
import type { AtfRunner, Board } from '@slop/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boundedFetcher, createOidcRunnerVerifier } from '../src/atf-oidc.js';
import type { OidcVerifierDeps } from '../src/atf-oidc.js';
import type { RunnerVerifier } from '../src/atf-auth.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { startIssuer, signJwt } from './support/atf-issuer.js';
import type { TestIssuer } from './support/atf-issuer.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const AUDIENCE = 'https://slop.example.com';

describe('OIDC runner identity', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let runners: AtfRunnerService;
  let board: Board;
  let github: TestIssuer;
  let gitlab: TestIssuer;
  let unlisted: TestIssuer;

  const register = async (
    name: string,
    claims: Record<string, string[]>,
    issuer = github.issuer,
  ): Promise<AtfRunner> => {
    const created = await runners.create(ADMIN, board.id, {
      name,
      method: 'oidc',
      config: { issuer, claims },
      environments: ['staging'],
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };

  const verifier = (extra: Partial<OidcVerifierDeps> = {}): RunnerVerifier => {
    const made = createOidcRunnerVerifier({
      store,
      oidcIssuers: [github.issuer, gitlab.issuer],
      awsIssuers: [],
      awsAccounts: [],
      audience: AUDIENCE,
      fetcher: github.fetcher(),
      ...extra,
    });
    if (made === null) throw new Error('no verifier');
    return made;
  };

  /** One fetcher for several issuers: each issuer's origin goes to its own local server. */
  const both = (options = {}) => {
    const a = github.fetcher(options);
    const b = gitlab.fetcher(options);
    return {
      fetch: (uri: string) => (uri.startsWith(gitlab.issuer) ? b.fetch(uri) : a.fetch(uri)),
    };
  };

  const claims = {
    aud: AUDIENCE,
    sub: 'repo:acme/app:ref:refs/heads/main',
    repository: 'acme/app',
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('atf_oidc'));
    store = new PgStore(database.db);
    runners = new AtfRunnerService({ store, clock: { now: () => '2026-10-05T13:00:00.000Z' } });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      board = await tx.insertBoard({
        name: 'sandbox',
        repo: 'acme/sandbox',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [{ name: 'staging', allowBranchDeploy: false, role: 'integration' }],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
    });
    github = await startIssuer('github');
    gitlab = await startIssuer('gitlab', 'ES256');
    unlisted = await startIssuer('rogue');
  });

  afterAll(async () => {
    await Promise.all([github.close(), gitlab.close(), unlisted.close()]);
    await drop();
  });

  let runner: AtfRunner;
  beforeEach(async () => {
    github.jwks = 'ok';
    runner = await register(`gh-${String(Math.random()).slice(2, 8)}`, {
      repository: ['acme/app'],
    });
  });
  afterEach(async () => {
    await runners.revoke(ADMIN, board.id, runner.id);
  });

  it('accepts a valid token and names the runner whose claim rules it satisfies', async () => {
    const found = await verifier()(board.id, github.token(claims));
    expect(found).toMatchObject({
      runnerId: runner.id,
      boardId: board.id,
      method: 'oidc',
      environments: ['staging'],
    });
  });

  it('verifies ES256 tokens from another issuer against that issuer’s own keys', async () => {
    const gl = await register('gl', { sub: ['project_path:acme/app:*'] }, gitlab.issuer);
    const token = gitlab.token({
      aud: AUDIENCE,
      sub: 'project_path:acme/app:ref_type:branch:ref:main',
    });
    const found = await verifier({ fetcher: both() })(board.id, token);
    expect(found?.runnerId).toBe(gl.id);
    await runners.revoke(ADMIN, board.id, gl.id);
  });

  it('refuses a token for another audience, an expired one, and one with no expiry', async () => {
    const verify = verifier();
    expect(
      await verify(board.id, github.token({ ...claims, aud: 'https://elsewhere.example.com' })),
    ).toBeNull();
    expect(
      await verify(board.id, github.token({ ...claims, exp: Math.floor(Date.now() / 1000) - 600 })),
    ).toBeNull();
    const noExp = signJwt(
      { alg: 'RS256', kid: github.kid },
      { iss: github.issuer, ...claims },
      github.privateKey,
    );
    expect(await verify(board.id, noExp)).toBeNull();
  });

  it('refuses a bad signature, a token signed by a key the issuer does not publish, and alg none', async () => {
    const verify = verifier();
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(await verify(board.id, github.token(claims, { key: stranger }))).toBeNull();
    const good = github.token(claims);
    const [head = '', body = ''] = good.split('.');
    expect(await verify(board.id, `${head}.${body}.AAAA`)).toBeNull();
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${body}.`;
    expect(await verify(board.id, none)).toBeNull();
    const fakeNone = signJwt(
      { alg: 'none', kid: github.kid },
      { iss: github.issuer, ...claims },
      stranger,
    );
    expect(await verify(board.id, fakeNone)).toBeNull();
    // A token whose payload is swapped after signing no longer verifies.
    const forged = Buffer.from(
      JSON.stringify({
        iss: github.issuer,
        aud: AUDIENCE,
        exp: 9999999999,
        repository: 'acme/app',
      }),
    ).toString('base64url');
    expect(await verify(board.id, `${head}.${forged}.${good.split('.')[2] ?? ''}`)).toBeNull();
  });

  it('never contacts an issuer the server does not list, even if it signs a valid token', async () => {
    const verify = verifier({ fetcher: unlisted.fetcher() });
    expect(await verify(board.id, unlisted.token(claims))).toBeNull();
    expect(unlisted.hits.size).toBe(0);
  });

  it('refuses a token from a listed issuer on a runner that names a different issuer, and one that misses a claim rule', async () => {
    const verify = verifier({ fetcher: both() });
    // GitLab is listed, but the only runner here is bound to GitHub's issuer.
    expect(
      await verify(board.id, gitlab.token({ aud: AUDIENCE, repository: 'acme/app' })),
    ).toBeNull();
    expect(
      await verify(board.id, github.token({ ...claims, repository: 'acme/other' })),
    ).toBeNull();
    expect(await verify(board.id, github.token({ aud: AUDIENCE, sub: 'x' }))).toBeNull();
  });

  it('refuses when the token matches two runners on the board', async () => {
    const twin = await register(`twin-${String(Math.random()).slice(2, 8)}`, {
      sub: ['repo:acme/*'],
    });
    expect(await verifier()(board.id, github.token(claims))).toBeNull();
    await runners.revoke(ADMIN, board.id, twin.id);
    expect(await verifier()(board.id, github.token(claims))).not.toBeNull();
  });

  it('does not match a disabled runner or another board’s runner', async () => {
    await runners.update(ADMIN, board.id, runner.id, { enabled: false });
    expect(await verifier()(board.id, github.token(claims))).toBeNull();
    await runners.update(ADMIN, board.id, runner.id, { enabled: true });
    expect(await verifier()(board.id + 1000, github.token(claims))).toBeNull();
  });

  it('ignores credentials that are not JWTs (the board token) so the legacy path can take them', async () => {
    github.hits.clear();
    expect(await verifier()(board.id, 'slopit_abcdef')).toBeNull();
    expect(github.hits.size).toBe(0);
  });

  it('is off (no verifier) when no issuer is listed', () => {
    expect(
      createOidcRunnerVerifier({
        store,
        oidcIssuers: [],
        awsIssuers: [],
        awsAccounts: [],
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  describe('the JWKS and discovery fetches', () => {
    it('gives up after the timeout', async () => {
      github.jwks = 'hang';
      const verify = verifier({ fetcher: github.fetcher({ timeoutMs: 200 }) });
      const started = Date.now();
      expect(await verify(board.id, github.token(claims))).toBeNull();
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it('does not follow a redirect to the keys', async () => {
      github.jwks = 'redirect';
      github.hits.clear();
      expect(await verifier()(board.id, github.token(claims))).toBeNull();
      expect(github.hits.get('/copy/jwks.json')).toBeUndefined();
    });

    it('refuses a document over the size cap', async () => {
      github.jwks = 'huge';
      const verify = verifier({ fetcher: github.fetcher({ maxBytes: 100_000 }) });
      expect(await verify(board.id, github.token(claims))).toBeNull();
    });

    it('caches discovery and keys: a second token does not fetch again', async () => {
      const verify = verifier();
      github.hits.clear();
      expect(await verify(board.id, github.token(claims))).not.toBeNull();
      expect(await verify(board.id, github.token(claims))).not.toBeNull();
      expect(github.hits.get('/.well-known/openid-configuration')).toBe(1);
      expect(github.hits.get('/.well-known/jwks.json')).toBe(1);
    });

    it('only fetches https unless a test allows http', async () => {
      await expect(boundedFetcher().fetch('http://127.0.0.1:1/x')).rejects.toThrow('https');
    });
  });
});
