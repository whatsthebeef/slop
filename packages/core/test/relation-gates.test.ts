import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import { machineSteps } from '../src/domain/machine-steps.js';
import { holdingOf, isMergeHeld } from '../src/domain/relations.js';
import { LABEL_NAMES } from '../src/domain/types.js';
import type { Glob, Relation } from '../src/domain/types.js';
import { hash } from '../src/app/text-hash.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board, ctx, dev, glob as fixture, po, relation, relationFacts } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);
const message = <T>(result: Result<T>): string => (result.ok ? '' : result.error.message);

const HEAD = 'a2a88c8aaaa';
const open = (patch: Partial<Glob> = {}): Glob =>
  fixture({ id: 's1t2', status: 'pr_open', type: 'same', pr: { number: 7, state: 'ready', headSha: HEAD }, headChecks: { sha: HEAD, state: 'passed' }, implementer: dev.email, ...patch });

/** Facts for glob s1t2 holding on `to` (s1t1) at `gate`, with `to` in the given state. */
const facts = (gate: Relation['gate'], state: Parameters<typeof relationFacts>[1][number][1], patch: Partial<Relation> = {}) =>
  relationFacts('s1t2', [['s1t1', state]], { gate, ...patch });

describe('the merge gate (machine)', () => {
  it('refuses Merge while a merge relation is unmet, and offers it once met; a start relation does not matter', () => {
    const g = open();
    const refused = machine.requestMerge(g, ctx(dev), { continue: false, facts: { relations: facts('merge', 'open') } });
    expect(code(refused)).toBe('invalid_transition');
    expect(message(refused)).toBe("Can't merge until s1t1 is merged and rolled out");
    expect(machine.allowedActions(g, dev, { relations: facts('merge', 'open') })).not.toContain('merge');
    expect(machine.allowedActions(g, dev, { relations: facts('merge', 'merged') })).toContain('merge');
    const met = unwrap(machine.requestMerge(g, ctx(dev), { continue: false, facts: { relations: facts('merge', 'merged') } }));
    expect(met.glob.status).toBe('merging');
    // A start relation holds a start, not a merge.
    expect(machine.allowedActions(g, dev, { relations: facts('start', 'open') })).toContain('merge');
    // Dismissed, it no longer holds.
    expect(machine.allowedActions(g, dev, { relations: facts('merge', 'open', { dismissedAt: NOW }) })).toContain('merge');
  });

  it('refuses Retry merge while a merge relation is unmet', () => {
    const failed = open({ status: 'failed', failure: { reason: 'GitHub had not decided', at: NOW, kind: 'merge' } });
    expect(code(machine.retryMerge(failed, ctx(dev), facts('merge', 'planning')))).toBe('invalid_transition');
    expect(unwrap(machine.retryMerge(failed, ctx(dev), facts('merge', 'merged'))).glob.status).toBe('merging');
  });

  it('an armed merge stays armed with one MergeHeld event while a merge relation is unmet, and no squash_merge', () => {
    const armed = open({ mergeMode: 'when_green', headChecks: { sha: HEAD, state: 'pending' } });
    const held = unwrap(machine.checksCompleted(armed, { sha: HEAD, passed: true }, ctx(null), facts('merge', 'open')));
    expect(held.glob.status).toBe('pr_open');
    expect(held.glob.mergeMode).toBe('when_green');
    expect(held.glob.mergeHold).toEqual({ since: NOW, sha: HEAD, for: ['s1t1'] });
    expect(held.effects.some((e) => e.kind === 'squash_merge')).toBe(false);
    expect(held.events.filter((e) => e.type === 'MergeHeld').map((e) => e.data)).toEqual([{ for: ['s1t1'], sha: HEAD }]);
    expect(isMergeHeld(held.glob)).toBe(true);
    // The same result again records nothing more.
    const again = unwrap(machine.checksCompleted(held.glob, { sha: HEAD, passed: true }, ctx(null), facts('merge', 'open')));
    expect(again.events.filter((e) => e.type === 'MergeHeld')).toEqual([]);
    // With the relation met (or loaded none) it merges as before.
    const free = unwrap(machine.checksCompleted(armed, { sha: HEAD, passed: true }, ctx(null), facts('merge', 'merged')));
    expect(free.glob.status).toBe('merging');
    expect(free.effects.some((e) => e.kind === 'squash_merge')).toBe(true);
  });

  it('a sub whose gate passed stays in pr_open, held, instead of merging', () => {
    const sub = open({ type: 'sub', implementer: null });
    const held = unwrap(machine.subGateCompleted(sub, { sha: HEAD, passed: true, reason: null }, ctx(null), facts('merge', 'open')));
    expect(held.glob.status).toBe('pr_open');
    expect(held.glob.mergeHold).toMatchObject({ sha: HEAD, for: ['s1t1'] });
    expect(held.events.map((e) => e.type)).toEqual(['SubReviewCompleted', 'MergeHeld']);
    expect(held.effects.some((e) => e.kind === 'squash_merge')).toBe(false);
    expect(machineSteps(held.glob).find((s) => s.kind === 'merge_held')).toMatchObject({ state: 'running', holdsBall: false, detail: 's1t1' });
    const free = unwrap(machine.subGateCompleted(sub, { sha: HEAD, passed: true, reason: null }, ctx(null), facts('merge', 'merged')));
    expect(free.glob.status).toBe('merging');
  });

  it('gateReleased resumes a held armed merge and a held sub, once, and only when every merge relation is met', () => {
    const armed = open({ mergeMode: 'when_green', mergeHold: { since: NOW, sha: HEAD, for: ['s1t1'] } });
    expect(unwrap(machine.gateReleased(armed, facts('merge', 'open'), null, ctx(null))).changed).toBe(false);
    const resumed = unwrap(machine.gateReleased(armed, facts('merge', 'merged'), null, ctx(null)));
    expect(resumed.glob).toMatchObject({ status: 'merging', mergeMode: null, mergeHold: null });
    expect(resumed.events.map((e) => e.type)).toEqual(['MergeResumed', 'StatusChanged']);
    expect(resumed.effects).toEqual([{ kind: 'squash_merge', globId: armed.id, generation: armed.generation, sha: HEAD }]);
    // Idempotent: the second call on the result changes nothing.
    expect(unwrap(machine.gateReleased(resumed.glob, facts('merge', 'merged'), null, ctx(null))).changed).toBe(false);

    const sub = open({ type: 'sub', implementer: null, mergeHold: { since: NOW, sha: HEAD, for: ['s1t1'] } });
    expect(unwrap(machine.gateReleased(sub, facts('merge', 'merged'), null, ctx(null))).glob.status).toBe('merging');
    // A new head: the hold was for the old one, the new gate verdict decides.
    const pushed = { ...sub, pr: { number: 7, state: 'ready' as const, headSha: 'ffff0000fff' }, headChecks: { sha: 'ffff0000fff', state: 'passed' as const } };
    expect(unwrap(machine.gateReleased(pushed, facts('merge', 'merged'), null, ctx(null))).changed).toBe(false);
    // Checks failed or a conflict since: nothing to merge.
    expect(unwrap(machine.gateReleased({ ...armed, conflict: { base: 'main', files: [], since: null, at: NOW } }, facts('merge', 'merged'), null, ctx(null))).changed).toBe(false);
    expect(unwrap(machine.gateReleased({ ...armed, headChecks: { sha: HEAD, state: 'failed' } }, facts('merge', 'merged'), null, ctx(null))).changed).toBe(false);
  });

  it('Start now never bypasses a merge or sign-off gate: it overrides inferred start relations only', () => {
    const held = fixture({ id: 's1t2', status: 'planning', type: 'same', waiting: { since: NOW } });
    const all = {
      relations: [
        relation('s1t2', 's1t1', { id: 'a', gate: 'start', source: 'inferred' }),
        relation('s1t2', 's1t3', { id: 'b', gate: 'merge', source: 'inferred' }),
        relation('s1t2', 's1t4', { id: 'c', gate: 'sign_off', source: 'learned' }),
        relation('s1t2', 's1t5', { id: 'd', gate: 'start', source: 'person' }),
      ],
      states: new Map([['s1t1', 'open'], ['s1t3', 'open'], ['s1t4', 'open'], ['s1t5', 'open']] as const),
    };
    const started = unwrap(machine.startAnyway(held, ctx(dev), all));
    expect(started.relationEdits?.map((e) => e.id)).toEqual(['a']);
    expect(started.glob.status).toBe('implementing');
  });
});

describe('editing what a glob waits for (machine)', () => {
  it('an `after` that lists the same globs in another order is no edit, even on a started glob', () => {
    const started = fixture({ id: 's1t3', status: 'in_progress' });
    const echoed = machine.changeFields(started, { after: { from: ['s1t2', 's1t1'], to: ['s1t1', 's1t2'] } }, board, ctx(dev));
    expect(unwrap(echoed).changed).toBe(false);
    expect(code(machine.changeFields(started, { after: { from: ['s1t1'], to: ['s1t1', 's1t2'] } }, board, ctx(dev)))).toBe('invalid_transition');
  });
});

describe('the sign-off gate (machine)', () => {
  const reviewing = (patch: Partial<Glob> = {}): Glob => fixture({ id: 's1t2', status: 'reviewing', labels: { QA: 'required' }, ...patch });

  it('labels stay approvable, but the last approval holds in Reviewing with a SignOffHeld event', () => {
    const t = unwrap(machine.reviewLabel(reviewing(), 'QA', { kind: 'approve' }, ctx(po), null, facts('sign_off', 'open')));
    expect(t.glob.labels.QA).toBe('approved');
    expect(t.glob.status).toBe('reviewing');
    expect(t.events.map((e) => e.type)).toEqual(['LabelChanged', 'SignOffHeld']);
    expect(t.events.find((e) => e.type === 'SignOffHeld')?.data).toEqual({ for: ['s1t1'] });
    // Met: it signs off, and releases whatever waits for it.
    const free = unwrap(machine.reviewLabel(reviewing(), 'QA', { kind: 'approve' }, ctx(po), null, facts('sign_off', 'merged')));
    expect(free.glob.status).toBe('signed_off');
    expect(free.effects.some((e) => e.kind === 'release_waiting')).toBe(true);
  });

  it('a start or merge relation does not hold the sign-off', () => {
    for (const gate of ['start', 'merge'] as const) {
      expect(unwrap(machine.reviewLabel(reviewing(), 'QA', { kind: 'approve' }, ctx(po), null, facts(gate, 'open'))).glob.status).toBe('signed_off');
    }
  });

  it('rolloutSettled waits for the relation; gateReleased then moves a glob with approved labels', () => {
    const approved = reviewing({ labels: { QA: 'approved' } });
    expect(unwrap(machine.rolloutSettled(approved, { open: 0, total: 1 }, ctx(null), facts('sign_off', 'open'))).changed).toBe(false);
    expect(unwrap(machine.rolloutSettled(approved, { open: 0, total: 1 }, ctx(null), facts('sign_off', 'merged'))).glob.status).toBe('signed_off');
    expect(unwrap(machine.gateReleased(approved, facts('sign_off', 'open'), null, ctx(null))).changed).toBe(false);
    const moved = unwrap(machine.gateReleased(approved, facts('sign_off', 'signed_off', { until: 'signed_off' }), null, ctx(null)));
    expect(moved.glob.status).toBe('signed_off');
    expect(moved.events.map((e) => e.type)).toEqual(['SignOffReleased', 'StatusChanged']);
    // A rollout still open, labels still to approve, or nothing in Reviewing: nothing to do. And a repeat changes nothing.
    expect(unwrap(machine.gateReleased(approved, facts('sign_off', 'merged'), { open: 1, total: 1 }, ctx(null))).changed).toBe(false);
    expect(unwrap(machine.gateReleased(reviewing(), facts('sign_off', 'merged'), null, ctx(null))).changed).toBe(false);
    expect(unwrap(machine.gateReleased(moved.glob, facts('sign_off', 'merged'), null, ctx(null))).changed).toBe(false);
  });

  it('refuses to sign off a decision while a sign-off relation is unmet', () => {
    const admin = { email: 'admin@example.com', role: 'admin' as const };
    const decision = fixture({
      id: 's1k1',
      category: 'decision',
      status: 'reviewing',
      attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: { kind: 'accept', by: 'x', at: NOW } },
    });
    expect(code(machine.signOffDecision(decision, ctx(admin), null, relationFacts('s1k1', [['s1t1', 'open']], { gate: 'sign_off' })))).toBe('invalid_transition');
    expect(unwrap(machine.signOffDecision(decision, ctx(admin), null, relationFacts('s1k1', [['s1t1', 'merged']], { gate: 'sign_off' }))).glob.status).toBe('signed_off');
  });
});

describe('Merge anyway and Sign off anyway (machine)', () => {
  const WHY = 'The prerequisite is cosmetic';
  const ids = (events: readonly { type: string }[]): string[] => events.map((e) => e.type);

  describe('merge', () => {
    const held = facts('merge', 'open');

    it('merges a same now when the checks passed, lifts the merge relation and logs who and why', () => {
      const t = unwrap(machine.mergeAnyway(open(), WHY, ctx(dev), { continue: false, facts: { relations: held } }));
      expect(t.glob.status).toBe('merging');
      expect(t.effects.some((e) => e.kind === 'squash_merge')).toBe(true);
      expect(t.relationEdits).toEqual([{ id: 'rel-s1t2-s1t1-merge', overriddenAt: NOW }]);
      expect(t.events.find((e) => e.type === 'MergeOverridden')).toMatchObject({ globId: 's1t2', actor: dev.email, data: { for: ['s1t1'], reason: WHY } });
      // Start-now learning reads HoldOverridden: Merge anyway must never emit it.
      expect(ids(t.events)).not.toContain('HoldOverridden');
    });

    it('arms the merge when the checks are still pending, as Merge would', () => {
      const t = unwrap(machine.mergeAnyway(open({ headChecks: { sha: HEAD, state: 'pending' } }), WHY, ctx(dev), { continue: false, facts: { relations: held } }));
      expect(t.glob).toMatchObject({ status: 'pr_open', mergeMode: 'when_green' });
      expect(ids(t.events)).toEqual(['MergeOverridden', 'MergeArmed']);
    });

    it('merges a same with rollout steps as Merge does: now once the checks passed (kept open for them), never armed', () => {
      const withSteps = { relations: held, rolloutSteps: 2 };
      const t = unwrap(machine.mergeAnyway(open(), WHY, ctx(dev), { continue: false, facts: withSteps }));
      expect(t.glob).toMatchObject({ status: 'merging', mergeMode: null });
      expect(t.effects.some((e) => e.kind === 'squash_merge')).toBe(true);
      // Kept open for the steps: the merge is observed as a rollout, not a close.
      expect(t.events.find((e) => e.type === 'StatusChanged')?.data).toMatchObject({ to: 'merging', mode: 'rollout' });
      const pending = open({ headChecks: { sha: HEAD, state: 'pending' } });
      expect(message(machine.mergeAnyway(pending, WHY, ctx(dev), { continue: false, facts: withSteps }))).toBe('Required checks have not passed on the current head');
      expect(machine.allowedActions(open(), dev, withSteps)).toContain('merge_anyway');
      expect(machine.allowedActions(pending, dev, withSteps)).not.toContain('merge_anyway');
    });

    it('lifts only the unmet merge relations, of any source: a person-made one included', () => {
      const relations = {
        relations: [
          relation('s1t2', 's1t1', { id: 'a', gate: 'merge', source: 'person' }),
          relation('s1t2', 's1t3', { id: 'b', gate: 'merge', source: 'mention' }),
          relation('s1t2', 's1t4', { id: 'c', gate: 'merge', source: 'agent' }),
          relation('s1t2', 's1t5', { id: 'd', gate: 'sign_off', source: 'person' }),
          relation('s1t2', 's1t6', { id: 'e', gate: 'start', source: 'person' }),
        ],
        states: new Map([['s1t1', 'open'], ['s1t3', 'open'], ['s1t4', 'merged'], ['s1t5', 'open'], ['s1t6', 'open']] as const),
      };
      const t = unwrap(machine.mergeAnyway(open(), WHY, ctx(dev), { continue: false, facts: { relations } }));
      expect(t.relationEdits?.map((e) => e.id)).toEqual(['a', 'b']);
      expect(t.events.find((e) => e.type === 'MergeOverridden')?.data).toMatchObject({ for: ['s1t1', 's1t3'] });
    });

    it('goes on with an armed merge held for the relation, and with a sub whose gate passed', () => {
      const armed = open({ mergeMode: 'when_green', mergeHold: { since: NOW, sha: HEAD, for: ['s1t1'] } });
      const a = unwrap(machine.mergeAnyway(armed, WHY, ctx(dev), { continue: false, facts: { relations: held } }));
      expect(a.glob).toMatchObject({ status: 'merging', mergeMode: null, mergeHold: null });
      expect(ids(a.events)).toEqual(['MergeOverridden', 'MergeResumed', 'StatusChanged']);
      const sub = open({ type: 'sub', implementer: null, mergeHold: { since: NOW, sha: HEAD, for: ['s1t1'] } });
      const b = unwrap(machine.mergeAnyway(sub, WHY, ctx(dev), { continue: false, facts: { relations: held } }));
      expect(b.glob.status).toBe('merging');
      expect(b.effects.some((e) => e.kind === 'squash_merge')).toBe(true);
    });

    it('lifts the relation and leaves an armed merge armed while its checks are pending', () => {
      const armed = open({ mergeMode: 'when_green', headChecks: { sha: HEAD, state: 'pending' } });
      const t = unwrap(machine.mergeAnyway(armed, WHY, ctx(dev), { continue: false, facts: { relations: held } }));
      expect(t.glob).toMatchObject({ status: 'pr_open', mergeMode: 'when_green' });
      expect(t.relationEdits).toHaveLength(1);
      expect(ids(t.events)).toEqual(['MergeOverridden']);
    });

    it('is refused when nothing holds, with no reason, with a conflict, failed checks or a merge question, and for QA or PO on a same', () => {
      const none = machine.mergeAnyway(open(), WHY, ctx(dev), { continue: false, facts: { relations: facts('merge', 'merged') } });
      expect(code(none)).toBe('invalid_transition');
      expect(message(none)).toBe('Nothing holds this merge; use Merge');
      expect(code(machine.mergeAnyway(open(), '  ', ctx(dev), { continue: false, facts: { relations: held } }))).toBe('invalid_transition');
      const conflicted = open({ conflict: { base: 'main', files: [], since: null, at: NOW } });
      expect(message(machine.mergeAnyway(conflicted, WHY, ctx(dev), { continue: false, facts: { relations: held } }))).toMatch(/^Conflicts with the base branch/);
      expect(message(machine.mergeAnyway(open({ headChecks: { sha: HEAD, state: 'failed' } }), WHY, ctx(dev), { continue: false, facts: { relations: held } }))).toBe('Required checks failed on the current head');
      expect(code(machine.mergeAnyway(open({ type: 'sub', implementer: null, conflict: { base: 'main', files: [], since: null, at: NOW } }), WHY, ctx(dev), { continue: false, facts: { relations: held } }))).toBe('invalid_transition');
      expect(code(machine.mergeAnyway(open({ status: 'in_progress' }), WHY, ctx(dev), { continue: false, facts: { relations: held } }))).toBe('invalid_transition');
      expect(code(machine.mergeAnyway(open(), WHY, ctx(po), { continue: false, facts: { relations: held } }))).toBe('forbidden');
    });

    it('is offered only while a merge relation holds a ready PR that nothing else blocks', () => {
      expect(machine.allowedActions(open(), dev, { relations: held })).toEqual(expect.arrayContaining(['merge_anyway']));
      expect(machine.allowedActions(open(), dev, { relations: held })).not.toContain('merge');
      expect(machine.allowedActions(open(), dev, { relations: facts('merge', 'merged') })).not.toContain('merge_anyway');
      expect(machine.allowedActions(open(), dev, { relations: facts('start', 'open') })).not.toContain('merge_anyway');
      expect(machine.allowedActions(open(), dev)).not.toContain('merge_anyway');
      expect(machine.allowedActions(open({ headChecks: { sha: HEAD, state: 'failed' } }), dev, { relations: held })).not.toContain('merge_anyway');
      expect(machine.allowedActions(open({ type: 'sub', implementer: null }), dev, { relations: held })).toContain('merge_anyway');
      expect(machine.allowedActions(open({ mergeMode: 'when_green', mergeHold: { since: NOW, sha: HEAD, for: ['s1t1'] } }), dev, { relations: held })).toEqual(expect.arrayContaining(['cancel_merge', 'merge_anyway']));
      expect(machine.allowedActions(open(), po, { relations: held })).not.toContain('merge_anyway');
    });
  });

  describe('sign off', () => {
    const reviewing = (patch: Partial<Glob> = {}): Glob => fixture({ id: 's1t2', status: 'reviewing', labels: { QA: 'approved' }, ...patch });
    const heldOff = facts('sign_off', 'open');

    it('signs off a merged glob with approved labels, lifts the relation and logs who and why', () => {
      const t = unwrap(machine.signOffAnyway(reviewing(), WHY, ctx(dev), null, heldOff));
      expect(t.glob).toMatchObject({ status: 'signed_off', signedOffAt: NOW });
      expect(t.relationEdits).toEqual([{ id: 'rel-s1t2-s1t1-sign_off', overriddenAt: NOW }]);
      expect(t.events.find((e) => e.type === 'SignOffOverridden')).toMatchObject({ actor: dev.email, data: { for: ['s1t1'], reason: WHY } });
      expect(ids(t.events)).not.toContain('HoldOverridden');
      expect(t.effects.some((e) => e.kind === 'release_waiting')).toBe(true);
    });

    it('never skips labels or rollout steps, and needs a held sign-off and a reason', () => {
      expect(message(machine.signOffAnyway(reviewing({ labels: { QA: 'required' } }), WHY, ctx(dev), null, heldOff))).toBe('Every label must be approved before the glob can be signed off');
      expect(code(machine.signOffAnyway(reviewing(), WHY, ctx(dev), { open: 1, total: 1, steps: [] } as never, heldOff))).toBe('invalid_transition');
      expect(message(machine.signOffAnyway(reviewing(), WHY, ctx(dev), null, facts('sign_off', 'merged')))).toBe('Nothing holds this sign-off');
      expect(code(machine.signOffAnyway(reviewing(), '', ctx(dev), null, heldOff))).toBe('invalid_transition');
      expect(code(machine.signOffAnyway(reviewing({ status: 'pr_open' }), WHY, ctx(dev), null, heldOff))).toBe('invalid_transition');
    });

    it('is offered next to nothing else: only while approved labels wait on a sign_off relation', () => {
      expect(machine.allowedActions(reviewing(), dev, { relations: heldOff })).toContain('sign_off_anyway');
      expect(machine.allowedActions(reviewing(), dev, { relations: facts('sign_off', 'merged') })).not.toContain('sign_off_anyway');
      expect(machine.allowedActions(reviewing({ labels: { QA: 'required' } }), dev, { relations: heldOff })).not.toContain('sign_off_anyway');
      expect(machine.allowedActions(reviewing(), dev)).not.toContain('sign_off_anyway');
    });

    it('signs off a decision, for admins and POs only', () => {
      const decisionGlob = fixture({
        id: 's1t2',
        category: 'decision',
        status: 'reviewing',
        pr: null,
        provisioning: 'none',
        attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: { kind: 'accept', by: po.email, at: NOW } },
      });
      const t = unwrap(machine.signOffAnyway(decisionGlob, WHY, ctx(po), null, heldOff));
      expect(t.glob.status).toBe('signed_off');
      expect(ids(t.events)).toContain('SignOffOverridden');
      expect(code(machine.signOffAnyway(decisionGlob, WHY, ctx(dev), null, heldOff))).toBe('forbidden');
      expect(machine.allowedActions(decisionGlob, po, { relations: heldOff })).toEqual(expect.arrayContaining(['sign_off', 'sign_off_anyway']));
      expect(machine.allowedActions(decisionGlob, po, { relations: facts('sign_off', 'merged') })).not.toContain('sign_off_anyway');
    });
  });

  describe('start', () => {
    it('records the reason on HoldOverridden when one is given, and lifts a mention start relation', () => {
      const held = fixture({ id: 's1t2', status: 'planning', type: 'same', waiting: { since: NOW } });
      const relations = {
        relations: [relation('s1t2', 's1t1', { id: 'a', gate: 'start', source: 'mention' }), relation('s1t2', 's1t3', { id: 'b', gate: 'start', source: 'person' })],
        states: new Map([['s1t1', 'open'], ['s1t3', 'open']] as const),
      };
      const t = unwrap(machine.startAnyway(held, ctx(dev), relations, ' ship it '));
      expect(t.relationEdits?.map((e) => e.id)).toEqual(['a']);
      expect(t.events.find((e) => e.type === 'HoldOverridden')?.data).toMatchObject({ reason: 'ship it' });
      const bare = unwrap(machine.startAnyway(held, ctx(dev), relations));
      expect(bare.events.find((e) => e.type === 'HoldOverridden')?.data).not.toHaveProperty('reason');
    });
  });
});

describe('releases from a decision being decided (machine)', () => {
  const admin = { email: 'admin@example.com', role: 'admin' as const };
  const decision = (patch: Partial<Glob> = {}) =>
    fixture({
      id: 's1k1',
      category: 'decision',
      status: 'in_progress',
      attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: null },
      ...patch,
    });

  it('accept and reject queue the release of what waits for the decision; needs work and retarget do not', () => {
    const queued = (outcome: Parameters<typeof machine.decideDecision>[1]['outcome']) =>
      unwrap(machine.decideDecision(decision(), { outcome, ...(outcome === 'reject' ? { reason: 'no' } : {}), ...(outcome === 'needs_work' ? { linkedGlobId: 's1t5' } : {}) }, ctx(admin))).effects.some((e) => e.kind === 'release_waiting');
    expect(queued('accept')).toBe(true);
    expect(queued('accept_with_edits')).toBe(true);
    expect(queued('reject')).toBe(true);
    expect(queued('needs_work')).toBe(false);
    expect(queued('retarget')).toBe(false);
  });
});

describe('the relation service: gates, resumes and the relations API', () => {
  const ADMIN = 'admin@example.com';
  const DEV = 'dev@example.com';
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let boardId: number;
  let runs: number;

  const create = async (patch: Record<string, unknown> = {}): Promise<Glob> =>
    unwrap(await globs.create(ADMIN, { boardId, title: 'Work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, ...patch }));
  const rows = (from?: string): Relation[] => [...store.state.relations.values()].filter((r) => from === undefined || r.from === from);
  const merge = async (id: string) => unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const setGlob = (g: Glob): void => {
    store.state.globs.set(g.id, { glob: g, creationKey: null });
  };
  /** A decision glob on the board. */
  const decision = (id: string, patch: Partial<Glob> = {}): Glob => {
    const g = fixture({
      id,
      boardId,
      category: 'decision',
      status: 'in_progress',
      pr: null,
      provisioning: 'none',
      attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: null },
      ...patch,
    });
    setGlob(g);
    return g;
  };
  const effectKinds = (): string[] => store.state.outbox.map((e) => e.kind);

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    boards = new BoardService({ store, notifier });
    globs = new GlobService({ store, notifier, clock: { now: () => NOW }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  /** A same at pr_open with passed checks. */
  const ready = async (patch: Partial<Glob> = {}): Promise<Glob> => {
    const g = await create();
    const next = { ...g, status: 'pr_open' as const, provisioning: 'ok' as const, pr: { number: 7, state: 'ready' as const, headSha: HEAD }, headChecks: { sha: HEAD, state: 'passed' as const }, ...patch };
    setGlob(next);
    return next;
  };

  it('Merge is refused with the reason while a merge relation is unmet, and offered once its glob merged', async () => {
    const first = await create();
    const g = await ready();
    unwrap(await globs.addRelation(DEV, g.id, (await current(g.id)).version, { to: first.id, gate: 'merge' }));
    const refused = await globs.merge(DEV, g.id, (await current(g.id)).version);
    expect(code(refused)).toBe('invalid_transition');
    expect(message(refused)).toBe(`Can't merge until ${first.id} is merged and rolled out`);
    expect(unwrap(await globs.get(DEV, g.id)).allowedActions).not.toContain('merge');
    await merge(first.id);
    expect(unwrap(await globs.get(DEV, g.id)).allowedActions).toContain('merge');
    expect(unwrap(await globs.merge(DEV, g.id, (await current(g.id)).version)).status).toBe('merging');
  });

  it('an armed merge held for a relation resumes when the other glob merges (the release path), exactly once', async () => {
    const first = await create();
    const g = await ready({ mergeMode: 'when_green', headChecks: { sha: HEAD, state: 'pending' } });
    unwrap(await globs.addRelation(DEV, g.id, (await current(g.id)).version, { to: first.id, gate: 'merge' }));
    unwrap(await globs.applyEvent(g.id, (x, c, f) => machine.checksCompleted(x, { sha: HEAD, passed: true }, c, f.relations), { relations: true }));
    const held = await current(g.id);
    expect(held).toMatchObject({ status: 'pr_open', mergeMode: 'when_green', mergeHold: { sha: HEAD, for: [first.id] } });
    expect(effectKinds()).not.toContain('squash_merge');
    expect(unwrap(await globs.get(DEV, g.id)).holding).toMatchObject([{ to: first.id, gate: 'merge' }]);
    // Nothing changes while the other glob has not merged.
    await globs.releaseDependents(first.id, boardId);
    expect((await current(g.id)).status).toBe('pr_open');
    await merge(first.id);
    await globs.releaseDependents(first.id, boardId);
    const resumed = await current(g.id);
    expect(resumed).toMatchObject({ status: 'merging', mergeMode: null });
    expect(resumed.mergeHold ?? null).toBeNull();
    expect(effectKinds().filter((k) => k === 'squash_merge')).toHaveLength(1);
    // A second release changes nothing and queues no second merge.
    await globs.releaseDependents(first.id, boardId);
    expect(effectKinds().filter((k) => k === 'squash_merge')).toHaveLength(1);
  });

  it('a held sub resumes when the relation is dismissed, and when the other glob is deleted', async () => {
    const first = await create();
    const second = await create();
    const sub = await ready({ type: 'sub', implementer: null });
    unwrap(await globs.addRelation(DEV, sub.id, (await current(sub.id)).version, { to: first.id, gate: 'merge' }));
    unwrap(await globs.applyEvent(sub.id, (x, c, f) => machine.subGateCompleted(x, { sha: HEAD, passed: true, reason: null }, c, f.relations), { relations: true }));
    expect((await current(sub.id)).status).toBe('pr_open');
    expect(rows(sub.id).filter((r) => r.gate === 'merge')).toHaveLength(1);
    const relation = rows(sub.id).find((r) => r.gate === 'merge');
    unwrap(await globs.dismissRelation(DEV, sub.id, (await current(sub.id)).version, relation?.id ?? ''));
    expect((await current(sub.id)).status).toBe('merging');

    // The same with a deleted other glob.
    const sub2 = await ready({ type: 'sub', implementer: null });
    unwrap(await globs.addRelation(DEV, sub2.id, (await current(sub2.id)).version, { to: second.id, gate: 'merge' }));
    unwrap(await globs.applyEvent(sub2.id, (x, c, f) => machine.subGateCompleted(x, { sha: HEAD, passed: true, reason: null }, c, f.relations), { relations: true }));
    expect((await current(sub2.id)).status).toBe('pr_open');
    unwrap(await globs.delete(DEV, second.id, (await current(second.id)).version));
    expect((await current(sub2.id)).status).toBe('merging');
  });

  /** A glob that signs off only after others have merged: the sign-off relations a person or agent sets (a split makes none now). */
  const gated = async (waitsFor: readonly string[]) => {
    const original = await create({ title: 'Big', plan: 'Big plan' });
    for (const to of waitsFor) unwrap(await globs.addRelation(DEV, original.id, (await current(original.id)).version, { to, gate: 'sign_off' }));
    return original;
  };

  it('a glob with sign-off relations cannot be signed off until each has merged, then it is (the release path)', async () => {
    const two = await create({ title: 'Two', plan: 'two' });
    const three = await create({ title: 'Three', plan: 'three' });
    const one = await gated([two.id, three.id]);
    // It merges and is reviewed: labels approved while the others are still open.
    const merged = await merge(one.id);
    let latest = merged;
    for (const label of LABEL_NAMES.filter((n) => n in merged.labels)) latest = unwrap(await globs.reviewLabel(DEV, latest.id, latest.version, label, { kind: 'approve' }));
    expect(Object.values(latest.labels).every((s) => s === 'approved')).toBe(true);
    expect(latest.status).toBe('reviewing');
    const view = unwrap(await globs.get(DEV, latest.id));
    expect(view.holding.map((h) => h.to)).toEqual([two.id, three.id]);
    await merge(two.id);
    await globs.releaseDependents(two.id, boardId);
    expect((await current(latest.id)).status).toBe('reviewing');
    await merge(three.id);
    await globs.releaseDependents(three.id, boardId);
    expect((await current(latest.id)).status).toBe('signed_off');
  });

  it('deleting the last unmet glob releases the sign-off, once; a second gateReleased changes nothing', async () => {
    const two = await create({ title: 'Two', plan: 'two' });
    const one = await gated([two.id]);
    const merged = await merge(one.id);
    let latest = merged;
    for (const label of LABEL_NAMES.filter((n) => n in merged.labels)) latest = unwrap(await globs.reviewLabel(DEV, latest.id, latest.version, label, { kind: 'approve' }));
    expect(latest.status).toBe('reviewing');
    unwrap(await globs.delete(DEV, two.id, (await current(two.id)).version));
    const done = await current(latest.id);
    expect(done.status).toBe('signed_off');
    const before = done.version;
    unwrap(await globs.gateReleased(latest.id));
    unwrap(await globs.gateReleased(latest.id));
    expect((await current(latest.id)).version).toBe(before);
  });

  it('a split makes no sign-off relation: the original signs off on its own, whatever its parts do', async () => {
    const original = await create({ title: 'Big', plan: 'Big plan' });
    const [one, two] = unwrap(await globs.split(DEV, original.id, original.version, { idempotencyKey: null, parts: [{ title: 'One', plan: 'one' }, { title: 'Two', plan: 'two' }] }));
    expect(rows(one?.id ?? '')).toEqual([]);
    const merged = await merge(one?.id ?? '');
    let latest = merged;
    for (const label of LABEL_NAMES.filter((n) => n in merged.labels)) latest = unwrap(await globs.reviewLabel(DEV, latest.id, latest.version, label, { kind: 'approve' }));
    expect(latest.status).toBe('signed_off');
    expect((await current(two?.id ?? '')).status).toBe('planning');
  });

  it('refuses a relation that closes a cycle through another gate: part waits for source to be signed off while source signs off after the part', async () => {
    const two = await create({ title: 'Two', plan: 'two' });
    const one = await gated([two.id]);
    // The source signs off after the other merges; making the other wait for the source to be signed off is a deadlock.
    const refused = await globs.addRelation(DEV, two.id, null, { to: one.id, gate: 'start', until: 'signed_off' });
    expect(code(refused)).toBe('invalid_input');
    expect(message(refused)).toContain('cycle');
    // Waiting for the source to merge is no cycle: the source's sign-off comes after its merge.
    expect(code(await globs.addRelation(DEV, two.id, null, { to: one.id, gate: 'merge' }))).toBeNull();
  });

  it('a decision relation (until decided) holds a sub until the decision is accepted or rejected, not on needs work', async () => {
    const d = decision('s1k1');
    const sub = await create({ type: 'sub', relations: [{ to: d.id, reason: 'the store is open' }] });
    expect(sub.status).toBe('planning');
    const row = rows(sub.id)[0];
    expect(row).toMatchObject({ to: d.id, gate: 'start', until: 'decided', reason: 'the store is open', source: 'person' });
    const outcome = (kind: string, status: Glob['status']) => setGlob({ ...d, status, attributes: { ...(d.attributes as object), outcome: { kind, by: ADMIN, at: NOW } } as never });
    outcome('needs_work', 'in_progress');
    await globs.releaseDependents(d.id, boardId);
    expect((await current(sub.id)).status).toBe('planning');
    outcome('accept', 'reviewing');
    expect(await globs.releaseDependents(d.id, boardId)).toEqual([sub.id]);
    expect((await current(sub.id)).status).toBe('implementing');

    const other = await create({ type: 'sub', relations: [{ to: 's1k2' }] }).catch(() => null);
    expect(other).toBeNull();
    const d2 = decision('s1k2');
    const held = await create({ type: 'sub', relations: [{ to: d2.id }] });
    setGlob({ ...d2, status: 'signed_off', attributes: { ...(d2.attributes as object), outcome: { kind: 'reject', by: ADMIN, at: NOW }, archived: true } as never });
    await globs.releaseDependents(d2.id, boardId);
    expect((await current(held.id)).status).toBe('implementing');
  });

  describe('Merge anyway and Sign off anyway (service)', () => {
    it('Merge anyway on a same lifts the relation, merges now and logs who and why; the gate is not asked again', async () => {
      const first = await create();
      const g = await ready();
      unwrap(await globs.addRelation(DEV, g.id, (await current(g.id)).version, { to: first.id, gate: 'merge', reason: 'needs it' }));
      expect(unwrap(await globs.get(DEV, g.id)).allowedActions).toContain('merge_anyway');
      expect(code(await globs.mergeAnyway(DEV, g.id, (await current(g.id)).version, ' '))).toBe('invalid_transition');
      const merging = unwrap(await globs.mergeAnyway(DEV, g.id, (await current(g.id)).version, 'It is cosmetic'));
      expect(merging.status).toBe('merging');
      expect(rows(g.id).find((r) => r.gate === 'merge')?.overriddenAt).toBe(NOW);
      expect(store.state.events.filter((e) => e.type === 'MergeOverridden' && e.globId === g.id)).toMatchObject([{ actor: DEV, data: { for: [first.id], reason: 'It is cosmetic' } }]);
      expect(store.state.events.some((e) => e.type === 'HoldOverridden')).toBe(false);
      expect(effectKinds().filter((k) => k === 'squash_merge')).toHaveLength(1);
      // The overridden relation shows as done (overridden), not holding.
      const view = unwrap(await globs.get(DEV, g.id));
      expect(view.holding).toEqual([]);
    });

    it('Merge anyway releases an armed merge held for a relation, exactly once', async () => {
      const first = await create();
      const g = await ready({ mergeMode: 'when_green', headChecks: { sha: HEAD, state: 'pending' } });
      unwrap(await globs.addRelation(DEV, g.id, (await current(g.id)).version, { to: first.id, gate: 'merge' }));
      unwrap(await globs.applyEvent(g.id, (x, c, f) => machine.checksCompleted(x, { sha: HEAD, passed: true }, c, f.relations), { relations: true }));
      expect((await current(g.id)).mergeHold).toMatchObject({ for: [first.id] });
      unwrap(await globs.mergeAnyway(DEV, g.id, (await current(g.id)).version, 'go'));
      expect(await current(g.id)).toMatchObject({ status: 'merging', mergeMode: null });
      expect(effectKinds().filter((k) => k === 'squash_merge')).toHaveLength(1);
      expect(code(await globs.mergeAnyway(DEV, g.id, (await current(g.id)).version, 'again'))).toBe('invalid_transition');
    });

    it('Sign off anyway signs off a Reviewing glob held by a sign_off relation, logs it and releases what waits for it', async () => {
      const two = await create({ title: 'Two', plan: 'two' });
      const one = await gated([two.id]);
      const merged = await merge(one.id);
      let latest = merged;
      for (const label of LABEL_NAMES.filter((n) => n in merged.labels)) latest = unwrap(await globs.reviewLabel(DEV, latest.id, latest.version, label, { kind: 'approve' }));
      expect(latest.status).toBe('reviewing');
      expect(unwrap(await globs.get(DEV, latest.id)).allowedActions).toContain('sign_off_anyway');
      expect(code(await globs.signOffAnyway(DEV, latest.id, latest.version, ''))).toBe('invalid_transition');
      const done = unwrap(await globs.signOffAnyway(DEV, latest.id, latest.version, 'Two is a nice-to-have'));
      expect(done.status).toBe('signed_off');
      expect(store.state.events.filter((e) => e.type === 'SignOffOverridden' && e.globId === one.id)).toMatchObject([{ actor: DEV, data: { for: [two.id], reason: 'Two is a nice-to-have' } }]);
    });

    it('dismissing a mention relation releases the gate it held and is remembered by the pair', async () => {
      const first = await create();
      const g = await ready({ type: 'sub', implementer: null });
      const plan = (await store.transaction((tx) => tx.artifactVersions(g.id, 'plan', ''))).at(-1)?.content ?? '';
      const applied = await globs.applyAutomatic(g.id, hash(plan), [{ to: first.id, gate: 'merge', until: 'merged', reason: 'wait for it', sentence: 'Wait for it.', from: 'plan' }], ADMIN);
      expect(applied).toEqual({ added: [first.id], skipped: [], stale: false });
      const relation = rows(g.id).find((r) => r.gate === 'merge');
      expect(relation).toMatchObject({ source: 'mention', reason: 'wait for it' });
      unwrap(await globs.applyEvent(g.id, (x, c, f) => machine.subGateCompleted(x, { sha: HEAD, passed: true, reason: null }, c, f.relations), { relations: true }));
      expect((await current(g.id)).status).toBe('pr_open');
      unwrap(await globs.dismissRelation(DEV, g.id, (await current(g.id)).version, relation?.id ?? ''));
      expect((await current(g.id)).status).toBe('merging');
      // The person's "no" is remembered by the pair, so the pass never adds it again.
      expect([...store.state.relationScans.values()]).toEqual([expect.objectContaining({ globId: g.id, mentionedId: first.id, decision: 'not_prerequisite', state: 'dismissed' })]);
    });
  });

  describe('adding and dismissing relations', () => {
    it('create and update take relations beside needs/after: any gate, defaults, and additive on update', async () => {
      const a = await create();
      const b = await create();
      const d = decision('s1k1');
      const made = await create({ after: [a.id], afterReason: 'uses its migration', relations: [{ to: b.id, gate: 'merge', reason: 'shares its helper' }, { to: d.id, gate: 'sign_off', reason: 'ship when decided' }], relationsBy: 'agent' });
      expect(rows(made.id).map((r) => [r.to, r.gate, r.until, r.source, r.reason])).toEqual([
        [a.id, 'start', 'merged', 'agent', 'uses its migration'],
        [b.id, 'merge', 'merged', 'agent', 'shares its helper'],
        [d.id, 'sign_off', 'decided', 'agent', 'ship when decided'],
      ]);
      const c = await create();
      const updated = unwrap(await globs.update(DEV, made.id, made.version, { relations: [{ to: c.id, gate: 'merge', reason: 'later' }, { to: b.id, gate: 'merge', until: 'signed_off', reason: 'wait for sign-off' }] }));
      expect(updated.version).toBe(made.version + 1);
      expect(rows(made.id).map((r) => [r.to, r.gate, r.until, r.reason])).toEqual([
        [a.id, 'start', 'merged', 'uses its migration'],
        [b.id, 'merge', 'signed_off', 'wait for sign-off'],
        [d.id, 'sign_off', 'decided', 'ship when decided'],
        [c.id, 'merge', 'merged', 'later'],
      ]);
      // `after` replaces only the start list: the other gates stay.
      unwrap(await globs.update(DEV, made.id, updated.version, { after: [] }));
      expect(rows(made.id).map((r) => r.gate)).toEqual(['merge', 'sign_off', 'merge']);
    });

    it('validates: not itself, same board, no cycle, decided only for a decision, a decision is never held back, the limit, the reason', async () => {
      const a = await create();
      const b = await create({ relations: [{ to: a.id, gate: 'start' }] });
      const d = decision('s1k1');
      const version = async (id: string) => (await current(id)).version;
      expect(code(await globs.addRelation(DEV, a.id, await version(a.id), { to: a.id }))).toBe('invalid_input');
      expect(code(await globs.addRelation(DEV, a.id, await version(a.id), { to: 's9t1' }))).toBe('invalid_input');
      const cycle = await globs.addRelation(DEV, a.id, await version(a.id), { to: b.id });
      expect(code(cycle)).toBe('invalid_input');
      expect(message(cycle)).toContain('cycle');
      // A cycle through another gate: a can't sign off until b starts-after-a... is fine; the reverse is not.
      expect(code(await globs.addRelation(DEV, a.id, await version(a.id), { to: b.id, gate: 'sign_off' }))).toBeNull();
      const notDecision = await globs.addRelation(DEV, b.id, await version(b.id), { to: a.id, gate: 'merge', until: 'decided' });
      expect(message(notDecision)).toContain('is not a decision');
      const fromDecision = await globs.addRelation(DEV, d.id, await version(d.id), { to: a.id });
      expect(message(fromDecision)).toContain('is a decision');
      expect(code(await globs.addRelation(DEV, a.id, await version(a.id), { to: d.id, reason: 'x'.repeat(301) }))).toBe('invalid_input');
      // The 21st relation of one gate is refused.
      const many: Glob[] = [];
      for (let i = 0; i < 21; i++) many.push(await create());
      const target = await create();
      for (const m of many.slice(0, 20)) unwrap(await globs.addRelation(DEV, target.id, await version(target.id), { to: m.id, gate: 'merge' }));
      const limit = await globs.addRelation(DEV, target.id, await version(target.id), { to: many[20]?.id ?? '', gate: 'merge' });
      expect(message(limit)).toContain('at most 20');
      // A stale version is refused.
      expect(code(await globs.addRelation(DEV, a.id, 1, { to: d.id }))).toBe('version_conflict');
    });

    it('a decision holds globs back: the relation is written on the held glob, no version is needed, and the decision shows it', async () => {
      const d = decision('s1k1');
      const g = await create();
      const added = unwrap(await globs.addRelation(DEV, d.id, null, { to: g.id, gate: 'start' }, 'holds_back'));
      expect(added.id).toBe(g.id);
      // Held back by a decision: it waits until decided (the default for a decision).
      expect(rows(g.id)).toMatchObject([{ from: g.id, to: d.id, gate: 'start', until: 'decided', source: 'person' }]);
      const view = unwrap(await globs.get(ADMIN, d.id));
      expect(view.relationGroups.holdsBack.map((h) => [h.from, h.gate, h.until])).toEqual([[g.id, 'start', 'decided']]);
      // A decision cannot be the held one.
      expect(message(await globs.addRelation(DEV, g.id, null, { to: d.id }, 'holds_back'))).toContain('is a decision');
    });

    it('the glob read groups relations: holding, holds back and done, with how each stopped', async () => {
      const a = await create();
      const b = await create();
      const c = await create();
      const g = await create({ after: [a.id], relations: [{ to: b.id, gate: 'merge' }, { to: c.id, gate: 'sign_off' }] });
      const held = await create({ after: [g.id] });
      await merge(a.id);
      const view = unwrap(await globs.get(DEV, g.id));
      expect(view.relationGroups.holding.map((h) => [h.to, h.gate])).toEqual([[b.id, 'merge'], [c.id, 'sign_off']]);
      expect(view.relationGroups.done.map((r) => [r.to, r.how])).toEqual([[a.id, 'met']]);
      expect(view.relationGroups.holdsBack.map((h) => h.from)).toEqual([held.id]);
      unwrap(await globs.dismissRelation(DEV, g.id, view.glob.version, rows(g.id).find((r) => r.to === b.id)?.id ?? ''));
      const again = unwrap(await globs.get(DEV, g.id));
      expect(again.relationGroups.done.map((r) => [r.to, r.how]).sort()).toEqual([[a.id, 'met'], [b.id, 'dismissed']]);
      // A dismissed relation can be added again: the fresh one replaces the dismissed row.
      unwrap(await globs.addRelation(DEV, g.id, again.glob.version, { to: b.id, gate: 'merge' }));
      expect(rows(g.id).filter((r) => r.to === b.id)).toHaveLength(1);
      expect(rows(g.id).find((r) => r.to === b.id)?.dismissedAt).toBeNull();
    });
  });

  it('the board list carries holding with titles, for a `to` the list does not carry', async () => {
    const old = await create({ title: 'Old work' });
    const g = await create({ title: 'Newer', relations: [{ to: old.id }] });
    const signed = { ...(await merge(old.id)), status: 'signed_off' as const, signedOffAt: '2020-01-01T00:00:00.000Z' };
    setGlob(signed);
    const listed = unwrap(await globs.listWithArtifacts(DEV, boardId, { include: 'all' }, (x) => x.id !== old.id)).find((r) => r.glob.id === g.id);
    // The old merged glob is not in the list, but it is read for the relation: met, so nothing holds the glob.
    expect(listed?.holding).toEqual([]);
    const open2 = await create({ title: 'Not yet' });
    const waiting = await create({ title: 'Waiting', relations: [{ to: open2.id }] });
    const all = unwrap(await globs.listWithArtifacts(DEV, boardId, { include: 'all' }, (x) => x.id === waiting.id));
    expect(all[0]?.holding).toMatchObject([{ to: open2.id, toTitle: 'Not yet', gate: 'start', until: 'merged', state: 'planning', source: 'person', toIsDecision: false }]);
    expect(holdingOf(all[0]?.relations ?? { relations: [], states: new Map() }, new Map())[0]?.toTitle).toBeNull();
  });

  describe('reasons: an agent says why a relation exists', () => {
    const NEED = (to: string): string =>
      `Relation to ${to} needs a one-line reason: name the file or symbol this glob uses from it, or why it must wait. Pass \`reason\` (shorthand for needs/after) or \`relations: [{to, reason}]\`.`;

    it('refuses an agent create without a reason, and accepts afterReason and per-relation reasons', async () => {
      const a = await create();
      const bare = await globs.create(ADMIN, { boardId, title: 'W', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, after: [a.id], relationsBy: 'agent' });
      expect(code(bare)).toBe('invalid_input');
      expect(message(bare)).toBe(NEED(a.id));
      expect(rows()).toHaveLength(0);
      const viaBy = await globs.create(ADMIN, { boardId, title: 'W', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, relations: [{ to: a.id, gate: 'merge' }], by: 'mention' });
      expect(message(viaBy)).toBe(NEED(a.id));
      const ok1 = await create({ after: [a.id], afterReason: 'uses a()', by: 'agent' });
      expect(rows(ok1.id)[0]).toMatchObject({ to: a.id, source: 'agent', reason: 'uses a()' });
      const ok2 = await create({ relations: [{ to: a.id, gate: 'sign_off', reason: 'handover waits' }], relationsBy: 'agent' });
      expect(rows(ok2.id)[0]).toMatchObject({ gate: 'sign_off', reason: 'handover waits' });
    });

    it('a person is never refused, and a target that holds nothing needs no reason', async () => {
      const a = await create();
      const made = await create({ after: [a.id] });
      expect(rows(made.id)[0]).toMatchObject({ source: 'person', reason: null });
      const done = await create();
      await merge(done.id);
      const skipped = await create({ type: 'sub', after: [done.id], by: 'agent' });
      expect(rows(skipped.id)).toEqual([]);
    });

    it('add_relation and update (relations, after) refuse an agent without a reason; an unchanged or reasoned row is fine', async () => {
      const a = await create();
      const b = await create();
      const g = await create();
      const refused = await globs.addRelation(DEV, g.id, null, { to: a.id }, 'held_by', 'agent');
      expect(message(refused)).toBe(NEED(a.id));
      expect(code(await globs.addRelation(DEV, g.id, null, { to: a.id, reason: 'x' }, 'held_by', 'agent'))).toBeNull();
      // The row already has a reason: restating it without one changes nothing and is not refused.
      expect(code(await globs.addRelation(DEV, g.id, null, { to: a.id }, 'held_by', 'agent'))).toBeNull();
      const v = (await current(g.id)).version;
      expect(message(await globs.update(DEV, g.id, v, { relations: [{ to: b.id, gate: 'merge' }], relationsBy: 'agent' }))).toBe(NEED(b.id));
      expect(message(await globs.update(DEV, g.id, v, { after: [a.id, b.id], by: 'agent' }))).toBe(NEED(b.id));
      const updated = unwrap(await globs.update(DEV, g.id, v, { after: [a.id, b.id], afterReason: 'b gives it the table', by: 'agent' }));
      expect(updated.version).toBeGreaterThan(v);
      expect(rows(g.id).map((r) => [r.to, r.source, r.reason])).toEqual([
        [a.id, 'agent', 'x'],
        [b.id, 'agent', 'b gives it the table'],
      ]);
    });

    it('an agent update after is stored as an agent relation, not a person one', async () => {
      const a = await create();
      const g = await create();
      unwrap(await globs.update(DEV, g.id, g.version, { after: [a.id], afterReason: 'needs a', by: 'agent' }));
      expect(rows(g.id)[0]?.source).toBe('agent');
    });

    it('accepts rolled_out as another way to write until merged', async () => {
      const a = await create();
      const g = await create({ relations: [{ to: a.id, gate: 'sign_off', until: 'rolled_out', reason: 'r' }], relationsBy: 'agent' });
      expect(rows(g.id)[0]?.until).toBe('merged');
      const bad = await globs.addRelation(DEV, g.id, null, { to: a.id, gate: 'merge', until: 'nonsense' as never, reason: 'r' }, 'held_by', 'agent');
      expect(code(bad)).toBe('invalid_input');
    });

    it('split parts get a generated reason instead of null', async () => {
      const g = await create();
      const parts = unwrap(
        await globs.split(ADMIN, g.id, g.version, {
          parts: [
            { title: 'One', plan: 'one' },
            { title: 'Two', plan: 'two', after: [0] },
            { title: 'Three', plan: 'three', after: [0, 1] },
          ],
          idempotencyKey: null,
        }),
      );
      const second = parts[1];
      const third = parts[2];
      expect(rows(second?.id).map((r) => r.reason)).toEqual([`Part 2 of ${g.id}'s split needs part 1`]);
      expect(rows(third?.id).map((r) => r.reason)).toEqual([`Part 3 of ${g.id}'s split needs part 1`, `Part 3 of ${g.id}'s split needs part 2`]);
    });
  });
});
