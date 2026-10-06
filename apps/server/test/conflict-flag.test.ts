import { GlobService, machine } from '@slop/core';
import type { Board, DiffSummary, Effect, Glob, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import type { CodeHost, MergeState } from '../src/codehost.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
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
  conflicting: string[] = [];
  readonly comments: { pr: number; marker: string; body: string }[] = [];

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
  markReady = () => Promise.resolve({ wasDraft: true, sha: HEAD });
  conflictFiles = () => Promise.resolve(this.conflicting);
  commentOnce = (_repo: unknown, pr: number, marker: string, body: string) => {
    if (this.comments.some((c) => c.marker === marker)) return Promise.resolve('exists' as const);
    this.comments.push({ pr, marker, body });
    return Promise.resolve('posted' as const);
  };
  diffSummary = () => Promise.resolve(this.diff);
  readFile = () => Promise.resolve(null);
  squashMerge = () => Promise.resolve({ outcome: 'merged' as const, sha: 'm1' });
}

describe('conflicts flagged after a merge', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let host: FakeHost;
  let executors: ReturnType<typeof codeHostExecutors>;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('conflicts'));
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
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    const boardOf = (boardId: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(boardId));
    host = new FakeHost();
    executors = codeHostExecutors(host, boardOf, new FileRoutines('/nonexistent/routines.json'));
  });

  afterAll(() => drop());

  const current = async (id: string) => unwrap(await globs.get(DEV, id)).glob;
  const newGlob = async (title: string, summary: string, pr: number) => {
    const created = unwrap(
      await globs.create(DEV, {
        boardId: 1,
        title,
        summary,
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    await globs.applyEvent(created.id, (g, ctx) =>
      machine.provisioned(g, { branch: g.id, pr: { number: pr, headSha: HEAD } }, ctx),
    );
    // Routine work in progress with no run live (a same starts in planning).
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(created.id);
      if (g === null) throw new Error('missing');
      await tx.updateGlob({ ...g, status: 'in_progress', implementer: null, version: g.version + 1 }, g.version);
    });
    return created.id;
  };
  const pending = async (globId: string, kind: Effect['kind']) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter(
      (row) => row.kind === kind && row.state === 'pending',
    );
  /** Runs every pending effect of `kind` on the glob as the outbox would; an executor that throws leaves it pending. */
  const run = async (globId: string, kind: Effect['kind']) => {
    const executor = executors[kind];
    if (executor === undefined) throw new Error(`No executor for ${kind}`);
    const outcomes = [];
    for (const row of await pending(globId, kind)) {
      outcomes.push(await executor(row.effect, await current(globId), { globs }));
      await database.db
        .update(schema.outbox)
        .set({ state: 'done' })
        .where(and(eq(schema.outbox.id, row.id), eq(schema.outbox.state, 'pending')));
    }
    return outcomes;
  };

  it('flags the other open PRs that conflict, retrying while GitHub is unsure, then asks @claude once', async () => {
    const merged = await newGlob('Add billing', 'Bills customers monthly', 7);
    const open = await newGlob('Change invoices', 'Reworks the invoice layout', 8);
    const clean = await newGlob('Docs only', 'Updates the docs', 9);
    host.conflicting = ['src/invoice.ts'];

    await globs.applyEvent(merged, (g, ctx) => machine.merged(g, { sha: 'm1', number: 7 }, ctx));
    expect(await run(merged, 'flag_conflicts')).toEqual(['done']);
    // The merged glob itself is not rechecked; each other open PR has its own effect.
    expect(await pending(merged, 'check_conflict')).toHaveLength(0);
    expect(await pending(open, 'check_conflict')).toHaveLength(1);
    expect(await pending(clean, 'check_conflict')).toHaveLength(1);

    // GitHub has not computed mergeability yet: the effect throws, so the outbox retries it.
    host.mergeStateNow = 'unknown';
    await expect(run(open, 'check_conflict')).rejects.toThrow(/not computed/);
    expect((await current(open)).conflict ?? null).toBeNull();

    host.mergeStateNow = 'conflict';
    expect(await run(open, 'check_conflict')).toEqual(['done']);
    const flagged = await current(open);
    expect(flagged.status).toBe('in_progress');
    expect(flagged.failure).toBeNull();
    expect(flagged.conflict).toMatchObject({ base: 'main', files: ['src/invoice.ts'], since: merged });

    host.mergeStateNow = 'passed';
    expect(await run(clean, 'check_conflict')).toEqual(['done']);
    expect((await current(clean)).conflict ?? null).toBeNull();

    // Resolve conflict asks once, with both globs' intent; a repeat adds nothing.
    unwrap(await globs.resolveConflict(DEV, open, flagged.version));
    expect(await run(open, 'request_conflict_fix')).toEqual(['done']);
    const [comment] = host.comments;
    expect(host.comments).toHaveLength(1);
    expect(comment?.pr).toBe(8);
    for (const text of ['@claude', open, 'Change invoices', 'Reworks the invoice layout', merged, 'Add billing', 'Bills customers monthly', 'src/invoice.ts', 'git merge origin/main', 'lint']) {
      expect(comment?.body).toContain(text);
    }
    const asked = await current(open);
    expect(asked.conflict?.requestedAt).toBeDefined();
    expect(unwrap(await globs.resolveConflict(DEV, open, asked.version)).version).toBe(asked.version);
    expect(await pending(open, 'request_conflict_fix')).toHaveLength(0);

    // The retried effect after a crash finds its marker and posts nothing more.
    const rows = await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, open));
    const request = rows.find((row) => row.kind === 'request_conflict_fix');
    if (request === undefined) throw new Error('no request effect');
    const executor = executors.request_conflict_fix;
    if (executor === undefined) throw new Error('no executor');
    await executor(request.effect, asked, { globs });
    expect(host.comments).toHaveLength(1);

    // A push that fixes it clears the flag.
    await globs.applyEvent(open, (g, ctx) => machine.commitPushed(g, { sha: 'fedcba9876543210', runId: null }, ctx));
    host.mergeStateNow = 'passed';
    expect(await run(open, 'check_conflict')).toEqual(['done']);
    expect((await current(open)).conflict ?? null).toBeNull();
  });
});
