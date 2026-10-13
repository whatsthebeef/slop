import { ArtifactService, BoardService, ContextReportService, ContextTuningService, FindingsService, GlobService, IntakeService, KnowledgeService, LearningJobService, MiningService } from '@slop/core';
import type { ContextReport, Result } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { mountKnowledge } from '../src/http/knowledge.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';
import { fakeCodeHost } from './support/fake-codehost.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOW = '2026-10-12T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const isReport = (body: unknown): body is ContextReport =>
  typeof body === 'object' && body !== null && 'retrievals' in body && 'settings' in body && Array.isArray(body.settings) && 'history' in body;
const reportOf = (body: unknown): ContextReport => {
  if (!isReport(body)) throw new Error('Not a context report');
  return body;
};
const catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

/** The context report and the setting reset routes, and the retrieval counters, on real Postgres. */
describe('Context report in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let boardId: number;
  const notifier = { publish: () => undefined };
  const clock = { now: () => NOW };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('context_report'));
    const { db } = database;
    store = new PgStore(db);
    const deps = { store, notifier, clock };
    const globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const boards = new BoardService(deps);
    const mining = new MiningService(deps);
    const contextTuning = new ContextTuningService(deps);
    app = createApp({
      auth: new Auth(db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub: new HintHub(),
      outbox: new OutboxRunner(db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
    mountKnowledge(app, {
      knowledge: new KnowledgeService({ ...deps, catalog, signals: mining }),
      artifacts: new ArtifactService(deps),
      findings: new FindingsService(deps),
      catalog,
      intake: new IntakeService({ store, llm: { complete: () => Promise.reject(new Error('not used')) } }),
      boards,
      host: fakeCodeHost({ configured: false }),
      jobs: new LearningJobService({ ...deps, mining, contextTuning, manifests: null }),
      contextTuning,
      contextReport: new ContextReportService({ store, clock, tuning: contextTuning }),
      logError: () => undefined,
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  afterAll(async () => {
    await drop();
  });

  const request = (method: string, path: string, email = ADMIN) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer dev:${email}` } });

  it('adds, lists and prunes the retrieval counters per board, day, source type and tier', async () => {
    await store.transaction(async (tx) => {
      await tx.recordContextRetrievals(boardId, '2026-10-11', [{ sourceType: 'decision', tier: 'decision', count: 2 }]);
      await tx.recordContextRetrievals(boardId, '2026-10-11', [
        { sourceType: 'decision', tier: 'decision', count: 3 },
        { sourceType: 'doc', tier: 'discussion', count: 1 },
      ]);
      await tx.recordContextRetrievals(boardId, '2026-07-01', [{ sourceType: 'doc', tier: 'discussion', count: 9 }]);
      await tx.recordContextRetrievals(boardId, '2026-10-11', []);
    });
    const rows = await store.transaction((tx) => tx.listContextRetrievals(boardId, '2026-09-01'));
    expect(rows.sort((a, b) => a.sourceType.localeCompare(b.sourceType))).toEqual([
      { day: '2026-10-11', sourceType: 'decision', tier: 'decision', count: 5 },
      { day: '2026-10-11', sourceType: 'doc', tier: 'discussion', count: 1 },
    ]);
    await store.transaction((tx) => tx.pruneContextRetrievals(boardId, '2026-09-01'));
    expect(await store.transaction((tx) => tx.listContextRetrievals(boardId, '2026-01-01'))).toHaveLength(2);
  });

  it('counts concurrent searches that list the same pairs in opposite orders without deadlocking', async () => {
    const a = { sourceType: 'decision', tier: 'decision', count: 1 } as const;
    const b = { sourceType: 'doc', tier: 'discussion', count: 1 } as const;
    const day = '2026-06-01';
    const before = (await store.transaction((tx) => tx.listContextRetrievals(boardId, day))).reduce((n, r) => n + r.count, 0);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.transaction((tx) => tx.recordContextRetrievals(boardId, day, i % 2 === 0 ? [a, b] : [b, a]))),
    );
    const after = (await store.transaction((tx) => tx.listContextRetrievals(boardId, day))).reduce((n, r) => n + r.count, 0);
    expect(after - before).toBe(20);
  });

  it('serves the report to members, with the retrievals and the settings', async () => {
    const res = await request('GET', `/api/boards/${String(boardId)}/context-report`, DEV);
    expect(res.status).toBe(200);
    const report = reportOf(await res.json());
    expect(report.retrievals.total).toBe(6);
    expect(report.retrievals.bySource[0]).toMatchObject({ key: 'decision', count: 5 });
    expect(report.settings).toHaveLength(16);
    expect((await request('GET', `/api/boards/${String(boardId)}/context-report`, 'nobody@example.com')).status).toBeGreaterThanOrEqual(401);
  });

  it('lets only admins reset a setting, and files the reset in the history', async () => {
    await store.transaction((tx) => tx.setContextSetting(boardId, 'inbox_candidates', 10, NOW));
    const path = `/api/boards/${String(boardId)}/context-settings/inbox_candidates/reset`;
    expect((await request('POST', path, DEV)).status).toBe(403);
    const reset = await request('POST', path);
    expect(reset.status).toBe(200);
    const view: unknown = await (await request('GET', `/api/boards/${String(boardId)}/context-report`)).json();
    const report = reportOf(view);
    expect(report.settings.find((s) => s.key === 'inbox_candidates')?.value).toBe(8);
    expect(report.history[0]).toMatchObject({ key: 'inbox_candidates', before: 10, after: 8, outcome: 'reset' });
    expect((await request('POST', `/api/boards/${String(boardId)}/context-settings/bogus/reset`)).status).toBe(422);
  });
});
