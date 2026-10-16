import { createHash, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  CreateUserPoolClientCommand,
  DeleteUserPoolClientCommand,
  DescribeResourceServerCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  AtfRunnerService,
  BoardService,
  IntegrationTokenService,
  TestRunService,
} from '@slop/core';
import type { Board } from '@slop/core';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import type { Jwks } from 'aws-jwt-verify/jwk';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATF_SCOPES,
  AwsCognitoClients,
  cognitoRunnerCredentials,
  createCognitoRunnerVerifier,
} from '../src/atf-cognito.js';
import type { CognitoClients } from '../src/atf-cognito.js';
import { createRunnerAuthenticator } from '../src/atf-auth.js';
import type { RunnerVerifier } from '../src/atf-auth.js';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountAtfResults } from '../src/http/atf-results.js';
import { mountAtfRunners } from '../src/http/atf-runners.js';
import { mountAtfSpecs } from '../src/http/atf-specs.js';
import { signJwt } from './support/atf-issuer.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const POOL = 'us-east-1_TestPool1';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const TOKEN_URL = 'https://auth.example.com/oauth2/token';
const READ = ATF_SCOPES['atf.read-specs'];
const WRITE = ATF_SCOPES['atf.write-results'];
const createdBody = z.object({
  value: z.record(z.string(), z.unknown()),
  credentials: z.record(z.string(), z.unknown()),
});
const revokedBody = z.object({
  value: z.record(z.string(), z.unknown()),
  warning: z.string().optional(),
});
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

/** Cognito's app-client API without the network: remembers what it made and can be told to fail. */
class FakeCognitoClients implements CognitoClients {
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  failCreate = false;
  failDelete = false;
  private next = 1;
  create(name: string): Promise<{ clientId: string; clientSecret: string }> {
    if (this.failCreate) return Promise.reject(new Error('Cognito is down'));
    this.created.push(name);
    const n = this.next++;
    return Promise.resolve({
      clientId: `client${String(n)}`,
      clientSecret: `s3cret-value-${String(n)}`,
    });
  }
  delete(clientId: string): Promise<void> {
    if (this.failDelete) return Promise.reject(new Error('Cognito is down'));
    this.deleted.push(clientId);
    return Promise.resolve();
  }
  describe(clientId: string) {
    return Promise.resolve(
      this.created.length > 0 && !this.deleted.includes(clientId)
        ? { clientId, scopes: [READ, WRITE] }
        : null,
    );
  }
  unavailableReason(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

describe('ATF client credentials (Cognito M2M)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let cognito: FakeCognitoClients;
  let runners: AtfRunnerService;
  let board: Board;
  let other: Board;
  let privateKey: KeyObject;
  let jwks: Jwks;
  let verify: RunnerVerifier;
  let app: Hono<Env>;
  const logs: string[] = [];
  const kid = 'pool-key-1';
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const token = (
    clientId: string,
    claims: Record<string, unknown> = {},
    key: KeyObject = privateKey,
  ): string =>
    signJwt(
      { alg: 'RS256', kid },
      {
        iss: ISSUER,
        sub: clientId,
        client_id: clientId,
        token_use: 'access',
        scope: `${READ} ${WRITE}`,
        auth_time: nowSeconds(),
        iat: nowSeconds(),
        exp: nowSeconds() + 3600,
        jti: 'token-id',
        version: 2,
        ...claims,
      },
      key,
    );

  const issued = async (name: string, boardId = board.id, environments = ['staging']) => {
    const created = await runners.create(ADMIN, boardId, {
      name,
      method: 'client_credentials',
      environments,
    });
    if (!created.ok) throw new Error(created.error.message);
    const { credentials, ...runner } = created.value;
    if (credentials === undefined) throw new Error('no credentials were issued');
    return { runner, credentials };
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('atf_cognito'));
    store = new PgStore(database.db);
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey;
    const exported = pair.publicKey.export({ format: 'jwk' });
    jwks = {
      keys: [
        { kty: 'RSA', n: exported.n ?? '', e: exported.e ?? '', kid, alg: 'RS256', use: 'sig' },
      ],
    };
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      const make = async (name: string): Promise<Board> => {
        const created = await tx.insertBoard({
          name,
          repo: `acme/${name}`,
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [{ name: 'staging', allowBranchDeploy: true }],
          sensitivePaths: [],
        });
        await tx.upsertMember({ boardId: created.id, email: ADMIN, role: 'admin' });
        return created;
      };
      board = await make('sandbox');
      other = await make('elsewhere');
    });
  });

  afterAll(async () => {
    await drop();
  });

  beforeEach(() => {
    cognito = new FakeCognitoClients();
    runners = new AtfRunnerService({
      store,
      clock: { now: () => '2026-10-05T13:00:00.000Z' },
      issuer: cognitoRunnerCredentials(cognito, TOKEN_URL),
      log: (task, message) => logs.push(`${task}: ${message}`),
    });
    verify = createCognitoRunnerVerifier({ store, userPoolId: POOL, jwks });
    const clock = { now: () => '2026-10-05T13:00:00.000Z' };
    const tokens = new IntegrationTokenService({
      store,
      clock,
      newSecret: () => `slopit_${Math.random().toString(36).slice(2)}`,
      hashSecret: (secret) => createHash('sha256').update(secret).digest('hex'),
    });
    const authenticate = createRunnerAuthenticator({
      store,
      tokens,
      verifiers: [verify],
      log: () => undefined,
    });
    const testRuns = new TestRunService({ store, notifier: { publish: () => undefined }, clock });
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', ADMIN);
      await next();
    });
    mountAtfRunners(app, { runners });
    mountAtfSpecs(app, {
      testRuns,
      boards: new BoardService({ store, notifier: { publish: () => undefined } }),
      authenticate,
      runners,
    });
    mountAtfResults(app, { testRuns, runners, authenticate, log: () => undefined });
  });

  afterEach(async () => {
    for (const r of await store.transaction((tx) => tx.listAtfRunners(board.id))) {
      await runners.revoke(ADMIN, board.id, r.id);
    }
    for (const r of await store.transaction((tx) => tx.listAtfRunners(other.id))) {
      await runners.revoke(ADMIN, other.id, r.id);
    }
  });

  describe('creating a runner', () => {
    it('creates the Cognito client, stores only its ID and returns the secret once', async () => {
      const { runner, credentials } = await issued('vendor');
      expect(cognito.created).toEqual([`slop-atf-b${String(board.id)}-r${String(runner.id)}`]);
      expect(credentials).toMatchObject({
        clientId: 'client1',
        clientSecret: 's3cret-value-1',
        tokenUrl: TOKEN_URL,
        scope: `${READ} ${WRITE}`,
      });
      expect(runner).toMatchObject({
        method: 'client_credentials',
        enabled: true,
        config: { clientId: 'client1' },
      });
      // The secret is in no row of the runners table and in no later read.
      const rows = JSON.stringify(await database.db.execute(sql`select * from atf_runners`));
      expect(rows).not.toContain('s3cret-value');
      const listed = await runners.list(ADMIN, board.id);
      expect(JSON.stringify(listed)).not.toContain('s3cret-value');
      expect(logs.join('\n')).not.toContain('s3cret-value');
    });

    it('answers the create route with the credentials once, uncacheable, and the list route without them', async () => {
      const created = await app.request(`/api/boards/${String(board.id)}/atf-runners`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'route',
          method: 'client_credentials',
          environments: ['staging'],
        }),
      });
      expect(created.status).toBe(201);
      expect(created.headers.get('cache-control')).toBe('no-store');
      const body = createdBody.parse(await created.json());
      expect(body.credentials).toMatchObject({
        clientId: 'client1',
        clientSecret: 's3cret-value-1',
      });
      expect(body.value).not.toHaveProperty('credentials');
      expect(JSON.stringify(body.value)).not.toContain('s3cret-value');
      const list = await app.request(`/api/boards/${String(board.id)}/atf-runners`);
      expect(JSON.stringify(await list.json())).not.toContain('s3cret-value');
    });

    it('ignores a client ID the caller supplies and leaves other methods without credentials', async () => {
      const created = await runners.create(ADMIN, board.id, {
        name: 'sneaky',
        method: 'client_credentials',
        config: { clientId: 'someone-elses-client' },
        environments: ['staging'],
      });
      expect(created.ok && created.value.config.clientId).toBe('client1');
      const oidc = await runners.create(ADMIN, board.id, {
        name: 'gh',
        method: 'oidc',
        config: {
          issuer: 'https://token.actions.githubusercontent.com',
          claims: { repository: ['acme/app'] },
        },
        environments: ['staging'],
      });
      expect(oidc.ok && oidc.value.credentials).toBeUndefined();
      expect(cognito.created).toHaveLength(1);
    });

    it('keeps the client ID fixed when the runner is changed', async () => {
      const { runner } = await issued('fixed');
      const changed = await runners.update(ADMIN, board.id, runner.id, {
        name: 'renamed',
        config: { clientId: 'other' },
      });
      expect(changed.ok && changed.value.config.clientId).toBe('client1');
    });

    it('saves nothing usable and frees the name when Cognito fails', async () => {
      cognito.failCreate = true;
      const failed = await runners.create(ADMIN, board.id, {
        name: 'unlucky',
        method: 'client_credentials',
        environments: ['staging'],
      });
      expect(failed.ok).toBe(false);
      expect(await runners.list(ADMIN, board.id)).toMatchObject({ ok: true, value: [] });
      cognito.failCreate = false;
      const again = await runners.create(ADMIN, board.id, {
        name: 'unlucky',
        method: 'client_credentials',
        environments: ['staging'],
      });
      expect(again.ok).toBe(true);
    });

    it('is for board admins only', async () => {
      const refused = await runners.create('stranger@example.com', board.id, {
        name: 'x',
        method: 'client_credentials',
        environments: ['staging'],
      });
      expect(refused.ok).toBe(false);
      expect(cognito.created).toEqual([]);
    });
  });

  describe('revoking a runner', () => {
    it('deletes the Cognito client and ends the credential', async () => {
      const { runner, credentials } = await issued('goner');
      expect(await verify(board.id, token(credentials.clientId), 'atf.read-specs')).not.toBeNull();
      const revoked = await runners.revoke(ADMIN, board.id, runner.id);
      expect(revoked).toMatchObject({ ok: true, value: { enabled: false } });
      expect(revoked.ok && revoked.value.cleanup).toBeUndefined();
      expect(cognito.deleted).toEqual([credentials.clientId]);
      expect(await verify(board.id, token(credentials.clientId), 'atf.read-specs')).toBeNull();
    });

    it('revokes first: a Cognito failure leaves no usable runner, says so, and revoking again retries', async () => {
      const { runner, credentials } = await issued('stuck');
      cognito.failDelete = true;
      const revoked = await runners.revoke(ADMIN, board.id, runner.id);
      expect(revoked.ok && revoked.value).toMatchObject({ enabled: false, cleanup: 'failed' });
      expect(revoked.ok && revoked.value.revokedAt).not.toBeNull();
      // The token still verifies as a Cognito token, but no runner is left for it.
      expect(await verify(board.id, token(credentials.clientId), 'atf.read-specs')).toBeNull();
      cognito.failDelete = false;
      const retried = await runners.revoke(ADMIN, board.id, runner.id);
      expect(retried.ok && retried.value.cleanup).toBeUndefined();
      expect(cognito.deleted).toEqual([credentials.clientId]);
    });

    it('answers the revoke route with a warning when the client could not be removed', async () => {
      const { runner } = await issued('warn');
      cognito.failDelete = true;
      const response = await app.request(
        `/api/boards/${String(board.id)}/atf-runners/${String(runner.id)}`,
        {
          method: 'DELETE',
        },
      );
      expect(response.status).toBe(200);
      const body = revokedBody.parse(await response.json());
      expect(body.warning).toMatch(/could not be removed/);
      expect(body.value).not.toHaveProperty('cleanup');
      expect(body.value['enabled']).toBe(false);
    });
  });

  describe('the access token', () => {
    it('maps a token with the right scope and client to its runner, for each door', async () => {
      const { runner, credentials } = await issued('vendor');
      for (const scope of ['atf.read-specs', 'atf.write-results'] as const) {
        expect(await verify(board.id, token(credentials.clientId), scope)).toEqual({
          runnerId: runner.id,
          boardId: board.id,
          name: 'vendor',
          method: 'client_credentials',
          environments: ['staging'],
        });
      }
    });

    it('wants the scope the door needs, and refuses a token whose scope is wrong or missing', async () => {
      const { credentials } = await issued('scoped');
      const readOnly = token(credentials.clientId, { scope: READ });
      expect(await verify(board.id, readOnly, 'atf.read-specs')).not.toBeNull();
      expect(await verify(board.id, readOnly, 'atf.write-results')).toBeNull();
      const writeOnly = token(credentials.clientId, { scope: WRITE });
      expect(await verify(board.id, writeOnly, 'atf.read-specs')).toBeNull();
      expect(
        await verify(
          board.id,
          token(credentials.clientId, { scope: 'openid email' }),
          'atf.read-specs',
        ),
      ).toBeNull();
      expect(
        await verify(
          board.id,
          token(credentials.clientId, { scope: 'slop/mcp' }),
          'atf.read-specs',
        ),
      ).toBeNull();
      expect(
        await verify(board.id, token(credentials.clientId, { scope: undefined }), 'atf.read-specs'),
      ).toBeNull();
      // A door that names no scope grants nothing.
      expect(await verify(board.id, token(credentials.clientId))).toBeNull();
    });

    it('refuses a person’s access token (it carries a username), even with the scope and a registered client', async () => {
      const { credentials } = await issued('person');
      expect(
        await verify(
          board.id,
          token(credentials.clientId, { username: 'someone' }),
          'atf.read-specs',
        ),
      ).toBeNull();
    });

    it('refuses a client that belongs to another board, or to no runner', async () => {
      const { credentials } = await issued('mine');
      expect(await verify(other.id, token(credentials.clientId), 'atf.read-specs')).toBeNull();
      expect(await verify(board.id, token('unregistered-client'), 'atf.read-specs')).toBeNull();
    });

    it('refuses a disabled runner’s token and accepts it again once enabled', async () => {
      const { runner, credentials } = await issued('toggle');
      await runners.update(ADMIN, board.id, runner.id, { enabled: false });
      expect(await verify(board.id, token(credentials.clientId), 'atf.read-specs')).toBeNull();
      await runners.update(ADMIN, board.id, runner.id, { enabled: true });
      expect(await verify(board.id, token(credentials.clientId), 'atf.read-specs')).not.toBeNull();
    });

    it('refuses a client named by two runners of the board', async () => {
      const plain = new AtfRunnerService({
        store,
        clock: { now: () => '2026-10-05T13:00:00.000Z' },
      });
      for (const name of ['twin-a', 'twin-b']) {
        const made = await plain.create(ADMIN, board.id, {
          name,
          method: 'client_credentials',
          config: { clientId: 'shared-client' },
          environments: ['staging'],
        });
        expect(made.ok).toBe(true);
      }
      expect(await verify(board.id, token('shared-client'), 'atf.read-specs')).toBeNull();
    });

    it('refuses tokens that are not valid access tokens of the pool', async () => {
      const { credentials } = await issued('strict');
      const id = credentials.clientId;
      const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      const cases: Record<string, string> = {
        'signed by another key': token(id, {}, stranger),
        'an ID token': token(id, { token_use: 'id', aud: id }),
        'another pool': token(id, {
          iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other',
        }),
        expired: token(id, { exp: nowSeconds() - 600 }),
        'not a JWT': 'slopit_abc',
        empty: '',
      };
      for (const [name, bearer] of Object.entries(cases)) {
        expect(await verify(board.id, bearer, 'atf.read-specs'), name).toBeNull();
      }
    });
  });

  describe('at the doors', () => {
    const specs = (bearer: string) =>
      app.request(
        `/integrations/boards/${String(board.id)}/atf-specs?environment=staging&sha=${SHA}`,
        {
          headers: { authorization: `Bearer ${bearer}` },
        },
      );
    const results = (bearer: string) =>
      app.request(`/integrations/boards/${String(board.id)}/atf-results`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: '{}',
      });

    it('lets each scope through its own door only, with a plain 401 otherwise', async () => {
      const { credentials } = await issued('doors');
      const readOnly = token(credentials.clientId, { scope: READ });
      const writeOnly = token(credentials.clientId, { scope: WRITE });
      expect((await specs(readOnly)).status).not.toBe(401);
      expect((await specs(writeOnly)).status).toBe(401);
      // A bad body is a 422 only after the credential was accepted.
      expect((await results(writeOnly)).status).toBe(422);
      const refused = await results(readOnly);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ code: 'unauthenticated', message: 'Unauthenticated' });
    });

    it('stops accepting the token the moment the runner is revoked', async () => {
      const { runner, credentials } = await issued('revoked');
      const bearer = token(credentials.clientId);
      expect((await specs(bearer)).status).not.toBe(401);
      await runners.revoke(ADMIN, board.id, runner.id);
      expect((await specs(bearer)).status).toBe(401);
    });
  });

  describe('the user verifier', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('never accepts a runner’s token, and bearerEmail does not see one', async () => {
      // Serve the pool's keys without the network, so the only thing left to refuse the token is its client.
      vi.spyOn(SimpleJwksCache.prototype, 'getJwks').mockResolvedValue(jwks);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const auth = new Auth(
        database.db,
        loadConfig({
          AUTH_MODE: 'cognito',
          PUBLIC_URL: 'https://slop.example.com',
          COGNITO_USER_POOL_ID: POOL,
          COGNITO_REGION: 'us-east-1',
          COGNITO_DOMAIN: 'auth.example.com',
          COGNITO_CLIENT_IDS: 'board-client,connector-client',
        }),
      );
      const { credentials } = await issued('not-a-user');
      expect(await auth.bearerEmail(token(credentials.clientId))).toBeNull();
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/client/i);
    });
  });
});

describe('the Cognito adapter', () => {
  const stub = (answer: (command: unknown) => unknown) => ({
    send: vi.fn((command: unknown) => Promise.resolve(answer(command))),
  });
  const notFound = () => new ResourceNotFoundException({ message: 'gone', $metadata: {} });

  it('creates a client with a secret, the client_credentials flow only and the two ATF scopes', async () => {
    const client = stub(() => ({ UserPoolClient: { ClientId: 'abc', ClientSecret: 'shh' } }));
    const clients = new AwsCognitoClients({ userPoolId: POOL, region: 'us-east-1', client });
    expect(await clients.create('slop-atf-b1-r2')).toEqual({
      clientId: 'abc',
      clientSecret: 'shh',
    });
    const [command] = client.send.mock.calls[0] ?? [];
    if (!(command instanceof CreateUserPoolClientCommand)) throw new Error('not a create command');
    expect(command.input).toMatchObject({
      UserPoolId: POOL,
      ClientName: 'slop-atf-b1-r2',
      GenerateSecret: true,
      AllowedOAuthFlows: ['client_credentials'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['slop/atf.read-specs', 'slop/atf.write-results'],
    });
  });

  it('fails when Cognito returns no secret', async () => {
    const clients = new AwsCognitoClients({
      userPoolId: POOL,
      region: 'us-east-1',
      client: stub(() => ({ UserPoolClient: { ClientId: 'abc' } })),
    });
    await expect(clients.create('x')).rejects.toThrow();
  });

  it('deletes a client, treats one that is gone as deleted and fails on anything else', async () => {
    const ok = stub(() => ({}));
    await new AwsCognitoClients({ userPoolId: POOL, region: 'us-east-1', client: ok }).delete(
      'abc',
    );
    const [command] = ok.send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(DeleteUserPoolClientCommand);
    const gone = { send: () => Promise.reject(notFound()) };
    await expect(
      new AwsCognitoClients({ userPoolId: POOL, region: 'us-east-1', client: gone }).delete('abc'),
    ).resolves.toBeUndefined();
    const denied = { send: () => Promise.reject(new Error('AccessDeniedException')) };
    await expect(
      new AwsCognitoClients({ userPoolId: POOL, region: 'us-east-1', client: denied }).delete(
        'abc',
      ),
    ).rejects.toThrow();
  });

  it('describes a client, or null when there is none', async () => {
    const found = stub(() => ({ UserPoolClient: { ClientId: 'abc', AllowedOAuthScopes: [READ] } }));
    expect(
      await new AwsCognitoClients({
        userPoolId: POOL,
        region: 'us-east-1',
        client: found,
      }).describe('abc'),
    ).toEqual({
      clientId: 'abc',
      scopes: [READ],
    });
    const gone = { send: () => Promise.reject(notFound()) };
    expect(
      await new AwsCognitoClients({ userPoolId: POOL, region: 'us-east-1', client: gone }).describe(
        'abc',
      ),
    ).toBeNull();
  });

  it('is available only when the resource server has both scopes and the role may read it', async () => {
    const both = stub((command) => {
      expect(command).toBeInstanceOf(DescribeResourceServerCommand);
      return {
        ResourceServer: {
          Scopes: [
            { ScopeName: 'mcp' },
            { ScopeName: 'atf.read-specs' },
            { ScopeName: 'atf.write-results' },
          ],
        },
      };
    });
    expect(
      await new AwsCognitoClients({
        userPoolId: POOL,
        region: 'us-east-1',
        client: both,
      }).unavailableReason(),
    ).toBeNull();
    const missing = stub(() => ({ ResourceServer: { Scopes: [{ ScopeName: 'mcp' }] } }));
    expect(
      await new AwsCognitoClients({
        userPoolId: POOL,
        region: 'us-east-1',
        client: missing,
      }).unavailableReason(),
    ).toMatch(/auth stack/);
    const denied = {
      send: () =>
        Promise.reject(Object.assign(new Error('not allowed'), { name: 'AccessDeniedException' })),
    };
    expect(
      await new AwsCognitoClients({
        userPoolId: POOL,
        region: 'us-east-1',
        client: denied,
      }).unavailableReason(),
    ).toMatch(/host stack/);
    const absent = { send: () => Promise.reject(notFound()) };
    expect(
      await new AwsCognitoClients({
        userPoolId: POOL,
        region: 'us-east-1',
        client: absent,
      }).unavailableReason(),
    ).toMatch(/resource server/);
  });
});
