import { createHash } from 'node:crypto';
import {
  ArtifactService,
  AtfRunnerService,
  BoardService,
  DeployService,
  IntegrationTokenService,
  TestRunService,
} from '@slop/core';
import type { AtfCredentialMethod, AtfRunner, Board, Deploy, Glob } from '@slop/core';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRunnerAuthenticator } from '../src/atf-auth.js';
import type { ResolvedRunner, RunnerVerifier } from '../src/atf-auth.js';
import { PgStore } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountAtfSpecs } from '../src/http/atf-specs.js';
import { mountDeploys } from '../src/http/deploys.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const STRANGER = 'stranger@example.com';
const KEY = 'test-aws-key';
const D1 = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const D2 = 'b1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const D3 = 'c1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

const glob = (id: string, boardId: number): Glob => ({
  id,
  boardId,
  title: id,
  type: 'super',
  category: 'feature',
  group: null,
  environment: null,
  status: 'reviewing',
  version: 1,
  generation: 1,
  creator: DEV,
  planner: DEV,
  implementer: DEV,
  labels: {},
  checklists: {},
  pr: null,
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

const plan = (specs: string[], grep?: string): string =>
  `| Name | Status | Location | Description |\n|---|---|---|---|\n\n\`\`\`atf-specs\nspecs:\n${specs.map((s) => `  - ${s}`).join('\n')}\n${grep === undefined ? '' : `grep: "${grep}"\n`}\`\`\`\n`;

/** Stands in for the OIDC, AWS and Cognito verifiers of later parts: a bearer `<method>:<runner id>` names that runner. */
const fakeVerifier =
  (method: AtfCredentialMethod): RunnerVerifier =>
  (boardId, bearer): Promise<ResolvedRunner | null> => {
    const [kind, id] = bearer.split(':');
    const runnerId = Number(id);
    if (kind !== method || !Number.isSafeInteger(runnerId)) return Promise.resolve(null);
    return Promise.resolve({ runnerId, boardId, name: 'fake', method, environments: null });
  };

const readyBody = z.object({
  status: z.literal('ready'),
  environment: z.string(),
  sha: z.string(),
  specs: z.array(z.object({ spec: z.string(), globs: z.array(z.string()) })),
  greps: z.array(z.object({ grep: z.string(), globs: z.array(z.string()) })),
});

describe('the ATF spec list endpoint', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let testRuns: TestRunService;
  let artifacts: ArtifactService;
  let board: Board;
  let other: Board;
  let runners: AtfRunnerService;
  const logs: string[] = [];
  let token = '';
  let otherToken = '';
  let clock = Date.parse('2026-10-05T13:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const tick = (): void => {
    clock += 60_000;
  };

  beforeAll(async () => {
    const test = await createTestDatabase('atf_specs_route');
    drop = test.drop;
    store = new PgStore(test.database.db);
    const notifier = { publish: () => undefined };
    const clockPort = { now };
    testRuns = new TestRunService({ store, notifier, clock: clockPort });
    artifacts = new ArtifactService({ store, clock: clockPort, notifier });
    const boards = new BoardService({ store, notifier });
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
      verifiers: [fakeVerifier('oidc'), fakeVerifier('aws_iam'), fakeVerifier('client_credentials')],
      log: (task, message) => logs.push(`${task}: ${message}`),
    });
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? DEV);
      await next();
    });
    mountDeploys(app, {
      deploys: new DeployService({
        store,
        notifier,
        clock: clockPort,
        newDeployId: () => `dep-${String(clock)}`,
      }),
      testRuns,
      boards,
      links: new SignedLinks('test-secret'),
      awsWebhookKeys: [KEY],
      log: () => undefined,
    });
    mountAtfSpecs(app, { testRuns, boards, authenticate, runners, log: (task, message) => logs.push(`${task}: ${message}`) });
    const makeBoard = async (name: string, repo: string): Promise<Board> =>
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
          ],
          sensitivePaths: [],
        });
        await tx.upsertMember({ boardId: inserted.id, email: DEV, role: 'admin' });
        return inserted;
      });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: STRANGER, name: 'Stranger', active: true });
    });
    board = await makeBoard('sandbox', 'acme/sandbox');
    other = await makeBoard('other', 'acme/other');
    await store.transaction(async (tx) => {
      for (const id of ['s9f1', 's9f2']) await tx.insertGlob(glob(id, board.id), null);
      await tx.insertGlob(glob('s8f1', other.id), null);
    });
    await artifacts.putTestPlan(DEV, 's9f1', plan(['e2e/a.spec.ts', 'e2e/b.spec.ts']));
    await artifacts.putTestPlan(DEV, 's9f2', plan(['e2e/b.spec.ts', 'e2e/c.spec.ts'], '@smoke'));
    await artifacts.putTestPlan(DEV, 's8f1', plan(['e2e/secret.spec.ts']));
    const created = await tokens.create(DEV, board.id);
    token = created.ok ? created.value.token : '';
    const createdOther = await tokens.create(DEV, other.id);
    otherToken = createdOther.ok ? createdOther.value.token : '';
  });

  afterAll(async () => {
    await drop();
  });

  /** A branch deploy of a glob's commit to staging, in the given state, requested at `time`. */
  const deploy = (id: string, globId: string, sha: string, time: string, state: Deploy['state'] = 'succeeded') =>
    store.transaction((tx) =>
      tx.saveDeploys([
        {
          id,
          boardId: board.id,
          environment: 'staging',
          globId,
          sha,
          state,
          trigger: 'push',
          requestedBy: null,
          requestedAt: new Date(time).toISOString(),
          runningSince: new Date(time).toISOString(),
          startedAt: new Date(time).toISOString(),
          finishedAt: state === 'succeeded' ? new Date(time).toISOString() : null,
          providerRef: null,
          url: null,
          error: null,
        },
      ]),
    );

  const query = (sha: string, environment = 'staging') => `environment=${environment}&sha=${sha}`;
  const viaApi = (sha: string, email = DEV, environment = 'staging') =>
    app.request(`/api/boards/${String(board.id)}/atf-specs?${query(sha, environment)}`, {
      headers: { 'x-test-email': email },
    });
  const viaToken = (sha: string, bearer = token, boardId = board.id) =>
    app.request(`/integrations/boards/${String(boardId)}/atf-specs?${query(sha)}`, {
      headers: bearer === '' ? {} : { authorization: `Bearer ${bearer}` },
    });

  it('is pending until the branch deploy has succeeded, then returns the deployed glob’s specs, and the same list again', async () => {
    const early = await viaApi(D1);
    expect(early.status).toBe(202);
    expect(await early.json()).toEqual({ status: 'pending', retryAfterSeconds: 15 });
    expect(early.headers.get('retry-after')).toBe('15');

    await deploy('dep-1', 's9f2', D1, '2026-10-05T12:30:00Z', 'running');
    expect((await viaApi(D1)).status).toBe(202);
    tick();
    await deploy('dep-1', 's9f2', D1, '2026-10-05T12:30:00Z');
    const first = await viaApi(D1);
    expect(first.status).toBe(200);
    const body = readyBody.parse(await first.json());
    expect(body).toMatchObject({
      environment: 'staging',
      sha: D1,
      specs: [
        { spec: 'e2e/b.spec.ts', globs: ['s9f2'] },
        { spec: 'e2e/c.spec.ts', globs: ['s9f2'] },
      ],
      greps: [{ grep: '@smoke', globs: ['s9f2'] }],
    });
    // The pipeline asks again (with an abbreviated commit, by token) and gets the same list.
    const second = readyBody.parse(await (await viaToken(D1.slice(0, 10))).json());
    expect(second).toEqual(body);
  });

  it('answers 409 for a commit a newer deploy replaced', async () => {
    await deploy('dep-2', 's9f1', D2, '2026-10-05T14:00:00Z');
    const old = await viaApi(D1);
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ status: 'superseded', latestSha: D2 });
  });

  it('opens to members and to the board’s own token only, and never answers for another board', async () => {
    expect((await viaApi(D2, STRANGER)).status).toBe(403);
    expect((await viaToken(D2, '')).status).toBe(401);
    expect((await viaToken(D2, 'slopit_wrong')).status).toBe(401);
    // Another board's token is refused on this board, and this board's on theirs: no cross-board answers.
    expect((await viaToken(D2, otherToken)).status).toBe(401);
    expect((await viaToken(D2, token, other.id)).status).toBe(401);
    // Their own token reads their own (empty) board: nothing of this board's deploys or plans.
    const theirs = await viaToken(D2, otherToken, other.id);
    expect(theirs.status).toBe(202);
    const mine = await viaToken(D2);
    expect([200, 202]).toContain(mine.status);
    expect(JSON.stringify(await mine.json())).not.toContain('secret.spec');
  });

  it('validates the parameters and the environment', async () => {
    expect((await app.request(`/api/boards/${String(board.id)}/atf-specs`)).status).toBe(422);
    expect((await viaApi('not-a-sha')).status).toBe(422);
    expect((await viaApi('abc')).status).toBe(422);
    expect((await viaApi(D2, DEV, 'x'.repeat(101))).status).toBe(422);
    // An environment the board doesn't have, and a board that isn't there.
    expect((await viaApi(D2, DEV, 'nowhere')).status).toBe(422);
    expect(
      (await app.request('/api/boards/9999/atf-specs?environment=staging&sha=' + D2)).status,
    ).toBe(404);
    expect(
      (await app.request('/api/boards/abc/atf-specs?environment=staging&sha=' + D2)).status,
    ).toBe(422);
  });

  it('takes per-spec results with the report, derives the missing ones and shows each planned spec on its glob', async () => {
    await store.transaction((tx) => tx.insertGlob(glob('s9f3', board.id), null));
    await artifacts.putTestPlan(DEV, 's9f3', plan(['e2e/z.spec.ts']));
    await deploy('dep-3', 's9f3', D3, '2026-10-05T15:00:00Z');
    const batch = readyBody.parse(await (await viaApi(D3)).json());
    expect(batch.specs).toEqual([{ spec: 'e2e/z.spec.ts', globs: ['s9f3'] }]);

    const report = (id: string, specs: unknown) =>
      app.request('/webhooks/aws', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-slop-key': KEY },
        body: JSON.stringify({
          id,
          'detail-type': 'Slop ATF Completed',
          source: 'slop.ci',
          detail: {
            repo: 'acme/sandbox',
            environment: 'staging',
            sha: D3,
            passed: 2,
            failed: 0,
            specs,
          },
        }),
      });
    // Rows the schema doesn't know lose only the rows: the run's counts are still recorded, never an error for the pipeline.
    const bad = await report('atf-bad', [{ file: 'x', status: 'exploded' }]);
    expect(bad.status).toBe(202);
    expect(await bad.json()).not.toEqual({ ok: true, ignored: true });
    const huge = await report(
      'atf-huge',
      Array.from({ length: 1001 }, (_, i) => ({ file: `e2e/gen-${String(i)}.spec.ts`, status: 'passed' })),
    );
    expect(await huge.json()).not.toEqual({ ok: true, ignored: true });
    expect(
      (await report('atf-1', [{ file: 'e2e/other.spec.ts', status: 'passed', tests: 2 }])).status,
    ).toBe(202);

    const view = z
      .object({
        value: z.array(
          z.object({
            specs: z.array(z.object({ spec: z.string(), status: z.string() })).optional(),
          }),
        ),
        specs: z.array(z.looseObject({ spec: z.string(), status: z.string().nullable() })),
      })
      .parse(await (await app.request('/api/globs/s9f3/tests')).json());
    expect(view.specs).toEqual([
      expect.objectContaining({
        spec: 'e2e/z.spec.ts',
        status: 'missing',
        url: null,
        environment: 'staging',
        sha: D3,
      }),
    ]);
    expect(view.value[0]?.specs?.map((r) => [r.spec, r.status])).toEqual([
      ['e2e/z.spec.ts', 'missing'],
      ['e2e/other.spec.ts', 'passed'],
    ]);
    expect(
      (await app.request('/api/globs/s9f3/tests', { headers: { 'x-test-email': STRANGER } }))
        .status,
    ).toBe(403);
  });

  describe('with runner credentials', () => {
    const register = async (name: string, method: AtfRunner['method'], environments: string[], boardId = board.id): Promise<AtfRunner> => {
      const created = await runners.create(DEV, boardId, {
        name,
        method,
        config: method === 'oidc' ? { issuer: 'https://ci.example.com', claims: { project: ['p'] } } : method === 'aws_iam' ? { roleArns: ['arn:aws:iam::123456789012:role/atf'] } : {},
        environments,
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.value;
    };
    const as = (method: string, runner: AtfRunner, sha = D3, boardId = board.id) =>
      app.request(`/integrations/boards/${String(boardId)}/atf-specs?${query(sha)}`, {
        headers: { authorization: `Bearer ${method}:${String(runner.id)}` },
      });

    it('answers every method alike, with the same 200, 202 and 409 as the legacy token and no Deprecation header', async () => {
      const oidc = await register('GH', 'oidc', ['staging']);
      const aws = await register('CB', 'aws_iam', ['staging']);
      const client = await register('Vendor', 'client_credentials', ['staging']);
      for (const [method, runner] of [['oidc', oidc], ['aws_iam', aws], ['client_credentials', client]] as const) {
        const answer = await as(method, runner);
        expect(answer.status).toBe(200);
        expect(answer.headers.get('deprecation')).toBeNull();
        expect(readyBody.parse(await answer.json()).sha).toBe(D3);
      }
      expect((await as('oidc', oidc, D1)).status).toBe(409);
      expect((await as('oidc', oidc, 'e1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0')).status).toBe(202);
    });

    it('notes when a runner was last seen', async () => {
      const runner = await register('Seen', 'oidc', ['staging']);
      expect(runner.lastSeenAt).toBeNull();
      await as('oidc', runner);
      const stored = await store.transaction((tx) => tx.getAtfRunner(board.id, runner.id));
      expect(stored?.lastSeenAt).toBe(now());
    });

    it('refuses a disabled or revoked runner, another board’s runner, and a credential of the wrong kind, all with the same plain 401', async () => {
      const runner = await register('Off', 'oidc', ['staging']);
      await runners.update(DEV, board.id, runner.id, { enabled: false });
      const disabled = await as('oidc', runner);
      expect(disabled.status).toBe(401);
      expect(await disabled.json()).toEqual({ code: 'unauthenticated', message: 'Unauthenticated' });
      await runners.update(DEV, board.id, runner.id, { enabled: true });
      expect((await as('oidc', runner)).status).toBe(200);
      await runners.revoke(DEV, board.id, runner.id);
      expect((await as('oidc', runner)).status).toBe(401);
      // A runner of the other board, presented on this board (and on its own board's URL for this board's runner).
      const theirs = await register('Theirs', 'oidc', ['staging'], other.id);
      expect((await as('oidc', theirs)).status).toBe(401);
      const mine = await register('Mine', 'oidc', ['staging']);
      expect((await as('oidc', mine, D3, other.id)).status).toBe(401);
      // The method must match the registered runner's.
      expect((await as('aws_iam', mine)).status).toBe(401);
    });

    it('refuses an environment the runner does not serve with 403', async () => {
      const serving = await register('Serving', 'oidc', ['staging']);
      const narrow = await register('Narrow', 'client_credentials', ['staging']);
      // The registry won't save an empty list, but a list narrowed after the fact must still hold at the door.
      await store.transaction((tx) => tx.updateAtfRunner(board.id, narrow.id, { environments: [] }));
      const get = (bearer: string) => app.request(`/integrations/boards/${String(board.id)}/atf-specs?${query(D3)}`, { headers: { authorization: `Bearer ${bearer}` } });
      expect((await get(`client_credentials:${String(narrow.id)}`)).status).toBe(403);
      expect((await get(`oidc:${String(serving.id)}`)).status).toBe(200);
    });

    it('refuses a credential that two verifiers resolve to different runners', async () => {
      const a = await register('A', 'oidc', ['staging']);
      const b = await register('B', 'oidc', ['staging']);
      const both: RunnerVerifier[] = [
        (boardId) => Promise.resolve({ runnerId: a.id, boardId, name: a.name, method: 'oidc', environments: null }),
        (boardId) => Promise.resolve({ runnerId: b.id, boardId, name: b.name, method: 'oidc', environments: null }),
      ];
      const ambiguous = createRunnerAuthenticator({ store, tokens: { authenticate: () => Promise.resolve({ ok: false, error: { code: 'forbidden', message: 'no' } }) }, verifiers: both, log: () => undefined });
      expect(await ambiguous(board.id, 'anything')).toBeNull();
      const one = createRunnerAuthenticator({ store, tokens: { authenticate: () => Promise.resolve({ ok: false, error: { code: 'forbidden', message: 'no' } }) }, verifiers: [both[0] ?? fakeVerifier('oidc')], log: () => undefined });
      expect(await one(board.id, 'anything')).toMatchObject({ runnerId: a.id, name: 'A', method: 'oidc', environments: ['staging'] });
    });

    it('tells a pipeline on the legacy token to move, and logs the use by board without the token', async () => {
      const used = () => logs.filter((l) => l.startsWith(`atf legacy token: Board ${String(board.id)} `)).length;
      const before = used();
      const answer = await viaToken(D3);
      expect(answer.headers.get('deprecation')).toBe('true');
      expect(answer.headers.get('link')).toContain('rel="deprecation"');
      expect(answer.headers.get('link')).toContain('catalog/scripts/README.md');
      // Logged at most once an hour per board: the earlier tests' calls already logged this board's use.
      expect(used()).toBe(before);
      expect(before).toBe(1);
      // Neither tokens nor credentials ever reach a log line.
      expect(logs.some((l) => l.includes(token) || l.includes('oidc:'))).toBe(false);
    });

    it('keeps the legacy 401s plain too', async () => {
      const refused = await viaToken(D3, 'slopit_wrong');
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ code: 'unauthenticated', message: 'Unauthenticated' });
      expect(refused.headers.get('deprecation')).toBeNull();
    });
  });
});

