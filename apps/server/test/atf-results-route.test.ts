import { createHash } from 'node:crypto';
import {
  AtfRunnerService,
  IntegrationTokenService,
  InboxService,
  TestRunService,
} from '@slop/core';
import type { AtfRunner, Board, Deploy, Glob } from '@slop/core';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRunnerAuthenticator } from '../src/atf-auth.js';
import type { RunnerVerifier } from '../src/atf-auth.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountAtfResults } from '../src/http/atf-results.js';
import { mountAtfRunners } from '../src/http/atf-runners.js';
import { mountIntegrations } from '../src/http/integrations.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const D1 = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const GH_ISSUER = 'https://token.actions.githubusercontent.com';

const glob = (id: string, boardId: number): Glob => ({
  id,
  boardId,
  title: id,
  type: 'super',
  category: 'feature',
  group: null,
  environment: 'dev1',
  status: 'reviewing',
  version: 1,
  generation: 1,
  creator: ADMIN,
  planner: ADMIN,
  implementer: ADMIN,
  labels: {},
  checklists: {},
  pr: { number: 7, state: 'ready', headSha: D1 },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: '2026-10-05T12:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  signedOffAt: null,
  doingSince: '2026-10-05T12:00:00.000Z',
});

/** A succeeded branch deploy of the glob's head commit. */
const deployOf = (globId: string, boardId: number, id: string, environment: string): Deploy => ({
  id,
  boardId,
  environment,
  globId,
  sha: D1,
  state: 'succeeded',
  trigger: 'push',
  requestedBy: null,
  requestedAt: '2026-10-05T12:00:00.000Z',
  runningSince: '2026-10-05T12:00:00.000Z',
  startedAt: '2026-10-05T12:00:00.000Z',
  finishedAt: '2026-10-05T12:05:00.000Z',
  providerRef: null,
  url: null,
  error: null,
});

/** A bearer `oidc:<runner id>` is that runner, standing in for the identity verifiers of later parts. */
const fakeOidc: RunnerVerifier = (boardId, bearer) => {
  const [kind, id] = bearer.split(':');
  const runnerId = Number(id);
  if (kind !== 'oidc' || !Number.isSafeInteger(runnerId)) return Promise.resolve(null);
  return Promise.resolve({ runnerId, boardId, name: 'fake', method: 'oidc', environments: null });
};

const runRows = z.array(
  z.object({
    runner_id: z.number().nullable(),
    event_id: z.string(),
    board_id: z.number(),
    glob_id: z.string().nullable(),
    environment: z.string().nullable(),
    passed: z.number(),
    failed: z.number(),
  }),
);
const specRows = z.array(z.object({ spec: z.string(), status: z.string() }));
const view = z.object({ value: z.looseObject({ id: z.number(), name: z.string() }) });

describe('the ATF results endpoint and the runner registry routes', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let runners: AtfRunnerService;
  let board: Board;
  let other: Board;
  let legacyToken = '';
  let otherLegacyToken = '';
  const clock = Date.parse('2026-10-05T13:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const logs: string[] = [];

  const register = async (
    name: string,
    boardId = board.id,
    environments = ['staging'],
  ): Promise<AtfRunner> => {
    const created = await runners.create(ADMIN, boardId, {
      name,
      method: 'oidc',
      config: { issuer: GH_ISSUER, claims: { repository: ['acme/app'] } },
      environments,
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };

  const report = (patch: Record<string, unknown> = {}) => ({
    environment: 'staging',
    sha: D1,
    passed: 5,
    failed: 1,
    skipped: 2,
    url: 'https://ci.example.com/1',
    ...patch,
  });
  const post = (
    bearer: string | null,
    body: unknown,
    headers: Record<string, string> = {},
    boardId = board.id,
  ) =>
    app.request(`/integrations/boards/${String(boardId)}/atf-results`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const asRunner = (runner: AtfRunner) => `oidc:${String(runner.id)}`;
  const runs = async () =>
    runRows.parse(
      await database.db.execute(
        sql`select runner_id::int as runner_id, event_id, board_id, glob_id, environment, passed, failed from test_runs order by id`,
      ),
    );

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('atf_results'));
    store = new PgStore(database.db);
    const notifier = { publish: () => undefined };
    const clockPort = { now };
    const tokens = new IntegrationTokenService({
      store,
      clock: clockPort,
      newSecret: () => `slopit_${Math.random().toString(36).slice(2)}${Date.now()}`,
      hashSecret: (secret) => createHash('sha256').update(secret).digest('hex'),
    });
    runners = new AtfRunnerService({ store, clock: clockPort });
    const authenticate = createRunnerAuthenticator({
      store,
      tokens,
      verifiers: [fakeOidc],
      log: (task, message) => logs.push(`${task}: ${message}`),
    });
    const testRuns = new TestRunService({ store, notifier, clock: clockPort });
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? ADMIN);
      await next();
    });
    mountAtfResults(app, {
      testRuns,
      runners,
      authenticate,
      log: (task, message) => logs.push(`${task}: ${message}`),
    });
    mountAtfRunners(app, { runners });
    mountIntegrations(app, {
      inbox: new InboxService({ store, clock: clockPort, notifier }),
      tokens,
    });
    const makeBoard = (name: string, repo: string): Promise<Board> =>
      store.transaction(async (tx) => {
        const inserted = await tx.insertBoard({
          name,
          repo,
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [
            { name: 'dev1', allowBranchDeploy: true },
            { name: 'staging', allowBranchDeploy: true },
            { name: 'prod', allowBranchDeploy: true },
          ],
          sensitivePaths: [],
        });
        await tx.upsertMember({ boardId: inserted.id, email: ADMIN, role: 'admin' });
        await tx.upsertMember({ boardId: inserted.id, email: DEV, role: 'dev' });
        return inserted;
      });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
    });
    board = await makeBoard('sandbox', 'acme/sandbox');
    other = await makeBoard('other', 'acme/other');
    await store.transaction(async (tx) => {
      await tx.insertGlob(glob('s9f1', board.id), null);
      await tx.insertGlob(glob('s8f1', other.id), null);
      // An environment run belongs to the glob whose branch deploy put its commit there.
      await tx.saveDeploys([deployOf('s9f1', board.id, 'd-staging', 'staging'), deployOf('s8f1', other.id, 'd-other', 'staging')]);
    });
    const created = await tokens.create(ADMIN, board.id);
    legacyToken = created.ok ? created.value.token : '';
    const createdOther = await tokens.create(ADMIN, other.id);
    otherLegacyToken = createdOther.ok ? createdOther.value.token : '';
  });

  afterAll(async () => {
    await drop();
  });

  describe('POST /integrations/boards/:b/atf-results', () => {
    it('records a runner’s report against the runner, with its per-spec rows, and notes last seen and last result', async () => {
      const runner = await register('GitHub Actions');
      const answer = await post(
        asRunner(runner),
        report({
          specs: [
            { file: 'e2e/a.spec.ts', status: 'passed', tests: 3 },
            { file: 'e2e/b.spec.ts', status: 'failed', tests: 2, failed: 1 },
          ],
        }),
        { 'idempotency-key': 'build-1' },
      );
      expect(answer.status).toBe(201);
      expect(answer.headers.get('deprecation')).toBeNull();
      expect(await answer.json()).toEqual({ status: 'recorded' });
      expect(await runs()).toEqual([
        expect.objectContaining({
          runner_id: runner.id,
          event_id: `runner:${String(runner.id)}:build-1`,
          board_id: board.id,
          environment: 'staging',
          passed: 5,
          failed: 1,
        }),
      ]);
      const specs = specRows.parse(
        await database.db.execute(sql`select spec, status from test_run_specs order by spec`),
      );
      expect(specs).toEqual([
        { spec: 'e2e/a.spec.ts', status: 'passed' },
        { spec: 'e2e/b.spec.ts', status: 'failed' },
      ]);
      const stored = await store.transaction((tx) => tx.getAtfRunner(board.id, runner.id));
      expect(stored?.lastSeenAt).toBe(now());
      expect(stored?.lastResultAt).toBe(now());
    });

    it('records a redelivery once, by Idempotency-Key, or by runner, commit, environment and counts without one', async () => {
      const runner = await register('Redelivery');
      const before = (await runs()).length;
      expect(
        (await post(asRunner(runner), report({ passed: 9 }), { 'idempotency-key': 'k1' })).status,
      ).toBe(201);
      const again = await post(asRunner(runner), report({ passed: 9 }), {
        'idempotency-key': 'k1',
      });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ status: 'ignored' });
      expect(
        (await post(asRunner(runner), report({ passed: 9 }), { 'idempotency-key': 'k2' })).status,
      ).toBe(201);
      expect((await post(asRunner(runner), report({ passed: 11 }))).status).toBe(201);
      expect((await post(asRunner(runner), report({ passed: 11 }))).status).toBe(200);
      expect((await runs()).length - before).toBe(3);
    });

    it('keeps two runners’ identical reports apart', async () => {
      const a = await register('Twin A');
      const b = await register('Twin B');
      expect(
        (await post(asRunner(a), report({ passed: 77 }), { 'idempotency-key': 'same' })).status,
      ).toBe(201);
      expect(
        (await post(asRunner(b), report({ passed: 77 }), { 'idempotency-key': 'same' })).status,
      ).toBe(201);
      const mine = (await runs()).filter((r) => r.passed === 77);
      expect(mine.map((r) => r.runner_id).sort()).toEqual([a.id, b.id].sort());
    });

    it('refuses with a plain 401 an unknown credential, no credential, another board’s runner, and a disabled or revoked runner', async () => {
      const runner = await register('Refused');
      const plain = { code: 'unauthenticated', message: 'Unauthenticated' };
      for (const bearer of [null, 'slopit_wrong', 'oidc:99999', 'garbage']) {
        const refused = await post(bearer, report());
        expect(refused.status).toBe(401);
        expect(await refused.json()).toEqual(plain);
      }
      const theirs = await register('Theirs', other.id);
      expect((await post(asRunner(theirs), report())).status).toBe(401);
      expect((await post(asRunner(runner), report(), {}, other.id)).status).toBe(401);
      expect((await post(legacyToken, report(), {}, other.id)).status).toBe(401);
      expect((await post(otherLegacyToken, report())).status).toBe(401);
      await runners.update(ADMIN, board.id, runner.id, { enabled: false });
      expect((await post(asRunner(runner), report())).status).toBe(401);
      await runners.update(ADMIN, board.id, runner.id, { enabled: true });
      expect((await post(asRunner(runner), report({ passed: 1234 }))).status).toBe(201);
      await runners.revoke(ADMIN, board.id, runner.id);
      expect((await post(asRunner(runner), report({ passed: 1235 }))).status).toBe(401);
      // Another runner of the board is untouched by it.
      const alive = await register('Still alive');
      expect((await post(asRunner(alive), report({ passed: 1236 }))).status).toBe(201);
    });

    it('answers 403 for an environment outside the runner’s list, and takes a branch run with none', async () => {
      const runner = await register('Staging only', board.id, ['staging']);
      const refused = await post(asRunner(runner), report({ environment: 'prod' }));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'forbidden' });
      const before = (await runs()).length;
      const branch = await post(asRunner(runner), {
        branch: 's9f1',
        sha: D1,
        passed: 3,
        failed: 0,
      });
      expect(branch.status).toBe(201);
      expect(await runs()).toHaveLength(before + 1);
      expect((await runs()).at(-1)).toMatchObject({ glob_id: 's9f1', runner_id: runner.id });
    });

    it('records on the credential’s board only: another board’s glob and the repo named in the body don’t matter', async () => {
      const runner = await register('Scoped');
      const before = (await runs()).length;
      const foreign = await post(asRunner(runner), {
        branch: 's8f1',
        sha: D1,
        passed: 1,
        failed: 0,
      });
      expect(foreign.status).toBe(200);
      expect(await foreign.json()).toEqual({ status: 'ignored' });
      const wrongRepo = await post(asRunner(runner), report({ repo: 'acme/other', passed: 4321 }));
      expect(wrongRepo.status).toBe(201);
      const recorded = (await runs()).slice(before);
      expect(recorded).toEqual([expect.objectContaining({ board_id: board.id, passed: 4321 })]);
    });

    it('ignores an environment with no branch deploy of the commit, as not an error for the pipeline', async () => {
      const runner = await register('Undeployed');
      // Nothing was deployed to dev1: the run has no glob to belong to.
      await store.transaction((tx) =>
        tx.updateAtfRunner(board.id, runner.id, { environments: ['dev1'] }),
      );
      const before = (await runs()).length;
      const answer = await post(asRunner(runner), report({ environment: 'dev1', passed: 31 }));
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ status: 'ignored' });
      expect(await runs()).toHaveLength(before);
    });

    it('answers 413 for an oversized body and 422 for a bad shape', async () => {
      const runner = await register('Shapes');
      const big = await post(
        asRunner(runner),
        report({ specs: [{ file: 'x'.repeat(300 * 1024), status: 'passed' }] }),
      );
      expect(big.status).toBe(413);
      for (const body of [
        { environment: 'staging', sha: D1, failed: 0 },
        { passed: 1, failed: 0 },
        { ...report(), passed: -1 },
        { ...report(), sha: 'xyz' },
        { ...report(), url: 'http://insecure.example.com' },
        'not json',
        '[]',
      ]) {
        const bad = await post(asRunner(runner), body);
        expect(bad.status, JSON.stringify(body)).toBe(422);
      }
      expect(
        (await post(asRunner(runner), report(), { 'idempotency-key': 'x'.repeat(201) })).status,
      ).toBe(422);
    });

    it('loses only the rows when per-spec rows are malformed, like the EventBridge door', async () => {
      const runner = await register('Rows');
      const before = (await runs()).length;
      const answer = await post(
        asRunner(runner),
        report({ passed: 6001, specs: [{ file: 'x', status: 'exploded' }] }),
      );
      expect(answer.status).toBe(201);
      expect((await runs()).length).toBe(before + 1);
    });

    it('still takes the board’s integration token, deprecated: recorded as the legacy runner, with a Deprecation header', async () => {
      const before = (await runs()).length;
      const answer = await post(legacyToken, report({ passed: 8001 }), {
        'idempotency-key': 'legacy-1',
      });
      expect(answer.status).toBe(201);
      expect(answer.headers.get('deprecation')).toBe('true');
      expect(answer.headers.get('link')).toContain('rel="deprecation"');
      const recorded = (await runs()).slice(before);
      expect(recorded).toEqual([
        expect.objectContaining({
          runner_id: null,
          event_id: 'runner:legacy:legacy-1',
          board_id: board.id,
          passed: 8001,
        }),
      ]);
      expect(
        (await post(legacyToken, report({ passed: 8001 }), { 'idempotency-key': 'legacy-1' }))
          .status,
      ).toBe(200);
    });

    it('never logs a credential', () => {
      expect(logs.some((l) => l.includes(legacyToken) || l.includes('oidc:'))).toBe(false);
    });
  });

  describe('the inbox door', () => {
    const inbox = (bearer: string, boardId = board.id) =>
      app.request(`/integrations/boards/${String(boardId)}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          source: 'meet',
          sourceRef: `ref-${bearer}`,
          text: 'Weekly sync notes about the websocket move.',
        }),
      });

    it('refuses a runner credential, and keeps taking the integration token', async () => {
      const runner = await register('Not for notes');
      expect((await inbox(asRunner(runner))).status).toBe(401);
      expect((await inbox(legacyToken)).status).toBe(201);
    });

    it('is not affected by revoking a runner, and revoking the runners leaves the token usable', async () => {
      const runner = await register('Revoked for notes');
      await runners.revoke(ADMIN, board.id, runner.id);
      expect((await inbox(legacyToken)).status).toBe(200);
    });
  });

  describe('/api/boards/:b/atf-runners', () => {
    const api = (method: string, path: string, email: string, body?: unknown) =>
      app.request(`/api/boards/${String(board.id)}/atf-runners${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-email': email },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const ghConfig = { issuer: GH_ISSUER, claims: { repository: ['acme/app'] } };

    it('lets a board admin register, list, rename, disable and revoke, and refuses everyone else', async () => {
      const created = await api('POST', '', ADMIN, {
        name: 'Via API',
        method: 'oidc',
        config: ghConfig,
        environments: ['staging'],
      });
      expect(created.status).toBe(201);
      const id = view.parse(await created.json()).value.id;
      expect((await api('GET', '', ADMIN)).status).toBe(200);
      const listed = z
        .object({ value: z.array(z.looseObject({ id: z.number() })) })
        .parse(await (await api('GET', '', ADMIN)).json());
      expect(listed.value.some((r) => r.id === id)).toBe(true);
      const renamed = await api('PATCH', `/${String(id)}`, ADMIN, {
        name: 'Via API 2',
        enabled: false,
      });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({
        value: { name: 'Via API 2', enabled: false, method: 'oidc' },
      });
      expect((await api('DELETE', `/${String(id)}`, ADMIN)).status).toBe(200);
      for (const [method, path, body] of [
        ['GET', '', undefined],
        ['POST', '', { name: 'x', method: 'oidc', config: ghConfig, environments: ['staging'] }],
        ['PATCH', `/${String(id)}`, { enabled: true }],
        ['DELETE', `/${String(id)}`, undefined],
      ] as const) {
        expect((await api(method, path, DEV, body)).status, method).toBe(403);
      }
    });

    it('validates the body and the registry rules with 422', async () => {
      expect(
        (
          await api('POST', '', ADMIN, {
            name: 'No pin',
            method: 'oidc',
            config: { issuer: GH_ISSUER, claims: { ref: ['refs/heads/main'] } },
            environments: ['staging'],
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await api('POST', '', ADMIN, {
            name: 'Unknown env',
            method: 'oidc',
            config: ghConfig,
            environments: ['nowhere'],
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await api('POST', '', ADMIN, {
            name: 'Bad method',
            method: 'password',
            environments: ['staging'],
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await api('POST', '', ADMIN, {
            name: 'Stray key',
            method: 'oidc',
            config: { ...ghConfig, secret: 'x' },
            environments: ['staging'],
          })
        ).status,
      ).toBe(422);
      const first = await api('POST', '', ADMIN, {
        name: 'Taken name',
        method: 'oidc',
        config: ghConfig,
        environments: ['staging'],
      });
      expect(first.status).toBe(201);
      expect(
        (
          await api('POST', '', ADMIN, {
            name: 'taken NAME',
            method: 'oidc',
            config: ghConfig,
            environments: ['staging'],
          })
        ).status,
      ).toBe(422);
      expect((await api('PATCH', '/abc', ADMIN, {})).status).toBe(422);
      expect((await api('PATCH', '/999999', ADMIN, { enabled: false })).status).toBe(404);
    });
  });
});
