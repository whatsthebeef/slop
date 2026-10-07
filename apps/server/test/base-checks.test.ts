import { BoardService, GlobService, machine } from '@slop/core';
import type { Board, CheckFailure, Effect, Glob, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import type { CodeHost } from '../src/codehost.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { githubDeliveryHandler } from '../src/github/events.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';

const REPO = 'acme/app';
const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const typecheck: CheckFailure = {
  name: 'Check',
  step: 'Type check',
  lines: ["apps/server/test/kb-routes.test.ts(31,7): error TS2739: Property 'commentOnce' is missing in type"],
  url: 'https://github.com/acme/app/actions/runs/1',
};

/** A code host with a scripted base branch and per-commit check results. */
class FakeHost implements CodeHost {
  readonly configured = true;
  baseHead = { sha: 'm1', subject: 's1f5: Slice 8, part 1' };
  checks: Record<string, { state: 'passed' | 'pending' | 'failed'; failure: CheckFailure | null }> = {};
  mergeStateNow: 'passed' | 'failed' | 'behind' | 'conflict' = 'failed';
  headSha = 'h1';
  readonly updated: { pr: number; sha: string }[] = [];

  connection = () => Promise.resolve({ configured: true, connected: true, installUrl: null, appName: null });
  provision = (_repo: unknown, glob: Glob) => Promise.resolve({ branch: glob.id, pr: { number: 7, headSha: this.headSha } });
  openDraftPr = () => Promise.resolve(null);
  syncLabels = () => Promise.resolve();
  closePr = () => Promise.resolve();
  deleteBranch = () => Promise.resolve();
  reopenPr = () => Promise.resolve('reopened' as const);
  mergeState = () => Promise.resolve({ sha: this.headSha, state: this.mergeStateNow });
  completedCheckRun = () => Promise.resolve(null);
  markReady = () => Promise.resolve({ wasDraft: true, sha: this.headSha });
  conflictFiles = () => Promise.resolve(['src/a.ts']);
  commentOnce = () => Promise.resolve('posted' as const);
  diffSummary = () => Promise.resolve({ changedLines: 1, files: [] });
  readFile = () => Promise.resolve(null);
  commitFiles = () => Promise.resolve({ parent: null, files: [] });
  commitDiffSummary = () => Promise.resolve({ changedLines: 0, files: [] });
  squashMerge = () => Promise.resolve({ outcome: 'merged' as const, sha: 'm9' });
  headOf = () => Promise.resolve(this.baseHead);
  commitChecks = (_repo: unknown, sha: string) => Promise.resolve(this.checks[sha] ?? { state: 'passed' as const, failure: null });
  updateBranchResult: 'updating' | 'up_to_date' | 'conflict' = 'updating';
  updateBranch = (_repo: unknown, pr: number, sha: string) => {
    this.updated.push({ pr, sha });
    return Promise.resolve(this.updateBranchResult);
  };
}

describe('a red base branch', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let boards: BoardService;
  let host: FakeHost;
  let executors: ReturnType<typeof codeHostExecutors>;
  let handle: ReturnType<typeof githubDeliveryHandler>;
  let n = 0;

  const boardOf = (boardId: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(boardId));

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('basechecks'));
    store = new PgStore(database.db);
    const notifier = { publish: () => undefined };
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boards = new BoardService({ store, notifier });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: REPO,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: DEV,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    host = new FakeHost();
    executors = codeHostExecutors(host, boardOf, new FileRoutines('/nonexistent/routines.json'), boards);
    // These deliveries never carry review comments.
    const findings = { recordCodeRabbitComment: () => Promise.reject(new Error('not used here')) };
    handle = githubDeliveryHandler({ db: database.db, globs, findings, boardOf, github: { deleteBranch: () => Promise.resolve() } });
  });

  afterAll(() => drop());

  const current = async (id: string) => unwrap(await globs.get(DEV, id)).glob;

  const newOpenGlob = async (title: string) => {
    const created = unwrap(
      await globs.create(DEV, { boardId: 1, title, summary: '', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    );
    await globs.applyEvent(created.id, (g, ctx) => machine.provisioned(g, { branch: g.id, pr: { number: 7, headSha: host.headSha } }, ctx));
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(created.id);
      if (g === null) throw new Error('missing');
      await tx.updateGlob({ ...g, status: 'pr_open', pr: { number: 7, state: 'ready', headSha: host.headSha }, version: g.version + 1 }, g.version);
    });
    return created.id;
  };

  const pending = async (globId: string, kind: Effect['kind']) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter((row) => row.kind === kind && row.state === 'pending');

  /** Runs every pending effect of `kind` on `globId` as the outbox would. */
  const run = async (globId: string, kind: Effect['kind']) => {
    const executor = executors[kind];
    if (executor === undefined) throw new Error(`No executor for ${kind}`);
    const outcomes = [];
    for (const row of await pending(globId, kind)) {
      outcomes.push(await executor(row.effect, await globs.peek(globId), { globs }));
      await database.db.update(schema.outbox).set({ state: 'done' }).where(and(eq(schema.outbox.id, row.id), eq(schema.outbox.state, 'pending')));
    }
    return outcomes;
  };

  const checkRunDelivery = (branch: string, status = 'completed') => ({
    id: `d-${String(++n)}`,
    event: 'check_run',
    payload: {
      repository: { full_name: REPO },
      check_run: { name: 'Check', head_sha: 'x', status, conclusion: 'failure', check_suite: { head_branch: branch } },
    },
  });

  it("explains a glob's failed checks, with the failing step and first error", async () => {
    host.baseHead = { sha: 'm0', subject: 's1t1: earlier work' };
    host.checks = { h1: { state: 'failed', failure: { ...typecheck, lines: ['src/own.ts(1,1): error TS1: its own mistake'] } } };
    const own = await newOpenGlob('Own failure');
    await globs.applyEvent(own, (g, ctx) => machine.checksChanged(g, ctx));
    expect(await run(own, 'refresh_checks')).toEqual(['done']);
    const glob = await current(own);
    expect(glob.headChecks).toMatchObject({ sha: 'h1', state: 'failed', failure: { name: 'Check', step: 'Type check', lines: ['src/own.ts(1,1): error TS1: its own mistake'] } });
    expect(glob.headChecks?.inheritedFrom).toBeUndefined();
  });

  it('a check finishing on the base branch queues one read of its head, not one per event', async () => {
    expect(await handle(checkRunDelivery('main', 'in_progress'))).toBe(true);
    expect(await pending('board-1', 'refresh_base_checks')).toHaveLength(0);
    await handle(checkRunDelivery('main'));
    await handle(checkRunDelivery('main'));
    expect(await pending('board-1', 'refresh_base_checks')).toHaveLength(1);
    await handle(checkRunDelivery('some-feature-branch'));
    expect(await pending('board-1', 'refresh_base_checks')).toHaveLength(1);
    // Run it to clear: main is green here.
    host.checks = {};
    expect(await run('board-1', 'refresh_base_checks')).toEqual(['done']);
    expect((await boardOf(1))?.baseChecks).toMatchObject({ state: 'passed', sha: 'm0' });
  });

  it('marks failures that match a red base as inherited, names the glob that merged, and tells the board', async () => {
    host.baseHead = { sha: 'm1', subject: 's1f5: Slice 8, part 1' };
    host.checks = { m1: { state: 'failed', failure: typecheck }, h1: { state: 'failed', failure: typecheck } };
    // This glob failed on the same error before the base's result was known.
    const early = await newOpenGlob('Fails the same way');
    await globs.applyEvent(early, (g, ctx) => machine.checksChanged(g, ctx));
    await run(early, 'refresh_checks');
    expect((await current(early)).headChecks?.inheritedFrom).toBeUndefined();

    await handle(checkRunDelivery('main'));
    expect(await run('board-1', 'refresh_base_checks')).toEqual(['done']);
    expect((await boardOf(1))?.baseChecks).toMatchObject({ state: 'failed', sha: 'm1', since: 's1f5', failure: { name: 'Check' } });
    expect((await current(early)).headChecks?.inheritedFrom).toEqual({ base: 'main', since: 's1f5' });

    // A glob whose checks fail after the base's result is marked as the failure is recorded.
    const late = await newOpenGlob('Created on a red base');
    await globs.applyEvent(late, (g, ctx) => machine.checksChanged(g, ctx));
    await run(late, 'refresh_checks');
    expect((await current(late)).headChecks?.inheritedFrom).toEqual({ base: 'main', since: 's1f5' });

    // Reading the same result again changes nothing.
    await handle(checkRunDelivery('main'));
    const before = (await current(early)).version;
    await run('board-1', 'refresh_base_checks');
    expect((await current(early)).version).toBe(before);
  });

  it('a failure that differs from the base failure is not inherited', async () => {
    host.checks = { ...host.checks, h1: { state: 'failed', failure: { ...typecheck, name: 'Test', lines: ['FAIL src/a.test.ts'] } } };
    const own = await newOpenGlob('Fails differently');
    await globs.applyEvent(own, (g, ctx) => machine.checksChanged(g, ctx));
    await run(own, 'refresh_checks');
    const glob = await current(own);
    expect(glob.headChecks?.state).toBe('failed');
    expect(glob.headChecks?.inheritedFrom).toBeUndefined();
  });

  it('when the base goes green, globs whose failure was inherited are updated, once, and others are left', async () => {
    host.checks = { ...host.checks, h1: { state: 'failed', failure: typecheck }, m2: { state: 'passed', failure: null } };
    const inherited = (await globs.peekAll(1, { status: ['pr_open'] })).filter((g) => g.headChecks?.inheritedFrom !== undefined).map((g) => g.id);
    const own = (await globs.peekAll(1, { status: ['pr_open'] })).filter((g) => g.headChecks?.state === 'failed' && g.headChecks.inheritedFrom === undefined).map((g) => g.id);
    expect(inherited).toHaveLength(2);
    expect(own).toHaveLength(2);

    host.baseHead = { sha: 'm2', subject: 's1b5: Fix main' };
    await handle(checkRunDelivery('main'));
    await run('board-1', 'refresh_base_checks');
    expect((await boardOf(1))?.baseChecks).toMatchObject({ state: 'passed', sha: 'm2' });
    for (const id of inherited) expect(await pending(id, 'update_branch')).toHaveLength(1);
    for (const id of own) expect(await pending(id, 'update_branch')).toHaveLength(0);

    for (const id of inherited) expect(await run(id, 'update_branch')).toEqual(['done']);
    expect(host.updated).toHaveLength(2);
    expect(host.updated.every((u) => u.sha === 'h1')).toBe(true);

    // The base staying green queues nothing more.
    await handle(checkRunDelivery('main'));
    host.baseHead = { sha: 'm3', subject: 's1t9: more' };
    host.checks = { ...host.checks, m3: { state: 'passed', failure: null } };
    await run('board-1', 'refresh_base_checks');
    for (const id of inherited) expect(await pending(id, 'update_branch')).toHaveLength(0);
  });

  it('drops an update for a head that has moved on, and flags a conflict the update runs into', async () => {
    host.baseHead = { sha: 'm4', subject: 's1f5: breaks main again' };
    host.checks = { m4: { state: 'failed', failure: typecheck }, h1: { state: 'failed', failure: typecheck }, m5: { state: 'passed', failure: null } };
    const moved = await newOpenGlob('Pushed to meanwhile');
    const conflicting = await newOpenGlob('Conflicts with the fix');
    for (const id of [moved, conflicting]) {
      await globs.applyEvent(id, (g, ctx) => machine.checksChanged(g, ctx));
      await run(id, 'refresh_checks');
    }
    await handle(checkRunDelivery('main'));
    await run('board-1', 'refresh_base_checks');
    host.baseHead = { sha: 'm5', subject: 's1b5: fixed' };
    await handle(checkRunDelivery('main'));
    await run('board-1', 'refresh_base_checks');
    expect(await pending(moved, 'update_branch')).toHaveLength(1);

    // Someone pushed first: the head checks are reset, so there is nothing to update.
    await globs.applyEvent(moved, (g, ctx) => machine.commitPushed(g, { sha: 'h2', runId: null }, ctx));
    const before = host.updated.length;
    expect(await run(moved, 'update_branch')).toEqual(['dropped']);
    expect(host.updated).toHaveLength(before);

    host.updateBranchResult = 'conflict';
    expect(await run(conflicting, 'update_branch')).toEqual(['done']);
    expect((await current(conflicting)).conflict).toMatchObject({ base: 'main', files: ['src/a.ts'] });
  });
});
