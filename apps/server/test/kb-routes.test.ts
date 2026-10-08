import {
  ArtifactService,
  BoardService,
  FindingsService,
  GlobService,
  IntakeService,
  KnowledgeService,
  LearningJobService,
  MAX_PROCESSING_ATTEMPTS,
  MiningService,
} from '@slop/core';
import type { BoardJob, BoardJobStatus, Catalog, KbItem, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodeHost } from '../src/codehost.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountKnowledge } from '../src/http/knowledge.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const unused = () => Promise.reject(new Error('not used by the knowledge routes'));

/** The knowledge routes only read `configured` and `connection` (repo connection); nothing here calls them. */
const host: CodeHost = {
  configured: false,
  connection: unused,
  provision: unused,
  openDraftPr: unused,
  syncLabels: unused,
  closePr: unused,
  deleteBranch: unused,
  reopenPr: unused,
  mergeState: unused,
  conflictFiles: unused,
  completedCheckRun: unused,
  readFile: unused,
  listFiles: unused,
  commitFiles: unused,
  commitDiffSummary: unused,
  markReady: unused,
  diffSummary: unused,
  squashMerge: unused,
  headOf: unused,
  commitChecks: unused,
  updateBranch: unused,
  commentOnce: unused,
};

const TS_V2 =
  '---\ncatalog: typescript_conventions\nversion: 2\narea: conventions\ndescription: TS.\n---\nNo any.\nNo casts.\n';

const catalog: Catalog = {
  kbEntries: () =>
    Promise.resolve([
      {
        id: 'typescript_conventions',
        version: 2,
        fileName: 'typescript_conventions.md',
        content: TS_V2,
      },
    ]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

describe('KB routes: retrying failed items and catalog updates', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let knowledge: KnowledgeService;
  let app: Hono<Env>;
  let boardId: number;
  let globId: string;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kb_routes'));
    store = new PgStore(database.db);
    const deps = {
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
    };
    knowledge = new KnowledgeService({ ...deps, catalog });
    const globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? ADMIN);
      await next();
    });
    mountKnowledge(app, {
      knowledge,
      artifacts: new ArtifactService(deps),
      findings: new FindingsService(deps),
      catalog,
      intake: new IntakeService({ store, llm: { complete: unused } }),
      boards: new BoardService(deps),
      host,
      jobs: new LearningJobService({ ...deps, mining: new MiningService(deps), manifests: null }),
      logError: () => undefined,
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      return board.id;
    });
    globId = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Source',
        summary: '',
        type: 'super',
        category: 'feature',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;
  });

  afterAll(async () => {
    await drop();
  });

  const post = (path: string, body: unknown, email = ADMIN) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-email': email },
      body: JSON.stringify(body),
    });

  it('POST /api/kb/:id/retry re-queues a failed item for admins, conditional on its version', async () => {
    const { id } = unwrap(
      await knowledge.submitLearning(DEV, boardId, {
        sourceGlobId: globId,
        type: 'gotcha',
        statement: 'Retry me',
        evidence: 'Seen',
      }),
    );
    await database.db.execute(
      sql`update kb_proposals set processing = 'failed', processing_error = 'Haiku is down', processing_attempts = ${MAX_PROCESSING_ATTEMPTS}, version = 2 where id = ${id}`,
    );
    expect((await post(`/api/kb/${id}/retry`, { version: 2 }, DEV)).status).toBe(403);
    expect((await post(`/api/kb/${id}/retry`, {})).status).toBe(422);
    const stale = await post(`/api/kb/${id}/retry`, { version: 1 });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { currentItem: KbItem }).currentItem.version).toBe(2);

    const response = await post(`/api/kb/${id}/retry`, { version: 2 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id,
      processing: 'pending',
      processingError: null,
      processingAttempts: 0,
      version: 3,
    });
    expect(await store.transaction((tx) => tx.getKbItem(id))).toMatchObject({
      processing: 'pending',
      processingAttempts: 0,
      version: 3,
    });
    // Only failed items: retrying again is refused.
    expect((await post(`/api/kb/${id}/retry`, { version: 3 })).status).toBe(422);
  });

  it('POST /api/kb/:id/reopen sends a covered item back to drafting for admins, conditional on its version', async () => {
    const { id } = unwrap(
      await knowledge.submitLearning(DEV, boardId, { sourceGlobId: globId, type: 'gotcha', statement: 'Reopen me', evidence: 'Seen' }),
    );
    const target = { kind: 'doc', name: 'testing', section: null, newDocument: null };
    const coveredBy = { kind: 'knowledge', knowledgeKind: 'doc', name: 'testing', section: null };
    await database.db.execute(
      sql`update kb_proposals set status = 'covered', processing = 'routed', target = ${JSON.stringify(target)}::jsonb, covered_by = ${JSON.stringify(coveredBy)}::jsonb, version = 2 where id = ${id}`,
    );
    expect((await post(`/api/kb/${id}/reopen`, { version: 2 }, DEV)).status).toBe(403);
    expect((await post(`/api/kb/${id}/reopen`, {})).status).toBe(422);
    expect((await post(`/api/kb/${id}/reopen`, { version: 1 })).status).toBe(409);

    const response = await post(`/api/kb/${id}/reopen`, { version: 2 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, status: 'open', coveredBy: null, processing: 'routed', target, version: 3 });
    expect(await store.transaction((tx) => tx.getKbItem(id))).toMatchObject({ status: 'open', coveredBy: null, processing: 'routed' });
    // Only closed items: reopening an open one is refused.
    expect((await post(`/api/kb/${id}/reopen`, { version: 3 })).status).toBe(422);
  });

  it('GET /api/boards/:b/kb/proposals lists open items and the newest decided ones up to the limit, with totals', async () => {
    const rejected: string[] = [];
    for (const statement of ['Old rule', 'Newer rule']) {
      const { id } = unwrap(await knowledge.submitLearning(DEV, boardId, { sourceGlobId: globId, type: 'gotcha', statement, evidence: 'Seen' }));
      unwrap(await knowledge.reject(ADMIN, id, 1, 'No'));
      rejected.push(id);
    }
    const get = (query: string) => app.request(`/api/boards/${boardId}/kb/proposals${query}`, { headers: { 'x-test-email': DEV } });
    const response = await get('?limit=1');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { open: KbItem[]; decided: { items: KbItem[]; total: number }; closed: { total: number } };
    expect(body.decided.items.map((i) => i.id)).toEqual([rejected[1]]);
    expect(body.decided.total).toBe(2);
    expect(body.open.every((i) => i.status === 'open')).toBe(true);
    expect((await get('')).status).toBe(200);
    expect((await get('?limit=0')).status).toBe(422);
    expect((await get('?limit=1001')).status).toBe(422);

    // Ordered by decision, not submission: the older item decided last leads the page.
    await database.db.execute(sql`update kb_proposals set decided_at = now() + interval '1 hour' where id = ${rejected[0]}`);
    const redecided = (await (await get('?limit=1')).json()) as { decided: { items: KbItem[] } };
    expect(redecided.decided.items.map((i) => i.id)).toEqual([rejected[0]]);
  });

  it('GET /api/boards/:b/kb lists documents forked from an older catalog version', async () => {
    const kb = async () => {
      const response = await app.request(`/api/boards/${String(boardId)}/kb`, {
        headers: { 'x-test-email': DEV },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { catalogUpdates: unknown[] };
    };
    unwrap(await knowledge.importCatalogEntries(ADMIN, boardId, ['typescript_conventions']));
    expect((await kb()).catalogUpdates).toEqual([]);
    await database.db.execute(
      sql`update knowledge set source = 'catalog:typescript_conventions@1', content = ${'No any.\n'} where board_id = ${boardId} and name = 'typescript_conventions'`,
    );
    expect((await kb()).catalogUpdates).toEqual([
      {
        name: 'typescript_conventions',
        catalogId: 'typescript_conventions',
        forkedVersion: 1,
        catalogVersion: 2,
        board: 'No any.\n',
        catalog: 'No any.\nNo casts.\n',
      },
    ]);
  });

  it('GET /api/globs/:id/findings shows members the glob\'s findings and refuses others', async () => {
    const outsider = 'outsider@example.com';
    await store.transaction((tx) => tx.upsertUser({ email: outsider, name: 'Outsider', active: true }));
    const get = (email: string, id = globId) => app.request(`/api/globs/${id}/findings`, { headers: { 'x-test-email': email } });
    const member = await get(DEV);
    expect(member.status).toBe(200);
    expect(await member.json()).toEqual({ findings: [], byClass: [], pending: 0, failed: 0, sources: { pending: 0, failed: 0 }, waiting: null });
    expect((await get(outsider)).status).toBe(403);
    expect((await get(DEV, 's999t1')).status).toBe(404);
  });

  it('POST /api/boards/:b/kb/jobs/:job/run runs mining for admins only, and GET lists the last run', async () => {
    const path = (job: string) => `/api/boards/${String(boardId)}/kb/jobs/${job}/run`;
    expect((await post(path('mining'), {}, DEV)).status).toBe(403);
    expect((await post(path('nonsense'), {})).status).toBe(404);
    expect((await post(path('consolidation'), {})).status).toBe(422);

    // Run now answers 202 with the claimed job and runs it after the response.
    const response = await post(path('mining'), {});
    expect(response.status).toBe(202);
    const job = (await response.json()) as BoardJob;
    expect(job).toMatchObject({ boardId, job: 'mining', lastRunAt: null });
    expect(job.runningUntil).not.toBeNull();

    const listJobs = async () => {
      const listed = await app.request(`/api/boards/${String(boardId)}/kb/jobs`, { headers: { 'x-test-email': DEV } });
      expect(listed.status).toBe(200);
      return (await listed.json()) as BoardJob[];
    };
    await vi.waitFor(async () => {
      const [mining] = await listJobs();
      expect(mining).toMatchObject({ job: 'mining', runningUntil: null, lastResult: { kind: 'mining', raised: [], refreshed: [] } });
      expect(mining?.lastRunAt).not.toBeNull();
    });
    // The lease was released: a second Run now runs again.
    expect((await post(path('mining'), {})).status).toBe(202);
    await vi.waitFor(async () => expect((await listJobs())[0]?.runningUntil).toBeNull());
    expect((await listJobs()).map((j) => j.job)).toEqual(['mining']);
  });

  it('POST /api/boards/:b/kb/jobs/mining/run answers 202 before the run ends, 409 while it runs, and logs a failed run (s15f8)', async () => {
    // A run held in its manifest read: the route must answer without waiting for it. The read then fails.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const deps = { store, notifier: { publish: () => undefined }, clock: { now: () => new Date().toISOString() } };
    const jobs = new LearningJobService({
      ...deps,
      mining: new MiningService(deps),
      manifests: {
        manifestChanges: () =>
          held.then(() => {
            throw new Error('GitHub is down');
          }),
      },
    });
    const logged: [string, string][] = [];
    const heldApp = new Hono<Env>();
    heldApp.use('/api/*', async (c, next) => {
      c.set('email', ADMIN);
      await next();
    });
    mountKnowledge(heldApp, {
      knowledge,
      artifacts: new ArtifactService(deps),
      findings: new FindingsService(deps),
      catalog,
      intake: new IntakeService({ store, llm: { complete: unused } }),
      boards: new BoardService(deps),
      host,
      jobs,
      logError: (task, message) => logged.push([task, message]),
    });
    const heldBoard = await store.transaction(async (tx) => {
      const board = await tx.insertBoard({ name: 'held', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      return board.id;
    });
    const run = () => heldApp.request(`/api/boards/${String(heldBoard)}/kb/jobs/mining/run`, { method: 'POST' });
    const getJobs = async () => (await (await heldApp.request(`/api/boards/${String(heldBoard)}/kb/jobs`)).json()) as BoardJobStatus[];

    const started = await run();
    expect(started.status).toBe(202);
    const claimed = (await started.json()) as BoardJob;
    expect(claimed).toMatchObject({ job: 'mining', lastRunAt: null });
    expect(claimed.runningUntil).not.toBeNull();
    // Still running: the Knowledge page shows it, and a second Run now is refused.
    expect((await getJobs())[0]).toMatchObject({ job: 'mining', lastRunAt: null, runningUntil: claimed.runningUntil, running: true });
    const again = await run();
    expect(again.status).toBe(409);
    expect(logged).toEqual([]);
    release();
    await vi.waitFor(async () =>
      expect((await getJobs())[0]).toMatchObject({ runningUntil: null, running: false, lastResult: { kind: 'failed', error: 'GitHub is down' } }),
    );
    // The failure reaches the server's error log, as the weekly run's do.
    await vi.waitFor(() => expect(logged).toEqual([['mining', `board ${String(heldBoard)}: GitHub is down`]]));
  });
});
