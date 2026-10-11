import { ArtifactService, BoardService, FindingsService, GlobService, IntakeService, KnowledgeService, LearningJobService, MiningService, RiskAreaService, SubLimitService } from '@slop/core';
import type { Result, RiskAreaView } from '@slop/core';
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
const NOW = '2026-10-11T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
/** Narrows a response body to the risk-area view (the guard checks its two lists). */
const isView = (body: unknown): body is RiskAreaView =>
  typeof body === 'object' && body !== null && 'areas' in body && Array.isArray(body.areas) && 'history' in body && Array.isArray(body.history);
const viewOf = (body: unknown): RiskAreaView => {
  if (!isView(body)) throw new Error('Not a risk-area view');
  return body;
};
const catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

describe('Risk areas and the adaptive sub step in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let boardId: number;
  let riskAreas: RiskAreaService;
  const notifier = { publish: () => undefined };
  const clock = { now: () => NOW };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('risk_areas'));
    const { db } = database;
    store = new PgStore(db);
    const deps = { store, notifier, clock };
    const globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const boards = new BoardService(deps);
    const mining = new MiningService(deps);
    riskAreas = new RiskAreaService({ store, clock });
    const subLimit = new SubLimitService({ store, notifier, diffs: null, riskAreas });
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
      jobs: new LearningJobService({ ...deps, mining, subLimit, manifests: null }),
      subLimit,
      riskAreas,
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

  it('starts a board at step 500, and keeps the step with the limit', async () => {
    expect((await store.transaction((tx) => tx.getBoard(boardId)))?.subLimitStep).toBe(500);
    expect(await store.transaction((tx) => tx.setSubLimit(boardId, 2000, 2750, 750))).toBe(true);
    expect(await store.transaction((tx) => tx.getBoard(boardId))).toMatchObject({ subMaxChangedLines: 2750, subLimitStep: 750 });
    // Without a step the step stays.
    expect(await store.transaction((tx) => tx.setSubLimit(boardId, 2750, 2000))).toBe(true);
    expect((await store.transaction((tx) => tx.getBoard(boardId)))?.subLimitStep).toBe(750);
    await store.transaction((tx) =>
      tx.insertSubLimitChange({ boardId, at: NOW, fromLines: 2000, toLines: 2750, outcome: 'merged_unchanged', globId: 's1t1', changedLines: 2900, evidence: 'x', step: 750 }),
    );
    expect((await store.transaction((tx) => tx.listSubLimitChanges(boardId)))[0]?.step).toBe(750);
  });

  it('seeds the defaults, records a learned area once per outcome, and resets', async () => {
    const view = await request('GET', `/api/boards/${String(boardId)}/risk-areas`, DEV);
    expect(view.status).toBe(200);
    const seeded = viewOf(await view.json());
    expect(seeded.areas).toHaveLength(5);
    expect(await riskAreas.record(boardId, { kind: 'reverted', globId: 's1t1', paths: ['apps/billing/src/a.ts'], at: NOW })).toBe(true);
    expect(await riskAreas.record(boardId, { kind: 'reverted', globId: 's1t1', paths: ['apps/billing/src/a.ts'], at: NOW })).toBe(false);
    const learned = (await store.transaction((tx) => tx.listRiskAreas(boardId))).find((a) => a.source === 'learned');
    expect(learned).toMatchObject({ name: 'Learned: apps/billing/src', pathPatterns: ['apps/billing/src/**'], strength: 1 });
    expect((await store.transaction((tx) => tx.listRiskAreaChanges(boardId)))[0]).toMatchObject({ kind: 'added', cause: 'reverted', globId: 's1t1' });
    // The unique index keeps a repeated change out.
    expect(
      await store.transaction((tx) => tx.insertRiskAreaChange({ boardId, at: NOW, areaName: 'Learned: apps/billing/src', kind: 'added', globId: 's1t1', cause: 'reverted' })),
    ).toBe(false);
    expect((await request('POST', `/api/boards/${String(boardId)}/risk-areas/reset`, DEV)).status).toBe(403);
    const reset = await request('POST', `/api/boards/${String(boardId)}/risk-areas/reset`);
    expect(reset.status).toBe(200);
    const after = viewOf(await reset.json());
    expect(after.areas.every((a) => a.source === 'default')).toBe(true);
    expect(after.history[0]).toMatchObject({ kind: 'reset', cause: 'reset', globId: null });
  });
});
