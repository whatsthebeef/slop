import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as m from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import { machineSteps } from '../src/domain/machine-steps.js';
import { MERGE_HEAD_STUCK_MS, headCandidates, mergeHeadStuck, mergeLineNeedsAdvance, mergeLineOf, mergeLinePlaces } from '../src/domain/merge-line.js';
import { reconcileDue } from '../src/domain/reconcile.js';
import { mergeLineText } from '../src/domain/whose-move.js';
import { presentGlob } from '../src/index.js';
import type { PresentableGlob } from '../src/index.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, ctx, dev, glob, relation as fixtureRelation, relationFacts } from './fixtures.js';

const value = (result: Result<Transition>): Transition => {
  if (!result.ok) throw new Error(`Expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
};
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const kinds = (t: Transition): string[] => t.effects.map((e) => e.kind);
const ADVANCE = { kind: 'advance_merge_line', globId: 'board-1', boardId: 1 };

const HEAD = 'bbbbbbb1234';
const at = (minutes: number): string => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const merging = (patch: Partial<Glob> = {}): Glob =>
  glob({ status: 'merging', pr: { number: 7, state: 'ready', headSha: HEAD }, headChecks: { sha: HEAD, state: 'passed' }, ...patch });
const waiting = (patch: Partial<Glob> = {}): Glob => merging({ mergeLine: { joinedAt: NOW }, ...patch });
const head = (patch: Partial<Glob> = {}): Glob => merging({ mergeLine: { joinedAt: NOW, head: { since: NOW } }, ...patch });
const open = (patch: Partial<Glob> = {}): Glob =>
  glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: HEAD }, headChecks: { sha: HEAD, state: 'passed' }, ...patch });

describe('joining the line (every transition that used to start the merge)', () => {
  it('Merge on passed checks joins at the back: merging, joinedAt, MergeLineJoined, advance queued, and no squash_merge', () => {
    const t = value(m.requestMerge(open(), ctx()));
    expect(t.glob).toMatchObject({ status: 'merging', mergeLine: { joinedAt: NOW }, mergeUpdates: 0 });
    expect(t.glob.mergeLine?.head).toBeUndefined();
    expect(t.events.map((e) => e.type)).toEqual(['StatusChanged', 'MergeLineJoined']);
    expect(t.events.find((e) => e.type === 'MergeLineJoined')?.data).toEqual({ sha: HEAD });
    expect(t.effects).toEqual([ADVANCE]);
  });

  it('an armed merge whose checks pass, a sub gate that passes and an action record all join the same way', () => {
    const armed = open({ mergeMode: 'when_green', headChecks: { sha: HEAD, state: 'pending' } });
    const pass = value(m.checksCompleted(armed, { sha: HEAD, passed: true }, ctx(null)));
    expect(pass.glob).toMatchObject({ status: 'merging', mergeMode: null, mergeLine: { joinedAt: NOW } });
    expect(pass.effects).toEqual([ADVANCE]);
    const sub = value(m.subGateCompleted(open({ type: 'sub' }), { sha: HEAD, passed: true, reason: null }, ctx(null)));
    expect(sub.glob).toMatchObject({ status: 'merging', mergeLine: { joinedAt: NOW } });
    expect(kinds(sub)).toEqual(['advance_merge_line']);
  });

  it('Merge and continue joins too, and keeps its mode while it waits', () => {
    const t = value(m.requestMerge(open({ type: 'super' }), ctx(), { continue: true, facts: { recordSha: HEAD } }));
    expect(t.glob).toMatchObject({ status: 'merging', mergeMode: 'continue', mergeLine: { joinedAt: NOW } });
    expect(t.effects).toEqual([ADVANCE]);
  });

  it('Retry merge (row 16c) rejoins at the back, not at its old place', () => {
    const failed = open({ status: 'failed', failure: { reason: 'GitHub had not decided', at: NOW, kind: 'merge' } });
    const t = value(m.retryMerge(failed, { ...ctx(), now: at(30) }));
    expect(t.glob).toMatchObject({ status: 'merging', failure: null, mergeLine: { joinedAt: at(30) } });
    expect(t.effects).toEqual([ADVANCE]);
  });
});

describe('the order and the places (pure)', () => {
  const a = waiting({ id: 's1t1', mergeLine: { joinedAt: at(0) } });
  const b = waiting({ id: 's1t2', mergeLine: { joinedAt: at(1) } });
  const c = waiting({ id: 's1t3', mergeLine: { joinedAt: at(1) } });

  it('orders by joinedAt then id, ignoring globs that are not in the line', () => {
    const open1 = open({ id: 's1t9' });
    const legacy = merging({ id: 's1t8' });
    expect(mergeLineOf([c, open1, b, legacy, a]).map((g) => g.id)).toEqual(['s1t1', 's1t2', 's1t3']);
  });

  it('puts the head first whatever its joinedAt', () => {
    const late = head({ id: 's1t7', mergeLine: { joinedAt: at(5), head: { since: at(5) } } });
    expect(mergeLineOf([a, b, late]).map((g) => g.id)).toEqual(['s1t7', 's1t1', 's1t2']);
  });

  it('gives each glob its place: 1 is the head, `ahead` lists the IDs in front, head first', () => {
    const places = mergeLinePlaces([c, a, head({ id: 's1t0', mergeLine: { joinedAt: at(0), head: { since: at(0) } } }), b]);
    expect(places.get('s1t0')).toEqual({ position: 1, ahead: [] });
    expect(places.get('s1t1')).toEqual({ position: 2, ahead: ['s1t0'] });
    expect(places.get('s1t2')).toEqual({ position: 3, ahead: ['s1t0', 's1t1'] });
    expect(places.get('s1t3')).toEqual({ position: 4, ahead: ['s1t0', 's1t1', 's1t2'] });
    expect(places.has('s1t9')).toBe(false);
  });

  it('has candidates only while there is no head, and says when a board needs an advance', () => {
    expect(headCandidates([a, b]).map((g) => g.id)).toEqual(['s1t1', 's1t2']);
    expect(headCandidates([head({ id: 's1t0' }), a, b])).toEqual([]);
    expect(mergeLineNeedsAdvance([a, b])).toBe(true);
    expect(mergeLineNeedsAdvance([head({ id: 's1t0' }), a])).toBe(false);
    expect(mergeLineNeedsAdvance([open()])).toBe(false);
    // A merging glob that predates the line has no place but needs one.
    expect(mergeLineNeedsAdvance([merging()])).toBe(true);
  });
});

describe('becoming head (row 16d)', () => {
  it('a head whose checks passed queues the pinned squash_merge, and only that', () => {
    const t = value(m.becomeMergeHead(waiting(), undefined, ctx(null)));
    expect(t.glob.mergeLine).toEqual({ joinedAt: NOW, head: { since: NOW } });
    expect(t.events.map((e) => e.type)).toEqual(['MergeLineHead']);
    expect(t.effects).toEqual([{ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: HEAD }]);
  });

  it('a head with no result for its current commit reads its checks instead; they queue the merge when they pass', () => {
    const t = value(m.becomeMergeHead(waiting({ headChecks: null }), undefined, ctx(null)));
    expect(kinds(t)).toEqual(['refresh_checks']);
    const later = value(m.checksCompleted(t.glob, { sha: HEAD, passed: true }, ctx(null)));
    expect(kinds(later)).toEqual(['squash_merge']);
  });

  it('is a no-op for a glob that is already head, is not in the line, or is not merging', () => {
    expect(value(m.becomeMergeHead(head(), undefined, ctx(null))).changed).toBe(false);
    expect(value(m.becomeMergeHead(merging(), undefined, ctx(null))).changed).toBe(false);
    expect(value(m.becomeMergeHead(open(), undefined, ctx(null))).changed).toBe(false);
  });

  it('a conflict already known leaves the line to pr_open, with advance queued, instead of becoming head', () => {
    const conflict = { base: 'main', files: ['a.ts'], since: null, at: NOW };
    const t = value(m.becomeMergeHead(waiting({ conflict }), undefined, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'pr_open', mergeLine: null });
    expect(t.events.find((e) => e.type === 'MergeFailed')?.data).toMatchObject({ conflict: true });
    expect(kinds(t)).toEqual(['advance_merge_line']);
  });

  it('a merge relation added after joining holds the candidate in pr_open and the next one is tried (a gated glob never blocks the line)', () => {
    const relations = relationFacts('s1t1', [['s1t0', 'open']], { gate: 'merge' });
    const t = value(m.becomeMergeHead(waiting(), relations, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'pr_open', mergeMode: 'when_green', mergeLine: null, mergeHold: { sha: HEAD, for: ['s1t0'] } });
    expect(t.events.map((e) => e.type)).toEqual(['StatusChanged', 'MergeHeld']);
    expect(kinds(t)).toEqual(['advance_merge_line']);
    // The release resumes it into the back of the line, like any held merge.
    const released = value(m.gateReleased(t.glob, relationFacts('s1t1', [['s1t0', 'merged']], { gate: 'merge' }), null, { ...ctx(null), now: at(9) }));
    expect(released.glob).toMatchObject({ status: 'merging', mergeLine: { joinedAt: at(9) } });
  });

  it('a held sub waits through mergeHold alone; a held Merge and continue is disarmed (a resumed hold would merge it for good)', () => {
    const relations = relationFacts('s1t1', [['s1t0', 'open']], { gate: 'merge' });
    const sub = value(m.becomeMergeHead(waiting({ type: 'sub' }), relations, ctx(null)));
    expect(sub.glob).toMatchObject({ status: 'pr_open', mergeMode: null, mergeLine: null, mergeHold: { sha: HEAD } });
    const cont = value(m.becomeMergeHead(waiting({ type: 'super', mergeMode: 'continue' }), relations, ctx(null)));
    expect(cont.glob).toMatchObject({ status: 'pr_open', mergeMode: null, mergeLine: null });
    expect(cont.events.find((e) => e.type === 'MergeDisarmed')?.data).toEqual({ reason: 'held' });
  });

  it('adopts a merging glob that predates the line where it last changed', () => {
    const t = value(m.adoptIntoMergeLine(merging({ updatedAt: at(-40) }), ctx(null)));
    expect(t.glob.mergeLine).toEqual({ joinedAt: at(-40) });
    expect(value(m.adoptIntoMergeLine(waiting(), ctx(null))).changed).toBe(false);
  });
});

describe('only the head works', () => {
  it('a waiting glob records its checks but queues neither squash_merge nor a refresh', () => {
    const t = value(m.checksCompleted(waiting({ headChecks: null }), { sha: HEAD, passed: true }, ctx(null)));
    expect(t.glob.headChecks).toMatchObject({ sha: HEAD, state: 'passed' });
    expect(t.glob.mergeLine).toEqual({ joinedAt: NOW });
    expect(t.effects).toEqual([]);
  });

  it('the head queues squash_merge when its checks pass', () => {
    const t = value(m.checksCompleted(head({ headChecks: null }), { sha: HEAD, passed: true }, ctx(null)));
    expect(t.effects).toEqual([{ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: HEAD }]);
  });

  it('a red head leaves the line with the reason, as a failed merge, and the next one is asked for', () => {
    const t = value(m.checksCompleted(head({ mergeUpdates: 1 }), { sha: HEAD, passed: false }, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'failed', mergeLine: null, failure: { kind: 'merge' } });
    expect(t.glob.failure?.reason).toContain('Checks failed after updating the branch');
    expect(kinds(t)).toEqual(['advance_merge_line']);
  });

  it('a red waiting glob leaves too: it can never merge', () => {
    const t = value(m.checksCompleted(waiting(), { sha: HEAD, passed: false }, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'failed', mergeLine: null });
    expect(kinds(t)).toEqual(['advance_merge_line']);
  });

  it('a conflict on the head goes back to pr_open (an ordinary conflict job), leaves the line and advances it', () => {
    const t = value(m.checksCompleted(head(), { sha: HEAD, passed: false, conflict: { base: 'main', files: ['a.ts'] } }, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'pr_open', mergeLine: null, conflict: { base: 'main', files: ['a.ts'] } });
    expect(kinds(t)).toEqual(['advance_merge_line']);
  });

  it('slop failing the head\'s merge (mergeFailed) leaves the line; a conflict returns it to pr_open', () => {
    const failed = value(m.mergeFailed(head(), 'GitHub refused', ctx(null)));
    expect(failed.glob).toMatchObject({ status: 'failed', mergeLine: null, failure: { reason: 'GitHub refused', kind: 'merge' } });
    expect(kinds(failed)).toEqual(['advance_merge_line']);
    const conflict = value(m.mergeFailed(head(), 'conflict', ctx(null), { base: 'main', files: ['a'] }));
    expect(conflict.glob).toMatchObject({ status: 'pr_open', mergeLine: null });
    expect(kinds(conflict)).toEqual(['advance_merge_line']);
  });

  it('the merge being observed (the head, or a glob merged outside slop) leaves the line and advances it', () => {
    for (const g of [head(), waiting()]) {
      const t = value(m.merged(g, { sha: 'm1', number: 7 }, ctx(null)));
      expect(t.glob).toMatchObject({ status: 'reviewing', mergeLine: null });
      expect(kinds(t)).toContain('advance_merge_line');
    }
    const cont = value(m.merged(head({ type: 'super', mergeMode: 'continue' }), { sha: 'm1', number: 7 }, ctx(null)));
    expect(cont.glob).toMatchObject({ status: 'in_progress', mergeLine: null });
    expect(kinds(cont)).toContain('advance_merge_line');
  });

  it('a glob that never was in the line queues no advance when it merges', () => {
    expect(kinds(value(m.merged(open(), { sha: 'm1', number: 7 }, ctx(null))))).not.toContain('advance_merge_line');
  });
});

describe('Cancel merge (row 14c)', () => {
  it.each([
    ['the head', head()],
    ['a waiting glob', waiting()],
  ])('takes %s out of the line: back to pr_open, place cleared, advance queued', (_name, g) => {
    expect(m.allowedActions(g, dev)).toContain('cancel_merge');
    const t = value(m.cancelMerge(g, ctx()));
    expect(t.glob).toMatchObject({ status: 'pr_open', mergeLine: null, mergeMode: null });
    expect(t.events.find((e) => e.type === 'MergeDisarmed')?.data).toEqual({ reason: 'cancelled' });
    expect(t.effects).toEqual([ADVANCE]);
  });

  it('is refused for a merging glob that is not in the line, and still disarms an armed merge', () => {
    expect(m.cancelMerge(merging(), ctx()).ok).toBe(false);
    const armed = open({ mergeMode: 'when_green' });
    expect(value(m.cancelMerge(armed, ctx())).glob.mergeMode).toBeNull();
    expect(kinds(value(m.cancelMerge(armed, ctx())))).toEqual([]);
  });

  it('is never the card\'s button: the card shows no primary action for a glob in the line', () => {
    for (const g of [head(), waiting()]) {
      const view: PresentableGlob = { ...g, list: 'doing', branch: g.id, currentRun: null, allowedActions: m.allowedActions(g, dev) };
      const p = presentGlob({ glob: view, now: NOW, viewer: { email: dev.email, role: 'dev' } });
      expect(p.primary).toBeNull();
      expect(p.cardPrimary).toBeNull();
    }
  });
});

describe('a push, the PR closing and removal while in the line', () => {
  it('a push keeps the place (joinedAt) and a head\'s place as head, resets the checks and restarts the stuck clock', () => {
    const t = value(m.commitPushed(head({ mergeLine: { joinedAt: at(-5), head: { since: at(-4), recheckedAt: at(-1) } } }), { sha: 'ccc', runId: null }, ctx(null)));
    expect(t.glob.mergeLine).toEqual({ joinedAt: at(-5), head: { since: NOW } });
    expect(t.glob).toMatchObject({ status: 'merging', headChecks: null, pr: { headSha: 'ccc' } });
    expect(kinds(t)).toContain('refresh_checks');
    expect(kinds(t)).not.toContain('squash_merge');
    const waits = value(m.commitPushed(waiting({ mergeLine: { joinedAt: at(-5) } }), { sha: 'ccc', runId: null }, ctx(null)));
    expect(waits.glob.mergeLine).toEqual({ joinedAt: at(-5) });
  });

  it('a new push needs green on the new head: the old head\'s result is stale, the new one merges only the head', () => {
    const pushed = value(m.commitPushed(head(), { sha: 'ccc', runId: null }, ctx(null))).glob;
    // A late result for the old commit is ignored.
    expect(value(m.checksCompleted(pushed, { sha: HEAD, passed: true }, ctx(null))).changed).toBe(false);
    const green = value(m.checksCompleted(pushed, { sha: 'ccc', passed: true }, ctx(null)));
    expect(green.effects).toEqual([{ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: 'ccc' }]);
    // The same push on a waiting glob records green and still queues nothing.
    const waited = value(m.commitPushed(waiting(), { sha: 'ccc', runId: null }, ctx(null))).glob;
    expect(kinds(value(m.checksCompleted(waited, { sha: 'ccc', passed: true }, ctx(null))))).toEqual([]);
    // Becoming head later with that green queues the merge for the new sha.
    expect(value(m.becomeMergeHead(value(m.checksCompleted(waited, { sha: 'ccc', passed: true }, ctx(null))).glob, undefined, ctx(null))).effects).toEqual([
      { kind: 'squash_merge', globId: 's1t1', generation: 1, sha: 'ccc' },
    ]);
  });

  it.each([
    ['the head', head()],
    ['a waiting glob', waiting()],
  ])('a PR closed without merging fails %s, ends its run and advances the line', (_name, g) => {
    const t = value(m.prClosed(g, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'failed', mergeLine: null, pr: { state: 'closed' } });
    expect(t.glob.failure?.reason).toBe('PR closed without merging');
    expect(kinds(t)).toContain('advance_merge_line');
  });

  it('a PR closed on a merging glob that is not in the line is left as before', () => {
    expect(value(m.prClosed(merging(), ctx(null))).glob.status).toBe('merging');
  });

  it('deleting a glob in the line, and Start again, ask for the next head', () => {
    expect(kinds(value(m.remove(waiting(), ctx())))).toContain('advance_merge_line');
    expect(kinds(value(m.remove(open(), ctx())))).not.toContain('advance_merge_line');
    const again = value(m.startAgain(head(), ctx()));
    expect(again.glob.mergeLine).toBeNull();
    expect(kinds(again)).toContain('advance_merge_line');
  });
});

describe('a stuck head (row 16e)', () => {
  const stuck = (patch: Partial<Glob> = {}): Glob => head({ headChecks: null, updatedAt: NOW, mergeLine: { joinedAt: NOW, head: { since: NOW } }, ...patch });
  const nowMs = (minutes: number): number => Date.parse(NOW) + minutes * 60_000;

  it('thresholds: fresh until 20 minutes; recheck after; fail 20 minutes after the recheck; never with a result or when waiting', () => {
    expect(mergeHeadStuck(stuck(), nowMs(19))).toBeNull();
    expect(mergeHeadStuck(stuck(), nowMs(21))).toBe('recheck');
    // updatedAt counts as a sign of life.
    expect(mergeHeadStuck(stuck({ updatedAt: at(15) }), nowMs(21))).toBeNull();
    const rechecked = stuck({ mergeLine: { joinedAt: NOW, head: { since: NOW, recheckedAt: at(21) } } });
    expect(mergeHeadStuck(rechecked, nowMs(40))).toBeNull();
    expect(mergeHeadStuck(rechecked, nowMs(42))).toBe('fail');
    expect(MERGE_HEAD_STUCK_MS).toBe(20 * 60_000);
    expect(mergeHeadStuck(head({ headChecks: { sha: HEAD, state: 'pending' } }), nowMs(120))).toBe('recheck'); // still running: as before
    expect(mergeHeadStuck(head({ headChecks: { sha: HEAD, state: 'failed' } }), nowMs(120))).toBeNull();
    expect(mergeHeadStuck(waiting({ headChecks: null }), nowMs(120))).toBeNull();
    expect(mergeHeadStuck(open(), nowMs(120))).toBeNull();
  });

  it('the first look asks for the checks and the PR again; the second, still silent, fails the merge with the reason and advances', () => {
    const first = value(m.mergeHeadChecked(stuck(), nowMs(25), { ...ctx(null), now: at(25) }));
    expect(first.glob.mergeLine?.head).toEqual({ since: NOW, recheckedAt: at(25) });
    expect(kinds(first)).toEqual(['refresh_checks', 'reconcile_pr']);
    expect(value(m.mergeHeadChecked(first.glob, nowMs(30), { ...ctx(null), now: at(30) })).changed).toBe(false);
    const second = value(m.mergeHeadChecked(first.glob, nowMs(46), { ...ctx(null), now: at(46) }));
    expect(second.glob).toMatchObject({ status: 'failed', mergeLine: null, failure: { kind: 'merge' } });
    expect(second.glob.failure?.reason).toBe('No check result 46 minutes after the last push: recheck the checks or push again');
    expect(kinds(second)).toEqual(['advance_merge_line']);
  });

  it('a head with passed checks and no merge is stuck the same way: recheck queues the merge again, then it fails', () => {
    const passed = (patch: Partial<Glob> = {}): Glob => head({ updatedAt: NOW, ...patch });
    expect(mergeHeadStuck(passed(), nowMs(19))).toBeNull();
    expect(mergeHeadStuck(passed(), nowMs(21))).toBe('recheck');
    expect(reconcileDue(passed(), nowMs(21))).toBe(true);
    expect(mergeHeadStuck(passed({ updatedAt: at(15) }), nowMs(21))).toBeNull();
    const first = value(m.mergeHeadChecked(passed(), nowMs(25), { ...ctx(null), now: at(25) }));
    expect(kinds(first)).toEqual(['refresh_checks', 'reconcile_pr', 'squash_merge']);
    expect(first.effects.at(-1)).toEqual({ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: HEAD });
    expect(mergeHeadStuck(first.glob, nowMs(40))).toBeNull();
    const second = value(m.mergeHeadChecked(first.glob, nowMs(46), { ...ctx(null), now: at(46) }));
    expect(second.glob).toMatchObject({ status: 'failed', mergeLine: null, failure: { kind: 'merge' } });
    expect(second.glob.failure?.reason).toBe('Not merged: no merge result 46 minutes after the checks passed');
    expect(kinds(second)).toEqual(['advance_merge_line']);
  });

  it('after slop updated the branch the reason says so', () => {
    const first = value(m.mergeHeadChecked(stuck({ mergeUpdates: 1 }), nowMs(25), { ...ctx(null), now: at(25) }));
    const second = value(m.mergeHeadChecked(first.glob, nowMs(46), { ...ctx(null), now: at(46) }));
    expect(second.glob.failure?.reason).toContain('minutes after updating the branch');
  });

  it('reconcile re-reads a quiet head, never a waiting glob; the old 5-minute queue rule is gone', () => {
    expect(reconcileDue(stuck(), nowMs(21))).toBe(true);
    expect(reconcileDue(stuck(), nowMs(6))).toBe(false);
    expect(reconcileDue(waiting({ headChecks: null }), nowMs(60))).toBe(true); // the missing-check rule for any ready PR, as before
    expect(reconcileDue(waiting(), nowMs(60))).toBe(false);
  });
});

describe('what the card and the glob say', () => {
  const present = (g: Glob, place?: { position: number; ahead: string[] }) => {
    const view: PresentableGlob = { ...g, list: 'doing', branch: g.id, currentRun: null, allowedActions: m.allowedActions(g, dev), ...(place === undefined ? {} : { mergeLinePlace: place }) };
    return presentGlob({ glob: view, now: NOW, viewer: { email: dev.email, role: 'dev' } });
  };

  it('the wording: head merging, second next to merge, third and later "N ahead in the merge line"', () => {
    expect(mergeLineText(1)).toBe('merging');
    expect(mergeLineText(2)).toBe('next to merge');
    expect(mergeLineText(3)).toBe('2 ahead in the merge line');
    expect(mergeLineText(5)).toBe('4 ahead in the merge line');
    expect(mergeLineText(null)).toBe('in the merge line');
  });

  it('the head reads "merging" top right with the machine icon, and "running checks" while its checks run; nothing bottom left', () => {
    const p = present(head());
    expect(p.status).toMatchObject({ kind: 'merging', text: 'merging', icon: 'machine' });
    expect(p.cardPrimary).toBeNull();
    const checking = present(head({ headChecks: { sha: HEAD, state: 'pending' } }));
    expect(checking.status).toMatchObject({ text: 'running checks', icon: 'machine' });
    expect(checking.cardPrimary).toBeNull();
  });

  it('a waiting glob reads its place top right with the hourglass and the IDs ahead in the tooltip; nothing bottom left', () => {
    const second = present(waiting(), { position: 2, ahead: ['s1t7'] });
    expect(second.status).toMatchObject({ text: 'next to merge', icon: 'hourglass' });
    expect(second.status?.tip).toContain('s1t7');
    expect(second.cardPrimary).toBeNull();
    const fourth = present(waiting(), { position: 4, ahead: ['s1t7', 's1t8', 's1t9'] });
    expect(fourth.status).toMatchObject({ text: '3 ahead in the merge line', icon: 'hourglass' });
    expect(fourth.status?.tip).toContain('s1t7, s1t8, s1t9');
    expect(fourth.cardPrimary).toBeNull();
    // Without the place (an older API) a waiting glob still says it waits in the line.
    expect(present(waiting()).status?.text).toBe('in the merge line');
  });

  it('a waiting glob does not say "running checks" even when its checks are not in', () => {
    expect(present(waiting({ headChecks: null }), { position: 2, ahead: ['s1t7'] }).status?.text).toBe('next to merge');
  });

  it('the merge step: running for a head, carrying the place for a waiting glob, never stale (no startedAt)', () => {
    expect(machineSteps(head()).find((s) => s.kind === 'merge')).toMatchObject({ state: 'running', startedAt: null, detail: null });
    expect(machineSteps(waiting(), { mergeLinePlace: { position: 3, ahead: ['a', 'b'] } }).find((s) => s.kind === 'merge')).toMatchObject({
      state: 'running',
      detail: '2 ahead in the merge line',
      startedAt: null,
    });
  });
});

describe('the board\'s line through the service', () => {
  const ADMIN = 'admin@example.com';
  const DEV = 'dev@example.com';
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let boardId: number;
  let runs: number;
  let now: string;

  const create = async (patch: Record<string, unknown> = {}): Promise<Glob> =>
    unwrap(await globs.create(ADMIN, { boardId, title: 'Work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, ...patch }));
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const setGlob = (g: Glob): void => {
    store.state.globs.set(g.id, { glob: g, creationKey: null });
  };
  /** A same at pr_open with passed checks. */
  const ready = async (): Promise<Glob> => {
    const g = await create();
    const next = { ...g, status: 'pr_open' as const, provisioning: 'ok' as const, pr: { number: 7, state: 'ready' as const, headSha: HEAD }, headChecks: { sha: HEAD, state: 'passed' as const } };
    setGlob(next);
    return next;
  };
  /** Presses Merge on a ready glob a minute after the last one. */
  const press = async (g: Glob): Promise<Glob> => {
    now = new Date(Date.parse(now) + 60_000).toISOString();
    return unwrap(await globs.merge(DEV, g.id, (await current(g.id)).version));
  };
  const effectsOf = (id: string): string[] => store.state.outbox.filter((e) => e.globId === id).map((e) => e.kind);
  const headsOf = async (): Promise<string[]> => (await store.transaction((tx) => tx.listGlobs(boardId, { include: 'all', status: ['merging'] }))).filter((g) => g.mergeLine?.head != null).map((g) => g.id);
  const merged = (id: string) => globs.applyEvent(id, (g, c) => m.merged(g, { sha: `m-${id}` }, c));

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    now = NOW;
    boards = new BoardService({ store, notifier });
    globs = new GlobService({ store, notifier, clock: { now: () => now }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('three ready globs merge one after another: one head at a time, the others get no merge, update or check work', async () => {
    const [a, b, c] = [await ready(), await ready(), await ready()] as [Glob, Glob, Glob];
    for (const g of [a, b, c]) await press(g);
    // Joining queues only the nudge.
    for (const g of [a, b, c]) expect(effectsOf(g.id)).not.toContain('squash_merge');

    const first = await globs.advanceMergeLine(boardId);
    expect(first?.id).toBe(a.id);
    expect(await headsOf()).toEqual([a.id]);
    expect(store.state.outbox.filter((e) => e.kind === 'squash_merge').map((e) => e.globId)).toEqual([a.id]);
    for (const g of [b, c]) {
      expect(effectsOf(g.id)).not.toContain('squash_merge');
      expect(effectsOf(g.id)).not.toContain('refresh_checks');
    }
    // A second nudge changes nothing.
    expect(await globs.advanceMergeLine(boardId)).toBeNull();
    expect(store.state.outbox.filter((e) => e.kind === 'squash_merge')).toHaveLength(1);

    // The places the glob view reads.
    expect(unwrap(await globs.get(DEV, c.id)).mergeLinePlace).toEqual({ position: 3, ahead: [a.id, b.id] });
    expect(unwrap(await globs.get(DEV, a.id)).mergeLinePlace).toEqual({ position: 1, ahead: [] });

    // A merges: B is next.
    unwrap(await merged(a.id));
    expect((await globs.advanceMergeLine(boardId))?.id).toBe(b.id);
    expect(store.state.outbox.filter((e) => e.kind === 'squash_merge').map((e) => e.globId)).toEqual([a.id, b.id]);
    expect(effectsOf(c.id)).not.toContain('squash_merge');
    unwrap(await merged(b.id));
    expect((await globs.advanceMergeLine(boardId))?.id).toBe(c.id);
    unwrap(await merged(c.id));
    expect(await globs.advanceMergeLine(boardId)).toBeNull();
    expect(await headsOf()).toEqual([]);
    expect((await current(c.id)).status).toBe('reviewing');
  });

  it('a red head leaves with the reason and the next glob is made head', async () => {
    const [a, b] = [await ready(), await ready()] as [Glob, Glob];
    await press(a);
    await press(b);
    await globs.advanceMergeLine(boardId);
    const failed = unwrap(await globs.applyEvent(a.id, (g, c) => m.checksCompleted(g, { sha: HEAD, passed: false }, c)));
    expect(failed).toMatchObject({ status: 'failed', mergeLine: null, failure: { kind: 'merge' } });
    expect((await globs.advanceMergeLine(boardId))?.id).toBe(b.id);
    expect(await headsOf()).toEqual([b.id]);
  });

  it('a gated candidate is held and skipped; the glob behind it becomes head', async () => {
    const [a, b] = [await ready(), await ready()] as [Glob, Glob];
    await press(a);
    await press(b);
    // A merge relation is added to A after it joined, on a glob that has not merged.
    const blocker = await create();
    const relation = fixtureRelation(a.id, blocker.id, { boardId, gate: 'merge' });
    store.state.relations.set(relation.id, relation);
    const next = await globs.advanceMergeLine(boardId);
    expect(next?.id).toBe(b.id);
    expect(await current(a.id)).toMatchObject({ status: 'pr_open', mergeLine: null, mergeMode: 'when_green', mergeHold: { sha: HEAD, for: [blocker.id] } });
    // Releasing the gate joins A again, at the back, behind B.
    unwrap(await merged(blocker.id));
    await globs.releaseDependents(blocker.id, boardId);
    const again = await current(a.id);
    expect(again.status).toBe('merging');
    expect(again.mergeLine?.head).toBeUndefined();
    expect(unwrap(await globs.get(DEV, a.id)).mergeLinePlace).toEqual({ position: 2, ahead: [b.id] });
  });

  it('Cancel merge takes a waiting glob out and the head\'s cancel hands the line on', async () => {
    const [a, b, c] = [await ready(), await ready(), await ready()] as [Glob, Glob, Glob];
    for (const g of [a, b, c]) await press(g);
    await globs.advanceMergeLine(boardId);
    unwrap(await globs.cancelMerge(DEV, b.id, (await current(b.id)).version));
    expect(await current(b.id)).toMatchObject({ status: 'pr_open', mergeLine: null });
    unwrap(await globs.cancelMerge(DEV, a.id, (await current(a.id)).version));
    expect((await globs.advanceMergeLine(boardId))?.id).toBe(c.id);
  });

  it('several advancers at once still make exactly one head', async () => {
    const all = [await ready(), await ready(), await ready(), await ready()];
    for (const g of all) await press(g);
    await Promise.all([1, 2, 3, 4, 5].map(() => globs.advanceMergeLine(boardId)));
    expect(await headsOf()).toHaveLength(1);
    expect(store.state.outbox.filter((e) => e.kind === 'squash_merge')).toHaveLength(1);
  });

  it('the store refuses a second head on a board (the one-head invariant), and allows one per board', async () => {
    const [a, b] = [await ready(), await ready()] as [Glob, Glob];
    await press(a);
    await press(b);
    await globs.advanceMergeLine(boardId);
    const waitingOne = await current(b.id);
    await expect(
      store.transaction((tx) => tx.updateGlob({ ...waitingOne, version: waitingOne.version + 1, mergeLine: { joinedAt: NOW, head: { since: NOW } } }, waitingOne.version)),
    ).rejects.toThrow(/already has a merge head/);
    // Another board keeps its own head.
    const other = unwrap(await boards.create(ADMIN, { name: 'other', repo: null, timeZone: 'UTC', environments: [] }));
    unwrap(await boards.setMember(ADMIN, other.id, DEV, 'dev'));
    const o = unwrap(await globs.create(ADMIN, { boardId: other.id, title: 'Other', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
    setGlob({ ...o, status: 'pr_open', provisioning: 'ok', pr: { number: 9, state: 'ready', headSha: HEAD }, headChecks: { sha: HEAD, state: 'passed' } });
    await press(o);
    expect((await globs.advanceMergeLine(other.id))?.id).toBe(o.id);
    expect(await headsOf()).toEqual([a.id]);
  });

  it('a merging glob that predates the line is adopted, keeping its seniority', async () => {
    const old = await ready();
    setGlob({ ...old, status: 'merging', updatedAt: at(-60) });
    const newer = await ready();
    await press(newer);
    expect((await globs.advanceMergeLine(boardId))?.id).toBe(old.id);
    expect((await current(old.id)).mergeLine?.joinedAt).toBe(at(-60));
  });

  it('the sweep\'s head check rechecks a quiet head, then fails it and hands the line on', async () => {
    const [a, b] = [await ready(), await ready()] as [Glob, Glob];
    await press(a);
    await press(b);
    await globs.advanceMergeLine(boardId);
    // The head's checks never report.
    const quiet = await current(a.id);
    setGlob({ ...quiet, headChecks: null, updatedAt: now, mergeLine: { joinedAt: quiet.mergeLine?.joinedAt ?? NOW, head: { since: now } } });
    const base = Date.parse(now);
    now = new Date(base + 25 * 60_000).toISOString();
    unwrap(await globs.checkMergeHead(a.id));
    expect((await current(a.id)).mergeLine?.head?.recheckedAt).toBe(now);
    expect(effectsOf(a.id)).toContain('reconcile_pr');
    now = new Date(base + 50 * 60_000).toISOString();
    unwrap(await globs.checkMergeHead(a.id));
    expect(await current(a.id)).toMatchObject({ status: 'failed', mergeLine: null });
    expect((await globs.advanceMergeLine(boardId))?.id).toBe(b.id);
    // A waiting glob is never swept.
    const untouched = await current(b.id);
    unwrap(await globs.checkMergeHead(b.id));
    expect((await current(b.id)).version).toBe(untouched.version);
  });
});
