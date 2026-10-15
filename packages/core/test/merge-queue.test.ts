import { describe, expect, it } from 'vitest';
import type { Result } from '../src/domain/errors.js';
import * as m from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import { reconcileDue } from '../src/domain/reconcile.js';
import { machineSteps } from '../src/domain/machine-steps.js';
import { MERGE_QUEUE_TEXT, MERGE_QUEUE_TIP, mergeQueueText } from '../src/domain/whose-move.js';
import type { Glob } from '../src/domain/types.js';
import { NOW, ctx, dev, glob } from './fixtures.js';

const value = (result: Result<Transition>): Transition => {
  if (!result.ok) throw new Error(`Expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const HEAD = 'bbb';
const merging = (patch: Partial<Glob> = {}): Glob =>
  glob({ status: 'merging', pr: { number: 7, state: 'ready', headSha: HEAD }, headChecks: { sha: HEAD, state: 'passed' }, ...patch });
const queued = (patch: Partial<Glob> = {}): Glob =>
  merging({ mergeQueue: { since: NOW, sha: HEAD, position: 3, state: 'queued' }, ...patch });

describe('merge queue wording', () => {
  it('reads "in merge queue · N ahead", plain when the position is unknown, "merging" once its group merges', () => {
    expect(mergeQueueText(3, 'queued')).toBe('in merge queue · 2 ahead');
    expect(mergeQueueText(1, 'queued')).toBe('in merge queue · 0 ahead');
    expect(mergeQueueText(null, 'queued')).toBe(MERGE_QUEUE_TEXT);
    expect(mergeQueueText(2, 'merging')).toBe('merging');
    expect(MERGE_QUEUE_TIP).toContain('PRs ahead of it');
  });
});

describe('mergeQueued', () => {
  it('records the entry on a merging glob, keeping status merging', () => {
    const t = value(m.mergeQueued(merging(), { sha: HEAD, position: 2, state: 'queued' }, ctx(null)));
    expect(t.glob.status).toBe('merging');
    expect(t.glob.mergeQueue).toEqual({ since: NOW, sha: HEAD, position: 2, state: 'queued' });
    expect(t.events.map((e) => e.type)).toEqual(['MergeQueued']);
  });

  it('keeps `since` and `failedSha`, and moves the position', () => {
    const before = queued({ mergeQueue: { since: '2026-10-05T11:00:00.000Z', sha: HEAD, position: 3, state: 'queued', failedSha: 'g1' } });
    const t = value(m.mergeQueued(before, { sha: HEAD, position: 1, state: 'merging' }, ctx(null)));
    expect(t.glob.mergeQueue).toEqual({ since: '2026-10-05T11:00:00.000Z', sha: HEAD, position: 1, state: 'merging', failedSha: 'g1' });
  });

  it('changes nothing, and logs nothing, when the entry is the same', () => {
    const t = value(m.mergeQueued(queued(), { sha: HEAD, position: 3, state: 'queued' }, ctx(null)));
    expect(t.events).toEqual([]);
    expect(t.effects).toEqual([]);
  });

  it('ignores an entry for another head, and a glob that is not merging', () => {
    expect(value(m.mergeQueued(merging(), { sha: 'old', position: 1, state: 'queued' }, ctx(null))).glob.mergeQueue).toBeUndefined();
    const open = glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: HEAD } });
    expect(value(m.mergeQueued(open, { sha: HEAD, position: 1, state: 'queued' }, ctx(null))).glob.mergeQueue).toBeUndefined();
  });
});

describe('mergeQueueEvent', () => {
  it('only asks for a re-read of the queue entry, carrying the reason and group', () => {
    const t = value(m.mergeQueueEvent(queued(), { kind: 'dequeued', reason: 'CI_FAILURE', groupSha: 'g1' }, ctx(null)));
    expect(t.effects).toEqual([{ kind: 'read_merge_queue', globId: 's1t1', generation: 1, reason: 'CI_FAILURE', groupSha: 'g1' }]);
    expect(t.glob.status).toBe('merging');
  });

  it('records the failing merge group on a failed queue check', () => {
    const t = value(m.mergeQueueEvent(queued(), { kind: 'checks_failed', groupSha: 'g9' }, ctx(null)));
    expect(t.glob.mergeQueue?.failedSha).toBe('g9');
    expect(t.effects.map((e) => e.kind)).toEqual(['read_merge_queue']);
  });

  it('is ignored when the glob is not merging (a person queued the PR in the host UI)', () => {
    const open = glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: HEAD } });
    expect(value(m.mergeQueueEvent(open, { kind: 'enqueued' }, ctx(null))).effects).toEqual([]);
  });
});

describe('mergeQueueDequeued (row 16)', () => {
  it('fails the glob with the queue reason and the failing check lines', () => {
    const checks = { name: 'checks', step: 'test', lines: ['Error: boom'], url: 'https://ci.example/1' };
    const t = value(m.mergeQueueDequeued(queued(), { reason: 'Removed from the merge queue: its checks failed', checks }, ctx(null)));
    expect(t.glob.status).toBe('failed');
    expect(t.glob.mergeQueue).toBeNull();
    expect(t.glob.failure).toMatchObject({ kind: 'merge', checks });
    expect(t.glob.failure?.reason).toContain('Removed from the merge queue: its checks failed: ');
    expect(t.glob.failure?.reason).toContain('Error: boom');
    expect(t.events.find((e) => e.type === 'MergeFailed')?.data).toMatchObject({ queue: true });
  });

  it('a conflict goes back to pr_open with the conflict flagged, not a failure', () => {
    const conflict = { base: 'main', files: ['a.ts'] };
    const t = value(m.mergeQueueDequeued(queued(), { reason: m.conflictReason(conflict), conflict }, ctx(null)));
    expect(t.glob.status).toBe('pr_open');
    expect(t.glob.mergeQueue).toBeNull();
    expect(t.glob.conflict).toMatchObject({ base: 'main', files: ['a.ts'] });
    expect(t.glob.failure).toBeNull();
  });

  it('Retry merge enqueues again from the failure', () => {
    const failed = value(m.mergeQueueDequeued(queued(), { reason: 'Left the merge queue without merging' }, ctx(null))).glob;
    expect(m.allowedActions(failed, dev)).toContain('retry_merge');
    const t = value(m.retryMerge(failed, ctx()));
    expect(t.glob).toMatchObject({ status: 'merging', failure: null });
    expect(t.effects.map((e) => e.kind)).toEqual(['squash_merge']);
  });

  it('does nothing to a glob that is not merging', () => {
    const open = glob({ status: 'pr_open' });
    expect(value(m.mergeQueueDequeued(open, { reason: 'x' }, ctx(null))).glob.status).toBe('pr_open');
  });
});

describe('leaving the queue', () => {
  it('row 14c: Cancel merge on a queued glob dequeues it and returns it to pr_open', () => {
    const g = queued();
    expect(m.allowedActions(g, dev)).toContain('cancel_merge');
    const t = value(m.cancelMerge(g, ctx()));
    expect(t.glob).toMatchObject({ status: 'pr_open', mergeQueue: null, mergeMode: null });
    expect(t.effects).toEqual([{ kind: 'dequeue_merge', globId: 's1t1', generation: 1 }]);
    expect(t.events.map((e) => e.type)).toContain('MergeDisarmed');
  });

  it('a merge that is merging directly (not queued) cannot be cancelled', () => {
    const g = merging();
    expect(m.allowedActions(g, dev)).not.toContain('cancel_merge');
    expect(m.cancelMerge(g, ctx()).ok).toBe(false);
  });

  it('row 15: a merge observed on a queued glob clears the queue and goes to reviewing', () => {
    const t = value(m.merged(queued(), { sha: 'm1', number: 7 }, ctx(null)));
    expect(t.glob.status).toBe('reviewing');
    expect(t.glob.mergeQueue).toBeNull();
  });

  it('a push while queued clears the queue state (the host drops the old head)', () => {
    const t = value(m.commitPushed(queued(), { sha: 'ccc', runId: null }, ctx(null)));
    expect(t.glob.mergeQueue).toBeNull();
  });

  it('a closed PR clears it', () => {
    expect(value(m.prClosed(queued(), ctx(null))).glob.mergeQueue).toBeNull();
  });

  it('head check events on a queued glob do not enqueue again, but do on a merging one', () => {
    const queuedAgain = value(m.checksCompleted(queued(), { sha: HEAD, passed: true }, ctx(null)));
    expect(queuedAgain.effects.map((e) => e.kind)).not.toContain('squash_merge');
    const direct = value(m.checksCompleted(merging(), { sha: HEAD, passed: true }, ctx(null)));
    expect(direct.effects.map((e) => e.kind)).toContain('squash_merge');
  });
});

describe('reconcile and steps', () => {
  const at = (minutesAgo: number) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();

  it('a queued glob quiet for over 5 minutes is due for a reconcile; a fresh one is not', () => {
    expect(reconcileDue(queued({ updatedAt: at(6) }), Date.parse(NOW))).toBe(true);
    expect(reconcileDue(queued({ updatedAt: at(2) }), Date.parse(NOW))).toBe(false);
    expect(reconcileDue(merging({ updatedAt: at(6) }), Date.parse(NOW))).toBe(false);
  });

  it('the merge step carries the queue wording and never goes stale (no startedAt)', () => {
    const steps = machineSteps(queued({ mergeQueue: { since: NOW, sha: HEAD, position: 4, state: 'queued' } }));
    const merge = steps.find((s) => s.kind === 'merge');
    expect(merge).toMatchObject({ state: 'running', detail: 'in merge queue · 3 ahead', startedAt: null });
  });
});
