import { createHash } from 'node:crypto';
import {
  ArtifactService,
  BoardService,
  DeployService,
  EnvironmentService,
  IntegrationTokenService,
  TestRunService,
} from '@slop/core';
import type { Board, Glob } from '@slop/core';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
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

const readyBody = z.object({
  status: z.literal('ready'),
  environment: z.string(),
  sha: z.string(),
  specs: z.array(z.object({ spec: z.string(), globs: z.array(z.string()) })),
  greps: z.array(z.object({ grep: z.string(), globs: z.array(z.string()) })),
  batchId: z.number(),
});

describe('the ATF spec list endpoint', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let testRuns: TestRunService;
  let environments: EnvironmentService;
  let artifacts: ArtifactService;
  let board: Board;
  let other: Board;
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
    environments = new EnvironmentService({ store, notifier, clock: clockPort });
    testRuns = new TestRunService({ store, notifier, clock: clockPort });
    artifacts = new ArtifactService({ store, clock: clockPort, notifier });
    const boards = new BoardService({ store, notifier });
    const tokens = new IntegrationTokenService({
      store,
      clock: clockPort,
      newSecret: () => `slopit_${Math.random().toString(36).slice(2)}${Date.now()}`,
      hashSecret: (secret) => createHash('sha256').update(secret).digest('hex'),
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
      environments,
      testRuns,
      boards,
      links: new SignedLinks('test-secret'),
      awsWebhookKeys: [KEY],
      log: () => undefined,
    });
    mountAtfSpecs(app, { testRuns, boards, tokens });
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
            { name: 'staging', allowBranchDeploy: false, role: 'integration' },
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

  const deployed = (id: string, sha: string, time: string) =>
    app.request('/webhooks/aws', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slop-key': KEY },
      body: JSON.stringify({
        id,
        'detail-type': 'Slop Environment Deployed',
        source: 'slop.ci',
        time,
        detail: { repo: 'acme/sandbox', environment: 'staging', sha, status: 'succeeded' },
      }),
    });

  const query = (sha: string, environment = 'staging') => `environment=${environment}&sha=${sha}`;
  const viaApi = (sha: string, email = DEV, environment = 'staging') =>
    app.request(`/api/boards/${String(board.id)}/atf-specs?${query(sha, environment)}`, {
      headers: { 'x-test-email': email },
    });
  const viaToken = (sha: string, bearer = token, boardId = board.id) =>
    app.request(`/integrations/boards/${String(boardId)}/atf-specs?${query(sha)}`, {
      headers: bearer === '' ? {} : { authorization: `Bearer ${bearer}` },
    });

  it('is pending until the deploy is reported and checked, then returns the union with its globs, and the same list again', async () => {
    const early = await viaApi(D1);
    expect(early.status).toBe(202);
    expect(await early.json()).toEqual({ status: 'pending', retryAfterSeconds: 15 });
    expect(early.headers.get('retry-after')).toBe('15');

    await deployed('dep-1', D1, '2026-10-05T12:30:00Z');
    expect((await viaApi(D1)).status).toBe(202);
    tick();
    await environments.recordContainment(board.id, 'staging', D1, [
      { globId: 's9f1', mergeSha: 'm1', contained: true },
      { globId: 's9f2', mergeSha: 'm2', contained: true },
    ]);
    const first = await viaApi(D1);
    expect(first.status).toBe(200);
    const body = readyBody.parse(await first.json());
    expect(body).toMatchObject({
      environment: 'staging',
      sha: D1,
      specs: [
        { spec: 'e2e/a.spec.ts', globs: ['s9f1'] },
        { spec: 'e2e/b.spec.ts', globs: ['s9f1', 's9f2'] },
        { spec: 'e2e/c.spec.ts', globs: ['s9f2'] },
      ],
      greps: [{ grep: '@smoke', globs: ['s9f2'] }],
    });
    // The second call (by the pipeline, with an abbreviated commit) is the stored batch.
    const second = readyBody.parse(await (await viaToken(D1.slice(0, 10))).json());
    expect(second).toEqual(body);
  });

  it('answers 409 for a commit a newer deploy replaced', async () => {
    await deployed('dep-2', D2, '2026-10-05T14:00:00Z');
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
    // An environment the board doesn't observe, and a board that isn't there.
    expect((await viaApi(D2, DEV, 'dev1')).status).toBe(422);
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
    await deployed('dep-3', D3, '2026-10-05T15:00:00Z');
    tick();
    await environments.recordContainment(board.id, 'staging', D3, [
      { globId: 's9f3', mergeSha: 'm3', contained: true },
    ]);
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
});
