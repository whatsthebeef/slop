import { BoardService, GlobService, machine } from '@slop/core';
import type { Board, CheckFailure, Effect, Glob, Result } from '@slop/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import { QueueDetectionError } from '../src/codehost.js';
import type { MergeQueueEntry, PrSnapshot } from '../src/codehost.js';
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
const FAILURE: CheckFailure = { name: 'checks', step: 'test', lines: ['Error: boom'], url: 'https://ci.example/run/1' };

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

class FakeHost extends FakeCodeHost {
  pr: PrSnapshot = { state: 'open', draft: false, headSha: HEAD, mergeSha: null };
  entry: MergeQueueEntry | null = { position: 2, state: 'queued' };
  squashResult: Awaited<ReturnType<FakeCodeHost['squashMerge']>> = { outcome: 'queued', position: 3, state: 'queued' };
  squashError: Error | null = null;
  dequeued = 0;
  dequeueResult: 'dequeued' | 'not_queued' = 'dequeued';
  readonly checked: string[] = [];
  override prState = () => Promise.resolve(this.pr);
  override mergeQueueEntry = () => Promise.resolve(this.entry);
  override squashMerge: FakeCodeHost['squashMerge'] = () => (this.squashError === null ? Promise.resolve(this.squashResult) : Promise.reject(this.squashError));
  override dequeue = () => {
    this.dequeued += 1;
    return Promise.resolve(this.dequeueResult);
  };
  override conflictFiles = () => Promise.resolve(['a.ts']);
  override commitChecks = (_repo: unknown, sha: string) => {
    this.checked.push(sha);
    return Promise.resolve(sha === 'g1' ? { state: 'failed' as const, failure: FAILURE } : { state: 'pending' as const, failure: null });
  };
}

describe('merge queue: following the host queue through executors and webhooks', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let host: FakeHost;
  let handle: ReturnType<typeof githubDeliveryHandler>;
  let executors: ReturnType<typeof codeHostExecutors>;
  const nowMs = Date.parse('2026-10-15T12:00:00Z');
  const clock = () => new Date(nowMs).toISOString();
  let n = 0;
  const deliveryId = () => `delivery-${++n}`;

  const boardOf = (boardId: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(boardId));

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('merge_queue'));
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: clock },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      for (const baseBranch of ['main', 'develop']) {
        const board = await tx.insertBoard({ name: baseBranch, repo: REPO, baseBranch, timeZone: 'UTC', defaultRoutineOwner: DEV, environments: [], sensitivePaths: [] });
        await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
      }
    });
    host = new FakeHost();
    handle = githubDeliveryHandler({ db: database.db, globs, boardOf, github: host });
    executors = codeHostExecutors(
      host,
      boardOf,
      new FileRoutines('/nonexistent/routines.json'),
      new BoardService({ store, notifier: { publish: () => undefined } }),
      clock,
    );
  });

  afterAll(() => drop());

  const current = async (id: string) => unwrap(await globs.get(DEV, id)).glob;

  /** A same whose PR is being merged; `queue` records it in the host's merge queue. */
  const mergingGlob = async (title: string, options: { queue?: boolean; since?: string; boardId?: number; prNumber?: number } = {}): Promise<string> => {
    const created = unwrap(
      await globs.create(DEV, { boardId: options.boardId ?? 1, title, type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    );
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(created.id);
      if (g === null) throw new Error('missing');
      const next: Glob = {
        ...g,
        status: 'merging',
        pr: { number: options.prNumber ?? 7, state: 'ready', headSha: HEAD },
        headChecks: { sha: HEAD, state: 'passed' },
        ...(options.queue === true && { mergeQueue: { since: options.since ?? clock(), sha: HEAD, position: 2, state: 'queued' as const } }),
        version: g.version + 1,
      };
      await tx.updateGlob(next, g.version);
    });
    return created.id;
  };

  const pending = async (globId: string, kind: Effect['kind']) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter((row) => row.kind === kind && row.state === 'pending');

  /** Runs the pending effects of `kind` on `globId` as the outbox would, marking each done. */
  const run = async (globId: string, kind: Effect['kind'], attempt?: { final: boolean }) => {
    const executor = executors[kind];
    if (executor === undefined) throw new Error(`No executor for ${kind}`);
    const outcomes = [];
    for (const row of await pending(globId, kind)) {
      outcomes.push(await executor(row.effect, await globs.peek(globId), { globs }, attempt));
      await database.db.update(schema.outbox).set({ state: 'done' }).where(eq(schema.outbox.id, row.id));
    }
    return outcomes;
  };

  const queueDelivery = (event: string, payload: Record<string, unknown>) => ({ id: deliveryId(), event, payload: { repository: { full_name: REPO }, ...payload } });
  const prEvent = (globId: string, action: string, extra: Record<string, unknown> = {}) =>
    queueDelivery('pull_request', {
      action,
      ...extra,
      pull_request: { number: 7, draft: false, merged: false, merge_commit_sha: null, head: { ref: globId, sha: HEAD } },
    });
  const checkRun = (branch: string, conclusion: string | null, sha = 'g1') =>
    queueDelivery('check_run', {
      check_run: { name: 'checks', head_sha: sha, status: conclusion === null ? 'in_progress' : 'completed', conclusion, check_suite: { head_branch: branch } },
    });

  it('a queued result records the entry and keeps the glob merging; head check events do not enqueue again', async () => {
    host.squashResult = { outcome: 'queued', position: 3, state: 'queued' };
    const id = await mergingGlob('Enqueue');
    const effect: Effect = { kind: 'squash_merge', globId: id, generation: 1, sha: HEAD };
    expect(await executors.squash_merge?.(effect, await current(id), { globs }, undefined)).toBe('done');
    expect(await current(id)).toMatchObject({ status: 'merging', mergeQueue: { sha: HEAD, position: 3, state: 'queued' } });
    // A check event on the queued head would otherwise ask for another merge each time.
    await globs.applyEvent(id, (g, ctx) => machine.checksCompleted(g, { sha: HEAD, passed: true }, ctx));
    expect(await pending(id, 'squash_merge')).toEqual([]);
  });

  it('a failed queue check then a dequeue fails the glob with the reason and the failing check lines', async () => {
    const id = await mergingGlob('Queue check fails', { queue: true, since: new Date(nowMs - 10 * 60_000).toISOString() });
    host.entry = null;
    await handle(checkRun('gh-readonly-queue/main/pr-7-abc123', 'failure'));
    expect((await current(id)).mergeQueue?.failedSha).toBe('g1');
    await handle(prEvent(id, 'dequeued', { reason: 'CI_FAILURE' }));
    expect(await pending(id, 'read_merge_queue')).toHaveLength(2);
    await run(id, 'read_merge_queue');
    const after = await current(id);
    expect(after.status).toBe('failed');
    expect(after.mergeQueue).toBeNull();
    expect(after.failure).toMatchObject({ kind: 'merge', checks: FAILURE });
    expect(after.failure?.reason).toContain('Removed from the merge queue: its checks failed');
    expect(after.failure?.reason).toContain('Error: boom');
    expect(host.checked).toContain('g1');
    host.entry = { position: 2, state: 'queued' };
  });

  it('a failed queue check is recorded only on the glob whose PR the group names, so another PR\'s failure is not shown on this one', async () => {
    const since = new Date(nowMs - 10 * 60_000).toISOString();
    const failing = await mergingGlob('Names the group', { queue: true, since, prNumber: 41 });
    const bystander = await mergingGlob('Queued behind', { queue: true, since, prNumber: 42 });
    host.entry = null;
    host.checked.length = 0;
    await handle(checkRun('gh-readonly-queue/main/pr-41-abc123', 'failure'));
    expect((await current(failing)).mergeQueue?.failedSha).toBe('g1');
    expect((await current(bystander)).mergeQueue?.failedSha).toBeUndefined();
    // The bystander is then removed for no stated reason: it must not read as a check failure with the other PR's lines.
    await run(bystander, 'read_merge_queue');
    const after = await current(bystander);
    expect(after.failure?.reason).toBe('Left the merge queue without merging');
    expect(after.failure?.checks).toBeUndefined();
    expect(host.checked).not.toContain('g1');
    host.entry = { position: 2, state: 'queued' };
  });

  it('merge_group reasons: `merged` (any case) means the merge is in flight; other group reasons are not a per-PR dequeue reason', async () => {
    const since = new Date(nowMs - 10 * 60_000).toISOString();
    host.entry = null;
    const id = await mergingGlob('Group merged', { queue: true, since });
    await handle(queueDelivery('merge_group', { action: 'destroyed', reason: 'merged', merge_group: { head_sha: 'g4', base_ref: 'refs/heads/main' } }));
    const [row] = await pending(id, 'read_merge_queue');
    expect(row?.effect).toMatchObject({ reason: 'merged' });
    // The PR still reads open: wait and retry rather than fail the glob.
    await expect(run(id, 'read_merge_queue')).rejects.toThrow(/not merged yet/);
    expect((await current(id)).status).toBe('merging');
    // Once it reads merged, the merged path takes it.
    host.pr = { state: 'merged', draft: false, headSha: HEAD, mergeSha: 'm5' };
    await globs.applyEvent(id, (g, ctx) => machine.mergeQueueEvent(g, { kind: 'group', reason: 'merged' }, ctx));
    await run(id, 'read_merge_queue');
    expect((await current(id)).status).toBe('reviewing');
    host.pr = { state: 'open', draft: false, headSha: HEAD, mergeSha: null };

    // An `invalidated` group says nothing about this PR: no reason travels, so it is not a dequeue.
    const other = await mergingGlob('Group invalidated', { queue: true, since });
    await handle(queueDelivery('merge_group', { action: 'destroyed', reason: 'invalidated', merge_group: { head_sha: 'g5', base_ref: 'refs/heads/main' } }));
    const [invalidated] = await pending(other, 'read_merge_queue');
    expect(invalidated?.effect).not.toHaveProperty('reason');
    host.entry = { position: 2, state: 'queued' };
  });

  it('a PR closed while queued fails the glob', async () => {
    const id = await mergingGlob('Closed in queue', { queue: true });
    await handle(prEvent(id, 'closed'));
    expect(await current(id)).toMatchObject({ status: 'failed', mergeQueue: null, failure: { reason: 'PR closed without merging' } });
  });

  it('a dequeue for a conflict returns the glob to pr_open with the conflict', async () => {
    const id = await mergingGlob('Queue conflict', { queue: true, since: new Date(nowMs - 10 * 60_000).toISOString() });
    host.entry = null;
    await handle(prEvent(id, 'dequeued', { reason: 'MERGE_CONFLICT' }));
    await run(id, 'read_merge_queue');
    expect(await current(id)).toMatchObject({ status: 'pr_open', mergeQueue: null, conflict: { base: 'main', files: ['a.ts'] }, failure: null });
    host.entry = { position: 2, state: 'queued' };
  });

  it('a manual dequeue and an unknown reason each fail the glob in words', async () => {
    host.entry = null;
    const manual = await mergingGlob('Manual dequeue', { queue: true, since: new Date(nowMs - 10 * 60_000).toISOString() });
    await handle(prEvent(manual, 'dequeued', { reason: 'MANUAL' }));
    await run(manual, 'read_merge_queue');
    expect((await current(manual)).failure?.reason).toBe('Removed from the merge queue');
    const odd = await mergingGlob('Odd dequeue', { queue: true, since: new Date(nowMs - 10 * 60_000).toISOString() });
    await handle(prEvent(odd, 'dequeued', { reason: 'SOMETHING_NEW' }));
    await run(odd, 'read_merge_queue');
    expect((await current(odd)).failure?.reason).toBe('Left the merge queue without merging');
    host.entry = { position: 2, state: 'queued' };
  });

  it('right after the enqueue, an entry the host does not show yet is retried, and at the last attempt the glob fails', async () => {
    host.entry = null;
    const id = await mergingGlob('Fresh entry', { queue: true });
    await handle(prEvent(id, 'dequeued'));
    await expect(run(id, 'read_merge_queue')).rejects.toThrow(/not merged yet/);
    expect((await current(id)).status).toBe('merging');
    await run(id, 'read_merge_queue', { final: true });
    expect((await current(id)).status).toBe('failed');
    host.entry = { position: 2, state: 'queued' };
  });

  it('a read that finds the entry updates "N ahead"; the same entry changes nothing', async () => {
    const id = await mergingGlob('Moves up', { queue: true });
    host.entry = { position: 1, state: 'merging' };
    await handle(queueDelivery('merge_group', { action: 'checks_requested', merge_group: { head_sha: 'g2', head_ref: 'refs/heads/gh-readonly-queue/main/pr-7-abc', base_ref: 'refs/heads/main' } }));
    await run(id, 'read_merge_queue');
    expect((await current(id)).mergeQueue).toMatchObject({ position: 1, state: 'merging' });
    const before = await current(id);
    await handle(queueDelivery('merge_group', { action: 'checks_requested', merge_group: { head_sha: 'g2', base_ref: 'refs/heads/main' } }));
    await run(id, 'read_merge_queue');
    expect((await current(id)).version).toBe(before.version);
    host.entry = { position: 2, state: 'queued' };
  });

  it('the queue merging the PR goes through the merged path (webhook, and a read that sees it merged)', async () => {
    const hooked = await mergingGlob('Merged by queue', { queue: true });
    await handle(
      queueDelivery('pull_request', {
        action: 'closed',
        pull_request: { number: 7, draft: false, merged: true, merge_commit_sha: 'm9', head: { ref: hooked, sha: HEAD } },
      }),
    );
    expect(await current(hooked)).toMatchObject({ status: 'reviewing', mergeQueue: null });

    const read = await mergingGlob('Read sees merge', { queue: true });
    await handle(prEvent(read, 'dequeued', { reason: 'SUCCEEDED' }));
    host.pr = { state: 'merged', draft: false, headSha: HEAD, mergeSha: 'm8' };
    await run(read, 'read_merge_queue');
    expect(await current(read)).toMatchObject({ status: 'reviewing', mergeQueue: null });
    host.pr = { state: 'open', draft: false, headSha: HEAD, mergeSha: null };
  });

  it('merge group and queue check webhooks refresh only the queued globs of that board', async () => {
    const queuedMain = await mergingGlob('Queued on main', { queue: true });
    const plainMain = await mergingGlob('Merging on main');
    const queuedDevelop = await mergingGlob('Queued on develop', { queue: true, boardId: 2 });
    await handle(queueDelivery('merge_group', { action: 'destroyed', reason: 'invalidated', merge_group: { head_sha: 'g3', base_ref: 'refs/heads/main' } }));
    expect(await pending(queuedMain, 'read_merge_queue')).toHaveLength(1);
    expect(await pending(plainMain, 'read_merge_queue')).toHaveLength(0);
    expect(await pending(queuedDevelop, 'read_merge_queue')).toHaveLength(0);

    await handle(checkRun('gh-readonly-queue/develop/pr-7-abc123', 'success'));
    expect(await pending(queuedDevelop, 'read_merge_queue')).toHaveLength(1);
    expect(await pending(queuedMain, 'read_merge_queue')).toHaveLength(1);
    // A check still running, and a payload without its merge group, say nothing.
    await handle(checkRun('gh-readonly-queue/develop/pr-7-abc123', null));
    await handle(queueDelivery('merge_group', { action: 'checks_requested' }));
    expect(await pending(queuedDevelop, 'read_merge_queue')).toHaveLength(1);
  });

  it('a duplicate delivery is ignored', async () => {
    const id = await mergingGlob('Duplicate', { queue: true });
    const delivery = prEvent(id, 'enqueued');
    expect(await handle(delivery)).toBe(true);
    expect(await handle(delivery)).toBe(false);
    expect(await pending(id, 'read_merge_queue')).toHaveLength(1);
  });

  it('a person queueing the PR in the host UI (glob not merging) schedules nothing', async () => {
    const created = unwrap(await globs.create(DEV, { boardId: 1, title: 'UI queue', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(created.id);
      if (g === null) throw new Error('missing');
      await tx.updateGlob({ ...g, status: 'pr_open', pr: { number: 7, state: 'ready', headSha: HEAD }, version: g.version + 1 }, g.version);
    });
    await handle(prEvent(created.id, 'enqueued'));
    expect(await pending(created.id, 'read_merge_queue')).toEqual([]);
  });

  it('Cancel merge on a queued glob dequeues it at the host; a PR the queue merged first is recorded as merged', async () => {
    host.dequeued = 0;
    const id = await mergingGlob('Cancel', { queue: true });
    unwrap(await globs.cancelMerge(DEV, id, (await current(id)).version));
    expect((await current(id)).status).toBe('pr_open');
    expect(await run(id, 'dequeue_merge')).toEqual(['done']);
    expect(host.dequeued).toBe(1);

    const late = await mergingGlob('Cancel too late', { queue: true });
    unwrap(await globs.cancelMerge(DEV, late, (await current(late)).version));
    host.dequeueResult = 'not_queued';
    host.pr = { state: 'merged', draft: false, headSha: HEAD, mergeSha: 'm7' };
    await run(late, 'dequeue_merge');
    expect((await current(late)).status).toBe('reviewing');
    host.dequeueResult = 'dequeued';
    host.pr = { state: 'open', draft: false, headSha: HEAD, mergeSha: null };
  });

  it('a delayed dequeue does not remove the entry of a merge started again after Cancel merge', async () => {
    host.dequeued = 0;
    const id = await mergingGlob('Cancel then merge again', { queue: true });
    unwrap(await globs.cancelMerge(DEV, id, (await current(id)).version));
    // The gate merged it again before the dequeue ran.
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(id);
      if (g === null) throw new Error('missing');
      await tx.updateGlob({ ...g, status: 'merging', version: g.version + 1 }, g.version);
    });
    expect((await current(id)).status).toBe('merging');
    expect(await run(id, 'dequeue_merge')).toEqual(['dropped']);
    expect(host.dequeued).toBe(0);
  });

  it('when the host cannot say whether there is a queue, the merge retries and at the last attempt hands the glob back', async () => {
    host.squashError = new QueueDetectionError('Could not read the merge rules of main');
    try {
      const id = await mergingGlob('Rules unreadable');
      const effect: Effect = { kind: 'squash_merge', globId: id, generation: 1, sha: HEAD };
      await expect(executors.squash_merge?.(effect, await current(id), { globs }, { final: false })).rejects.toBeInstanceOf(QueueDetectionError);
      expect((await current(id)).status).toBe('merging');
      expect(await executors.squash_merge?.(effect, await current(id), { globs }, { final: true })).toBe('done');
      expect(await current(id)).toMatchObject({ status: 'failed', failure: { kind: 'merge' } });
    } finally {
      host.squashError = null;
    }
  });
});
