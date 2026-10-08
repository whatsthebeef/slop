import { readFile } from 'node:fs/promises';
import {
  ArtifactService,
  BoardService,
  DEDUPE_SYSTEM,
  FindingsService,
  IntakeService,
  KbConsolidation,
  KbPipeline,
  KnowledgeService,
  LearningJobService,
  MiningService,
  PAIRS_SYSTEM,
  ROUTE_SYSTEM,
  UNPROCESSED,
  VERIFY_SYSTEM,
} from '@slop/core';
import type { BoardJob, BoardJobStatus, KbItem, KbSignal, Llm } from '@slop/core';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeHost } from '../src/codehost.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountKnowledge } from '../src/http/knowledge.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';
const START = '2026-10-07T12:00:00.000Z';

const catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};
const notifier = { publish: () => undefined };
const unused = () => Promise.reject(new Error('not used by the knowledge routes'));

/** The knowledge routes only read `configured` and `connection`; nothing here calls them. */
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
  commentOnce: unused,
  headOf: unused,
  commitChecks: unused,
  updateBranch: unused,
};

/** This strand's migration: a renumber (when another migration lands first) changes only this. */
const MIGRATION = '0018_kb_consolidation';

const json = (value: unknown) => JSON.stringify(value);
const QUOTE = 'run vitest with --reporter=dot';
const PAIR = (a: string, b: string) => json({ pairs: [{ a, b }] });
const SAME = json({
  fact: 'Run vitest with the dot reporter',
  relation: 'same fact',
  quoteA: QUOTE,
  quoteB: QUOTE,
});

/** An LLM answering each call by its system prompt; a handler may do something during the call. */
const bySystem = (handlers: Record<string, () => Promise<string>>): Llm => ({
  complete: (request) => {
    const handler = handlers[request.system];
    return handler === undefined ? Promise.reject(new Error('No canned answer')) : handler();
  },
});

const SIGNAL: KbSignal = {
  key: 'run_superseded',
  kind: 'run_superseded',
  agent: 'orchestrator',
  label: 'runs taken over or started again',
  window: { from: '2026-09-09T12:00:00.000Z', to: START },
  figures: { affected: 4, eligible: 16, rate: 0.25, count: 4 },
  globIds: [],
  examples: [],
  measuredAt: START,
};

describe('Weekly consolidation in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;
  let n = 0;
  const clock = { now: () => START };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kb_consolidation'));
    store = new PgStore(database.db);
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
  });

  afterAll(async () => {
    await drop();
  });

  // Each test starts with no open items, so the run compares only its own.
  beforeEach(async () => {
    await database.db.execute(
      sql`update kb_proposals set status = 'rejected' where status = 'open'`,
    );
  });

  /** An open, drafted statement, as the pipeline leaves it. */
  const add = async (patch: Partial<KbItem> = {}): Promise<KbItem> => {
    const id = `s${String(boardId)}k${String(++n)}`;
    const item: KbItem = {
      id,
      boardId,
      status: 'open',
      type: 'gotcha',
      statement: `Always ${QUOTE} (${id}).`,
      evidence: `Evidence for ${id}`,
      suggestedTarget: null,
      sourceGlobIds: [`s${String(boardId)}t${String(n)}`],
      source: 'submitted',
      signal: null,
      agentSetVersion: null,
      submittedBy: DEV,
      createdAt: START,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      document: null,
      outcome: null,
      ...UNPROCESSED,
      processing: 'drafted',
      target: { kind: 'doc', name: 'build_test_lint', section: 'Test', newDocument: null },
      draft: { section: 'Test', content: '## Test\n\n- Dot reporter\n' },
      draftedAgainstVersion: 1,
      version: 2,
      ...patch,
    };
    expect(await store.transaction((tx) => tx.insertKbItem(item))).toBe(true);
    return item;
  };
  const get = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => tx.getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };
  /** Waits until some query is blocked on a lock (deterministic: no sleeps that guess at timing). */
  const blockedOnLock = () =>
    vi.waitFor(
      async () => {
        const rows = await database.db.execute(
          sql`select count(*)::int as waiting from pg_locks where not granted`,
        );
        expect(rows[0]?.waiting).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 20 },
    );

  it('the consolidation migration adds its columns with their defaults, and re-running it is harmless', async () => {
    const migration = await readFile(new URL(`../drizzle/${MIGRATION}.sql`, import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint'))
      await database.db.execute(sql.raw(statement));
    const columns = await database.db.execute(sql`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_name = 'kb_proposals' and column_name in ('stale_since', 'stale_reason', 'stale_dismissed_at', 'kept_apart_from', 'merge_note')
      order by column_name`);
    expect([...columns]).toEqual([
      {
        column_name: 'kept_apart_from',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: "'[]'::jsonb",
      },
      { column_name: 'merge_note', data_type: 'jsonb', is_nullable: 'YES', column_default: null },
      {
        column_name: 'stale_dismissed_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      { column_name: 'stale_reason', data_type: 'text', is_nullable: 'YES', column_default: null },
      {
        column_name: 'stale_since',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
    // A row from before the migration reads as never flagged, kept apart from nothing and not merged by consolidation.
    const id = `s${String(boardId)}k${String(++n)}`;
    await database.db.execute(sql`
      insert into kb_proposals (id, board_id, status, type, statement, evidence, source_glob_ids, source, submitted_by, created_at, version)
      values (${id}, ${boardId}, 'rejected', 'gotcha', 'Old', 'Old', '[]'::jsonb, 'submitted', ${DEV}, now(), 1)`);
    expect(await get(id)).toMatchObject({
      staleSince: null,
      staleReason: null,
      staleDismissedAt: null,
      keptApartFrom: [],
      mergeNote: null,
    });
    const journal = JSON.parse(
      await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as {
      entries: { tag: string; when: number }[];
    };
    // Found by its tag, so later migrations can follow it.
    const index = journal.entries.findIndex((e) => e.tag === MIGRATION);
    expect(index).toBeGreaterThan(0);
    const ours = journal.entries[index];
    const previous = journal.entries[index - 1];
    expect(ours?.when).toBeGreaterThan(previous?.when ?? Infinity);
    // The board job's state column: null on rows from before it.
    const state = await database.db.execute(sql`
      select data_type, is_nullable from information_schema.columns
      where table_name = 'board_jobs' and column_name = 'state'`);
    expect([...state]).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);
  });

  it('round-trips the consolidation columns', async () => {
    const item = await add();
    const updated: KbItem = {
      ...item,
      staleSince: '2026-10-07T12:00:00.000Z',
      staleReason: 'signal_below_threshold',
      staleDismissedAt: '2026-08-01T00:00:00.000Z',
      keptApartFrom: ['s1k1', 's1k2'],
      mergeNote: { by: 'consolidation', quote: 'a', survivorQuote: 'b', at: START },
      version: item.version + 1,
    };
    expect(await store.transaction((tx) => tx.updateKbItem(updated, item.version))).toBe(true);
    expect(await get(item.id)).toEqual(updated);
  });

  it("stores a board job's state beside its result, untouched by claiming or finishing a run, and out of the job's record", async () => {
    expect(await store.transaction((tx) => tx.getBoardJobState(boardId, 'consolidation'))).toBeNull();
    const memory = { candidates: 's1k1@2 s1k2@2', notSame: [['s1k1@2', 's1k2@2']] };
    await store.transaction((tx) => tx.setBoardJobState(boardId, 'consolidation', memory));
    const claimed = await store.transaction((tx) => tx.claimBoardJob(boardId, 'consolidation', START, 60_000));
    if (claimed === null) throw new Error('Not claimed');
    expect(claimed).not.toHaveProperty('state');
    const finished: BoardJob = { ...claimed, lastRunAt: START, lastResult: { kind: 'skipped', reason: 'AI unavailable' } };
    expect(await store.transaction((tx) => tx.finishBoardJob(finished, claimed.runningUntil ?? ''))).toBe(true);
    expect(await store.transaction((tx) => tx.getBoardJobState(boardId, 'consolidation'))).toEqual(memory);
    // Setting it again replaces it; another job's state is its own.
    await store.transaction((tx) => tx.setBoardJobState(boardId, 'consolidation', { candidates: null, notSame: [] }));
    expect(await store.transaction((tx) => tx.getBoardJobState(boardId, 'consolidation'))).toEqual({ candidates: null, notSame: [] });
    expect(await store.transaction((tx) => tx.getBoardJobState(boardId, 'mining'))).toBeNull();
  });

  it('merges a verified pair with both writes, moving the signal and its kb_signals row to the survivor', async () => {
    const survivor = await add({ occurrenceCount: 2 });
    const loser = await add({ source: 'mined', signal: SIGNAL, submittedBy: 'slop' });
    await store.transaction((tx) =>
      tx.upsertKbSignal({
        boardId,
        key: SIGNAL.key,
        itemId: loser.id,
        lastFigures: SIGNAL.figures,
        lastMeasuredAt: START,
        raisedAt: START,
        belowThresholdRuns: 0,
      }),
    );
    const consolidation = new KbConsolidation({
      store,
      clock,
      notifier,
      llm: bySystem({
        [PAIRS_SYSTEM]: () => Promise.resolve(PAIR(loser.id, survivor.id)),
        [VERIFY_SYSTEM]: () => Promise.resolve(SAME),
      }),
    });
    expect(await consolidation.consolidate(boardId)).toMatchObject({
      proposed: 1,
      verified: 1,
      merged: [{ id: loser.id, into: survivor.id }],
    });
    expect(await get(survivor.id)).toMatchObject({
      status: 'open',
      occurrenceCount: 3,
      signal: SIGNAL,
      sourceGlobIds: [...survivor.sourceGlobIds, ...loser.sourceGlobIds],
      extraEvidence: [
        {
          itemId: loser.id,
          evidence: loser.evidence,
          globIds: loser.sourceGlobIds,
          submittedBy: 'slop',
          at: START,
        },
      ],
      draft: survivor.draft,
      version: survivor.version + 1,
    });
    expect(await get(loser.id)).toMatchObject({
      status: 'merged',
      duplicateOf: survivor.id,
      mergeNote: { by: 'consolidation', quote: QUOTE, survivorQuote: QUOTE, at: START },
      version: loser.version + 1,
    });
    const [row] = await store.transaction((tx) => tx.listKbSignals(boardId));
    expect(row).toMatchObject({ key: SIGNAL.key, itemId: survivor.id });
  });

  it("rolls the survivor's write back when the other item's write loses to a concurrent writer", async () => {
    const survivor = await add({ occurrenceCount: 2 });
    const loser = await add();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let concurrent: Promise<boolean> = Promise.resolve(false);
    const run = new KbConsolidation({
      store,
      clock,
      notifier,
      llm: bySystem({
        [PAIRS_SYSTEM]: () => Promise.resolve(PAIR(survivor.id, loser.id)),
        [VERIFY_SYSTEM]: () => {
          // Another writer updates the loser and holds its transaction open: the merge reads the committed
          // version (unchanged), writes the survivor, then waits on the loser's row.
          concurrent = store.transaction(async (tx) => {
            const wrote = await tx.updateKbItem(
              { ...loser, evidence: 'Edited meanwhile', version: loser.version + 1 },
              loser.version,
            );
            await gate;
            return wrote;
          });
          return Promise.resolve(SAME);
        },
      }),
    }).consolidate(boardId);
    try {
      await blockedOnLock();
    } finally {
      release();
    }
    expect(await concurrent).toBe(true);
    expect(await run).toMatchObject({ verified: 1, merged: [], skipped: 1 });
    // Nothing of the merge landed: the survivor is as it was, the loser has only the other writer's change.
    expect(await get(survivor.id)).toEqual(survivor);
    expect(await get(loser.id)).toMatchObject({
      status: 'open',
      evidence: 'Edited meanwhile',
      version: loser.version + 1,
    });
  });

  it("waits for a mining run's board lock before merging, so it never interleaves with mining's writes", async () => {
    const survivor = await add({ occurrenceCount: 2 });
    const loser = await add();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked = (): void => undefined;
    const lockHeld = new Promise<void>((resolve) => (locked = resolve));
    // A mining run's transaction, holding the board's mining lock.
    const mining = store.transaction(async (tx) => {
      await tx.lockBoardJob(boardId, 'mining');
      locked();
      await gate;
    });
    await lockHeld;
    const run = new KbConsolidation({
      store,
      clock,
      notifier,
      llm: bySystem({
        [PAIRS_SYSTEM]: () => Promise.resolve(PAIR(survivor.id, loser.id)),
        [VERIFY_SYSTEM]: () => Promise.resolve(SAME),
      }),
    }).consolidate(boardId);
    try {
      await blockedOnLock();
      // Still waiting: nothing merged yet.
      expect((await get(loser.id)).status).toBe('open');
    } finally {
      release();
    }
    await mining;
    expect(await run).toMatchObject({ merged: [{ id: loser.id, into: survivor.id }] });
  });

  it("doesn't race a pipeline worker merging a new item into the survivor: the pair is skipped and no evidence is lost", async () => {
    const survivor = await add({ occurrenceCount: 2 });
    const loser = await add();
    // A new submission the pipeline hasn't routed yet: its dedupe finds it the same fact as the survivor.
    const fresh = await add({
      processing: 'pending',
      target: null,
      draft: null,
      draftedAgainstVersion: null,
      evidence: 'New review',
    });
    const routing = json({
      target: {
        kind: 'document',
        name: 'testing',
        section: null,
        newDocument: { area: 'testing', audience: [], description: 'Tests' },
      },
      catalogCandidate: false,
      catalogReason: null,
    });
    const dedupe = json({
      fact: 'f',
      checked: [{ ref: survivor.id, relation: 'same fact' }],
      duplicateOf: { id: survivor.id, quote: QUOTE, newQuote: QUOTE },
      suppressedBy: null,
      coveredBy: null,
      contradicts: [],
    });
    const route = bySystem({
      [ROUTE_SYSTEM]: () => Promise.resolve(routing),
      [DEDUPE_SYSTEM]: () => Promise.resolve(dedupe),
    });
    const pipeline = new KbPipeline({ store, clock, catalog, notifier, route, draft: route });
    const run = new KbConsolidation({
      store,
      clock,
      notifier,
      llm: bySystem({
        [PAIRS_SYSTEM]: () => Promise.resolve(PAIR(survivor.id, loser.id)),
        [VERIFY_SYSTEM]: async () => {
          // A pipeline worker merges the new item into the survivor while the pair is being verified.
          expect(await pipeline.process(fresh.id)).toBe(true);
          return SAME;
        },
      }),
    });
    expect(await run.consolidate(boardId)).toMatchObject({ verified: 1, merged: [], skipped: 1 });
    expect(await get(fresh.id)).toMatchObject({ status: 'merged', duplicateOf: survivor.id });
    expect(await get(survivor.id)).toMatchObject({
      status: 'open',
      occurrenceCount: 3,
      extraEvidence: [{ itemId: fresh.id, evidence: 'New review' }],
    });
    expect(await get(loser.id)).toEqual(loser);
  });
});

describe('Consolidation routes', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let boardId: number;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('kb_consolidation_routes'));
    store = new PgStore(database.db);
    const deps = { store, notifier, clock: { now: () => new Date().toISOString() } };
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
      host,
      jobs: new LearningJobService({
        ...deps,
        mining: new MiningService(deps),
        consolidation: new KbConsolidation({
          ...deps,
          llm: { complete: () => Promise.resolve('{"pairs": []}') },
        }),
        manifests: null,
      }),
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

  it('POST /api/boards/:b/kb/jobs/consolidation/run answers 202 for admins and 403 for developers', async () => {
    const path = `/api/boards/${String(boardId)}/kb/jobs/consolidation/run`;
    expect((await post(path, {}, DEV)).status).toBe(403);
    const response = await post(path, {});
    expect(response.status).toBe(202);
    expect((await response.json()) as BoardJob).toMatchObject({
      boardId,
      job: 'consolidation',
      lastRunAt: null,
    });
    await vi.waitFor(async () => {
      const listed = await app.request(`/api/boards/${String(boardId)}/kb/jobs`, {
        headers: { 'x-test-email': DEV },
      });
      const jobs = (await listed.json()) as BoardJobStatus[];
      expect(jobs.find((j) => j.job === 'consolidation')).toMatchObject({
        running: false,
        lastResult: { kind: 'consolidation', candidates: 0 },
      });
    });
  });

  it('POST /api/kb/:id/keep clears a stale flag for admins, conditional on the version', async () => {
    const id = `s${String(boardId)}k1`;
    const item: KbItem = {
      id,
      boardId,
      status: 'open',
      type: 'gotcha',
      statement: 'Old',
      evidence: 'Old',
      suggestedTarget: null,
      sourceGlobIds: [],
      source: 'submitted',
      signal: null,
      agentSetVersion: null,
      submittedBy: DEV,
      createdAt: '2026-06-01T00:00:00.000Z',
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      document: null,
      outcome: null,
      ...UNPROCESSED,
      processing: 'drafted',
      staleSince: START,
      staleReason: 'no_recent_evidence',
      version: 4,
    };
    await store.transaction((tx) => tx.insertKbItem(item));
    expect((await post(`/api/kb/${id}/keep`, { version: 4 }, DEV)).status).toBe(403);
    expect((await post(`/api/kb/${id}/keep`, { version: 3 })).status).toBe(409);
    const kept = await post(`/api/kb/${id}/keep`, { version: 4 });
    expect(kept.status).toBe(200);
    expect((await kept.json()) as KbItem).toMatchObject({
      staleSince: null,
      staleReason: null,
      version: 5,
    });
    expect((await post(`/api/kb/${id}/keep`, { version: 5 })).status).toBe(422);
  });
});
