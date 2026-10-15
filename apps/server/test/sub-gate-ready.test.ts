import { BoardService, GlobService, machine } from '@slop/core';
import type { Board, DiffSummary, Effect, Glob, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import type { MergeState } from '../src/codehost.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { githubDeliveryHandler } from '../src/github/events.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const REPO = 'acme/app';
const DEV = 'dev@example.com';
const HEAD = 'abcdef0123456789';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** A code host whose gate check run on the head may already have completed. */
class FakeHost extends FakeCodeHost {
  /** The completed gate check run on HEAD, or null while it is still running. */
  subGate: { passed: boolean } | null = null;
  readonly lookups: string[] = [];
  diff: DiffSummary = { changedLines: 10, files: ['src/a.ts'] };
  mergeStateNow: MergeState = 'pending';
  conflicting: string[] = [];

  override provision = (_repo: unknown, glob: Glob) => Promise.resolve({ branch: glob.id, pr: { number: 7, headSha: HEAD } });
  override mergeState = () => Promise.resolve({ sha: HEAD, state: this.mergeStateNow });
  override completedCheckRun = (_repo: unknown, sha: string, name: string) => {
    this.lookups.push(`${name}@${sha}`);
    return Promise.resolve(this.subGate === null ? null : { sha, passed: this.subGate.passed });
  };
  override markReady = () => Promise.resolve({ wasDraft: true, sha: HEAD });
  override conflictFiles = () => Promise.resolve(this.conflicting);
  override diffSummary = () => Promise.resolve(this.diff);
}

describe('a sub whose PR is ready', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let host: FakeHost;
  let handle: ReturnType<typeof githubDeliveryHandler>;
  /** A board whose policy still names the old `sub-gate` check. */
  let handleLegacy: ReturnType<typeof githubDeliveryHandler>;
  let executors: ReturnType<typeof codeHostExecutors>;
  let n = 0;
  const deliveryId = () => `delivery-${String(++n)}`;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('subgate'));
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: REPO,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: DEV,
        environments: [],
        sensitivePaths: ['infra/**'],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    const boardOf = (boardId: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(boardId));
    host = new FakeHost();
    // These deliveries never carry review comments.
    handle = githubDeliveryHandler({ db: database.db, globs, boardOf, github: host });
    handleLegacy = githubDeliveryHandler({ db: database.db, globs, boardOf, github: host, subGateCheck: () => Promise.resolve('sub-gate') });
    executors = codeHostExecutors(host, boardOf, new FileRoutines('/nonexistent/routines.json'), new BoardService({ store, notifier: { publish: () => undefined } }));
  });

  afterAll(() => drop());

  let globId: string;
  beforeEach(async () => {
    host.subGate = null;
    host.lookups.length = 0;
    host.diff = { changedLines: 10, files: ['src/a.ts'] };
    host.mergeStateNow = 'pending';
    const created = unwrap(
      await globs.create(DEV, {
        boardId: 1,
        title: 'Sub glob',
        type: 'sub',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    globId = created.id;
    await globs.applyEvent(globId, (g, ctx) =>
      machine.provisioned(g, { branch: g.id, pr: { number: 7, headSha: HEAD } }, ctx),
    );
  });

  const current = async () => unwrap(await globs.get(DEV, globId)).glob;
  const pending = async (kind: Effect['kind']) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter(
      (row) => row.kind === kind && row.state === 'pending',
    );
  /** Runs every pending effect of `kind` against the current glob, as the outbox would, and marks it done. */
  const run = async (kind: Effect['kind']) => {
    const executor = executors[kind];
    if (executor === undefined) throw new Error(`No executor for ${kind}`);
    const rows = await pending(kind);
    if (rows.length === 0) throw new Error(`No pending ${kind}`);
    const outcomes = [];
    for (const row of rows) {
      outcomes.push(await executor(row.effect, await current(), { globs }));
      await database.db
        .update(schema.outbox)
        .set({ state: 'done' })
        .where(and(eq(schema.outbox.id, row.id), eq(schema.outbox.state, 'pending')));
    }
    return outcomes;
  };
  const readyForReview = () => ({
    id: deliveryId(),
    event: 'pull_request',
    payload: {
      action: 'ready_for_review',
      pull_request: { number: 7, draft: false, merged: false, merge_commit_sha: null, head: { ref: globId, sha: HEAD } },
      repository: { full_name: REPO },
    },
  });

  const checkRun = (name: string, sha: string, conclusion: string) => ({
    id: deliveryId(),
    event: 'check_run',
    payload: {
      action: 'completed',
      check_run: { name, head_sha: sha, status: 'completed', conclusion, check_suite: { head_branch: globId } },
      repository: { full_name: REPO },
    },
  });
  const queuedEvaluations = async () => {
    const rows = await pending('evaluate_sub_gate');
    for (const row of rows) await database.db.update(schema.outbox).set({ state: 'done' }).where(eq(schema.outbox.id, row.id));
    return rows.length;
  };

  it('waits for the `checks` run on the PR head by default, not for a sub-gate run or a run on another sha', async () => {
    await handle(readyForReview());
    await queuedEvaluations();
    await handle(checkRun('sub-gate', HEAD, 'success'));
    await handle(checkRun('checks', 'ffffffffffffffff', 'success'));
    await handle(checkRun('checks', HEAD, 'failure'));
    await handle(checkRun('checks', HEAD, 'skipped'));
    expect(await queuedEvaluations()).toBe(0);
    await handle(checkRun('checks', HEAD, 'success'));
    expect(await queuedEvaluations()).toBe(1);
  });

  it("a board whose policy names `sub-gate` waits for that run and ignores `checks`", async () => {
    await handleLegacy(readyForReview());
    await queuedEvaluations();
    await handleLegacy(checkRun('checks', HEAD, 'success'));
    expect(await queuedEvaluations()).toBe(0);
    await handleLegacy(checkRun('sub-gate', HEAD, 'success'));
    expect(await queuedEvaluations()).toBe(1);
  });

  it('looks up the default `checks` run by name on the PR head when its webhook was missed', async () => {
    await handle(readyForReview());
    await queuedEvaluations();
    host.subGate = { passed: true };
    const glob = await current();
    const refresh = executors.refresh_sub_gate;
    if (refresh === undefined) throw new Error('No executor for refresh_sub_gate');
    expect(await refresh({ kind: 'refresh_sub_gate', globId: globId, generation: glob.generation }, glob, { globs })).toBe('done');
    expect(host.lookups).toEqual([`checks@${HEAD}`]);
    expect(await queuedEvaluations()).toBe(1);
  });

  it('a sub is evaluated as soon as its PR is ready, without its checks, and merges', async () => {
    // Checks haven't run (or are still running): the sub merges anyway; they run on the base afterwards.
    await handle(readyForReview());
    expect((await current()).status).toBe('pr_open');
    expect(await run('evaluate_sub_gate')).toEqual(['done']);
    expect((await current()).status).toBe('merging');
    await run('squash_merge');
    expect((await current()).status).toBe('reviewing');
    expect(host.lookups).toEqual([]);
  });

  it('a sub the policy flags converts to a same at ready', async () => {
    host.diff = { changedLines: 10, files: ['infra/main.tf'] };
    await handle(readyForReview());
    await run('evaluate_sub_gate');
    const glob = await current();
    expect(glob.type).toBe('same');
    expect(glob.status).toBe('pr_open');
  });

  it('a sub touching a risk path (`**/stacks/**`) converts to a same at ready, however small, with cause risk_path', async () => {
    host.diff = { changedLines: 4, files: ['src/a.ts', 'services/app/stacks/app.yaml'] };
    await handle(readyForReview());
    await run('evaluate_sub_gate');
    const glob = await current();
    expect(glob.type).toBe('same');
    expect(glob.status).toBe('pr_open');
    const verdicts = await store.transaction((tx) => tx.listBoardEvents(1, '2000-01-01T00:00:00.000Z', ['SubReviewCompleted']));
    expect(verdicts.filter((e) => e.globId === globId).at(-1)?.data).toMatchObject({
      passed: false,
      reason: 'Touches risk paths: services/app/stacks/app.yaml',
      cause: 'risk_path',
      changedLines: 4,
    });
  });

  it("a path the board's merge policy lists as a risk path converts a sub too", async () => {
    const own = codeHostExecutors(host, (id) => store.transaction((tx) => tx.getBoard(id)), new FileRoutines('/nonexistent/routines.json'), new BoardService({ store, notifier: { publish: () => undefined } }), undefined, null, null, undefined, undefined, null, null, undefined, () => Promise.resolve({ riskPaths: ['.sstor/**'] }));
    host.diff = { changedLines: 4, files: ['.sstor/config.json'] };
    await handle(readyForReview());
    const row = (await pending('evaluate_sub_gate'))[0];
    if (row === undefined) throw new Error('No pending evaluate_sub_gate');
    await own.evaluate_sub_gate?.(row.effect, await current(), { globs });
    expect((await current()).type).toBe('same');
  });

  it("generated files (the defaults without a merge policy) don't count toward the size, and the verdict says how many", async () => {
    await store.transaction((tx) => tx.setSubLimit(1, 5000, 200));
    try {
      host.diff = { changedLines: 3300, files: ['src/a.ts', 'pnpm-lock.yaml'], fileLines: { 'src/a.ts': 60, 'pnpm-lock.yaml': 3240 } };
      await handle(readyForReview());
      await run('evaluate_sub_gate');
      expect((await current()).status).toBe('merging');
      const verdicts = await store.transaction((tx) => tx.listBoardEvents(1, '2000-01-01T00:00:00.000Z', ['SubReviewCompleted']));
      expect(verdicts.filter((e) => e.globId === globId).at(-1)?.data).toMatchObject({ passed: true, changedLines: 60, ignoredLines: 3240 });
    } finally {
      await store.transaction((tx) => tx.setSubLimit(1, 200, 5000));
    }
  });

  it('a conflict found while merging returns the glob to pr_open with the conflict recorded', async () => {
    await handle(readyForReview());
    await globs.applyEvent(globId, (g, ctx) => machine.subGateCompleted(g, { sha: HEAD, passed: true, reason: null }, ctx));
    expect((await current()).status).toBe('merging');
    host.mergeStateNow = 'conflict';
    host.conflicting = ['src/a.ts'];
    expect(await run('refresh_checks')).toEqual(['done']);
    const glob = await current();
    expect(glob.status).toBe('pr_open');
    expect(glob.failure).toBeNull();
    expect(glob.conflict).toMatchObject({ base: 'main', files: ['src/a.ts'] });
    host.conflicting = [];
  });

  it('a merge refused for a modified head takes the real head instead of failing the glob (s15b103)', async () => {
    const MOVED = '0123456789abcdef';
    await handle(readyForReview());
    await run('evaluate_sub_gate');
    expect((await current()).status).toBe('merging');
    const { squashMerge, prState } = host;
    host.squashMerge = () => Promise.resolve({ outcome: 'refused', reason: 'Head branch was modified. Review and try the merge again.' });
    host.prState = () => Promise.resolve({ state: 'open', draft: false, headSha: MOVED, mergeSha: null });
    try {
      await run('squash_merge');
      const glob = await current();
      expect(glob.status).not.toBe('failed');
      expect(glob.pr?.headSha).toBe(MOVED);
    } finally {
      host.squashMerge = squashMerge;
      host.prState = prState;
    }
  });

  it('mark_ready on an already-ready PR records the head GitHub reports, not the stored one (s15b103)', async () => {
    const MOVED = '0123456789abcdef';
    unwrap(await globs.requestReady(DEV, globId, null));
    const { markReady } = host;
    host.markReady = () => Promise.resolve({ wasDraft: false, sha: MOVED });
    try {
      await run('mark_pr_ready');
    } finally {
      host.markReady = markReady;
    }
    const glob = await current();
    expect(glob.status).toBe('pr_open');
    expect(glob.pr).toMatchObject({ state: 'ready', headSha: MOVED });
  });

  it('the policy decides with the learned limit as it is now, and records its cause, size and limit (s15f8)', async () => {
    await store.transaction((tx) => tx.setSubLimit(1, 5000, 200));
    try {
      host.diff = { changedLines: 250, files: ['src/a.ts'] };
      await handle(readyForReview());
      await run('evaluate_sub_gate');
      const glob = await current();
      expect(glob.type).toBe('same');
      const verdicts = await store.transaction((tx) => tx.listBoardEvents(1, '2000-01-01T00:00:00.000Z', ['SubReviewCompleted']));
      expect(verdicts.filter((e) => e.globId === globId).at(-1)?.data).toMatchObject({
        passed: false,
        reason: 'Changes 250 lines (limit 200)',
        cause: 'size',
        changedLines: 250,
        limit: 200,
      });
    } finally {
      await store.transaction((tx) => tx.setSubLimit(1, 200, 5000));
    }
  });
});
