import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as m from '../src/domain/machine.js';
import { PENDING_TIMEOUT_MS, pendingInForce } from '../src/domain/pending-action.js';
import type { PendingAction } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, ctx, dev, glob, run } from './fixtures.js';

const value = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const pending = (patch: Partial<PendingAction> = {}): PendingAction => ({
  kind: 'merge',
  at: NOW,
  by: dev.email,
  ...patch,
});
const later = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();

describe('pending action transitions', () => {
  it('a click sets the pending action (with the run it queued) and clears the last outcome', () => {
    const before = glob({
      lastOutcome: { kind: 'merge', at: NOW, by: dev.email, result: 'failed', reason: 'no' },
    });
    const t = value(m.actionRequested(before, { kind: 'resolve_conflict', runId: 'run-9' }, ctx()));
    expect(t.glob.pendingAction).toEqual({
      kind: 'resolve_conflict',
      at: NOW,
      by: dev.email,
      runId: 'run-9',
    });
    expect(t.glob.lastOutcome).toBeNull();
    expect(t.changed).toBe(true);
  });

  it('a refusal stores the reason as the last outcome and leaves the pending action alone', () => {
    const t = value(
      m.actionRefused(
        glob({ pendingAction: pending({ kind: 'start' }) }),
        { kind: 'merge', reason: 'Checks have not passed' },
        ctx(),
      ),
    );
    expect(t.glob.lastOutcome).toEqual({
      kind: 'merge',
      at: NOW,
      by: dev.email,
      result: 'failed',
      reason: 'Checks have not passed',
    });
    expect(t.glob.pendingAction).toEqual(pending({ kind: 'start' }));
  });

  it('settles on success: the glob moving on clears the pending action and leaves no outcome', () => {
    const conflict = { base: 'main', files: ['a.ts'], since: null, at: NOW };
    const queued = run({ id: 'run-1', state: 'queued', purpose: 'resolve_conflict' });
    const before = glob({
      status: 'pr_open',
      conflict,
      runs: [queued],
      pendingAction: pending({ kind: 'resolve_conflict', runId: 'run-1' }),
    });
    const t = value(m.conflictCleared(before, ctx(null)));
    expect(t.glob.pendingAction).toBeNull();
    expect(t.glob.lastOutcome).toBeNull();
  });

  it('keeps a pending action that names a run while that run only starts', () => {
    const queued = run({
      id: 'run-1',
      state: 'queued',
      startedAt: null,
      purpose: 'resolve_conflict',
    });
    const before = glob({
      status: 'pr_open',
      runs: [queued],
      pendingAction: pending({ kind: 'resolve_conflict', runId: 'run-1' }),
    });
    const t = value(
      m.runFired(before, { runId: 'run-1', sessionId: 's', sessionUrl: null }, ctx(null)),
    );
    expect(t.changed).toBe(true);
    expect(t.glob.pendingAction).toEqual(before.pendingAction);
  });

  it('settles on failure: a new failure ends the pending action and is stored as the outcome', () => {
    const before = glob({ status: 'merging', pendingAction: pending() });
    const t = value(m.mergeFailed(before, 'Merge was refused by the host', ctx(null)));
    expect(t.glob.pendingAction).toBeNull();
    expect(t.glob.lastOutcome).toEqual({
      kind: 'merge',
      at: NOW,
      by: dev.email,
      result: 'failed',
      reason: 'Merge was refused by the host',
    });
  });

  it('keeps the pending action through a change that moves nothing it watches', () => {
    const before = glob({ status: 'merging', pendingAction: pending() });
    const t = value(m.relationsChanged(before, ctx(null)));
    expect(t.changed).toBe(true);
    expect(t.glob.pendingAction).toEqual(pending());
  });

  it('records a timeout on the next change once the pending action is old and nothing new showed', () => {
    const before = glob({ status: 'merging', pendingAction: pending() });
    const t = value(m.relationsChanged(before, { ...ctx(null), now: later(PENDING_TIMEOUT_MS) }));
    expect(t.glob.pendingAction).toBeNull();
    expect(t.glob.lastOutcome).toMatchObject({ kind: 'merge', result: 'timed_out', by: dev.email });
  });
});

describe('pendingInForce', () => {
  it('is the pending action for a minute, then none, without any write', () => {
    const g = glob({ pendingAction: pending() });
    expect(pendingInForce(g, later(PENDING_TIMEOUT_MS - 1))).toEqual(pending());
    expect(pendingInForce(g, later(PENDING_TIMEOUT_MS))).toBeNull();
    expect(pendingInForce(glob(), NOW)).toBeNull();
    expect(pendingInForce(glob({ pendingAction: null }), NOW)).toBeNull();
  });
});

describe('recording a click through the service (MemoryStore)', () => {
  let globs: GlobService;
  let id: string;
  let version: number;

  const read = async () => value(await globs.get(dev.email, id)).glob;

  beforeEach(async () => {
    const store = new MemoryStore();
    const notifier = new RecordingNotifier();
    let runs = 0;
    const boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => NOW },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of ['admin@example.com', dev.email])
        await tx.upsertUser({ email, name: email, active: true });
    });
    const boardId = value(
      await boards.create('admin@example.com', {
        name: 'demo',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    value(await boards.setMember('admin@example.com', boardId, dev.email, 'dev'));
    const created = value(
      await globs.create(dev.email, {
        boardId,
        title: 'Fix it',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    id = created.id;
    version = created.version;
  });

  it('stores the click, bumps the version and clears an earlier refusal', async () => {
    value(await globs.recordRefusal(dev.email, id, 'merge', 'Required checks have not passed'));
    expect((await read()).lastOutcome).toMatchObject({
      kind: 'merge',
      reason: 'Required checks have not passed',
      result: 'failed',
    });
    const current = (await read()).version;
    expect(current).toBeGreaterThan(version);
    const recorded = value(
      await globs.recordRequested(dev.email, id, 'resolve_conflict', current, 'run-7'),
    );
    expect(recorded.version).toBe(current + 1);
    expect(recorded.pendingAction).toEqual({
      kind: 'resolve_conflict',
      at: NOW,
      by: dev.email,
      runId: 'run-7',
    });
    expect(recorded.lastOutcome).toBeNull();
  });

  it('skips a click recorded against a stale version, leaving the glob as it is', async () => {
    value(await globs.recordRefusal(dev.email, id, 'merge', 'no'));
    const stale = await globs.recordRequested(dev.email, id, 'merge', version);
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
    expect((await read()).pendingAction ?? null).toBeNull();
  });

  it('keeps a refusal from someone who is not a member out of the record', async () => {
    const refused = await globs.recordRefusal('nobody@example.com', id, 'merge', 'no');
    expect(!refused.ok && refused.error.code).toBe('forbidden');
    expect((await read()).lastOutcome ?? null).toBeNull();
  });
});
