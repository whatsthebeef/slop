import { GlobService, machine } from '@slop/core';
import type { Board, DiffSummary, Effect, Glob, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import type { CodeHost, MergeState } from '../src/codehost.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { githubDeliveryHandler } from '../src/github/events.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';

const REPO = 'acme/app';
const DEV = 'dev@example.com';
const HEAD = 'abcdef0123456789';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** A code host whose `sub-gate` check run on the head may already have completed. */
class FakeHost implements CodeHost {
  readonly configured = true;
  /** The completed `sub-gate` run on HEAD, or null while it is still running. */
  subGate: { passed: boolean } | null = null;
  readonly lookups: string[] = [];
  diff: DiffSummary = { changedLines: 10, files: ['src/a.ts'] };
  mergeStateNow: MergeState = 'pending';

  connection = () => Promise.resolve({ configured: true, connected: true, installUrl: null, appName: null });
  provision = (_repo: unknown, glob: Glob) => Promise.resolve({ branch: glob.id, pr: { number: 7, headSha: HEAD } });
  openDraftPr = () => Promise.resolve(null);
  syncLabels = () => Promise.resolve();
  closePr = () => Promise.resolve();
  deleteBranch = () => Promise.resolve();
  reopenPr = () => Promise.resolve('reopened' as const);
  mergeState = () => Promise.resolve({ sha: HEAD, state: this.mergeStateNow });
  completedCheckRun = (_repo: unknown, sha: string, name: string) => {
    this.lookups.push(`${name}@${sha}`);
    return Promise.resolve(this.subGate === null ? null : { sha, passed: this.subGate.passed });
  };
  markReady = () => Promise.resolve();
  diffSummary = () => Promise.resolve(this.diff);
  squashMerge = () => Promise.resolve({ outcome: 'merged' as const, sha: 'm1' });
}

describe('a sub gate that completed before the PR was recorded as ready', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let host: FakeHost;
  let handle: ReturnType<typeof githubDeliveryHandler>;
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
    handle = githubDeliveryHandler({ db: database.db, globs, boardOf, github: host });
    executors = codeHostExecutors(host, boardOf, new FileRoutines('/nonexistent/routines.json'));
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
        summary: '',
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
  const checkRun = (passed: boolean) => ({
    id: deliveryId(),
    event: 'check_run',
    payload: {
      action: 'completed',
      check_run: {
        name: 'sub-gate',
        status: 'completed',
        conclusion: passed ? 'success' : 'failure',
        head_sha: HEAD,
        check_suite: { head_branch: globId },
      },
      repository: { full_name: REPO },
    },
  });
  const readyForReview = () => ({
    id: deliveryId(),
    event: 'pull_request',
    payload: {
      action: 'ready_for_review',
      pull_request: { number: 7, draft: false, merged: false, merge_commit_sha: null, head: { ref: globId, sha: HEAD } },
      repository: { full_name: REPO },
    },
  });

  it('a gate that passed before ready is evaluated after the ready confirmation and the sub merges', async () => {
    // The webhook for the finished gate arrives while the PR is still a draft: ignored.
    host.subGate = { passed: true };
    await handle(checkRun(true));
    expect((await current()).status).not.toBe('pr_open');
    expect(await pending('evaluate_sub_gate')).toHaveLength(0);

    await handle(readyForReview());
    expect((await current()).status).toBe('pr_open');
    expect(await run('refresh_sub_gate')).toEqual(['done']);
    expect(host.lookups).toEqual([`sub-gate@${HEAD}`]);
    expect(await run('evaluate_sub_gate')).toEqual(['done']);
    expect((await current()).status).toBe('merging');
    await run('squash_merge');
    expect((await current()).status).toBe('reviewing');
  });

  it('a gate that passed before ready on a sub the policy flags converts it to a same', async () => {
    host.subGate = { passed: true };
    host.diff = { changedLines: 10, files: ['infra/main.tf'] };
    await handle(readyForReview());
    await run('refresh_sub_gate');
    await run('evaluate_sub_gate');
    const glob = await current();
    expect(glob.type).toBe('same');
    expect(glob.status).toBe('pr_open');
  });

  it('no completed gate at ready does nothing, and a later refresh of the checks picks it up', async () => {
    await handle(readyForReview());
    const version = (await current()).version;
    expect(await run('refresh_sub_gate')).toEqual(['done']);
    expect(await pending('evaluate_sub_gate')).toHaveLength(0);
    expect((await current()).version).toBe(version);

    // The gate finishes, and a refresh of the head's checks (here with other checks still pending) finds it.
    host.subGate = { passed: true };
    expect(await run('refresh_checks')).toEqual(['done']);
    expect(await pending('evaluate_sub_gate')).toHaveLength(1);
    await run('evaluate_sub_gate');
    expect((await current()).status).toBe('merging');
  });

  it('a failed gate found at ready is left to the routine', async () => {
    host.subGate = { passed: false };
    await handle(readyForReview());
    const version = (await current()).version;
    await run('refresh_sub_gate');
    expect(await pending('evaluate_sub_gate')).toHaveLength(0);
    expect((await current()).version).toBe(version);
    expect((await current()).status).toBe('pr_open');
  });
});
