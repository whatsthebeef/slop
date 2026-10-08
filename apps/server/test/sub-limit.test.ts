import { readFile } from 'node:fs/promises';
import {
  ArtifactService,
  BoardService,
  FindingsService,
  GlobService,
  IntakeService,
  KnowledgeService,
  LearningJobService,
  MiningService,
  SubLimitService,
} from '@slop/core';
import type { Board, DomainEvent, Glob, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import type { CodeHost, Repo } from '../src/codehost.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { mountKnowledge } from '../src/http/knowledge.js';
import { CodeHostSubDiffs } from '../src/jobs/sub-diffs.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const HOUR = 60 * 60 * 1000;
const MERGED = '2026-10-07T12:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(MERGED) + ms).toISOString();
const NOW = at(2 * HOUR);
/** This strand's migration: a renumber (when another migration lands first) changes only this. */
const MIGRATION = '0020_sub_limit_learning';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const unused = () => Promise.reject(new Error('not used by these tests'));
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
const catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'empty', files: [] }),
};

const event = (
  globId: string,
  type: DomainEvent['type'],
  when: string,
  data: DomainEvent['data'],
): DomainEvent => ({
  type,
  globId,
  actor: null,
  at: when,
  data,
});

describe('The learned sub limit in Postgres', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let boards: BoardService;
  let boardId: number;
  const notifier = { publish: () => undefined };
  const clock = { now: () => NOW };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('sub_limit'));
    const { db } = database;
    store = new PgStore(db);
    const deps = { store, notifier, clock };
    const globs = new GlobService({
      ...deps,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boards = new BoardService(deps);
    const mining = new MiningService(deps);
    const subLimit = new SubLimitService({ store, notifier, diffs: null });
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
      intake: new IntakeService({ store, llm: { complete: unused } }),
      boards,
      host,
      jobs: new LearningJobService({ ...deps, mining, subLimit, manifests: null }),
      subLimit,
      logError: () => undefined,
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER])
        await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, {
        name: 'b',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  afterAll(async () => {
    await drop();
  });

  const request = (method: string, path: string, body: unknown, email = ADMIN) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${email}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const board = async (): Promise<Board> => {
    const found = await store.transaction((tx) => tx.getBoard(boardId));
    if (found === null) throw new Error('No board');
    return found;
  };
  const globOf = (id: string, patch: Partial<Glob>): Glob => ({
    id,
    boardId,
    title: `Change ${id}`,
    summary: '',
    type: 'sub',
    category: 'task',
    group: null,
    environment: null,
    status: 'reviewing',
    version: 1,
    generation: 1,
    creator: DEV,
    planner: DEV,
    implementer: null,
    labels: {},
    checklists: {},
    pr: null,
    prs: [],
    mergeMode: null,
    headChecks: null,
    runs: [],
    failure: null,
    provisioning: 'ok',
    createdAt: at(-HOUR),
    updatedAt: at(-HOUR),
    signedOffAt: null,
    doingSince: null,
    ...patch,
  });

  it('the migration creates the history table, and re-running it is harmless; found by its tag', async () => {
    const migration = await readFile(
      new URL(`../drizzle/${MIGRATION}.sql`, import.meta.url),
      'utf8',
    );
    // Run it twice: it is idempotent, and it makes the line count nullable.
    for (let run = 0; run < 2; run++)
      for (const statement of migration.split('--> statement-breakpoint'))
        await database.db.execute(sql.raw(statement));
    const columns = await database.db.execute(sql`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_name = 'sub_limit_changes' order by ordinal_position`);
    expect([...columns].map((c) => c.column_name)).toEqual([
      'id',
      'board_id',
      'at',
      'from_lines',
      'to_lines',
      'outcome',
      'glob_id',
      'changed_lines',
      'evidence',
    ]);
    expect([...columns].find((c) => c.column_name === 'changed_lines')?.is_nullable).toBe('YES');
    const journal = JSON.parse(
      await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as {
      entries: { tag: string; when: number }[];
    };
    const index = journal.entries.findIndex((e) => e.tag === MIGRATION);
    expect(index).toBeGreaterThan(0);
    expect(journal.entries[index]?.when).toBeGreaterThan(
      journal.entries[index - 1]?.when ?? Infinity,
    );
  });

  it('records each outcome once and writes the limit only from the value it read', async () => {
    const change = {
      boardId,
      at: NOW,
      fromLines: 2000,
      toLines: 1950,
      outcome: 'needed_fixes' as const,
      globId: 's1t1',
      changedLines: 2,
      evidence: 'QA review asked for changes',
    };
    expect(await store.transaction((tx) => tx.insertSubLimitChange(change))).toBe(true);
    // Unique per board, glob and outcome: the job is idempotent.
    expect(
      await store.transaction((tx) => tx.insertSubLimitChange({ ...change, at: at(3 * HOUR) })),
    ).toBe(false);
    expect(
      await store.transaction((tx) =>
        tx.insertSubLimitChange({ ...change, outcome: 'merged_unchanged', at: at(3 * HOUR) }),
      ),
    ).toBe(true);
    const history = await store.transaction((tx) => tx.listSubLimitChanges(boardId));
    expect(history.map((c) => [c.outcome, c.at])).toEqual([
      ['merged_unchanged', at(3 * HOUR)],
      ['needed_fixes', NOW],
    ]);
    expect(history[1]).toMatchObject({ ...change, id: expect.any(Number) as number });
    // An outcome without a line count (neither the verdict nor the merge commit gave one).
    expect(
      await store.transaction((tx) =>
        tx.insertSubLimitChange({ ...change, globId: 's1t2', changedLines: null }),
      ),
    ).toBe(true);
    expect(
      (await store.transaction((tx) => tx.listSubLimitChanges(boardId))).find(
        (c) => c.globId === 's1t2',
      )?.changedLines,
    ).toBeNull();
    // Conditional: a stale `from` writes nothing.
    expect(await store.transaction((tx) => tx.setSubLimit(boardId, 1900, 1850))).toBe(false);
    expect(await store.transaction((tx) => tx.setSubLimit(boardId, 2000, 1950))).toBe(true);
    expect((await board()).subMaxChangedLines).toBe(1950);
    // A board write (settings, agent-set bumps) doesn't carry it, so it can't undo a learned move.
    const current = await board();
    expect(
      await store.transaction((tx) =>
        tx.updateBoard(
          { ...current, subMaxChangedLines: 4000, version: current.version + 1 },
          current.version,
        ),
      ),
    ).toBe(true);
    expect((await board()).subMaxChangedLines).toBe(1950);
    await store.transaction((tx) => tx.setSubLimit(boardId, 1950, 2000));
    await database.db.execute(sql`delete from sub_limit_changes where board_id = ${boardId}`);
  });

  it('the settings route no longer sets the limit', async () => {
    const before = await board();
    const saved = await request('PATCH', `/api/boards/${String(boardId)}/settings`, {
      version: before.version,
      timeZone: 'Europe/London',
      subMaxChangedLines: 100,
    });
    expect(saved.status).toBe(200);
    expect(await board()).toMatchObject({ timeZone: 'Europe/London', subMaxChangedLines: 2000 });
  });

  it('learns from a merged sub end to end, and shows members the limit with its history', async () => {
    await store.transaction(async (tx) => {
      await tx.insertGlob(globOf('s9t1', { type: 'same', status: 'signed_off' }), null);
      await tx.appendEvents([
        event('s9t1', 'CommitPushed', at(-5 * HOUR), {
          sha: 'c1',
          runId: 'r1',
          fromSupersededRun: false,
        }),
        event('s9t1', 'SubReviewCompleted', at(-4 * HOUR), {
          sha: 'c1',
          passed: false,
          reason: 'Changes 2898 lines (limit 2000)',
          cause: 'size',
          changedLines: 2898,
          limit: 2000,
        }),
        event('s9t1', 'Merged', MERGED, { sha: 'm1' }),
      ]);
    });
    const result = await new SubLimitService({ store, notifier, diffs: null }).learn(
      boardId,
      NOW,
      null,
    );
    expect(result.changes).toEqual([
      { globId: 's9t1', outcome: 'merged_unchanged', from: 2000, to: 2250 },
    ]);
    const view = await request('GET', `/api/boards/${String(boardId)}/sub-limit`, undefined, DEV);
    expect(view.status).toBe(200);
    const body = (await view.json()) as {
      current: number;
      bounds: { min: number; max: number; step: number };
      history: { globId: string; fromLines: number; toLines: number; evidence: string }[];
    };
    expect(body).toMatchObject({ current: 2250, bounds: { min: 200, max: 5000, step: 250 } });
    expect(body.history).toEqual([
      expect.objectContaining({ globId: 's9t1', fromLines: 2000, toLines: 2250 }),
    ]);
    expect(
      (await request('GET', `/api/boards/${String(boardId)}/sub-limit`, undefined, OUTSIDER))
        .status,
    ).toBe(403);
    // Admins can run it now; nothing new to learn.
    expect(
      (await request('POST', `/api/boards/${String(boardId)}/kb/jobs/sub_limit/run`, undefined))
        .status,
    ).toBe(202);
  });

  it('two concurrent runs record each outcome once and chain the limit (tester, s15f8)', async () => {
    const other = unwrap(
      await boards.create(ADMIN, {
        name: 'concurrent',
        repo: 'acme/other',
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    await store.transaction(async (tx) => {
      await tx.insertGlob(
        globOf('s8t1', { boardId: other, type: 'same', status: 'signed_off' }),
        null,
      );
      await tx.insertGlob(globOf('s8t2', { boardId: other }), null);
      await tx.appendEvents([
        event('s8t1', 'SubReviewCompleted', at(-4 * HOUR), {
          sha: 'c1',
          passed: false,
          reason: 'Changes 2898 lines (limit 2000)',
          cause: 'size',
          changedLines: 2898,
          limit: 2000,
        }),
        event('s8t1', 'Merged', MERGED, { sha: 'm1' }),
        event('s8t2', 'SubReviewCompleted', at(-HOUR), {
          sha: 'c2',
          passed: true,
          reason: null,
          cause: null,
          changedLines: 2,
          limit: 2000,
        }),
        event('s8t2', 'Merged', MERGED, { sha: 'm2' }),
        event('s8t2', 'LabelChanged', at(HOUR), {
          label: 'QA',
          from: 'required',
          to: 'added',
          items: ['Overflow'],
        }),
      ]);
    });
    const learn = () =>
      new SubLimitService({ store, notifier, diffs: null }).learn(other, NOW, null);
    const runs = await Promise.all([learn(), learn(), learn()]);
    // Every run reads the same candidates; under the lock each outcome is recorded by exactly one of them, and each
    // move starts from the limit the one before left.
    expect(runs.flatMap((r) => r.changes).sort((x, y) => x.from - y.from)).toEqual([
      { globId: 's8t1', outcome: 'merged_unchanged', from: 2000, to: 2250 },
      { globId: 's8t2', outcome: 'needed_fixes', from: 2250, to: 2000 },
    ]);
    const recorded = await store.transaction((tx) => tx.listSubLimitChanges(other));
    expect(recorded.map((c) => [c.globId, c.fromLines, c.toLines])).toEqual([
      ['s8t2', 2250, 2000],
      ['s8t1', 2000, 2250],
    ]);
    const limitNow = await store.transaction((tx) => tx.getBoard(other));
    expect(limitNow?.subMaxChangedLines).toBe(2000);
  });

  it("reads a merged sub's size from its merge commit through the code host", async () => {
    const calls: { repo: Repo; sha: string; signal: AbortSignal | undefined }[] = [];
    const logged: string[] = [];
    let failing = false;
    const diffs = new CodeHostSubDiffs(
      {
        configured: true,
        commitDiffSummary: (repo, sha, signal) => {
          calls.push({ repo, sha, signal });
          return failing
            ? Promise.reject(new Error('502'))
            : Promise.resolve({ changedLines: 42, files: ['a.ts'] });
        },
      },
      (_task, message) => logged.push(message),
    );
    const current = await board();
    expect(await diffs.mergedChangedLines(current, 'abc1234def')).toBe(42);
    expect(calls[0]).toMatchObject({
      repo: { owner: 'acme', name: 'app', base: 'main' },
      sha: 'abc1234def',
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(await diffs.mergedChangedLines({ ...current, repo: null }, 'abc')).toBeNull();
    failing = true;
    await expect(diffs.mergedChangedLines(current, 'abc1234def')).rejects.toThrow('502');
    expect(logged[0]).toMatch(/abc1234/);
    const unconfigured = new CodeHostSubDiffs(
      { configured: false, commitDiffSummary: unused },
      () => undefined,
    );
    expect(await unconfigured.mergedChangedLines(current, 'abc')).toBeNull();
  });
});
