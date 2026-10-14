import { ArtifactService, BoardService, FindingsService, IntakeService, KnowledgePageService, KnowledgeService, LearningJobService, MiningService, knowledgePageEffect } from '@slop/core';
import type { Catalog, KnowledgePageVersion, Result } from '@slop/core';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { connect, PgStore, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountKnowledge } from '../src/http/knowledge.js';
import { knowledgePageExecutors } from '../src/knowledge-page-executors.js';
import { createTestDatabase } from './support/database.js';
import { fakeCodeHost } from './support/fake-codehost.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const unused = () => Promise.reject(new Error('not used by the knowledge page routes'));
const catalog: Catalog = { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'empty', files: [] }) };

const version = (boardId: number, n: number, patch: Partial<KnowledgePageVersion> = {}): KnowledgePageVersion => ({
  boardId,
  version: n,
  createdAt: `2026-10-05T12:0${String(n)}:00.000Z`,
  reason: n === 1 ? 'first' : 'delta',
  sections: {
    agents: [{ path: 'agents/a.md', kind: 'agent', name: 'a', description: 'An agent', hash: 'h', changedInAgentSet: null, decisionGlobId: null }],
    decisions: [{ area: 'Testing', entries: [{ text: 'Run it', rationale: 'Because', globIds: ['s1k1'], key: true, at: '2026-10-05T11:00:00.000Z' }] }],
  },
  changed: { agents: true, decisions: n === 1 },
  basis: { agentSetVersion: 1, agentsHash: 'x', agentSeen: { 'agents/a.md': { hash: 'h', since: null } }, decisions: { s1k1: 'f' }, promptVersion: 1, agentSetBumps: [] },
  ...patch,
});

describe('knowledge page store', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kpage'));
    store = new PgStore(database.db);
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      const board = await tx.insertBoard({ name: 'test', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: ADMIN, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
  });

  afterAll(() => drop());

  const jobs = async () => (await database.db.select().from(schema.outbox)).filter((r) => r.kind === 'regenerate_knowledge_page');

  it('gives a board the default interval, and keeps the one an admin sets', async () => {
    const board = await store.transaction((tx) => tx.getBoard(boardId));
    expect(board?.knowledgePageIntervalMinutes).toBe(1440);
    await store.transaction(async (tx) => {
      if (board === null) throw new Error('no board');
      await tx.updateBoard({ ...board, knowledgePageIntervalMinutes: 15, version: board.version + 1 }, board.version);
    });
    expect((await store.transaction((tx) => tx.getBoard(boardId)))?.knowledgePageIntervalMinutes).toBe(15);
  });

  it('round-trips versions: latest, one by number, and the history newest first without sections', async () => {
    expect(await store.transaction((tx) => tx.latestKnowledgePageVersion(boardId))).toBeNull();
    expect(await store.transaction((tx) => tx.insertKnowledgePageVersion(version(boardId, 1)))).toBe(true);
    expect(await store.transaction((tx) => tx.insertKnowledgePageVersion(version(boardId, 2)))).toBe(true);
    // The same number again is a concurrent regeneration that lost.
    expect(await store.transaction((tx) => tx.insertKnowledgePageVersion(version(boardId, 2, { reason: 'rebuild' })))).toBe(false);
    expect(await store.transaction((tx) => tx.latestKnowledgePageVersion(boardId))).toEqual(version(boardId, 2));
    expect(await store.transaction((tx) => tx.getKnowledgePageVersion(boardId, 1))).toEqual(version(boardId, 1));
    expect(await store.transaction((tx) => tx.getKnowledgePageVersion(boardId, 3))).toBeNull();
    expect(await store.transaction((tx) => tx.listKnowledgePageVersions(boardId, 10))).toEqual([
      { version: 2, createdAt: '2026-10-05T12:02:00.000Z', reason: 'delta' },
      { version: 1, createdAt: '2026-10-05T12:01:00.000Z', reason: 'first' },
    ]);
    expect(await store.transaction((tx) => tx.listKnowledgePageVersions(boardId, 1))).toHaveLength(1);
  });

  it('queues one unclaimed regeneration per board on the llm lane, and a rebuild upgrades it and makes it due now', async () => {
    await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId), knowledgePageEffect(boardId)]));
    await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId)]));
    let rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 'llm', state: 'pending', attempts: 0, effect: knowledgePageEffect(boardId) });

    // The job waits for the interval (an executor's retry-later): attempts stay 0, run_after is in the future.
    const later = new Date(Date.now() + 60 * 60_000);
    await database.db.update(schema.outbox).set({ runAfter: later }).where(eq(schema.outbox.id, rows[0]?.id ?? 0));
    await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId)]));
    rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runAfter.getTime()).toBe(later.getTime());

    await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId, true)]));
    rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.effect).toEqual(knowledgePageEffect(boardId, true));
    expect(rows[0]?.runAfter.getTime()).toBeLessThanOrEqual(Date.now());

    // A claimed job (attempts spent) gets a sibling: it may have read the board before this change.
    await database.db.update(schema.outbox).set({ attempts: 1 }).where(eq(schema.outbox.id, rows[0]?.id ?? 0));
    await store.transaction((tx) => tx.enqueueEffects([knowledgePageEffect(boardId)]));
    expect(await jobs()).toHaveLength(2);
  });

  it('runs the regeneration through the executor with the effect\'s full flag', async () => {
    const calls: [number, boolean][] = [];
    const executors = knowledgePageExecutors({ regenerate: (id, full) => (calls.push([id, full]), Promise.resolve('done')) });
    const run = executors.regenerate_knowledge_page;
    if (run === undefined) throw new Error('no executor');
    const deps = { globs: {} as never };
    expect(await run(knowledgePageEffect(boardId), null, deps)).toBe('done');
    expect(await run(knowledgePageEffect(boardId, true), null, deps)).toBe('done');
    expect(await run({ kind: 'recheck_overlaps', globId: 'board-1', boardId }, null, deps)).toBe('dropped');
    expect(calls).toEqual([[boardId, false], [boardId, true]]);
  });

  it('serves the page through the service from the real store', async () => {
    const notifier = { publish: () => undefined };
    const page = new KnowledgePageService({
      store,
      clock: { now: () => new Date().toISOString() },
      notifier,
      llm: { complete: () => Promise.reject(new Error('no model needed')) },
      model: 'm',
      spend: { record: () => Promise.resolve() },
      knowledge: { agentSetForDownload: (): Promise<Result<never>> => Promise.resolve({ ok: false, error: { code: 'not_found', message: 'none' } }) },
    });
    const view = await page.view(ADMIN, boardId);
    if (!view.ok) throw new Error(view.error.message);
    expect(view.value.current?.version).toBe(2);
    expect(view.value.history.map((h) => h.version)).toEqual([2, 1]);
    expect(view.value.pending).toBe(true);
  });
});

describe('knowledge page routes', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let boardId: number;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kpage_routes'));
    store = new PgStore(database.db);
    const deps = { store, notifier: { publish: () => undefined }, clock: { now: () => new Date().toISOString() } };
    const knowledge = new KnowledgeService({ ...deps, catalog });
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
      host: fakeCodeHost({ configured: false }),
      jobs: new LearningJobService({ ...deps, mining: new MiningService(deps), manifests: null }),
      knowledgePage: new KnowledgePageService({ ...deps, llm: { complete: unused }, model: 'm', spend: { record: () => Promise.resolve() }, knowledge }),
      logError: () => undefined,
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({ name: 'test', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
  });

  afterAll(() => drop());

  const get = (path: string, email = DEV) => app.request(`/api/boards/${String(boardId)}/knowledge-page${path}`, { headers: { 'x-test-email': email } });

  it('serves an empty page, then the current version with its history, and one version by number', async () => {
    const empty = await get('');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ current: null, history: [], nextRegenerationAt: null, pending: false, agentSetHistory: [], feedback: [] });

    await store.transaction((tx) => tx.insertKnowledgePageVersion(version(boardId, 1)));
    const page = await get('');
    expect(await page.json()).toEqual({ current: version(boardId, 1), history: [{ version: 1, createdAt: version(boardId, 1).createdAt, reason: 'first' }], nextRegenerationAt: null, pending: false, agentSetHistory: [], feedback: [] });
    expect(await (await get('/versions/1')).json()).toEqual(version(boardId, 1));
    expect((await get('/versions/2')).status).toBe(404);
    expect((await get('/versions/abc')).status).toBe(422);
  });

  it('queues a rebuild for admins (202) and refuses a dev (403)', async () => {
    const refused = await app.request(`/api/boards/${String(boardId)}/knowledge-page/rebuild`, { method: 'POST', headers: { 'x-test-email': DEV } });
    expect(refused.status).toBe(403);
    const queued = await app.request(`/api/boards/${String(boardId)}/knowledge-page/rebuild`, { method: 'POST', headers: { 'x-test-email': ADMIN } });
    expect(queued.status).toBe(202);
    expect(await queued.json()).toEqual({ queued: true });
    const page = (await (await get('')).json()) as { pending: boolean };
    expect(page.pending).toBe(true);
  });
});

describe('knowledge page verdicts (s15f63)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;
  let app: Hono<Env>;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kpage_feedback'));
    store = new PgStore(database.db);
    const deps = { store, notifier: { publish: () => undefined }, clock: { now: () => new Date().toISOString() } };
    const knowledge = new KnowledgeService({ ...deps, catalog });
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
      host: fakeCodeHost({ configured: false }),
      jobs: new LearningJobService({ ...deps, mining: new MiningService(deps), manifests: null }),
      knowledgePage: new KnowledgePageService({ ...deps, llm: { complete: unused }, model: 'm', spend: { record: () => Promise.resolve() }, knowledge }),
      logError: () => undefined,
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({ name: 'test', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
  });

  afterAll(() => drop());

  const post = (body: unknown, email = ADMIN) =>
    app.request(`/api/boards/${String(boardId)}/knowledge-page/feedback`, {
      method: 'POST',
      headers: { 'x-test-email': email, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('keeps one verdict per decision, replaces it, lists the newest first and deletes it on undo', async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
    await store.transaction(async (tx) => {
      await tx.saveKnowledgePageFeedback({ boardId, globId: 's1k1', verdict: 'pin', by: ADMIN, at: at(1) });
      await tx.saveKnowledgePageFeedback({ boardId, globId: 's1k2', verdict: 'hide', by: ADMIN, at: at(2) });
      await tx.saveKnowledgePageFeedback({ boardId, globId: 's1k1', verdict: 'hide', by: DEV, at: at(3) });
    });
    const listed = await store.transaction((tx) => tx.listKnowledgePageFeedback(boardId));
    expect(listed).toEqual([
      { boardId, globId: 's1k1', verdict: 'hide', by: DEV, at: at(3) },
      { boardId, globId: 's1k2', verdict: 'hide', by: ADMIN, at: at(2) },
    ]);
    await store.transaction((tx) => tx.deleteKnowledgePageFeedback(boardId, 's1k1'));
    expect((await store.transaction((tx) => tx.listKnowledgePageFeedback(boardId))).map((f) => f.globId)).toEqual(['s1k2']);
  });

  it('refuses a dev (403), a bad body (422) and a decision that is not on the board (404)', async () => {
    expect((await post({ globIds: ['s1k1'], verdict: 'pin' }, DEV)).status).toBe(403);
    expect((await post({ globIds: [], verdict: 'pin' })).status).toBe(422);
    expect((await post({ globIds: ['s1k1'], verdict: 'maybe' })).status).toBe(422);
    expect((await post({ globIds: ['s1k404'], verdict: 'pin' })).status).toBe(404);
  });
});

const MIGRATION = '0055_knowledge_page_daily';
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const MIGRATION_DB = `slop_test_kpagemig_${process.pid}`;
const migrationUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${MIGRATION_DB}`);

/** Migration 0052: boards still at the old hourly default move to daily; boards that chose another value keep it. */
describe('knowledge page daily default (migration 0052)', () => {
  let admin: Database;
  let database: Database;
  let folder: string;
  const interval = async (id: number) => {
    const rows = await database.db.execute(sql`select knowledge_page_interval_minutes as m from boards where id = ${id}`);
    return Number((rows[0] as { m: unknown } | undefined)?.m);
  };

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${MIGRATION_DB}`));
    // Migrated up to the one before: a copy of the migrations without its journal entry.
    folder = await mkdtemp(join(tmpdir(), 'kpage-migration-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
    // Cut at this migration's index, so any later migration is held back too.
    const at = journal.entries.findIndex((e) => e.tag === MIGRATION);
    const earlier = journal.entries.slice(0, at);
    expect(journal.entries[at]?.when ?? 0).toBeGreaterThan(earlier.at(-1)?.when ?? Infinity);
    journal.entries = earlier;
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(migrationUrl, folder);
    database = connect(migrationUrl);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${MIGRATION_DB} with (force)`));
    await admin.close();
    await rm(folder, { recursive: true, force: true });
  });

  it('moves boards at 60 to 1440, keeps other values, and sets the column default', async () => {
    // Raw inserts: this database stops at the migration before, so a board column added since (the store writes them all) isn't there yet.
    const ids: number[] = [];
    for (const name of ['hourly', 'custom']) {
      const rows = await database.db.execute(
        sql`insert into boards (name, base_branch, time_zone, environments, sensitive_paths, version) values (${name}, 'main', 'UTC', '[]'::jsonb, '[]'::jsonb, 1) returning id`,
      );
      ids.push(Number((rows[0] as { id: unknown } | undefined)?.id));
    }
    const [hourly, custom] = ids;
    if (hourly === undefined || custom === undefined) throw new Error('boards not created');
    await database.db.execute(sql`update boards set knowledge_page_interval_minutes = 60 where id = ${hourly}`);
    await database.db.execute(sql`update boards set knowledge_page_interval_minutes = 15 where id = ${custom}`);
    for (const statement of (await readFile(new URL(`../drizzle/${MIGRATION}.sql`, import.meta.url), 'utf8')).split('--> statement-breakpoint')) {
      await database.db.execute(sql.raw(statement));
    }
    expect(await interval(hourly)).toBe(1440);
    expect(await interval(custom)).toBe(15);
    const defaults = await database.db.execute(
      sql`select column_default as d from information_schema.columns where table_name = 'boards' and column_name = 'knowledge_page_interval_minutes'`,
    );
    expect(String((defaults[0] as { d: unknown } | undefined)?.d)).toBe('1440');
  });
});
