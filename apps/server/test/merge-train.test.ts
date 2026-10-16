import { cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardService, GlobService, machine } from '@slop/core';
import type { Board, Effect, Glob, Result } from '@slop/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import * as schema from '../src/db/schema.js';
import { connect, PgStore, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { globViewOf } from '../src/http/views.js';
import { ReconcileWatch } from '../src/jobs/reconcile.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface FakePr {
  readonly id: string;
  readonly repo: string;
  head: string;
  behind: boolean;
  checks: 'passed' | 'pending' | 'failed';
  merged: boolean;
}

/**
 * A repo as the merge train sees it: a merge makes every other open PR of the repo behind; updating a behind PR gives it a new
 * head whose checks are green at once (one round) unless `autoGreen` is off; a merge needs a green head that is not behind.
 */
class TrainHost extends FakeCodeHost {
  readonly prs = new Map<number, FakePr>();
  readonly merged: string[] = [];
  readonly updated: { id: string; head: string }[] = [];
  readonly squashCalls: string[] = [];
  readonly checkReads: string[] = [];
  readonly bases: string[] = [];
  autoGreen = true;
  trunk = 'main';

  private pr = (n: number): FakePr => {
    const found = this.prs.get(n);
    if (found === undefined) throw new Error(`No PR #${String(n)}`);
    return found;
  };

  override defaultBranch = () => Promise.resolve(this.trunk);
  override mergeState: FakeCodeHost['mergeState'] = (repo, n) => {
    const pr = this.pr(n);
    this.bases.push(repo.base);
    this.checkReads.push(pr.id);
    return Promise.resolve({ sha: pr.head, state: pr.checks, behind: pr.behind });
  };
  override prState: FakeCodeHost['prState'] = (_repo, n) => {
    const pr = this.pr(n);
    return Promise.resolve({ state: pr.merged ? 'merged' : 'open', draft: false, headSha: pr.head, mergeSha: pr.merged ? `m-${pr.id}` : null });
  };
  override squashMerge: FakeCodeHost['squashMerge'] = (repo, glob, n, sha) => {
    const pr = this.pr(n);
    this.bases.push(repo.base);
    this.squashCalls.push(glob.id);
    if (pr.head !== sha) return Promise.resolve({ outcome: 'refused', reason: 'Head branch was modified' });
    if (pr.behind) {
      pr.behind = false;
      pr.head = `${pr.head}+u`;
      pr.checks = this.autoGreen ? 'passed' : 'pending';
      this.updated.push({ id: pr.id, head: pr.head });
      return Promise.resolve({ outcome: 'updating' });
    }
    if (pr.checks !== 'passed') return Promise.resolve({ outcome: 'checks_not_green', state: pr.checks === 'failed' ? 'failed' : 'pending' });
    pr.merged = true;
    this.merged.push(pr.id);
    for (const other of this.prs.values()) if (!other.merged && other.repo === pr.repo) other.behind = true;
    return Promise.resolve({ outcome: 'merged', sha: `m-${pr.id}` });
  };
}

describe('the merge train: one glob per board updates, rechecks and merges at a time', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let host: TrainHost;
  let executors: ReturnType<typeof codeHostExecutors>;
  let clockMs = Date.parse('2026-10-16T09:00:00Z');
  let prNumber = 0;
  let boardN = 0;
  const ran: { kind: string; globId: string; outcome: unknown }[] = [];
  const RUN = new Set<string>(['advance_merge_line', 'squash_merge', 'refresh_checks', 'reconcile_pr']);

  const tick = () => new Date(clockMs++).toISOString();
  const boardOf = (id: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(id));

  /** A board of its own, with its own repo (a merge makes only that repo's other PRs behind). */
  const newBoard = async (): Promise<number> => {
    const repo = `acme/app${String(++boardN)}`;
    host.merged.length = 0;
    host.updated.length = 0;
    return store.transaction(async (tx) => {
      const board = await tx.insertBoard({ name: repo, repo, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: DEV, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
      return board.id;
    });
  };

  const current = async (id: string): Promise<Glob> => unwrap(await globs.get(DEV, id)).glob;

  /**
   * A sub whose PR is ready, with its checks passed (unless `checked` is false) and its sub gate passed: it joins its board's
   * merge line. Nothing runs (no drain): the nudge that makes the head is still pending.
   */
  const ready = async (boardId: number, title: string, opts: { checked?: boolean } = {}): Promise<string> => {
    const n = ++prNumber;
    const created = unwrap(await globs.create(DEV, { boardId, title, type: 'sub', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
    const head = `h${String(n)}`;
    const board = await boardOf(boardId);
    host.prs.set(n, { id: created.id, repo: board?.repo ?? '', head, behind: false, checks: opts.checked === false ? 'pending' : 'passed', merged: false });
    await globs.applyEvent(created.id, (g, ctx) => machine.provisioned(g, { branch: g.id, pr: { number: n, headSha: head } }, ctx));
    await globs.applyEvent(created.id, (g, ctx) => machine.prReadyForReview(g, { number: n, headSha: head }, ctx));
    if (opts.checked !== false) await globs.applyEvent(created.id, (g, ctx) => machine.checksCompleted(g, { sha: head, passed: true }, ctx));
    // What the glob's own setup queued is not the join's: only the line's effects are looked at.
    await database.db.update(schema.outbox).set({ state: 'done' }).where(eq(schema.outbox.globId, created.id));
    await globs.applyEvent(created.id, (g, ctx) => machine.subGateCompleted(g, { sha: head, passed: true, reason: null }, ctx));
    return created.id;
  };

  const effectsOf = async (globId: string, kinds: readonly string[]) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter((r) => kinds.includes(r.kind) && r.state === 'pending');

  /** The outbox: runs pending effects (in order, marking each done first) until none is left; a head's update arrives as the push webhook would. */
  const drain = async (): Promise<void> => {
    for (let round = 0; round < 100; round++) {
      const rows = (await database.db.select().from(schema.outbox).where(eq(schema.outbox.state, 'pending')).orderBy(schema.outbox.id)).filter((r) => RUN.has(r.kind));
      const row = rows[0];
      if (row === undefined) return;
      await database.db.update(schema.outbox).set({ state: 'done' }).where(eq(schema.outbox.id, row.id));
      const executor = executors[row.kind as Effect['kind']];
      if (executor === undefined) throw new Error(`No executor for ${row.kind}`);
      const before = host.updated.length;
      const outcome = await executor(row.effect, await globs.peek(row.globId), { globs });
      ran.push({ kind: row.kind, globId: row.globId, outcome });
      for (const update of host.updated.slice(before)) {
        await globs.applyEvent(update.id, (g, ctx) => machine.commitPushed(g, { sha: update.head, runId: null }, ctx));
      }
    }
    throw new Error('The outbox did not settle');
  };

  const headsOf = async (boardId: number): Promise<string[]> =>
    (await globs.peekAll(boardId, { include: 'all', status: ['merging'] })).filter((g) => g.mergeLine?.head != null).map((g) => g.id);

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('merge_train'));
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: tick },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: 'Dev', active: true }));
    host = new TrainHost();
    executors = codeHostExecutors(host, boardOf, new FileRoutines('/nonexistent/routines.json'), new BoardService({ store, notifier: { publish: () => undefined } }), tick);
  });

  afterAll(() => drop());

  it('three ready globs merge one after another, one round each', async () => {
    const board = await newBoard();
    const a = await ready(board, 'A');
    const b = await ready(board, 'B');
    const c = await ready(board, 'C');
    await drain();
    expect(host.merged).toEqual([a, b, c]);
    // The first merged on its own checks; each of the others was updated once from the base, checked once, and merged.
    expect(host.updated.map((u) => u.id)).toEqual([b, c]);
    for (const id of [a, b, c]) expect((await current(id)).mergeLine ?? null).toBeNull();
    expect(host.squashCalls).toEqual([a, b, b, c, c]);
  });

  it('the globs waiting get no merge, update or check read while the head works', async () => {
    const board = await newBoard();
    const a = await ready(board, 'A');
    const b = await ready(board, 'B');
    const c = await ready(board, 'C');
    host.checkReads.length = 0;
    host.squashCalls.length = 0;
    // Only the nudge is queued: nothing for B and C, and the head is not made yet.
    expect(await effectsOf(b, ['squash_merge', 'refresh_checks'])).toEqual([]);
    expect(await effectsOf(c, ['squash_merge', 'refresh_checks'])).toEqual([]);
    await globs.advanceMergeLine(board);
    expect(await headsOf(board)).toEqual([a]);
    expect(await effectsOf(a, ['squash_merge'])).toHaveLength(1);
    expect(await effectsOf(b, ['squash_merge', 'refresh_checks'])).toEqual([]);
    expect(await effectsOf(c, ['squash_merge', 'refresh_checks'])).toEqual([]);
    expect(host.checkReads).toEqual([]);
    expect(host.updated).not.toContainEqual(expect.objectContaining({ id: b }));
    await drain();
  });

  it('a red head leaves with the reason, and the next one becomes head and merges', async () => {
    const board = await newBoard();
    const a = await ready(board, 'A');
    const b = await ready(board, 'B');
    await globs.advanceMergeLine(board);
    const head = (await current(a)).pr?.headSha ?? '';
    await globs.applyEvent(a, (g, ctx) => machine.checksCompleted(g, { sha: head, passed: false }, ctx));
    expect(await current(a)).toMatchObject({ status: 'failed', failure: { kind: 'merge' } });
    expect((await current(a)).mergeLine ?? null).toBeNull();
    await drain();
    expect(host.merged).toContain(b);
    expect(host.merged).not.toContain(a);
  });

  it('a glob held by a merge relation is skipped, and does not block the globs behind it', async () => {
    const board = await newBoard();
    const a = await ready(board, 'A');
    const b = await ready(board, 'B');
    const c = await ready(board, 'C');
    const gate = unwrap(await globs.create(DEV, { boardId: board, title: 'Gate', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
    // B gets a merge gate while it waits: when its turn comes it is held, not made head.
    unwrap(await globs.addRelation(DEV, b, (await current(b)).version, { to: gate.id, gate: 'merge', reason: 'after the gate' }));
    await drain();
    expect(host.merged).toContain(a);
    expect(host.merged).toContain(c);
    expect(host.merged).not.toContain(b);
    expect((await current(b)).status).not.toBe('merging');
  });

  it('Cancel merge takes a glob out of the line, and its stale merge effect is dropped', async () => {
    const board = await newBoard();
    const a = await ready(board, 'A');
    const b = await ready(board, 'B');
    await globs.advanceMergeLine(board);
    expect(await effectsOf(a, ['squash_merge'])).toHaveLength(1);
    unwrap(await globs.cancelMerge(DEV, a, (await current(a)).version));
    expect(await current(a)).toMatchObject({ status: 'pr_open' });
    expect((await current(a)).mergeLine ?? null).toBeNull();
    host.squashCalls.length = 0;
    await drain();
    expect(ran.filter((r) => r.kind === 'squash_merge' && r.globId === a).map((r) => r.outcome)).toContain('dropped');
    expect(host.squashCalls).not.toContain(a);
    expect(host.merged).toEqual(expect.arrayContaining([b]));
    expect(host.merged).not.toContain(a);
  });

  it('a push to a waiting glob keeps its place but needs green before it merges', async () => {
    const board = await newBoard();
    const a = await ready(board, 'A');
    const b = await ready(board, 'B');
    const joinedAt = (await current(b)).mergeLine?.joinedAt;
    const pr = host.prs.get((await current(b)).pr?.number ?? 0);
    if (pr === undefined) throw new Error('no PR');
    pr.head = 'pushed';
    pr.checks = 'pending';
    await globs.applyEvent(b, (g, ctx) => machine.commitPushed(g, { sha: 'pushed', runId: null }, ctx));
    expect((await current(b)).mergeLine?.joinedAt).toBe(joinedAt);
    host.squashCalls.length = 0;
    await drain();
    expect(host.merged).toEqual([a]);
    expect(await headsOf(board)).toEqual([b]);
    // Head now, but its new head's checks have not passed: no merge call.
    expect(host.squashCalls).toEqual([a]);
    pr.checks = 'passed';
    await globs.applyEvent(b, (g, ctx) => machine.checksChanged(g, ctx));
    await drain();
    expect(host.merged).toEqual([a, b]);
  });

  it('several advancers at once make exactly one head; a second head cannot be written; a non-head merge effect is dropped', async () => {
    const board = await newBoard();
    const [a, b, c] = [await ready(board, 'A'), await ready(board, 'B'), await ready(board, 'C')];
    await Promise.all([globs.advanceMergeLine(board), globs.advanceMergeLine(board), globs.advanceMergeLine(board), globs.advanceMergeLine(board)]);
    expect(await headsOf(board)).toEqual([a]);

    // The partial unique index is the backstop when a bug writes a second head.
    const waiting = await globs.peek(b);
    if (waiting === null || waiting.mergeLine == null) throw new Error('B should be waiting');
    const second = { ...waiting, mergeLine: { joinedAt: waiting.mergeLine.joinedAt, head: { since: tick() } }, version: waiting.version + 1 };
    const failure: unknown = await store.transaction((tx) => tx.updateGlob(second, waiting.version)).then(() => null, (error: unknown) => error);
    const text = (error: unknown): string => (error instanceof Error ? `${error.message} ${text(error.cause)}` : '');
    expect(text(failure)).toContain('globs_merge_head_idx');
    expect(await headsOf(board)).toEqual([a]);

    // An effect for a glob that is not the head is dropped without calling the host.
    const effect: Effect = { kind: 'squash_merge', globId: c, generation: (await current(c)).generation, sha: (await current(c)).pr?.headSha ?? '' };
    host.squashCalls.length = 0;
    expect(await executors.squash_merge?.(effect, await globs.peek(c), { globs })).toBe('dropped');
    expect(host.squashCalls).toEqual([]);
    await drain();
  });

  it('the glob view carries each globs place in the line for the card', async () => {
    const board = await newBoard();
    const a = await ready(board, 'A');
    const b = await ready(board, 'B');
    const c = await ready(board, 'C');
    await globs.advanceMergeLine(board);
    const view = async (id: string) => globViewOf(unwrap(await globs.get(DEV, id)));
    expect((await view(a)).mergeLinePlace).toEqual({ position: 1, ahead: [] });
    expect((await view(b)).mergeLinePlace).toEqual({ position: 2, ahead: [a] });
    expect((await view(c)).mergeLinePlace).toEqual({ position: 3, ahead: [a, b] });
    await drain();
    expect((await view(c)).mergeLinePlace).toBeUndefined();
  });

  it('two boards each get their own head', async () => {
    const one = await newBoard();
    const two = await newBoard();
    const a = await ready(one, 'A');
    const b = await ready(two, 'B');
    const c = await ready(two, 'C');
    await Promise.all([globs.advanceMergeLine(one), globs.advanceMergeLine(two)]);
    expect((await headsOf(one)).concat(await headsOf(two)).sort()).toEqual([a, b].sort());
    expect(await headsOf(two)).toEqual([b]);
    await drain();
    expect(host.merged).toEqual(expect.arrayContaining([a, b, c]));
  });

  it('a head whose checks stay silent is asked again, then fails with the reason, and the next one goes', async () => {
    const board = await newBoard();
    const a = await ready(board, 'A', { checked: false });
    const b = await ready(board, 'B');
    await globs.advanceMergeLine(board);
    expect(await headsOf(board)).toEqual([a]);
    // No result is ever recorded for A (its effects are not run).
    const watch = new ReconcileWatch(store, globs, () => undefined, () => clockMs);
    clockMs += 21 * 60_000;
    await watch.sweep(false);
    expect((await current(a)).mergeLine?.head?.recheckedAt).toBeDefined();
    expect((await effectsOf(a, ['refresh_checks'])).length).toBeGreaterThan(0);
    // The waiting glob is never swept for stuck.
    expect((await current(b)).mergeLine?.head).toBeUndefined();
    clockMs += 21 * 60_000;
    await watch.sweep(false);
    expect(await current(a)).toMatchObject({ status: 'failed', failure: { kind: 'merge' } });
    expect((await current(a)).failure?.reason).toMatch(/No check result/);
    await drain();
    expect(host.merged).toContain(b);
  });

  it('the sweep gives a board with merging globs and no head one', async () => {
    const board = await newBoard();
    const a = await ready(board, 'A');
    // The nudge is lost.
    await database.db.update(schema.outbox).set({ state: 'done' }).where(eq(schema.outbox.state, 'pending'));
    expect(await headsOf(board)).toEqual([]);
    await new ReconcileWatch(store, globs, () => undefined, () => clockMs).sweep(false);
    expect(await headsOf(board)).toEqual([a]);
    await drain();
  });

  it('the base branch is the repo default branch from the host, not a board setting', async () => {
    const board = await newBoard();
    host.trunk = 'trunk';
    expect(await executors.refresh_base_branch?.({ kind: 'refresh_base_branch', globId: `board-${String(board)}`, boardId: board }, null, { globs })).toBe('done');
    expect((await boardOf(board))?.baseBranch).toBe('trunk');
    await ready(board, 'A');
    host.bases.length = 0;
    await drain();
    expect(host.bases.length).toBeGreaterThan(0);
    expect(new Set(host.bases)).toEqual(new Set(['trunk']));
    host.trunk = 'main';
  });
});

describe('migration 0086: the merge head index', () => {
  const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
  const DB = `slop_test_mergehead_${process.pid}`;
  const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
  const TAG = '0086_merge_line_head';
  let admin: Database;
  let database: Database;

  const insert = (id: string, status: string, data: Record<string, unknown>) =>
    database.db.execute(
      sql`insert into globs (id, board_id, version, status, type, planner, data, updated_at)
          values (${id}, 1, 1, ${status}, 'same', 'x', ${JSON.stringify({ status, ...data })}::jsonb, now())`,
    );

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    const folder = await mkdtemp(join(tmpdir(), 'merge-head-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // Everything before the migration, then merging globs of the kinds that exist at deploy, then the migration.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(URL_, folder);
    database = connect(URL_);
    await database.db.execute(sql`insert into boards (id, name, base_branch, time_zone, environments, sensitive_paths, version) overriding system value values (1, 'b', 'main', 'UTC', '[]'::jsonb, '[]'::jsonb, 1)`);
    await insert('s1t1', 'merging', {});
    await insert('s1t2', 'merging', {});
    await insert('s1t3', 'merging', { mergeNote: 'in flight when the line ships' });
    await runMigrations(URL_, new URL('../drizzle', import.meta.url).pathname);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
  });

  it('applies with merging globs that have no line, and creates the index', async () => {
    const rows = await database.db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname = 'globs_merge_head_idx'`);
    expect(rows[0]?.indexdef).toContain('UNIQUE');
    expect((await database.db.execute(sql`select id from globs where status = 'merging'`)).length).toBe(3);
  });

  it('allows any number of waiting globs and one head per board, and not a second', async () => {
    await insert('s1t4', 'merging', { mergeLine: { joinedAt: '2026-10-16T09:00:00Z' } });
    await insert('s1t5', 'merging', { mergeLine: { joinedAt: '2026-10-16T09:01:00Z', head: { since: '2026-10-16T09:02:00Z' } } });
    await expect(insert('s1t6', 'merging', { mergeLine: { joinedAt: '2026-10-16T09:03:00Z', head: { since: '2026-10-16T09:04:00Z' } } })).rejects.toThrow();
    // A glob that left `merging` no longer counts.
    await insert('s1t7', 'failed', { mergeLine: { joinedAt: '2026-10-16T09:03:00Z', head: { since: '2026-10-16T09:04:00Z' } } });
  });
});

describe('no merge queue code remains', () => {
  const ROOT = new URL('../../../', import.meta.url).pathname;
  const GONE = /merge_queue|merge_group|enqueuePullRequest|read_merge_queue|dequeue_merge|gh-readonly-queue/;
  /** The tests that assert the words are gone, so they name them. */
  const ASSERTING = new Set(['apps/server/test/merge-train.test.ts', 'apps/server/test/checks-workflow.test.ts', 'catalog/scripts/setup-repo.test.sh']);
  const SKIP = new Set(['node_modules', 'dist', '.git']);

  const walk = async (dir: string, found: string[] = []): Promise<string[]> => {
    for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) await walk(path, found);
      } else if (!ASSERTING.has(path) && /\.(ts|tsx|js|mjs|json|ya?ml|sh|md)$/.test(entry.name)) {
        found.push(path);
      }
    }
    return found;
  };

  it('names none of the GitHub merge queue in apps, packages, catalog or .github', async () => {
    const files = (await Promise.all(['apps', 'packages', 'catalog', '.github'].map((dir) => walk(dir)))).flat();
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const file of files) if (GONE.test(await readFile(join(ROOT, file), 'utf8'))) hits.push(file);
    expect(hits).toEqual([]);
  });
});
