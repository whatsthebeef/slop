import { describe, expect, it } from 'vitest';
import type { Result } from '../src/domain/errors.js';
import * as m from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { NOW, board, ctx, dev, glob, other, po, run } from './fixtures.js';
import { isRepoAccessFailure, provisioningFailureReason } from '../src/domain/provisioning.js';

const value = (result: Result<Transition>): Transition => {
  if (!result.ok) throw new Error(`Expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const errorCode = (result: Result<Transition>): string => {
  if (result.ok) throw new Error('Expected an error');
  return result.error.code;
};

const effectKinds = (t: Transition) => t.effects.map((e) => e.kind);

const createInput = (patch: Partial<m.CreateInput> = {}): m.CreateInput => ({
  id: 's1t1',
  boardId: 1,
  title: 'Fix login timeout',
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  autoTrigger: false,
  ...patch,
});

describe('create (rows 1–4)', () => {
  it('row 1: a same starts in planning, unprovisioned, with the creator as planner', () => {
    const t = value(m.create(createInput(), board, ctx()));
    expect(t.glob.status).toBe('planning');
    expect(t.glob.planner).toBe(dev.email);
    expect(t.glob.implementer).toBeNull();
    expect(t.glob.provisioning).toBe('none');
    expect(effectKinds(t)).toEqual([]);
  });

  it('row 2: a sub starts implementing with a queued run', () => {
    const t = value(m.create(createInput({ type: 'sub' }), board, ctx()));
    expect(t.glob.status).toBe('implementing');
    expect(m.currentRun(t.glob)?.state).toBe('queued');
    expect(effectKinds(t)).toEqual(['provision', 'fire_routine']);
  });

  it('row 3: a super starts in progress with the creator as implementer', () => {
    const t = value(m.create(createInput({ type: 'super' }), board, ctx()));
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.implementer).toBe(dev.email);
  });

  it('a super created with start: false is parked in planning: no branch, run, implementer or active glob', () => {
    const t = value(m.create(createInput({ type: 'super', category: 'feature', start: false }), board, ctx()));
    expect(t.glob.status).toBe('planning');
    expect(t.glob.implementer).toBeNull();
    expect(t.glob.provisioning).toBe('none');
    expect(t.glob.doingSince).toBeNull();
    expect(t.glob.runs).toEqual([]);
    expect(effectKinds(t)).toEqual([]);
    const actions = m.allowedActions(t.glob, dev);
    expect(actions).toContain('pick_up');
    expect(actions).not.toContain('start');
    expect(errorCode(m.start(t.glob, ctx()))).toBe('invalid_transition');
  });

  it('start: false changes nothing for a sub or a same', () => {
    expect(value(m.create(createInput({ type: 'sub', start: false }), board, ctx())).glob.status).toBe('implementing');
    expect(value(m.create(createInput({ type: 'same', start: false }), board, ctx())).glob.status).toBe('planning');
  });

  it('picking up a parked super provisions it and makes the person its implementer', () => {
    const parked = value(m.create(createInput({ type: 'super', category: 'feature', start: false }), board, ctx())).glob;
    const t = value(m.pickUp(parked, ctx(other), board, { takeOver: false }));
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.implementer).toBe(other.email);
    expect(t.glob.provisioning).toBe('pending');
    expect(effectKinds(t)).toEqual(['provision']);
    expect(t.glob.doingSince).not.toBeNull();
  });

  it('row 4: a same with an explicit auto-trigger starts implementing', () => {
    const t = value(m.create(createInput({ autoTrigger: true }), board, ctx()));
    expect(t.glob.status).toBe('implementing');
    expect(effectKinds(t)).toContain('fire_routine');
  });

  it('enforces the type/category matrix', () => {
    expect(m.create(createInput({ type: 'sub', category: 'feature' }), board, ctx()).ok).toBe(true);
    expect(errorCode(m.create(createInput({ type: 'super', category: 'bug' }), board, ctx()))).toBe(
      'invalid_combination',
    );
  });

  it('refuses supers from QA and PO members', () => {
    expect(errorCode(m.create(createInput({ type: 'super' }), board, ctx(po)))).toBe('forbidden');
    expect(value(m.create(createInput({ type: 'same' }), board, ctx(po))).glob.status).toBe('planning');
  });

  it('only allows environments that accept branch deploys', () => {
    expect(value(m.create(createInput({ environment: 'dev' }), board, ctx())).glob.environment).toBe('dev');
    expect(errorCode(m.create(createInput({ environment: 'prod' }), board, ctx()))).toBe('invalid_input');
    expect(errorCode(m.create(createInput({ environment: 'nope' }), board, ctx()))).toBe('invalid_input');
  });

  it("gives a new sub without an environment the board's default for subs, and nothing else", () => {
    const withDefault = {
      ...board,
      environments: [
        { name: 'dev', allowBranchDeploy: true },
        { name: 'qa', allowBranchDeploy: true, subDefault: true as const },
      ],
    };
    const sub = createInput({ type: 'sub' });
    expect(value(m.create(sub, withDefault, ctx())).glob.environment).toBe('qa');
    expect(value(m.create({ ...sub, environment: 'dev' }, withDefault, ctx())).glob.environment).toBe('dev');
    expect(value(m.create(createInput(), withDefault, ctx())).glob.environment).toBeNull();
    expect(value(m.create(createInput({ type: 'super', category: 'feature' }), withDefault, ctx())).glob.environment).toBeNull();
    expect(value(m.create(sub, board, ctx())).glob.environment).toBeNull();
  });
});

describe('start (row 5)', () => {
  it('moves a same from planning to implementing and queues a run', () => {
    const t = value(m.start(glob(), ctx()));
    expect(t.glob.status).toBe('implementing');
    expect(effectKinds(t)).toEqual(['fire_routine']);
  });

  it('refuses anything else with the allowed actions', () => {
    const result = m.start(glob({ status: 'in_progress', implementer: dev.email }), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'invalid_transition') {
      expect(result.error.status).toBe('in_progress');
      expect(result.error.allowedActions).toContain('start_again');
    }
  });
});

describe('investigate (row 5a)', () => {
  it('queues an investigate-only run on a glob in planning, with no status change or provisioning', () => {
    const t = value(m.investigate(glob(), ctx()));
    expect(t.glob.status).toBe('planning');
    expect(t.effects.map((e) => e.kind)).not.toContain('provision');
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'queued', purpose: 'investigate', triggeredBy: dev.email });
    expect(t.effects).toEqual([expect.objectContaining({ kind: 'fire_routine', purpose: 'investigate' })]);
    expect(t.events.map((e) => e.type)).toEqual(['RunTriggered']);
    expect(m.allowedActions(glob(), dev)).toContain('investigate');
  });

  it('works on a held sub too, and for slop itself it is the glob creator who triggers it', () => {
    const t = value(m.investigate(glob({ type: 'sub', waiting: { since: NOW } }), ctx(null), true));
    expect(m.currentRun(t.glob)).toMatchObject({ purpose: 'investigate', triggeredBy: dev.email });
  });

  it('refuses a live run, a started glob, a super and QA or PO on a same', () => {
    expect(errorCode(m.investigate(glob({ runs: [run({ state: 'queued' })] }), ctx()))).toBe('run_active');
    expect(errorCode(m.investigate(glob({ status: 'in_progress' }), ctx()))).toBe('invalid_transition');
    expect(errorCode(m.investigate(glob({ type: 'super' }), ctx()))).toBe('invalid_transition');
    expect(errorCode(m.investigate(glob(), ctx(po)))).toBe('forbidden');
    expect(m.allowedActions(glob(), po)).not.toContain('investigate');
    expect(m.allowedActions(glob({ runs: [run({ state: 'active', purpose: 'investigate' })] }), dev)).not.toContain('investigate');
  });

  it('ends completed when its investigation is pushed; other runs and stale run IDs are untouched', () => {
    const investigating = glob({ runs: [run({ id: 'run-9', purpose: 'investigate' })] });
    const t = value(m.investigationPushed(investigating, 'run-9', ctx()));
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(t.glob.status).toBe('planning');
    expect(value(m.investigationPushed(investigating, 'run-old', ctx())).changed).toBe(false);
    expect(value(m.investigationPushed(glob({ status: 'implementing', runs: [run({ id: 'run-9' })] }), 'run-9', ctx())).changed).toBe(false);
  });

  it('a failure report ends the run and leaves the glob in planning', () => {
    const investigating = glob({ runs: [run({ id: 'run-9', purpose: 'investigate' })] });
    const t = value(m.reportFailure(investigating, { reason: 'no routine', runId: 'run-9' }, ctx(null)));
    expect(t.glob.status).toBe('planning');
    expect(t.glob.failure).toBeNull();
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'ended', outcome: 'failed', failureReason: 'no routine' });
  });

  it('starting the glob supersedes an investigation still running', () => {
    const t = value(m.start(glob({ runs: [run({ id: 'run-9', purpose: 'investigate' })] }), ctx()));
    expect(t.glob.status).toBe('implementing');
    expect(t.glob.runs.map((r) => [r.id, r.state, r.outcome, r.purpose])).toEqual([
      ['run-9', 'ended', 'superseded', 'investigate'],
      ['run-1', 'queued', null, undefined],
    ]);
  });

  it('picking the glob up supersedes an active investigation instead of being refused', () => {
    const t = value(m.pickUp(glob({ runs: [run({ id: 'run-9', purpose: 'investigate' })] }), ctx(), board, { takeOver: false }));
    expect(t.glob.status).toBe('in_progress');
    expect(m.currentRun(t.glob)).toMatchObject({ id: 'run-9', state: 'ended', outcome: 'superseded' });
  });

  it('times out on no progress but never for an unmarked PR', () => {
    const later = '2026-10-05T21:00:00.000Z';
    const investigating = glob({ runs: [run({ purpose: 'investigate' })] });
    expect(m.runTimeoutReason(investigating, board, '2026-10-05T13:00:00.000Z')).toBeNull();
    expect(m.runTimeoutReason(investigating, board, '2026-10-05T14:30:00.000Z')).toMatch(/No progress/);
    const progressing = glob({ runs: [run({ purpose: 'investigate', lastProgressAt: '2026-10-05T20:30:00.000Z' })] });
    expect(m.runTimeoutReason(progressing, board, later)).toBeNull();
    expect(m.runTimeoutReason(glob({ status: 'implementing', runs: [run({ lastProgressAt: '2026-10-05T20:30:00.000Z' })] }), board, later)).toMatch(/PR not marked ready/);
  });
});

describe('pick up (rows 6–10)', () => {
  it('row 6: from planning, the picker becomes implementer and a queued run is cancelled', () => {
    const t = value(
      m.pickUp(glob({ runs: [run({ state: 'queued', startedAt: null })] }), ctx(), board, { takeOver: false }),
    );
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.implementer).toBe(dev.email);
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'ended', outcome: 'superseded' });
  });

  it('row 6: from failed, clears the failure', () => {
    const t = value(
      m.pickUp(glob({ status: 'failed', failure: { reason: 'x', at: 'y' } }), ctx(), board, { takeOver: false }),
    );
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.failure).toBeNull();
  });

  it('row 7: from pr_open, status is unchanged', () => {
    const t = value(m.pickUp(glob({ status: 'pr_open' }), ctx(), board, { takeOver: false }));
    expect(t.glob.status).toBe('pr_open');
    expect(t.glob.implementer).toBe(dev.email);
  });

  it('row 8: the current implementer picking up again is a no-op', () => {
    const t = value(
      m.pickUp(glob({ status: 'in_progress', implementer: dev.email }), ctx(), board, { takeOver: false }),
    );
    expect(t.changed).toBe(false);
  });

  it('row 9: someone else picking up changes the implementer', () => {
    const t = value(
      m.pickUp(glob({ status: 'in_progress', implementer: dev.email }), ctx(other), board, { takeOver: false }),
    );
    expect(t.glob.implementer).toBe(other.email);
  });

  it('is refused without takeOver while a run is active', () => {
    const g = glob({ status: 'pr_open', runs: [run({ state: 'active' })] });
    expect(errorCode(m.pickUp(g, ctx(), board, { takeOver: false }))).toBe('run_active');
    expect(value(m.pickUp(g, ctx(), board, { takeOver: true })).glob.implementer).toBe(dev.email);
  });

  it('supersedes a queued or standby run without takeOver (nothing unpushed can be lost)', () => {
    const queued = glob({ status: 'implementing', runs: [run({ state: 'queued', startedAt: null })] });
    const queuedPick = value(m.pickUp(queued, ctx(), board, { takeOver: false }));
    expect(queuedPick.glob.status).toBe('in_progress');
    expect(queuedPick.glob.implementer).toBe(dev.email);
    expect(m.currentRun(queuedPick.glob)?.outcome).toBe('superseded');
    const standby = glob({ status: 'pr_open', runs: [run({ state: 'watching' })] });
    const standbyPick = value(m.pickUp(standby, ctx(), board, { takeOver: false }));
    expect(standbyPick.glob.status).toBe('pr_open');
    expect(standbyPick.glob.generation).toBe(standby.generation + 1);
    expect(standbyPick.glob.implementer).toBe(dev.email);
  });

  it('row 10: take over supersedes the run and bumps the generation', () => {
    const t = value(
      m.pickUp(glob({ status: 'implementing', runs: [run()] }), ctx(), board, { takeOver: true }),
    );
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.generation).toBe(2);
    expect(m.currentRun(t.glob)?.outcome).toBe('superseded');
    // Mined signals count runs someone had to take over.
    expect(t.events.find((e) => e.type === 'RunEnded')?.data).toMatchObject({ outcome: 'superseded', cause: 'take_over' });

    const watching = value(
      m.pickUp(glob({ status: 'pr_open', runs: [run({ state: 'watching' })] }), ctx(), board, { takeOver: true }),
    );
    expect(watching.glob.status).toBe('pr_open');
  });

  it('QA and PO cannot pick up or take over sames', () => {
    expect(errorCode(m.pickUp(glob(), ctx(po), board, { takeOver: false }))).toBe('forbidden');
    const sub = glob({ type: 'sub', status: 'failed' });
    expect(value(m.pickUp(sub, ctx(po), board, { takeOver: false })).glob.implementer).toBe(po.email);
  });

  it('QA and PO cannot pick up supers, and are not offered it', () => {
    const qa = { email: 'qa@example.com', role: 'qa' } as const;
    const superGlob = glob({ type: 'super', category: 'feature', status: 'in_progress', implementer: dev.email });
    for (const actor of [po, qa]) {
      expect(errorCode(m.pickUp(superGlob, ctx(actor), board, { takeOver: false }))).toBe('forbidden');
      expect(m.allowedActions(superGlob, actor)).not.toContain('pick_up');
    }
    expect(m.allowedActions(superGlob, other)).toContain('pick_up');
  });
});

describe('environment at pick-up', () => {
  it('sets a valid environment, records the change and relabels the PR', () => {
    const t = value(m.pickUp(glob({ status: 'pr_open' }), ctx(), board, { takeOver: false, environment: 'dev' }));
    expect(t.glob.environment).toBe('dev');
    expect(t.glob.implementer).toBe(dev.email);
    expect(t.events.find((e) => e.type === 'FieldsChanged')?.data).toEqual({ environment: { from: null, to: 'dev' } });
    expect(effectKinds(t)).toEqual(['sync_pr_labels']);
  });

  it('does not queue a label sync before the glob has a PR', () => {
    const t = value(m.pickUp(glob({ pr: null }), ctx(), board, { takeOver: false, environment: 'dev' }));
    expect(t.glob.environment).toBe('dev');
    expect(effectKinds(t)).not.toContain('sync_pr_labels');
  });

  it('refuses an environment the board lacks or that does not allow branch deploys', () => {
    const g = glob({ status: 'pr_open' });
    expect(errorCode(m.pickUp(g, ctx(), board, { takeOver: false, environment: 'nope' }))).toBe('invalid_input');
    expect(errorCode(m.pickUp(g, ctx(), board, { takeOver: false, environment: 'prod' }))).toBe('invalid_input');
  });

  it('row 8 with a changed environment applies it; with the same one it stays a no-op', () => {
    const mine = glob({ type: 'super', category: 'feature', status: 'in_progress', implementer: dev.email });
    const t = value(m.pickUp(mine, ctx(), board, { takeOver: false, environment: 'dev' }));
    expect(t.changed).toBe(true);
    expect(t.glob.environment).toBe('dev');
    expect(t.events.map((e) => e.type)).toEqual(['FieldsChanged']);
    expect(effectKinds(t)).toEqual(['sync_pr_labels']);

    const same = value(m.pickUp({ ...mine, environment: 'dev' }, ctx(), board, { takeOver: false, environment: 'dev' }));
    expect(same.changed).toBe(false);
  });

  it('take over can set the environment, labelled at the new generation', () => {
    const t = value(
      m.pickUp(glob({ status: 'implementing', runs: [run()] }), ctx(), board, { takeOver: true, environment: 'dev' }),
    );
    expect(t.glob.environment).toBe('dev');
    expect(t.effects).toContainEqual({ kind: 'sync_pr_labels', globId: 's1t1', generation: 2 });
  });
});

describe('PR and merge events (rows 11–16)', () => {
  it('row 11: PR ready moves to pr_open and an active run to watching', () => {
    const t = value(
      m.prReadyForReview(glob({ status: 'implementing', runs: [run()] }), { number: 7, headSha: 'bbb' }, ctx(null)),
    );
    expect(t.glob.status).toBe('pr_open');
    expect(m.currentRun(t.glob)?.state).toBe('watching');
    expect(t.glob.pr).toEqual({ number: 7, state: 'ready', headSha: 'bbb' });
  });

  it('row 11: PR ready is only valid while implementing or in progress', () => {
    expect(errorCode(m.prReadyForReview(glob({ status: 'reviewing' }), { number: 7, headSha: 'bbb' }, ctx(null)))).toBe('invalid_transition');
  });

  it('row 12: the sub gate passing on the current head merges', () => {
    const g = glob({ type: 'sub', status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'bbb' } });
    const t = value(m.subGateCompleted(g, { sha: 'bbb', passed: true, reason: null }, ctx(null)));
    expect(t.glob.status).toBe('merging');
    expect(t.effects).toEqual([{ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: 'bbb' }]);
  });

  it('row 12: results for an older commit are ignored', () => {
    const g = glob({ type: 'sub', status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'bbb' } });
    expect(value(m.subGateCompleted(g, { sha: 'aaa', passed: true, reason: null }, ctx(null))).changed).toBe(
      false,
    );
  });

  it('row 13: the sub gate flagging converts the sub to a same', () => {
    const g = glob({ type: 'sub', status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'bbb' } });
    const t = value(m.subGateCompleted(g, { sha: 'bbb', passed: false, reason: 'sensitive path' }, ctx(null)));
    expect(t.glob.type).toBe('same');
    expect(t.glob.status).toBe('pr_open');
  });

  it('rows 12–13: the verdict records its cause, size and limit for the learned sub limit', () => {
    const g = glob({ type: 'sub', status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'bbb' } });
    const converted = value(
      m.subGateCompleted(
        g,
        { sha: 'bbb', passed: false, reason: 'Changes 2898 lines (limit 2000)', cause: 'size', changedLines: 2898, limit: 2000 },
        ctx(null),
      ),
    );
    expect(converted.events.find((e) => e.type === 'SubReviewCompleted')?.data).toEqual({
      sha: 'bbb',
      passed: false,
      reason: 'Changes 2898 lines (limit 2000)',
      cause: 'size',
      changedLines: 2898,
      limit: 2000,
    });
    const passed = value(m.subGateCompleted(g, { sha: 'bbb', passed: true, reason: null, cause: null, changedLines: 12, limit: 2000 }, ctx(null)));
    expect(passed.events.find((e) => e.type === 'SubReviewCompleted')?.data).toEqual({
      sha: 'bbb',
      passed: true,
      reason: null,
      cause: null,
      changedLines: 12,
      limit: 2000,
    });
    // Callers that don't know them leave them out (the data is additive).
    const bare = value(m.subGateCompleted(g, { sha: 'bbb', passed: true, reason: null }, ctx(null)));
    expect(bare.events.find((e) => e.type === 'SubReviewCompleted')?.data).toEqual({ sha: 'bbb', passed: true, reason: null });
  });

  it('row 16c: Retry merge puts a failed, conflict-free merge back to merging at the head', () => {
    const failed = {
      ...glob({ status: 'failed', pr: { number: 7, state: 'ready', headSha: 'bbb' } }),
      headChecks: { sha: 'bbb', state: 'passed' as const },
      failure: { reason: "GitHub hasn't decided whether the PR can merge; try again", at: 'x', kind: 'merge' as const },
    };
    expect(m.allowedActions(failed, dev)).toContain('retry_merge');
    const t = value(m.retryMerge(failed, ctx()));
    expect(t.glob).toMatchObject({ status: 'merging', failure: null });
    expect(t.effects).toEqual([{ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: 'bbb' }]);
    const conflicted = { ...failed, failure: { ...failed.failure, conflict: { base: 'main', files: ['a'] } } };
    expect(m.allowedActions(conflicted, dev)).not.toContain('retry_merge');
    expect(errorCode(m.retryMerge(conflicted, ctx()))).toBe('invalid_transition');
  });

  it('row 14: Merge with passing checks on the current head merges now', () => {
    const g = glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'bbb' } });
    const passing = { ...g, headChecks: { sha: 'bbb', state: 'passed' as const } };
    const t = value(m.requestMerge(passing, ctx()));
    expect(t.glob.status).toBe('merging');
    expect(t.effects.map((e) => e.kind)).toEqual(['squash_merge']);
    expect(m.allowedActions(passing, dev)).toContain('merge');
    const failed = { ...g, headChecks: { sha: 'bbb', state: 'failed' as const } };
    expect(errorCode(m.requestMerge(failed, ctx()))).toBe('invalid_transition');
    expect(m.allowedActions(failed, dev)).not.toContain('merge');
    const conflicted = { ...passing, conflict: { base: 'main', files: ['a'], since: null, at: 'x' } };
    expect(errorCode(m.requestMerge(conflicted, ctx()))).toBe('invalid_transition');
  });

  describe('row 14b: Merge with checks pending arms "merge when checks pass"', () => {
    const open = glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'bbb' } });
    const pending = { ...open, headChecks: { sha: 'bbb', state: 'pending' as const } };

    it('arms instead of merging, with no merge call, and hides Merge until cancelled', () => {
      for (const g of [open, pending, { ...open, headChecks: { sha: 'aaa', state: 'passed' as const } }]) {
        expect(m.allowedActions(g, dev)).toContain('merge');
        const t = value(m.requestMerge(g, ctx()));
        expect(t.glob).toMatchObject({ status: 'pr_open', mergeMode: 'when_green' });
        expect(t.effects.map((e) => e.kind)).not.toContain('squash_merge');
        expect(m.allowedActions(t.glob, dev)).toContain('cancel_merge');
        expect(m.allowedActions(t.glob, dev)).not.toContain('merge');
        expect(errorCode(m.requestMerge(t.glob, ctx()))).toBe('invalid_transition');
      }
    });

    it('reads the checks when none are reported for the head, and leaves a behind branch to the merge', () => {
      expect(value(m.requestMerge(open, ctx())).effects).toEqual([{ kind: 'refresh_checks', globId: 's1t1', generation: 1 }]);
      const behind = { ...pending, behind: { base: 'main', behindBy: 1, files: [], at: 'x' } };
      expect(value(m.requestMerge(behind, ctx())).effects).toEqual([]);
    });

    it('is disarmed by a new push, a closed PR, and never carried into a re-readied PR', () => {
      const armed = value(m.requestMerge(pending, ctx())).glob;
      const pushed = value(m.commitPushed(armed, { sha: 'ccc', runId: null }, ctx()));
      expect(pushed.glob).toMatchObject({ mergeMode: null, status: 'pr_open' });
      expect(value(m.prClosed(armed, ctx())).glob).toMatchObject({ mergeMode: null, status: 'failed' });
      const stale = { ...armed, status: 'in_progress' as const };
      expect(value(m.prReadyForReview(stale, { number: 7, headSha: 'bbb' }, ctx())).glob.mergeMode).toBeNull();
    });

    it('records the conflict when it disarms, even if the head own checks passed', () => {
      const armed = value(m.requestMerge(pending, ctx())).glob;
      const conflict = { base: 'main', files: ['a'] };
      const t = value(m.checksCompleted(armed, { sha: 'bbb', passed: true, conflict }, ctx()));
      expect(t.glob.mergeMode).toBeNull();
    });

    it('merges when the head checks pass', () => {
      const armed = value(m.requestMerge(pending, ctx())).glob;
      const t = value(m.checksCompleted(armed, { sha: 'bbb', passed: true }, ctx()));
      expect(t.glob).toMatchObject({ status: 'merging', mergeMode: null });
      expect(t.effects).toEqual([{ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: 'bbb' }]);
    });

    it('disarms when the checks fail or the PR conflicts, leaving the failure to show', () => {
      const armed = value(m.requestMerge(pending, ctx())).glob;
      const failed = value(m.checksCompleted(armed, { sha: 'bbb', passed: false }, ctx()));
      expect(failed.glob).toMatchObject({ status: 'pr_open', mergeMode: null, headChecks: { state: 'failed' } });
      expect(failed.effects).toEqual([]);
      const conflict = { base: 'main', files: ['a'] };
      expect(value(m.checksCompleted(armed, { sha: 'bbb', passed: false, conflict }, ctx())).glob.mergeMode).toBeNull();
      expect(value(m.conflictFound(armed, { ...conflict, since: null }, ctx())).glob.mergeMode).toBeNull();
    });

    it('is cancelled by Cancel merge, which only works while armed', () => {
      const armed = value(m.requestMerge(pending, ctx())).glob;
      expect(value(m.cancelMerge(armed, ctx())).glob.mergeMode).toBeNull();
      expect(errorCode(m.cancelMerge(pending, ctx()))).toBe('invalid_transition');
    });

    it('is not offered to a sub, and Merge and continue still waits for passed checks', () => {
      expect(m.allowedActions({ ...pending, type: 'sub' }, dev)).not.toContain('merge');
      const sup = { ...pending, type: 'super' as const };
      expect(errorCode(m.requestMerge(sup, ctx(), { continue: true, facts: { recordSha: 'bbb' } }))).toBe('invalid_transition');
    });
  });

  it('row 14: Merge is withheld and refused while a conflict with the base is recorded', () => {
    const conflict = { base: 'main', files: ['a.ts'], since: 's1t2', at: NOW };
    const passing = {
      ...glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'bbb' } }),
      headChecks: { sha: 'bbb', state: 'passed' as const },
    };
    const conflicted = { ...passing, conflict };
    expect(m.allowedActions(conflicted, dev)).not.toContain('merge');
    expect(m.allowedActions(conflicted, dev)).toContain('resolve_conflict');
    const refused = m.requestMerge(conflicted, ctx());
    expect(errorCode(refused)).toBe('invalid_transition');
    expect(conflicted.status).toBe('pr_open');
    // A push that merges the base clears the conflict; Merge is offered again.
    const cleared = { ...passing, conflict: null };
    expect(m.allowedActions(cleared, dev)).toContain('merge');
    expect(value(m.requestMerge(cleared, ctx())).glob.status).toBe('merging');
    // Merge and continue (supers) is withheld the same way.
    const superConflicted = { ...conflicted, type: 'super' as const };
    expect(m.allowedActions(superConflicted, dev, { recordSha: 'bbb' })).not.toContain('merge_continue');
    expect(errorCode(m.requestMerge(superConflicted, ctx(), { continue: true, facts: { recordSha: 'bbb' } }))).toBe(
      'invalid_transition',
    );
  });

  it('row 15: a merge sets labels Required by type and ends the run', () => {
    const sub = value(m.merged(glob({ type: 'sub', status: 'merging', runs: [run({ state: 'watching' })] }), { sha: 'm' }, ctx(null)));
    expect(sub.glob.status).toBe('reviewing');
    expect(sub.glob.labels).toEqual({ QA: 'required' });
    expect(m.currentRun(sub.glob)?.outcome).toBe('completed');

    const same = value(m.merged(glob({ status: 'in_progress' }), { sha: 'm' }, ctx(null)));
    expect(same.glob.labels).toEqual({ FR: 'required', CR: 'required', QA: 'required' });
  });

  it('row 15: a merge observed for a planning glob still moves it to reviewing', () => {
    expect(errorCode(m.prReadyForReview(glob(), { number: 7, headSha: 'bbb' }, ctx(null)))).toBe('invalid_transition');
    const mergedFromPlanning = value(m.merged(glob(), { sha: 'm' }, ctx(null)));
    expect(mergedFromPlanning.glob.status).toBe('reviewing');
    expect(mergedFromPlanning.glob.labels).toEqual({ FR: 'required', CR: 'required', QA: 'required' });
  });

  it('row 15: the second merge observation is a no-op', () => {
    const t = value(m.merged(glob({ status: 'reviewing' }), { sha: 'm' }, ctx(null)));
    expect(t.changed).toBe(false);
  });

  it('row 16: a failed merge leaves the glob failed with a reason', () => {
    const t = value(m.mergeFailed(glob({ status: 'merging' }), 'conflict', ctx(null)));
    expect(t.glob.status).toBe('failed');
    expect(t.glob.failure?.reason).toBe('conflict');
  });

  it('row 16: a failed merge ends a watching run, so the glob can be picked up again', () => {
    const t = value(m.mergeFailed(glob({ status: 'merging', runs: [run({ state: 'watching' })] }), 'conflict', ctx(null)));
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'ended', outcome: 'failed', failureReason: 'conflict' });
    expect(m.hasLiveRun(t.glob)).toBe(false);
  });

  it('row 16: a failed merge leaves an active run alone', () => {
    const t = value(m.mergeFailed(glob({ status: 'merging', runs: [run({ state: 'active' })] }), 'conflict', ctx(null)));
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'active' });
  });
});

describe('failures (rows 17–19, 25)', () => {
  it('row 17: report_failure with the current run fails an implementing glob', () => {
    const t = value(m.reportFailure(glob({ status: 'implementing', runs: [run()] }), { reason: 'stuck', runId: 'run-0' }, ctx(null)));
    expect(t.glob.status).toBe('failed');
    expect(m.currentRun(t.glob)).toMatchObject({ outcome: 'failed', failureReason: 'stuck' });
  });

  it('row 17: a superseded run ID is recorded but ignored', () => {
    const t = value(m.reportFailure(glob({ status: 'implementing', runs: [run()] }), { reason: 'stuck', runId: 'old' }, ctx(null)));
    expect(t.changed).toBe(false);
    expect(t.events[0]?.data).toMatchObject({ ignored: true });
  });

  it('row 18: an interactive session fails an in-progress glob', () => {
    const t = value(m.reportFailure(glob({ status: 'in_progress' }), { reason: 'blocked', runId: null }, ctx()));
    expect(t.glob.status).toBe('failed');
  });

  it('records the agent-set version a failure report gives', () => {
    const failed = value(m.reportFailure(glob({ status: 'in_progress' }), { reason: 'blocked', runId: null, agentSetVersion: 4 }, ctx()));
    expect(failed.glob.failure).toEqual({ reason: 'blocked', at: NOW, agentSetVersion: 4 });
    const ignored = value(m.reportFailure(glob({ status: 'implementing', runs: [run()] }), { reason: 'stuck', runId: 'old', agentSetVersion: 4 }, ctx(null)));
    expect(ignored.events[0]?.data).toMatchObject({ ignored: true, agentSetVersion: 4 });
  });

  // The glob's failure is cleared by pick-up and start-again, so the event log keeps the version.
  it('row 18: the StatusChanged event carries the reason and agent-set version', () => {
    const t = value(m.reportFailure(glob({ status: 'in_progress' }), { reason: 'blocked', runId: null, agentSetVersion: 4 }, ctx()));
    expect(t.events.find((e) => e.type === 'StatusChanged')?.data).toEqual({
      from: 'in_progress',
      to: 'failed',
      reason: 'blocked',
      agentSetVersion: 4,
    });
  });

  it('rows 17 and 25: the RunFailed event carries the agent-set version', () => {
    const implementing = value(
      m.reportFailure(glob({ status: 'implementing', runs: [run()] }), { reason: 'stuck', runId: 'run-0', agentSetVersion: 4 }, ctx(null)),
    );
    expect(implementing.events.find((e) => e.type === 'RunFailed')?.data).toEqual({ runId: 'run-0', reason: 'stuck', agentSetVersion: 4 });
    const watching = value(
      m.reportFailure(glob({ status: 'pr_open', runs: [run({ state: 'watching' })] }), { reason: 'gave up', runId: 'run-0', agentSetVersion: 4 }, ctx(null)),
    );
    expect(watching.events.find((e) => e.type === 'RunFailed')?.data).toEqual({ runId: 'run-0', reason: 'gave up', agentSetVersion: 4 });
  });

  it('records a null agent-set version when a failure report gives none', () => {
    const t = value(m.reportFailure(glob({ status: 'implementing', runs: [run()] }), { reason: 'stuck', runId: 'run-0' }, ctx(null)));
    expect(t.events.find((e) => e.type === 'RunFailed')?.data).toMatchObject({ agentSetVersion: null });
    expect(t.glob.failure).toEqual({ reason: 'stuck', at: NOW });
  });

  it('row 19: closing the PR unmerged fails a pr_open glob', () => {
    const t = value(m.prClosed(glob({ status: 'pr_open', runs: [run({ state: 'watching' })] }), ctx(null)));
    expect(t.glob.status).toBe('failed');
    expect(m.currentRun(t.glob)?.state).toBe('ended');
  });

  it('row 25: a watching run failing keeps pr_open and shows the failure', () => {
    const g = glob({ status: 'pr_open', runs: [run({ state: 'watching' })] });
    const t = value(m.reportFailure(g, { reason: 'auto-fix gave up', runId: 'run-0' }, ctx(null)));
    expect(t.glob.status).toBe('pr_open');
    expect(t.glob.failure?.reason).toBe('auto-fix gave up');
  });
});

describe('re-trigger, start again, delete (rows 20, 23, 24)', () => {
  it('row 20: re-trigger bumps the generation, reopens the PR and queues a run', () => {
    const t = value(m.retrigger(glob({ status: 'failed', implementer: other.email }), ctx()));
    expect(t.glob.status).toBe('implementing');
    expect(t.glob.generation).toBe(2);
    expect(t.glob.implementer).toBeNull();
    expect(effectKinds(t)).toEqual(['reopen_pr', 'fire_routine']);
    expect(t.effects.every((e) => !('generation' in e) || e.generation === 2)).toBe(true);
  });

  it('row 20: refused while a run is live, and for supers', () => {
    expect(errorCode(m.retrigger(glob({ status: 'failed', runs: [run({ state: 'queued' })] }), ctx()))).toBe('run_active');
    expect(errorCode(m.retrigger(glob({ status: 'failed', type: 'super' }), ctx()))).toBe('invalid_transition');
  });

  it('row 23: start again resets by type and re-provisions under the new generation', () => {
    const sub = value(m.startAgain(glob({ type: 'sub', status: 'pr_open', runs: [run({ state: 'watching' })] }), ctx()));
    expect(sub.glob.status).toBe('implementing');
    expect(effectKinds(sub)).toEqual(['close_pr', 'delete_branch', 'provision', 'fire_routine']);
    expect(sub.glob.runs.at(-2)?.outcome).toBe('superseded');
    expect(sub.events.find((e) => e.type === 'RunEnded')?.data).toMatchObject({ outcome: 'superseded', cause: 'start_again' });

    const sup = value(m.startAgain(glob({ type: 'super', status: 'failed', implementer: other.email, creator: dev.email }), ctx()));
    expect(sup.glob.status).toBe('in_progress');
    expect(sup.glob.implementer).toBe(dev.email);

    expect(errorCode(m.startAgain(glob({ status: 'reviewing' }), ctx()))).toBe('invalid_transition');
  });

  it("records a push's Slop-Agent-Set trailer version on its CommitPushed event", () => {
    const pushed = value(m.commitPushed(glob({ status: 'in_progress' }), { sha: 'ccc', runId: null, agentSetVersion: 12 }, ctx(null)));
    expect(pushed.events.find((e) => e.type === 'CommitPushed')?.data).toEqual({ sha: 'ccc', runId: null, fromSupersededRun: false, agentSetVersion: 12 });
    const plain = value(m.commitPushed(glob({ status: 'in_progress' }), { sha: 'ddd', runId: null }, ctx(null)));
    expect(plain.events.find((e) => e.type === 'CommitPushed')?.data).toEqual({ sha: 'ddd', runId: null, fromSupersededRun: false });
  });

  it('records the cause of every other superseded run: pick up, PR closed, delete (s15f8)', () => {
    const cause = (t: Transition) => t.events.find((e) => e.type === 'RunEnded')?.data;
    const queued = run({ state: 'queued', startedAt: null });
    expect(cause(value(m.pickUp(glob({ runs: [queued] }), ctx(), board, { takeOver: false })))).toMatchObject({ outcome: 'superseded', cause: 'pick_up' });
    expect(cause(value(m.pickUp(glob({ status: 'pr_open', runs: [queued] }), ctx(), board, { takeOver: false })))).toMatchObject({ cause: 'take_over' });
    expect(cause(value(m.prClosed(glob({ status: 'pr_open', runs: [run({ state: 'watching' })] }), ctx(null))))).toMatchObject({ outcome: 'superseded', cause: 'pr_closed' });
    expect(cause(value(m.remove(glob({ status: 'implementing', runs: [run()] }), ctx())))).toMatchObject({ outcome: 'superseded', cause: 'deleted' });
  });

  it('row 24: delete supersedes the run and queues the clean-up', () => {
    const t = value(m.remove(glob({ status: 'implementing', runs: [run()] }), ctx()));
    expect(effectKinds(t)).toEqual(['delete_glob_data']);
    expect(t.events.map((e) => e.type)).toContain('GlobDeleted');
  });
});

describe('labels and review checklists (rows 21, 22, 27–30)', () => {
  const reviewing = glob({ status: 'reviewing', labels: { FR: 'approved', CR: 'approved', QA: 'required' } });
  const items = (t: m.Transition, name: 'FR' | 'CR' | 'QA' = 'QA') => t.glob.checklists[name] ?? [];

  it('row 27: the reviewer submits items on a required label', () => {
    const t = value(m.reviewLabel(reviewing, 'QA', { kind: 'submit_items', items: [' Fix copy ', '', 'Add test'] }, ctx()));
    expect(t.glob.labels.QA).toBe('added');
    expect(t.glob.status).toBe('reviewing');
    expect(items(t)).toEqual([
      { id: '1', text: 'Fix copy', done: false, addedBy: dev.email, addedAt: NOW, doneBy: null, doneAt: null },
      { id: '2', text: 'Add test', done: false, addedBy: dev.email, addedAt: NOW, doneBy: null, doneAt: null },
    ]);
    expect(t.events[0]).toMatchObject({
      type: 'LabelChanged',
      actor: dev.email,
      data: { label: 'QA', from: 'required', to: 'added', items: ['Fix copy', 'Add test'] },
    });
  });

  it('submitting needs at least one item and a required label', () => {
    expect(errorCode(m.reviewLabel(reviewing, 'QA', { kind: 'submit_items', items: [' ', ''] }, ctx()))).toBe(
      'invalid_input',
    );
    expect(errorCode(m.reviewLabel(reviewing, 'FR', { kind: 'submit_items', items: ['x'] }, ctx()))).toBe(
      'invalid_transition',
    );
  });

  it('row 28 and row 21: approving the last label without items signs off', () => {
    const t = value(m.reviewLabel(reviewing, 'QA', { kind: 'approve' }, ctx()));
    expect(t.glob.labels.QA).toBe('approved');
    expect(t.glob.status).toBe('signed_off');
    expect(t.glob.signedOffAt).toBe(NOW);
    expect(t.events.map((e) => e.type)).toEqual(['LabelChanged', 'StatusChanged']);
  });

  it('row 28: approving a label with items keeps them, ticked or not, and signs off', () => {
    const added = value(m.reviewLabel(reviewing, 'QA', { kind: 'submit_items', items: ['a', 'b'] }, ctx())).glob;
    const ticked = value(m.reviewLabel(added, 'QA', { kind: 'tick', itemId: '1', done: true }, ctx())).glob;
    const t = value(m.reviewLabel(ticked, 'QA', { kind: 'approve' }, ctx()));
    expect(t.glob.status).toBe('signed_off');
    expect(items(t).map((i) => i.done)).toEqual([true, false]);
    expect(t.events[0]?.data).toMatchObject({ from: 'added', to: 'approved', open: 1 });
  });

  it('approving while other labels are open does not sign off; approving twice is a no-op', () => {
    const open = glob({ status: 'reviewing', labels: { FR: 'required', CR: 'added', QA: 'required' } });
    const t = value(m.reviewLabel(open, 'QA', { kind: 'approve' }, ctx()));
    expect(t.glob.status).toBe('reviewing');
    expect(value(m.reviewLabel(t.glob, 'QA', { kind: 'approve' }, ctx())).changed).toBe(false);
  });

  it('row 29: the developer ticks and unticks items while the label has items added', () => {
    const added = value(m.reviewLabel(reviewing, 'QA', { kind: 'submit_items', items: ['a'] }, ctx())).glob;
    const ticked = value(m.reviewLabel(added, 'QA', { kind: 'tick', itemId: '1', done: true }, ctx(other)));
    expect(ticked.glob.labels.QA).toBe('added');
    expect(items(ticked)[0]).toMatchObject({ done: true, doneBy: other.email, doneAt: NOW });
    expect(ticked.events).toMatchObject([{ type: 'LabelItemTicked', data: { label: 'QA', item: '1', done: true } }]);
    expect(value(m.reviewLabel(ticked.glob, 'QA', { kind: 'tick', itemId: '1', done: true }, ctx())).changed).toBe(false);
    const unticked = value(m.reviewLabel(ticked.glob, 'QA', { kind: 'tick', itemId: '1', done: false }, ctx()));
    expect(items(unticked)[0]).toMatchObject({ done: false, doneBy: null, doneAt: null });
    expect(errorCode(m.reviewLabel(added, 'QA', { kind: 'tick', itemId: '9', done: true }, ctx()))).toBe('invalid_input');
  });

  it('items cannot be ticked while the label waits for its reviewer', () => {
    const added = value(m.reviewLabel(reviewing, 'QA', { kind: 'submit_items', items: ['a'] }, ctx())).glob;
    const resubmitted = value(m.reviewLabel(added, 'QA', { kind: 'resubmit' }, ctx())).glob;
    expect(errorCode(m.reviewLabel(resubmitted, 'QA', { kind: 'tick', itemId: '1', done: true }, ctx()))).toBe(
      'invalid_transition',
    );
  });

  it('row 30: resubmitting with items unticked returns the label to required, keeping items and ticks', () => {
    const added = value(m.reviewLabel(reviewing, 'QA', { kind: 'submit_items', items: ['a', 'b'] }, ctx())).glob;
    const ticked = value(m.reviewLabel(added, 'QA', { kind: 'tick', itemId: '2', done: true }, ctx())).glob;
    const t = value(m.reviewLabel(ticked, 'QA', { kind: 'resubmit' }, ctx()));
    expect(t.glob.labels.QA).toBe('required');
    expect(items(t).map((i) => [i.text, i.done])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(t.events[0]?.data).toMatchObject({ from: 'added', to: 'required', open: 1 });
    // The reviewer's next round adds to the same list.
    const again = value(m.reviewLabel(t.glob, 'QA', { kind: 'submit_items', items: ['c'] }, ctx()));
    expect(items(again).map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(errorCode(m.reviewLabel(t.glob, 'QA', { kind: 'resubmit' }, ctx()))).toBe('invalid_transition');
  });

  it('row 22: re-opening an approved label returns a signed-off glob to reviewing, keeping its items', () => {
    const added = value(m.reviewLabel(reviewing, 'QA', { kind: 'submit_items', items: ['a'] }, ctx())).glob;
    const signedOff = value(m.reviewLabel(added, 'QA', { kind: 'approve' }, ctx())).glob;
    const t = value(m.reviewLabel(signedOff, 'FR', { kind: 'reopen' }, ctx()));
    expect(t.glob.status).toBe('reviewing');
    expect(t.glob.signedOffAt).toBeNull();
    expect(t.glob.labels.FR).toBe('required');
    expect(t.glob.checklists.QA).toHaveLength(1);
    expect(errorCode(m.reviewLabel(t.glob, 'FR', { kind: 'reopen' }, ctx()))).toBe('invalid_transition');
  });

  it("a signed-off glob's checklists are read-only", () => {
    const added = value(m.reviewLabel(reviewing, 'QA', { kind: 'submit_items', items: ['a'] }, ctx())).glob;
    const signedOff = value(m.reviewLabel(added, 'QA', { kind: 'approve' }, ctx())).glob;
    expect(signedOff.status).toBe('signed_off');
    expect(errorCode(m.reviewLabel(signedOff, 'QA', { kind: 'tick', itemId: '1', done: true }, ctx()))).toBe(
      'invalid_transition',
    );
    expect(errorCode(m.reviewLabel(signedOff, 'QA', { kind: 'submit_items', items: ['b'] }, ctx()))).toBe(
      'invalid_transition',
    );
    expect(errorCode(m.reviewLabel(signedOff, 'QA', { kind: 'resubmit' }, ctx()))).toBe('invalid_transition');
  });

  it('labels that are not required cannot be acted on', () => {
    expect(
      errorCode(m.reviewLabel(glob({ status: 'reviewing', labels: { QA: 'required' } }), 'FR', { kind: 'approve' }, ctx())),
    ).toBe('invalid_transition');
  });

  it('a merge starts with fresh labels and empty checklists', () => {
    const t = value(m.merged(glob({ status: 'merging', checklists: { QA: [] } }), { sha: 'abc' }, ctx()));
    expect(t.glob.checklists).toEqual({});
  });
});

describe('field changes and type changes (row 26)', () => {
  it('changes group and category without moving the glob', () => {
    const t = value(m.changeFields(glob(), { group: 'Sync', category: 'feature' }, board, ctx()));
    expect(t.glob.status).toBe('planning');
    expect(t.glob.category).toBe('feature');
    expect(t.glob.id).toBe('s1t1');
  });

  it('enforces the matrix on category changes', () => {
    expect(errorCode(m.changeFields(glob({ type: 'super' }), { category: 'bug' }, board, ctx()))).toBe(
      'invalid_combination',
    );
    expect(m.changeFields(glob({ type: 'sub' }), { category: 'feature' }, board, ctx()).ok).toBe(true);
  });

  it('row 26: same to sub from planning starts work', () => {
    const t = value(m.changeFields(glob(), { type: 'sub' }, board, ctx()));
    expect(t.glob.status).toBe('implementing');
    expect(effectKinds(t)).toEqual(['sync_pr_labels', 'fire_routine']);
  });

  it('sub to same is allowed before merge only', () => {
    expect(value(m.changeFields(glob({ type: 'sub', status: 'pr_open' }), { type: 'same' }, board, ctx())).glob.type).toBe('same');
    expect(errorCode(m.changeFields(glob({ type: 'sub', status: 'reviewing' }), { type: 'same' }, board, ctx()))).toBe(
      'invalid_transition',
    );
  });

  it('same and super swap only while a human implements with no live run', () => {
    expect(value(m.changeFields(glob({ status: 'in_progress' }), { type: 'super' }, board, ctx())).glob.type).toBe('super');
    expect(
      errorCode(m.changeFields(glob({ status: 'pr_open', runs: [run({ state: 'watching' })] }), { type: 'super' }, board, ctx())),
    ).toBe('invalid_transition');
  });

  describe('in planning', () => {
    it('a sub and a super swap while parked in planning with no run; a held sub stops waiting', () => {
      const held = glob({ type: 'sub', status: 'planning', provisioning: 'none', pr: null, waiting: { since: NOW }, runs: [] });
      const sup = value(m.changeFields(held, { type: 'super' }, board, ctx())).glob;
      expect(sup).toMatchObject({ type: 'super', status: 'planning', waiting: null, implementer: null });
      const sub = value(m.changeFields(sup, { type: 'sub' }, board, ctx()));
      expect(sub.glob.type).toBe('sub');
      expect(sub.glob.status).toBe('implementing');
      expect(effectKinds(sub)).toContain('fire_routine');
    });

    it('a sub cannot become a super once running, and QA cannot make one', () => {
      expect(errorCode(m.changeFields(glob({ type: 'sub', status: 'implementing', runs: [run()] }), { type: 'super' }, board, ctx()))).toBe(
        'invalid_transition',
      );
      expect(errorCode(m.changeFields(glob({ type: 'sub', status: 'planning', runs: [] }), { type: 'super' }, board, ctx(po)))).toBe('forbidden');
    });

    it('sames and subs can always be picked up, in planning and in doing with a live run (take over)', () => {
      for (const type of ['same', 'sub'] as const) {
        const planning = glob({ type, status: 'planning', provisioning: 'none', pr: null, runs: [] });
        expect(value(m.pickUp(planning, ctx(), board, { takeOver: false })).glob.implementer).toBe(dev.email);
        const running = glob({ type, status: 'implementing', runs: [run({ state: 'active' })] });
        expect(errorCode(m.pickUp(running, ctx(), board, { takeOver: false }))).toBe('run_active');
        const taken = value(m.pickUp(running, ctx(), board, { takeOver: true }));
        expect(taken.glob.implementer).toBe(dev.email);
        expect(taken.glob.status).toBe('in_progress');
      }
    });

    const planned = (patch: Partial<Parameters<typeof glob>[0]> = {}) => glob({ status: 'planning', provisioning: 'none', pr: null, ...patch });

    it('same to super and back is allowed and does not move the glob', () => {
      const up = value(m.changeFields(planned(), { type: 'super' }, board, ctx()));
      expect(up.glob.type).toBe('super');
      expect(up.glob.status).toBe('planning');
      expect(effectKinds(up)).toEqual([]);
      const down = value(m.changeFields(up.glob, { type: 'same' }, board, ctx()));
      expect(down.glob.type).toBe('same');
      expect(down.glob.status).toBe('planning');
    });

    it('is refused while implementing, with a queued run, and after merge', () => {
      for (const g of [
        glob({ status: 'implementing', runs: [run()] }),
        planned({ runs: [run({ state: 'queued' })] }),
        glob({ status: 'reviewing' }),
      ]) {
        expect(errorCode(m.changeFields(g, { type: 'super' }, board, ctx()))).toBe('invalid_transition');
      }
      expect(errorCode(m.changeFields(glob({ type: 'super', status: 'implementing' }), { type: 'same' }, board, ctx()))).toBe(
        'invalid_transition',
      );
    });

    it('QA and PO members cannot make a super', () => {
      const qa = { email: 'qa@example.com', role: 'qa' } as const;
      for (const actor of [qa, po]) {
        expect(errorCode(m.changeFields(planned(), { type: 'super' }, board, ctx(actor)))).toBe('forbidden');
      }
    });

    it('a same held only by `after` offers Start now, not Start, with the dependencies loaded (the list path)', () => {
      const held = glob({ type: 'same', status: 'planning', after: ['s1t9'], waiting: null });
      const actions = m.allowedActions(held, dev, { dependencies: new Map([['s1t9', 'open' as const]]) });
      expect(actions).toContain('start_anyway');
      expect(actions).not.toContain('start');
      expect(m.allowedActions(held, dev, { dependencies: new Map([['s1t9', 'merged' as const]]) })).toContain('start');
    });

    it('a glob held only for its oversized flag offers Start now with the dependencies loaded', () => {
      const held = glob({ type: 'sub', status: 'planning', waiting: { since: NOW } });
      expect(m.allowedActions(held, dev, { dependencies: new Map() })).not.toContain('start_anyway');
      expect(m.allowedActions(held, dev, { dependencies: new Map(), sizeHeld: true })).toContain('start_anyway');
      const t = value(m.startAnyway(held, ctx()));
      expect(t.glob.status).toBe('implementing');
      expect(t.glob.waiting).toBeNull();
      expect(t.glob.runs.at(-1)?.state).toBe('queued');
    });

    it('a picked-up glob with no run can be handed to a routine; with a live run it cannot', () => {
      const picked = glob({ type: 'sub', status: 'in_progress', implementer: dev.email, runs: [] });
      expect(m.allowedActions(picked, dev)).toContain('start_anyway');
      const t = value(m.startAnyway(picked, ctx()));
      expect(t.glob.status).toBe('implementing');
      expect(t.glob.implementer).toBeNull();
      expect(t.glob.generation).toBe(picked.generation + 1);
      expect(t.glob.runs.at(-1)?.state).toBe('queued');
      const sup = glob({ type: 'super', status: 'in_progress', implementer: dev.email, runs: [] });
      expect(m.allowedActions(sup, dev)).not.toContain('start_anyway');
      expect(errorCode(m.startAnyway(sup, ctx()))).toBe('invalid_transition');
    });

    it('a planned super offers Pick up but not Start; back to same offers both', () => {
      const sup = value(m.changeFields(planned(), { type: 'super' }, board, ctx())).glob;
      const actions = m.allowedActions(sup, dev);
      expect(actions).toContain('pick_up');
      expect(actions).not.toContain('start');
      expect(errorCode(m.start(sup, ctx()))).toBe('invalid_transition');
      const same = value(m.changeFields(sup, { type: 'same' }, board, ctx())).glob;
      expect(m.allowedActions(same, dev)).toEqual(expect.arrayContaining(['start', 'pick_up']));
    });

    it('picking up a planned super goes straight to in_progress and provisions', () => {
      const sup = value(m.changeFields(planned(), { type: 'super' }, board, ctx())).glob;
      const t = value(m.pickUp(sup, ctx(), board, { takeOver: false }));
      expect(t.glob.status).toBe('in_progress');
      expect(t.glob.implementer).toBe(dev.email);
      expect(t.glob.provisioning).toBe('pending');
      expect(effectKinds(t)).toEqual(['provision']);
    });
  });

  it('refuses other type changes', () => {
    expect(errorCode(m.changeFields(glob({ type: 'super', status: 'in_progress' }), { type: 'sub' }, board, ctx()))).toBe(
      'invalid_transition',
    );
  });
});

describe('provisioning when a glob enters Doing', () => {
  const planning = glob({ provisioning: 'none', pr: null });

  it('start and pick-up provision before any routine run', () => {
    const started = value(m.start(planning, ctx()));
    expect(started.glob.provisioning).toBe('pending');
    expect(effectKinds(started)).toEqual(['provision', 'fire_routine']);
    expect(effectKinds(value(m.pickUp(planning, ctx(), board, { takeOver: false })))).toEqual(['provision']);
  });

  it('subs, supers and auto-started sames provision at creation', () => {
    for (const input of [createInput({ type: 'sub' }), createInput({ type: 'super' }), createInput({ autoTrigger: true })]) {
      expect(effectKinds(value(m.create(input, board, ctx())))[0]).toBe('provision');
    }
  });

  it('same to sub from planning provisions as it starts work', () => {
    expect(effectKinds(value(m.changeFields(planning, { type: 'sub' }, board, ctx())))).toEqual(['provision', 'fire_routine']);
  });

  it('start again leaves a same unprovisioned and re-provisions a sub', () => {
    const same = value(m.startAgain(glob({ status: 'in_progress' }), ctx()));
    expect(same.glob.provisioning).toBe('none');
    expect(effectKinds(same)).toEqual(['close_pr', 'delete_branch']);
    const sub = value(m.startAgain(glob({ type: 'sub', status: 'failed' }), ctx()));
    expect(effectKinds(sub)).toEqual(['close_pr', 'delete_branch', 'provision', 'fire_routine']);
  });

  it('an already provisioned glob is not provisioned again', () => {
    expect(effectKinds(value(m.start(glob(), ctx())))).toEqual(['fire_routine']);
  });
});

describe('checks and merging (slice 2)', () => {
  const ready = glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'bbb' } });

  it('PR ready and pushes to an open PR refresh the head checks', () => {
    const t = value(m.prReadyForReview(glob({ status: 'in_progress' }), { number: 7, headSha: 'bbb' }, ctx(null)));
    expect(effectKinds(t)).toEqual(['refresh_checks', 'review_change']);
    const pushed = value(m.commitPushed({ ...ready, headChecks: { sha: 'bbb', state: 'passed' } }, { sha: 'ccc', runId: null }, ctx(null)));
    expect(pushed.glob.headChecks).toBeNull();
    expect(effectKinds(pushed)).toEqual(['refresh_checks', 'review_change']);
  });

  it('a sub entering pr_open goes straight to the sub policy, without waiting for its checks', () => {
    const sub = value(m.prReadyForReview(glob({ type: 'sub', status: 'implementing' }), { number: 7, headSha: 'bbb' }, ctx(null)));
    expect(sub.effects).toEqual([
      { kind: 'refresh_checks', globId: 's1t1', generation: 1 },
      { kind: 'evaluate_sub_gate', globId: 's1t1', generation: 1, sha: 'bbb' },
    ]);
    const same = value(m.prReadyForReview(glob({ type: 'same', status: 'in_progress' }), { number: 7, headSha: 'bbb' }, ctx(null)));
    expect(effectKinds(same)).toEqual(['refresh_checks', 'review_change']);
    const superGlob = value(m.prReadyForReview(glob({ type: 'super', status: 'in_progress' }), { number: 7, headSha: 'bbb' }, ctx(null)));
    expect(effectKinds(superGlob)).toEqual(['refresh_checks', 'review_change']);
  });

  describe('automatic independent review', () => {
    const review = (stage: 'pre_merge' | 'post_merge', sha: string) => ({ kind: 'review_change', globId: 's1t1', generation: 1, stage, sha });

    it('queues a pre-merge review of the head when a same or super is marked ready, none for a sub', () => {
      const same = value(m.prReadyForReview(glob({ type: 'same', status: 'in_progress' }), { number: 7, headSha: 'bbb' }, ctx(null)));
      expect(same.effects).toContainEqual(review('pre_merge', 'bbb'));
      const sub = value(m.prReadyForReview(glob({ type: 'sub', status: 'implementing' }), { number: 7, headSha: 'bbb' }, ctx(null)));
      expect(effectKinds(sub)).not.toContain('review_change');
    });

    it('queues a review of each push while the PR is ready, but not for drafts, subs, superseded runs or the start commit', () => {
      const pushed = value(m.commitPushed(ready, { sha: 'ccc', runId: null }, ctx(null)));
      expect(pushed.effects).toContainEqual(review('pre_merge', 'ccc'));
      const draft = glob({ status: 'in_progress', pr: { number: 7, state: 'draft', headSha: 'bbb' } });
      expect(effectKinds(value(m.commitPushed(draft, { sha: 'ccc', runId: null }, ctx(null))))).not.toContain('review_change');
      expect(effectKinds(value(m.commitPushed({ ...ready, type: 'sub' }, { sha: 'ccc', runId: null }, ctx(null))))).not.toContain('review_change');
      expect(effectKinds(value(m.commitPushed(ready, { sha: 'ccc', runId: 'old-run' }, ctx(null))))).not.toContain('review_change');
      expect(effectKinds(value(m.commitPushed(ready, { sha: 'ccc', runId: null, message: 's1t1: start' }, ctx(null))))).not.toContain('review_change');
    });

    it('reviews a sub once after it merges, and a same or super not at all (it was reviewed before)', () => {
      const sub = value(m.merged(glob({ type: 'sub', status: 'merging', pr: { number: 7, state: 'ready', headSha: 'bbb' } }), { sha: 'm1' }, ctx(null)));
      expect(sub.effects).toContainEqual(review('post_merge', 'm1'));
      const same = value(m.merged(glob({ type: 'same', status: 'merging', pr: { number: 7, state: 'ready', headSha: 'bbb' } }), { sha: 'm1' }, ctx(null)));
      expect(effectKinds(same)).not.toContain('review_change');
    });
  });

  describe('review now (on-demand independent review)', () => {
    const doing = glob({ status: 'pr_open', pr: { number: 7, state: 'draft', headSha: 'bbb' } });
    const merged = glob({ type: 'sub', status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'bbb' } });

    it('is offered in Doing and Reviewing for a glob with an open or merged PR, and nowhere else', () => {
      expect(m.allowedActions(doing, dev)).toContain('review_now');
      expect(m.allowedActions(glob({ status: 'in_progress', pr: { number: 7, state: 'draft', headSha: 'bbb' } }), dev)).toContain('review_now');
      expect(m.allowedActions(merged, dev)).toContain('review_now');
      expect(m.allowedActions(glob({ status: 'planning' }), dev)).not.toContain('review_now');
      expect(m.allowedActions(glob({ status: 'in_progress', pr: null }), dev)).not.toContain('review_now');
      expect(m.allowedActions(glob({ status: 'signed_off', pr: { number: 7, state: 'merged', headSha: 'bbb' } }), dev)).not.toContain('review_now');
      expect(m.allowedActions(glob({ status: 'failed', pr: { number: 7, state: 'closed', headSha: 'bbb' } }), dev)).not.toContain('review_now');
    });

    it('queues one review job with a request id and changes nothing on the glob', () => {
      const t = value(m.reviewNow(doing, ctx()));
      expect(t.changed).toBe(false);
      expect(t.effects).toHaveLength(1);
      expect(t.effects[0]).toMatchObject({ kind: 'review_change', stage: 'pre_merge', sha: 'bbb', generation: 1 });
      expect(t.effects[0]?.kind === 'review_change' ? t.effects[0].requestId : undefined).toEqual(expect.any(String));
      expect(t.events.map((e) => e.type)).toEqual(['ReviewRequested']);
    });

    it('reviews a merged glob at the post-merge stage, with a request id each time it is asked', () => {
      const first = value(m.reviewNow(merged, ctx()));
      expect(first.effects[0]).toMatchObject({ kind: 'review_change', stage: 'post_merge' });
      const id = (t: Transition) => (t.effects[0]?.kind === 'review_change' ? t.effects[0].requestId : undefined);
      const calls = ['r1', 'r2'];
      const asked = () => value(m.reviewNow(merged, { ...ctx(), newRunId: () => calls.shift() ?? 'x' }));
      expect([id(asked()), id(asked())]).toEqual(['r1', 'r2']);
    });

    it('refuses a glob without a reviewable PR', () => {
      expect(errorCode(m.reviewNow(glob({ status: 'planning' }), ctx()))).toBe('invalid_transition');
      expect(errorCode(m.reviewNow(glob({ status: 'in_progress', pr: null }), ctx()))).toBe('invalid_transition');
      expect(errorCode(m.reviewNow(glob({ status: 'failed', pr: { number: 7, state: 'closed', headSha: 'bbb' } }), ctx()))).toBe('invalid_transition');
    });
  });

  it('red checks on a sub\'s merge commit revert it and fail the sub; sames and supers are left alone', () => {
    const failure = { name: 'Type check', step: null, lines: [], url: 'https://ci/1' };
    const merged = (type: 'sub' | 'same' | 'super') =>
      glob({ type, status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'bbb' } });
    const t = value(m.mergeTurnedBaseRed(merged('sub'), { sha: 'm1', failure, base: 'main' }, ctx(null)));
    expect(t.glob.status).toBe('failed');
    expect(t.glob.failure?.kind).toBe('reverted');
    expect(t.glob.failure?.reason).toContain('Reverted from main');
    expect(t.glob.failure?.reason).toContain('https://ci/1');
    expect(t.effects).toEqual([{ kind: 'revert_merge', globId: 's1t1', generation: 1, sha: 'm1' }]);
    expect(value(m.mergeTurnedBaseRed(merged('same'), { sha: 'm1', failure, base: 'main' }, ctx(null))).changed).toBe(false);
    expect(value(m.mergeTurnedBaseRed(merged('super'), { sha: 'm1', failure, base: 'main' }, ctx(null))).changed).toBe(false);
    const failed = t.glob;
    expect(value(m.revertFailed(failed, 'by hand', ctx(null))).glob.failure?.reason).toContain('by hand');
  });

  it('a check change queues a refresh without changing the glob', () => {
    const t = value(m.checksChanged(ready, ctx(null)));
    expect(t.changed).toBe(false);
    expect(effectKinds(t)).toEqual(['refresh_checks']);
    expect(effectKinds(value(m.checksChanged(glob(), ctx(null))))).toEqual([]);
  });

  it('while merging, passing checks on the updated head merge it and failing ones fail it', () => {
    const merging = { ...ready, status: 'merging' as const };
    const pass = value(m.checksCompleted(merging, { sha: 'bbb', passed: true }, ctx(null)));
    expect(pass.effects).toEqual([{ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: 'bbb' }]);
    const fail = value(m.checksCompleted(merging, { sha: 'bbb', passed: false }, ctx(null)));
    expect(fail.glob.status).toBe('failed');
  });

  it('a conflict after updating the branch returns the glob to pr_open with the conflict recorded, no failure', () => {
    const merging = { ...ready, status: 'merging' as const };
    const conflict = { base: 'main', files: ['a.ts', 'b.ts'] };
    const t = value(m.checksCompleted(merging, { sha: 'bbb', passed: false, conflict }, ctx(null)));
    expect(t.glob.status).toBe('pr_open');
    expect(t.glob.failure).toBeNull();
    expect(t.glob.mergeMode).toBeNull();
    expect(t.glob.conflict).toMatchObject(conflict);
    expect(t.events.map((e) => e.type)).toContain('MergeFailed');
    const noFiles = value(m.checksCompleted(merging, { sha: 'bbb', passed: false, conflict: { base: 'main', files: [] } }, ctx(null)));
    expect(noFiles.glob.status).toBe('pr_open');
    expect(noFiles.glob.conflict?.files).toEqual([]);
    const checks = value(m.checksCompleted(merging, { sha: 'bbb', passed: false }, ctx(null))).glob;
    expect(checks.status).toBe('failed');
    expect(checks.failure?.reason).toBe('Checks failed after updating the branch');
    expect(checks.failure?.conflict).toBeUndefined();
  });

  it('resolve conflict: a failed merge conflict returns to review and queues a conflict-fixing routine run', () => {
    const conflict = { base: 'main', files: ['a.ts'] };
    const pr = { number: 7, state: 'ready' as const, headSha: 'abc1234' };
    const failed = glob({ type: 'sub', status: 'failed', pr, failure: { reason: 'Merge conflict with main', at: NOW, conflict } });
    expect(m.allowedActions(failed, dev)).toContain('resolve_conflict');
    expect(m.allowedActions(glob({ type: 'sub', status: 'failed', failure: { reason: 'x', at: NOW } }), dev)).not.toContain('resolve_conflict');
    const owned = { ...failed, implementer: other.email };
    expect(m.allowedActions(owned, dev)).not.toContain('resolve_conflict');
    expect(m.allowedActions(owned, dev)).toContain('start_again');
    expect(errorCode(m.resolveConflict(owned, ctx()))).toBe('invalid_transition');

    const t = value(m.resolveConflict(failed, ctx()));
    expect(t.glob.status).toBe('pr_open');
    expect(t.glob.failure).toBeNull();
    expect(t.glob.runs).toHaveLength(1);
    expect(t.glob.runs[0]).toMatchObject({ state: 'queued', purpose: 'resolve_conflict' });
    expect(t.glob.conflict).toMatchObject({ base: 'main', files: ['a.ts'], since: null });
    expect(effectKinds(t)).toEqual(['refresh_checks', 'fire_routine']);
    expect(t.effects.at(-1)).toMatchObject({ kind: 'fire_routine', purpose: 'resolve_conflict' });
  });

  it('resolve conflict: a flagged conflict queues a run, is refused while it works, and is offered again after it fails', () => {
    const pr = { number: 7, state: 'ready' as const, headSha: 'abc1234' };
    const flagged = glob({ status: 'pr_open', pr, conflict: { base: 'main', files: [], since: 's1t2', at: NOW } });
    expect(m.allowedActions(flagged, dev)).toContain('resolve_conflict');
    const t = value(m.resolveConflict(flagged, ctx()));
    expect(t.glob.status).toBe('pr_open');
    expect(effectKinds(t)).toEqual(['fire_routine']);
    expect(t.glob.runs.at(-1)).toMatchObject({ state: 'queued', purpose: 'resolve_conflict' });
    // Queued or working: refused, and the action is gone.
    expect(m.allowedActions(t.glob, dev)).not.toContain('resolve_conflict');
    expect(errorCode(m.resolveConflict(t.glob, ctx()))).toBe('run_active');
    const started = value(m.runProgress(t.glob, t.glob.runs.at(-1)?.id ?? '', ctx()));
    expect(started.glob.runs.at(-1)?.state).toBe('watching');
    // A run that gave up leaves the conflict flagged, with its reason, and the action comes back.
    const runId = started.glob.runs.at(-1)?.id ?? '';
    const gaveUp = value(m.reportFailure(started.glob, { reason: 'Real conflict in a.ts', runId }, ctx())).glob;
    expect(gaveUp.runs.at(-1)).toMatchObject({ state: 'ended', outcome: 'failed' });
    expect(gaveUp.failure?.reason).toBe('Real conflict in a.ts');
    expect(gaveUp.conflict).not.toBeNull();
    expect(m.allowedActions(gaveUp, dev)).toContain('resolve_conflict');
    expect(m.allowedActions(gaveUp, dev)).not.toContain('retry_autofix');
    const again = value(m.resolveConflict(gaveUp, ctx()));
    expect(again.glob.failure).toBeNull();
    expect(again.glob.runs).toHaveLength(2);
  });

  it('resolve conflict: a run on standby is ended and replaced; an unflagged or human-implemented glob is refused', () => {
    const pr = { number: 7, state: 'ready' as const, headSha: 'abc1234' };
    const conflict = { base: 'main', files: [], since: 's1t2', at: NOW };
    expect(errorCode(m.resolveConflict(glob({ status: 'pr_open', pr }), ctx()))).toBe('invalid_transition');
    const watching = glob({ status: 'pr_open', pr, conflict, runs: [run({ state: 'watching' })] });
    expect(m.allowedActions(watching, dev)).toContain('resolve_conflict');
    const t = value(m.resolveConflict(watching, ctx()));
    expect(t.glob.runs).toHaveLength(2);
    expect(t.glob.runs[0]).toMatchObject({ state: 'ended', outcome: 'superseded' });
    expect(t.glob.runs[1]).toMatchObject({ state: 'queued', purpose: 'resolve_conflict' });
    expect(errorCode(m.resolveConflict(glob({ status: 'pr_open', pr, conflict, runs: [run({ state: 'active' })] }), ctx()))).toBe('run_active');
    expect(errorCode(m.resolveConflict(glob({ status: 'pr_open', pr, conflict, runs: [run({ state: 'queued' })] }), ctx()))).toBe('run_active');
    const human = glob({ status: 'pr_open', pr, conflict, implementer: 'a@b.c', runs: [run({ state: 'watching' })] });
    expect(m.allowedActions(human, dev)).not.toContain('resolve_conflict');
  });

  it('resolve conflict: a conflict fix that has started is not superseded by another request or a base merge', () => {
    const pr = { number: 7, state: 'ready' as const, headSha: 'abc1234' };
    const conflict = { base: 'main', files: [], since: 's1t2', at: NOW };
    const fixing = glob({
      status: 'pr_open',
      pr,
      conflict,
      runs: [run({ state: 'watching', purpose: 'resolve_conflict' })],
    });
    expect(m.allowedActions(fixing, dev)).not.toContain('resolve_conflict');
    expect(errorCode(m.resolveConflict(fixing, ctx()))).toBe('run_active');
    // A merge to main only re-checks the conflict; it never queues or ends a run.
    const merged = value(m.baseMerged(fixing, { since: 's1t9' }, ctx()));
    expect(merged.glob.runs).toHaveLength(1);
    expect(merged.glob.runs[0]).toMatchObject({ state: 'watching' });
    // Once the fix ends, a remaining conflict queues exactly one new fix.
    const ended = glob({
      status: 'pr_open',
      pr,
      conflict,
      runs: [run({ state: 'ended', outcome: 'completed', purpose: 'resolve_conflict' })],
    });
    expect(m.allowedActions(ended, dev)).toContain('resolve_conflict');
    expect(value(m.resolveConflict(ended, ctx())).glob.runs).toHaveLength(2);
    // A person's action still ends the fix.
    const taken = value(m.pickUp(fixing, ctx(dev), board, { takeOver: true }));
    expect(taken.glob.runs[0]).toMatchObject({ state: 'ended', outcome: 'superseded' });
  });
});

describe('how far a branch is behind the base', () => {
  const pr = { number: 7, state: 'draft' as const, headSha: 'abc1234' };
  const found = { base: 'main', behindBy: 3, files: ['a.ts'] };

  it('a push to the branch or the base queues a recheck for a glob in Doing with an open PR only', () => {
    const effect = [{ kind: 'check_behind', globId: 's1t1', generation: 1 }];
    expect(value(m.behindCheckRequested(glob({ status: 'in_progress', pr }), ctx(null))).effects).toEqual(effect);
    expect(value(m.behindCheckRequested(glob({ status: 'in_progress', pr: null }), ctx(null))).effects).toEqual([]);
    expect(value(m.behindCheckRequested(glob({ status: 'pr_open', pr }), ctx(null))).effects).toEqual([]);
    const pushed = value(m.commitPushed(glob({ status: 'in_progress', pr }), { sha: 'def5678', runId: null }, ctx(null)));
    expect(pushed.effects).toContainEqual(effect[0]);
  });

  it('records the distance when it changes and clears it when the branch is up to date', () => {
    const g = glob({ status: 'in_progress', pr });
    const recorded = value(m.behindChecked(g, found, ctx(null)));
    expect(recorded.glob.behind).toEqual({ ...found, at: NOW });
    expect(value(m.behindChecked(recorded.glob, found, ctx(null))).changed).toBe(false);
    expect(value(m.behindChecked(recorded.glob, { ...found, behindBy: 4 }, ctx(null))).glob.behind?.behindBy).toBe(4);
    expect(value(m.behindChecked(g, { ...found, behindBy: 0, files: [] }, ctx(null))).changed).toBe(false);
    const cleared = value(m.behindChecked(recorded.glob, { ...found, behindBy: 0, files: [] }, ctx(null)));
    expect(cleared.glob.behind).toBeNull();
    expect(value(m.behindChecked(glob({ status: 'in_progress', pr: null }), found, ctx(null))).changed).toBe(false);
  });
});

describe('conflicts flagged after a merge', () => {
  const pr = { number: 7, state: 'draft' as const, headSha: 'abc1234' };
  const found = { base: 'main', files: ['a.ts'], since: 's1t2' };

  it('a merge queues the recheck of other globs with an open PR only', () => {
    const merged = value(m.merged(glob({ status: 'pr_open' }), { sha: 'm1' }, ctx(null)));
    expect(effectKinds(merged)).toEqual(['flag_conflicts', 'release_waiting']);
    const open = value(m.baseMerged(glob({ status: 'in_progress', pr }), { since: 's1t2' }, ctx(null)));
    expect(open.effects).toEqual([{ kind: 'check_conflict', globId: 's1t1', generation: 1, since: 's1t2' }]);
    expect(value(m.baseMerged(glob({ status: 'in_progress', pr: null }), { since: 's1t2' }, ctx(null))).effects).toEqual([]);
    expect(value(m.baseMerged(glob({ status: 'planning', pr }), { since: 's1t2' }, ctx(null))).effects).toEqual([]);
    expect(value(m.baseMerged(glob({ status: 'in_progress', pr, id: 's1t2' }), { since: 's1t2' }, ctx(null))).effects).toEqual([]);
  });

  it('flags a conflict without failing the glob, keeps the first one, and clears it', () => {
    const g = glob({ status: 'in_progress', pr });
    const flagged = value(m.conflictFound(g, found, ctx(null)));
    expect(flagged.glob.status).toBe('in_progress');
    expect(flagged.glob.failure).toBeNull();
    expect(flagged.glob.conflict).toEqual({ ...found, at: NOW });
    expect(value(m.conflictFound(flagged.glob, { ...found, since: 's1t3' }, ctx(null))).changed).toBe(false);
    expect(value(m.conflictFound(glob({ status: 'in_progress', pr: null }), found, ctx(null))).changed).toBe(false);

    const cleared = value(m.conflictCleared(flagged.glob, ctx(null)));
    expect(cleared.glob.conflict).toBeNull();
    expect(cleared.events[0]?.data).toEqual({
      base: found.base,
      files: [...found.files],
      since: found.since,
      by: 'human',
      kind: 'unknown',
    });
    expect(value(m.conflictCleared(cleared.glob, ctx(null))).changed).toBe(false);
  });

  it('attributes a cleared conflict to the run only while its conflict-fix run is live or completed', () => {
    const by = (r: Partial<Parameters<typeof run>[0]>) => {
      const g = glob({ status: 'in_progress', pr, conflict: { ...found, at: NOW }, runs: [run({ purpose: 'resolve_conflict', ...r })] });
      return value(m.conflictCleared(g, ctx(null))).events[0]?.data;
    };
    expect(by({ state: 'watching' })).toMatchObject({ by: 'run' });
    expect(by({ state: 'ended', outcome: 'completed' })).toMatchObject({ by: 'run' });
    expect(by({ state: 'ended', outcome: 'superseded' })).toMatchObject({ by: 'human' });
  });

  it('a push rechecks a flagged conflict; merging clears it', () => {
    const flagged = glob({ status: 'in_progress', pr, conflict: { ...found, at: NOW } });
    const pushed = value(m.commitPushed(flagged, { sha: 'def5678', runId: null }, ctx(null)));
    expect(pushed.effects).toContainEqual({ kind: 'check_conflict', globId: 's1t1', generation: 1, since: null });
    const merged = value(m.merged({ ...flagged, status: 'pr_open' }, { sha: 'm1' }, ctx(null)));
    expect(merged.glob.conflict).toBeNull();
  });
});

describe('a ready PR picked up into Doing returns to review', () => {
  const ready = { number: 7, state: 'ready' as const, headSha: 'def5678' };
  const found = { base: 'main', files: ['a.ts'], since: null };

  it('goes back to pr_open when the conflict clears', () => {
    const g = glob({ status: 'in_progress', type: 'same', pr: ready, conflict: { ...found, at: NOW } });
    const t = value(m.conflictCleared(g, ctx(null)));
    expect(t.glob.status).toBe('pr_open');
    expect(t.glob.conflict).toBeNull();
    expect(effectKinds(t)).toEqual(['refresh_checks', 'review_change']);
  });

  it('goes back to pr_open on a push with no conflict flagged, but a sub is not reviewed', () => {
    const same = value(m.commitPushed(glob({ status: 'in_progress', type: 'same', pr: ready }), { sha: 'aaa1111', runId: null }, ctx(null)));
    expect(same.glob.status).toBe('pr_open');
    const sub = value(m.commitPushed(glob({ status: 'in_progress', type: 'sub', pr: ready }), { sha: 'aaa1111', runId: null }, ctx(null)));
    expect(sub.glob.status).toBe('pr_open');
    expect(effectKinds(sub)).not.toContain('review_change');
  });

  it('stays in Doing for a super, a draft PR, or a flagged conflict', () => {
    const push = { sha: 'aaa1111', runId: null };
    expect(value(m.commitPushed(glob({ status: 'in_progress', type: 'super', pr: ready }), push, ctx(null))).glob.status).toBe('in_progress');
    expect(value(m.commitPushed(glob({ status: 'in_progress', type: 'same', pr: { ...ready, state: 'draft' } }), push, ctx(null))).glob.status).toBe('in_progress');
    const flagged = glob({ status: 'in_progress', type: 'same', pr: ready, conflict: { ...found, at: NOW } });
    expect(value(m.commitPushed(flagged, push, ctx(null))).glob.status).toBe('in_progress');
  });
});

describe('fields and labels', () => {
  it('type and environment changes sync the PR labels', () => {
    const t = value(m.changeFields(glob({ status: 'in_progress' }), { environment: 'dev' }, board, ctx()));
    expect(effectKinds(t)).toEqual(['sync_pr_labels']);
    expect(effectKinds(value(m.changeFields(glob(), { group: 'x' }, board, ctx())))).toEqual([]);
  });
});

describe('aging', () => {
  it('records when a glob enters Doing and clears it when it leaves', () => {
    const started = value(m.start(glob(), ctx())).glob;
    expect(started.doingSince).toBe('2026-10-05T12:00:00.000Z');
    const merged = value(m.merged({ ...started, status: 'pr_open' }, { sha: 'm' }, ctx(null))).glob;
    expect(merged.doingSince).toBeNull();
    const sub = value(m.create(createInput({ type: 'sub' }), board, ctx())).glob;
    expect(sub.doingSince).not.toBeNull();
  });
});

describe('merge failure recovery (row 16a)', () => {
  const failedMerge = (over: Record<string, unknown> = {}) =>
    glob({
      type: 'same',
      status: 'failed',
      implementer: dev.email,
      pr: { number: 7, state: 'ready', headSha: 'aaa' },
      failure: { reason: 'Merge conflict with main', at: NOW, kind: 'merge', conflict: { base: 'main', files: ['a.ts'] } },
      ...over,
    });
  it('puts a failed same or super back in pr_open on a push, keeping the implementer and queuing no run', () => {
    for (const type of ['same', 'super'] as const) {
      const t = value(m.commitPushed(failedMerge({ type }), { sha: 'bbb', runId: null }, ctx(null)));
      expect(t.glob.status).toBe('pr_open');
      expect(t.glob.failure).toBeNull();
      expect(t.glob.implementer).toBe(dev.email);
      expect(t.glob.pr?.headSha).toBe('bbb');
      expect(t.glob.runs).toEqual([]);
      expect(effectKinds(t)).toEqual(['refresh_checks', 'review_change']);
    }
  });
  it('leaves a failed sub, a non-merge failure and a draft PR alone', () => {
    expect(value(m.commitPushed(failedMerge({ type: 'sub' }), { sha: 'bbb', runId: null }, ctx(null))).glob.status).toBe('failed');
    expect(value(m.commitPushed(failedMerge({ failure: { reason: 'x', at: NOW } }), { sha: 'bbb', runId: null }, ctx(null))).glob.status).toBe('failed');
    expect(value(m.commitPushed(failedMerge({ pr: { number: 7, state: 'draft', headSha: 'aaa' } }), { sha: 'bbb', runId: null }, ctx(null))).glob.status).toBe('failed');
  });
  it('hides Retrigger for a merge failure with a human implementer', () => {
    expect(m.allowedActions(failedMerge(), dev)).not.toContain('retrigger');
    expect(m.allowedActions(failedMerge({ implementer: null }), dev)).toContain('retrigger');
  });
});

describe('mark ready', () => {
  it('moves an in-progress glob whose PR is already ready straight to pr_open', () => {
    const g = glob({ status: 'in_progress', pr: { number: 7, state: 'ready', headSha: 'aaa' } });
    const t = value(m.readyRequested(g, null, ctx()));
    expect(t.glob.status).toBe('pr_open');
    expect(effectKinds(t)).not.toContain('mark_pr_ready');
  });
  it('queues marking the draft PR ready for the current run only', () => {
    const g = glob({ status: 'implementing', runs: [run()] });
    expect(effectKinds(value(m.readyRequested(g, 'run-0', ctx(null))))).toEqual(['mark_pr_ready']);
    expect(errorCode(m.readyRequested(g, 'old', ctx(null)))).toBe('invalid_transition');
    expect(errorCode(m.readyRequested(glob({ status: 'planning' }), null, ctx()))).toBe('invalid_transition');
    expect(effectKinds(value(m.readyRequested(glob({ status: 'in_progress' }), null, ctx())))).toEqual(['mark_pr_ready']);
  });
});

describe('run sessions and timeouts', () => {
  it('records the cloud session of the current run only', () => {
    const g = glob({ status: 'implementing', runs: [run({ state: 'queued', startedAt: null })] });
    const t = value(m.runFired(g, { runId: 'run-0', sessionId: 'sess', sessionUrl: 'https://claude.ai/code/sess' }, ctx(null)));
    expect(m.currentRun(t.glob)).toMatchObject({ sessionId: 'sess', sessionUrl: 'https://claude.ai/code/sess' });
    expect(value(m.runFired(g, { runId: 'old', sessionId: 'x', sessionUrl: null }, ctx(null))).changed).toBe(false);
  });

  it('times out a run with no progress, or one that never marks its PR ready', () => {
    const limits = { runNoProgressHours: 2, runReadyHours: 8, runStartMinutes: 30, runRespondMinutes: 30 };
    const at = (hours: number) => new Date(Date.parse('2026-10-05T00:00:00.000Z') + hours * 3_600_000).toISOString();
    const active = (lastProgress: number) =>
      glob({ status: 'implementing', runs: [run({ state: 'active', startedAt: at(0), lastProgressAt: at(lastProgress) })] });
    expect(m.runTimeoutReason(active(0), limits, at(1))).toBeNull();
    expect(m.runTimeoutReason(active(0), limits, at(3))).toMatch(/No progress/);
    expect(m.runTimeoutReason(active(8.5), limits, at(9))).toMatch(/not marked ready/);
    const watching = glob({ status: 'pr_open', runs: [run({ state: 'watching', startedAt: at(0), lastProgressAt: at(8.5) })] });
    expect(m.runTimeoutReason(watching, limits, at(9))).toBeNull();
  });

  describe('a watching run', () => {
    const limits = { runNoProgressHours: 2, runReadyHours: 8, runStartMinutes: 30, runRespondMinutes: 30 };
    const t0 = Date.parse('2026-10-05T00:00:00.000Z');
    const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
    const watching = (headChecks: Glob['headChecks'], lastProgress = 0) =>
      glob({
        status: 'pr_open',
        pr: { number: 7, state: 'ready', headSha: '47f4a3d9c0' },
        headChecks,
        runs: [run({ state: 'watching', startedAt: at(0), lastProgressAt: at(lastProgress) })],
      });
    const failed = (at0: number, extra: object = {}) => ({
      sha: '47f4a3d9c0',
      state: 'failed' as const,
      at: at(at0),
      failure: { name: 'Type check', step: null, lines: [], url: null },
      ...extra,
    });

    it('is never failed for being idle while the checks pass or are pending', () => {
      expect(m.runTimeoutReason(watching({ sha: '47f4a3d9c0', state: 'passed' }), limits, at(24 * 60))).toBeNull();
      expect(m.runTimeoutReason(watching(null), limits, at(24 * 60))).toBeNull();
    });

    it('is failed once it has not responded to failed checks within the window, naming what it ignored', () => {
      const g = watching(failed(10));
      expect(m.runTimeoutReason(g, limits, at(39))).toBeNull();
      expect(m.runTimeoutReason(g, limits, at(40))).toBe("Auto-fix didn't respond to failed checks (Type check) on 47f4a3d");
      expect(m.runTimeoutReason(g, { ...limits, runRespondMinutes: 60 }, at(60))).toBeNull();
    });

    it('counts from its last slop call or push when that is later than the failure', () => {
      expect(m.runTimeoutReason(watching(failed(10), 30), limits, at(59))).toBeNull();
      expect(m.runTimeoutReason(watching(failed(10), 30), limits, at(60))).toMatch(/didn't respond/);
    });

    it('ignores failures inherited from the base and failures of an older head', () => {
      const inherited = failed(10, { inheritedFrom: { base: 'main', since: 's1t1' } });
      expect(m.runTimeoutReason(watching(inherited), limits, at(600))).toBeNull();
      expect(m.runTimeoutReason(watching(failed(10, { sha: 'old' })), limits, at(600))).toBeNull();
    });
  });

  it('fails a queued run that never started after the board\'s time, and leaves younger ones', () => {
    const limits = { runNoProgressHours: 2, runReadyHours: 8, runStartMinutes: 30, runRespondMinutes: 30 };
    const queuedAt = '2026-10-07T02:01:55.115Z';
    const after = (minutes: number) => new Date(Date.parse(queuedAt) + minutes * 60_000).toISOString();
    const queued = glob({ status: 'implementing', runs: [run({ state: 'queued', queuedAt, startedAt: null })] });
    expect(m.runTimeoutReason(queued, limits, after(29))).toBeNull();
    expect(m.runTimeoutReason(queued, limits, after(30))).toBe('Routine run never started (queued at 2026-10-07 02:01 UTC)');
    expect(m.runTimeoutReason(queued, { ...limits, runStartMinutes: 60 }, after(45))).toBeNull();
    // Starting (a slop call) makes it active, which the existing timeouts cover; the hours are unchanged.
    const started = value(m.runProgress(queued, 'run-0', { ...ctx(null), now: after(5) }));
    expect(m.runTimeoutReason(started.glob, limits, after(60))).toBeNull();
    expect(m.runTimeoutReason(started.glob, limits, after(5 + 121))).toMatch(/No progress for 2 hours/);
  });
});

describe('a session that never reaches slop', () => {
  const limits = { runNoProgressHours: 2, runReadyHours: 8, runStartMinutes: 30, runRespondMinutes: 30 };
  const queuedAt = '2026-10-07T02:01:55.115Z';
  const after = (minutes: number) => new Date(Date.parse(queuedAt) + minutes * 60_000).toISOString();
  const queued = (sessionId: string | null) => glob({ status: 'implementing', runs: [run({ state: 'queued', queuedAt, startedAt: null, sessionId })] });

  it('fails at 5 minutes once the session was created, and not before', () => {
    expect(m.runTimeoutReason(queued('cse_1'), limits, after(4))).toBeNull();
    expect(m.runTimeoutReason(queued('cse_1'), limits, after(5))).toMatch(/^The run's session never reached slop/);
  });

  it('does not fail a session that called slop at 4 minutes', () => {
    const started = value(m.runProgress(queued('cse_1'), 'run-0', { ...ctx(null), now: after(4) }));
    expect(m.runTimeoutReason(started.glob, limits, after(6))).toBeNull();
  });

  it('keeps the board\'s start time for a run with no session', () => {
    expect(m.runTimeoutReason(queued(null), limits, after(29))).toBeNull();
    expect(m.runTimeoutReason(queued(null), limits, after(30))).toMatch(/^Routine run never started/);
  });
});

describe('Retry auto-fix', () => {
  const ended = run({ state: 'ended', outcome: 'failed', endedAt: NOW, failureReason: "Auto-fix didn't respond to failed checks (Type check) on 47f4a3d" });
  const stuck = () =>
    glob({
      status: 'pr_open',
      type: 'sub',
      pr: { number: 7, state: 'ready', headSha: '47f4a3d9c0' },
      failure: { reason: ended.failureReason ?? '', at: NOW },
      runs: [ended],
    });

  it('is offered next to Pick up, and queues a new run keeping the PR, branch and generation', () => {
    expect(m.allowedActions(stuck(), dev)).toEqual(expect.arrayContaining(['pick_up', 'retry_autofix']));
    const t = value(m.retryAutofix(stuck(), ctx(dev)));
    expect(t.glob).toMatchObject({ status: 'pr_open', failure: null, generation: stuck().generation, pr: stuck().pr });
    expect(t.glob.runs).toHaveLength(2);
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'queued' });
    expect(t.effects.map((e) => e.kind)).toEqual(['fire_routine']);
  });

  it('starts the retried run watching, since there is no PR to mark ready', () => {
    const queued = value(m.retryAutofix(stuck(), ctx(dev))).glob;
    expect(m.currentRun(value(m.runProgress(queued, m.currentRun(queued)?.id ?? '', ctx(null))).glob)?.state).toBe('watching');
  });

  it('is refused while a run is live, for merge failures and without an ended failed run', () => {
    const live = { ...stuck(), runs: [ended, run({ id: 'run-1', state: 'watching' })] };
    expect(m.allowedActions(live, dev)).not.toContain('retry_autofix');
    expect(m.retryAutofix(live, ctx(dev)).ok).toBe(false);
    const merge = { ...stuck(), failure: { reason: 'x', at: NOW, kind: 'merge' as const } };
    expect(m.allowedActions(merge, dev)).not.toContain('retry_autofix');
    expect(m.retryAutofix({ ...stuck(), runs: [] }, ctx(dev)).ok).toBe(false);
  });
});

describe('a watcher that gave up is retried once', () => {
  const GAVE_UP = "Auto-fix didn't respond to failed checks (Type check) on 47f4a3d";
  const headChecks = {
    sha: '47f4a3d9c0',
    state: 'failed' as const,
    at: NOW,
    failure: { name: 'Type check', step: 'Run tsc', lines: ['src/a.ts(1,1): error TS2322', 'second line'], url: null },
  };
  const watching = (extra: Partial<ReturnType<typeof glob>> = {}) =>
    glob({
      status: 'pr_open',
      type: 'sub',
      pr: { number: 7, state: 'ready', headSha: '47f4a3d9c0' },
      headChecks,
      runs: [run({ id: 'run-0', state: 'watching' })],
      ...extra,
    });

  it('queues one new run on the same PR and generation, carrying the failure summary, and shows no failure', () => {
    const g = watching();
    const t = value(m.reportFailure(g, { reason: GAVE_UP, runId: 'run-0' }, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'pr_open', failure: null, generation: g.generation, pr: g.pr });
    expect(t.glob.runs).toHaveLength(2);
    expect(t.glob.runs[0]).toMatchObject({ state: 'ended', outcome: 'failed', failureReason: GAVE_UP });
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'queued', autoRetry: true });
    const fire = t.effects.find((e) => e.kind === 'fire_routine');
    expect(fire).toMatchObject({ failureSummary: 'Type check (Run tsc)\nsrc/a.ts(1,1): error TS2322\nsecond line' });
    expect(t.events.map((e) => e.type)).toEqual(expect.arrayContaining(['RunFailed', 'RunTriggered']));
    expect(t.events.find((e) => e.type === 'RunTriggered')?.data).toMatchObject({ automatic: true });
    // The retried run watches from the start, since the PR is ready.
    expect(m.currentRun(value(m.runProgress(t.glob, m.currentRun(t.glob)?.id ?? '', ctx(null))).glob)?.state).toBe('watching');
  });

  it('leaves the failure and the Retry auto-fix button for a person when the retried run gives up too', () => {
    const first = value(m.reportFailure(watching(), { reason: GAVE_UP, runId: 'run-0' }, ctx(null))).glob;
    const retryId = m.currentRun(first)?.id ?? '';
    const watchingAgain = value(m.runProgress(first, retryId, ctx(null))).glob;
    const second = value(m.reportFailure(watchingAgain, { reason: GAVE_UP, runId: retryId }, ctx(null)));
    expect(second.glob.runs).toHaveLength(2);
    expect(second.glob.failure).toMatchObject({ reason: GAVE_UP });
    expect(second.effects).toEqual([]);
    expect(m.allowedActions(second.glob, dev)).toContain('retry_autofix');
  });

  it('retries only a give-up for ignoring failed checks, not a run that reported another failure, and not a super or a person\'s PR', () => {
    expect(value(m.reportFailure(watching(), { reason: 'Cannot fix it', runId: 'run-0' }, ctx(null))).glob.runs).toHaveLength(1);
    expect(value(m.reportFailure(watching({ type: 'super' }), { reason: GAVE_UP, runId: 'run-0' }, ctx(null))).glob.runs).toHaveLength(1);
    expect(value(m.reportFailure(watching({ implementer: 'dev@example.com' }), { reason: GAVE_UP, runId: 'run-0' }, ctx(null))).glob.runs).toHaveLength(1);
  });

  it('goes without a summary when the failing log was not read', () => {
    const t = value(m.reportFailure(watching({ headChecks: { sha: '47f4a3d9c0', state: 'failed' } }), { reason: GAVE_UP, runId: 'run-0' }, ctx(null)));
    expect(t.effects.find((e) => e.kind === 'fire_routine')).not.toHaveProperty('failureSummary');
  });
});

describe('runs', () => {
  it('a slop call marks a queued run active; superseded runs are ignored', () => {
    const g = glob({ status: 'implementing', runs: [run({ state: 'queued', startedAt: null })] });
    const t = value(m.runProgress(g, 'run-0', ctx(null)));
    expect(m.currentRun(t.glob)?.state).toBe('active');
    expect(value(m.runProgress(g, 'other', ctx(null))).changed).toBe(false);
  });

  it('flags pushes from superseded runs', () => {
    const g = glob({ status: 'in_progress', runs: [run({ state: 'ended', outcome: 'superseded' })] });
    const t = value(m.commitPushed(g, { sha: 'ccc', runId: 'run-0' }, ctx(null)));
    expect(t.events[0]?.data).toMatchObject({ fromSupersededRun: true });
    expect(t.glob.pr?.headSha).toBe('ccc');
  });
});

describe('supers: Merge and continue (row 31) and Ready for review on the board', () => {
  const HEAD = 'bbbbbbb1234567890';
  const atHead = { recordSha: HEAD.slice(0, 7) };
  const superReady = glob({
    type: 'super',
    status: 'pr_open',
    implementer: dev.email,
    pr: { number: 7, state: 'ready', headSha: HEAD },
    headChecks: { sha: HEAD, state: 'passed' },
  });

  it('titles a piece landed with Merge and continue by its part number', () => {
    expect(m.squashTitle(superReady)).toBe(`${superReady.id}: ${superReady.title}`);
    const continuing = { ...superReady, mergeMode: 'continue' as const };
    expect(m.squashTitle(continuing)).toBe(`${superReady.id}: ${superReady.title} (part 1)`);
    const second = { ...continuing, prs: [{ number: 6, mergeSha: 'm1', mergedAt: NOW }] };
    expect(m.squashTitle(second)).toBe(`${superReady.id}: ${superReady.title} (part 2)`);
  });

  it('offers merge_continue only to supers with the latest implementation record at the head', () => {
    expect(m.allowedActions(superReady, dev, atHead)).toEqual(expect.arrayContaining(['merge', 'merge_continue']));
    expect(m.allowedActions(superReady, dev, { recordSha: HEAD })).toContain('merge_continue');
    expect(m.allowedActions(superReady, dev, { recordSha: 'ccccccc' })).not.toContain('merge_continue');
    expect(m.allowedActions(superReady, dev, { recordSha: null })).not.toContain('merge_continue');
    expect(m.allowedActions(superReady, dev)).not.toContain('merge_continue');
    // Too short to identify a commit.
    expect(m.allowedActions(superReady, dev, { recordSha: 'bbb' })).not.toContain('merge_continue');
    const same = { ...superReady, type: 'same' as const };
    expect(m.allowedActions(same, dev, atHead)).toContain('merge');
    expect(m.allowedActions(same, dev, atHead)).not.toContain('merge_continue');
    // The same conditions as merge: checks passed on the current head.
    const pending = { ...superReady, headChecks: null };
    expect(m.allowedActions(pending, dev, atHead)).not.toContain('merge_continue');
  });

  it('merge_continue goes to merging in continue mode; it needs a super and the implementation record at the head', () => {
    const t = value(m.requestMerge(superReady, ctx(), { continue: true, facts: atHead }));
    expect(t.glob.status).toBe('merging');
    expect(t.glob.mergeMode).toBe('continue');
    expect(t.effects).toEqual([{ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: HEAD }]);
    expect(errorCode(m.requestMerge(superReady, ctx(), { continue: true, facts: { recordSha: 'ccccccc' } }))).toBe(
      'invalid_transition',
    );
    const same = { ...superReady, type: 'same' as const };
    expect(errorCode(m.requestMerge(same, ctx(), { continue: true, facts: atHead }))).toBe('invalid_transition');
  });

  it('the observed continue merge returns to in_progress with the PR in its history and no labels', () => {
    const merging = value(m.requestMerge(superReady, ctx(), { continue: true, facts: atHead })).glob;
    const t = value(m.merged(merging, { sha: 'm1', number: 7 }, ctx(null)));
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.labels).toEqual({});
    expect(t.glob.prs).toEqual([{ number: 7, mergeSha: 'm1', mergedAt: NOW }]);
    expect(t.glob.pr).toBeNull();
    expect(t.glob.headChecks).toBeNull();
    expect(t.glob.mergeMode).toBeNull();
    expect(t.glob.implementer).toBe(dev.email);
    expect(t.glob.doingSince).toBe(merging.doingSince);
    expect(t.events.map((e) => e.type)).toEqual(['Merged', 'StatusChanged']);

    // The second observation (merged webhook after slop's own response, or the reverse) is a no-op.
    const again = value(m.merged(t.glob, { sha: 'm1', number: 7 }, ctx(null)));
    expect(again.changed).toBe(false);
    expect(again.glob.status).toBe('in_progress');
  });

  it('the next push opens a fresh draft PR, which is then recorded once', () => {
    const merging = value(m.requestMerge(superReady, ctx(), { continue: true, facts: atHead })).glob;
    const continued = value(m.merged(merging, { sha: 'm1', number: 7 }, ctx(null))).glob;
    const pushed = value(m.commitPushed(continued, { sha: 'ddd', runId: null }, ctx(null)));
    expect(pushed.effects).toEqual([{ kind: 'open_pr', globId: 's1t1', generation: 1 }]);
    const opened = value(m.prOpened(pushed.glob, { number: 8, headSha: 'ddd' }, ctx(null)));
    expect(opened.glob.pr).toEqual({ number: 8, state: 'draft', headSha: 'ddd' });
    expect(value(m.prOpened(opened.glob, { number: 8, headSha: 'ddd' }, ctx(null))).changed).toBe(false);
    // Once it has a PR, pushes don't open another.
    // (Only the check of how far the branch is behind the base.)
    expect(effectKinds(value(m.commitPushed(opened.glob, { sha: 'eee', runId: null }, ctx(null))))).toEqual(['check_behind', 'check_exclusive_paths']);
    // Neither do pushes while provisioning is still under way.
    const provisioning = glob({ type: 'super', status: 'in_progress', pr: null, provisioning: 'pending' });
    expect(effectKinds(value(m.commitPushed(provisioning, { sha: 'fff', runId: null }, ctx(null))))).toEqual([]);
  });

  it('the final Merge still moves a super to reviewing with FR, CR and QA', () => {
    const continued = { ...superReady, prs: [{ number: 5, mergeSha: 'm0', mergedAt: NOW }] };
    const merging = value(m.requestMerge(continued, ctx())).glob;
    expect(merging.mergeMode).toBeNull();
    const t = value(m.merged(merging, { sha: 'm2', number: 7 }, ctx(null)));
    expect(t.glob.status).toBe('reviewing');
    expect(t.glob.labels).toEqual({ FR: 'required', CR: 'required', QA: 'required' });
    expect(t.glob.prs).toHaveLength(1);
    expect(t.glob.pr?.state).toBe('merged');
  });

  it('failed head checks are recorded on a pr_open glob, so a failing check never shows as passed', () => {
    const open = glob({ status: 'pr_open', pr: { number: 1, headSha: HEAD, state: 'open' } as never });
    const failed = value(m.checksCompleted(open, { sha: HEAD, passed: false }, ctx(null))).glob;
    expect(failed.headChecks).toEqual({ sha: HEAD, state: 'failed', at: NOW });
    const later = value(m.checksCompleted(failed, { sha: HEAD, passed: false }, { ...ctx(null), now: '2026-10-05T12:30:00.000Z' })).glob;
    expect(later.headChecks?.at).toBe(NOW);
  });

  it('a failed continue merge clears the merge mode', () => {
    const merging = value(m.requestMerge(superReady, ctx(), { continue: true, facts: atHead })).glob;
    const failed = value(m.mergeFailed(merging, 'conflict', ctx(null))).glob;
    expect(failed.status).toBe('failed');
    expect(failed.mergeMode).toBeNull();
    const checksFailed = value(m.checksCompleted(merging, { sha: HEAD, passed: false }, ctx(null))).glob;
    expect(checksFailed.mergeMode).toBeNull();
  });

  it('mark_ready from the board: supers with a draft PR and the implementation record at the head', () => {
    const drafting = glob({
      type: 'super',
      status: 'in_progress',
      implementer: dev.email,
      pr: { number: 7, state: 'draft', headSha: HEAD },
    });
    expect(m.allowedActions(drafting, dev, atHead)).toContain('mark_ready');
    expect(m.allowedActions(drafting, dev, { recordSha: 'ccccccc' })).not.toContain('mark_ready');
    expect(m.allowedActions(drafting, dev)).not.toContain('mark_ready');
    expect(m.allowedActions({ ...drafting, type: 'same' }, dev, atHead)).not.toContain('mark_ready');

    const board = { from: 'board' as const, facts: atHead };
    expect(effectKinds(value(m.readyRequested(drafting, null, ctx(), board)))).toEqual(['mark_pr_ready']);
    const behind = m.readyRequested(drafting, null, ctx(), { from: 'board', facts: { recordSha: 'ccccccc' } });
    expect(!behind.ok && behind.error.message).toBe(m.RECORD_NOT_AT_HEAD);
    expect(errorCode(m.readyRequested({ ...drafting, type: 'same' }, null, ctx(), board))).toBe('invalid_transition');
    // QA and PO can't mark a super ready from the board, and aren't offered it.
    for (const actor of [po, { email: 'qa@example.com', role: 'qa' } as const]) {
      expect(errorCode(m.readyRequested(drafting, null, ctx(actor), board))).toBe('forbidden');
      expect(m.allowedActions(drafting, actor, atHead)).not.toContain('mark_ready');
    }
    // The MCP tool (sstor --ready) is unchanged: it needs no record.
    expect(effectKinds(value(m.readyRequested(drafting, null, ctx())))).toEqual(['mark_pr_ready']);
  });

  it('start again clears the merge mode and keeps the PR history', () => {
    const merging = value(m.requestMerge(superReady, ctx(), { continue: true, facts: atHead })).glob;
    const withHistory = { ...merging, prs: [{ number: 5, mergeSha: 'm0', mergedAt: NOW }] };
    const t = value(m.startAgain(withHistory, ctx()));
    expect(t.glob.mergeMode).toBeNull();
    expect(t.glob.prs).toHaveLength(1);
  });
});

describe('provisioning failure', () => {
  const queued = () => glob({ status: 'implementing', provisioning: 'pending', pr: null, runs: [run({ state: 'queued' })] });
  const reason = "Couldn't create branch s1t1 on acme/app: the slop GitHub App can't see that repo. Install it on the repo, or add the repo to its access, then Discard & restart.";

  it('a retryable failure only records the attempt', () => {
    const t = value(m.provisioningFailed(queued(), 'boom', ctx()));
    expect(t.glob.provisioning).toBe('failed');
    expect(t.glob.failure).toBeNull();
    expect(m.currentRun(t.glob)?.state).toBe('queued');
  });

  it('one that will not be retried puts the reason on the glob and ends the queued run with it', () => {
    const t = value(m.provisioningFailed(queued(), reason, ctx(), true));
    expect(t.glob.status).toBe('failed');
    expect(t.glob.failure).toMatchObject({ reason, kind: 'provisioning' });
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'ended', outcome: 'failed', failureReason: reason });
  });

  it('maps a 404 and a 403 to what a person can act on, and leaves throttling alone', () => {
    expect(provisioningFailureReason('s1t1', 'acme/app', 404, 'Not Found')).toBe(reason);
    expect(provisioningFailureReason('s1t1', 'acme/app', 403, 'Resource not accessible')).toContain('lacks permission (contents: write)');
    expect(provisioningFailureReason('s1t1', 'acme/app', 500, 'oops')).toBe("Couldn't create branch s1t1 on acme/app: oops");
    expect(isRepoAccessFailure(404)).toBe(true);
    expect(isRepoAccessFailure(403, 'Resource not accessible by integration')).toBe(true);
    expect(isRepoAccessFailure(403, 'You have exceeded a secondary rate limit')).toBe(false);
    expect(isRepoAccessFailure(500)).toBe(false);
  });

  it('a later successful provision clears the failure', () => {
    const failed = value(m.provisioningFailed(queued(), reason, ctx(), true)).glob;
    const t = value(m.provisioned(failed, { branch: 's1t1', pr: null }, ctx()));
    expect(t.glob.failure).toBeNull();
    expect(t.glob.provisioning).toBe('ok');
  });
});

describe('allowedTypeChanges', () => {
  const tos = (g: Glob, role: 'dev' | 'po' = 'dev') => m.allowedTypeChanges(g, role).map((o) => o.to);

  it('offers sub and super for a same task in planning', () => {
    expect(m.allowedTypeChanges(glob({ type: 'same', category: 'task' }), 'dev')).toEqual([{ to: 'sub' }, { to: 'super' }]);
  });

  it('offers a feature a sub, and not a bug a super', () => {
    expect(m.allowedTypeChanges(glob({ type: 'same', category: 'feature' }), 'dev')).toEqual([{ to: 'sub' }, { to: 'super' }]);
    expect(tos(glob({ type: 'same', category: 'bug' }))).toEqual(['sub']);
  });

  it('offers a sub only a same before it merges', () => {
    expect(tos(glob({ type: 'sub', category: 'task', status: 'implementing' }))).toEqual(['same']);
    expect(tos(glob({ type: 'sub', category: 'task', status: 'reviewing' }))).toEqual([]);
  });

  it('offers a same no sub once it has left planning, and no super from the PO', () => {
    expect(tos(glob({ type: 'same', category: 'task', status: 'in_progress' }))).toEqual(['super']);
    expect(tos(glob({ type: 'same', category: 'task' }), 'po')).toEqual(['sub']);
  });

  it('offers nothing a refused change would be', () => {
    expect(tos(glob({ type: 'same', category: 'task', status: 'merging' }))).toEqual([]);
  });
});

describe('escalation to a same', () => {
  const sub = (patch: Partial<Glob> = {}): Glob =>
    glob({ type: 'sub', status: 'implementing', runs: [run()], pr: { number: 7, state: 'draft', headSha: 'bbb' }, ...patch });

  it('a current run converts the sub to a same in place with the reason recorded', () => {
    const t = value(m.escalateToSame(sub(), { reason: 'Unplanned auth change', evidence: 'src/auth.ts', runId: 'run-0' }, ctx(null)));
    expect(t.glob.type).toBe('same');
    expect(t.glob.status).toBe('implementing');
    expect(t.glob.escalation).toMatchObject({ reason: 'Unplanned auth change', evidence: 'src/auth.ts', runId: 'run-0' });
    expect(t.events.map((e) => e.type)).toEqual(['FieldsChanged', 'Escalated']);
    expect(effectKinds(t)).toEqual(['sync_pr_labels']);
  });

  it('a sub in Planning can be escalated before it starts', () => {
    const t = value(m.escalateToSame(sub({ status: 'planning', runs: [], pr: null }), { reason: 'Open decision' }, ctx(null)));
    expect(t.glob.type).toBe('same');
    expect(t.glob.status).toBe('planning');
  });

  it('a call from a superseded run is ignored', () => {
    expect(value(m.escalateToSame(sub(), { reason: 'x', runId: 'other' }, ctx(null))).changed).toBe(false);
  });

  it('a same is left as it is, and a merged sub is refused', () => {
    expect(value(m.escalateToSame(glob({ type: 'same' }), { reason: 'x' }, ctx())).changed).toBe(false);
    expect(errorCode(m.escalateToSame(sub({ status: 'reviewing' }), { reason: 'x', runId: 'run-0' }, ctx(null)))).toBe('invalid_transition');
  });

  it('records the criterion it was made for, reading it from the reason when none is named', () => {
    const named = value(m.escalateToSame(sub(), { reason: 'x', criterion: 'risk_area', runId: 'run-0' }, ctx(null)));
    expect(named.glob.escalation?.criterion).toBe('risk_area');
    expect(named.events.find((e) => e.type === 'Escalated')?.data).toMatchObject({ criterion: 'risk_area' });
    const read = value(m.escalateToSame(sub(), { reason: 'Changes the agent instructions', runId: 'run-0' }, ctx(null)));
    expect(read.glob.escalation?.criterion).toBe('agent_instructions');
  });

  it('an escalation needs a reason', () => {
    expect(errorCode(m.escalateToSame(sub(), { reason: '  ', runId: 'run-0' }, ctx(null)))).toBe('invalid_input');
  });

  it('a person makes it a sub again, and the gate runs on a ready PR whose checks passed', () => {
    const escalated = value(m.escalateToSame(sub(), { reason: 'x', runId: 'run-0' }, ctx(null))).glob;
    expect(m.allowedActions(escalated, dev)).toContain('deescalate');
    const ready = { ...escalated, status: 'pr_open' as const, pr: { number: 7, state: 'ready' as const, headSha: 'bbb' }, headChecks: { sha: 'bbb', state: 'passed' as const } };
    const t = value(m.deescalate(ready, ctx()));
    expect(t.glob.type).toBe('sub');
    expect(t.glob.escalation).toBeNull();
    expect(effectKinds(t)).toEqual(['sync_pr_labels', 'evaluate_sub_gate']);
  });

  it('only an escalated same can be made a sub again', () => {
    expect(errorCode(m.deescalate(glob({ type: 'same' }), ctx()))).toBe('invalid_transition');
  });
});

describe('needs_pairing and Make it a super', () => {
  const pairing = (patch: Partial<Glob> = {}) =>
    value(
      m.reportFailure(
        glob({ type: 'sub', status: 'implementing', runs: [run()], implementer: null, ...patch }),
        { reason: 'The storage design is open', runId: 'run-0', kind: 'needs_pairing', decision: ' Which store holds it? ' },
        ctx(null),
      ),
    ).glob;

  it('report_failure with kind needs_pairing records the kind and the decision on the failure', () => {
    const failed = pairing();
    expect(failed.status).toBe('failed');
    expect(failed.failure).toMatchObject({ reason: 'The storage design is open', kind: 'needs_pairing', decision: 'Which store holds it?' });
  });

  it('a plain report has no kind, and a super never records one', () => {
    const plain = value(m.reportFailure(glob({ status: 'implementing', runs: [run()] }), { reason: 'stuck', runId: 'run-0' }, ctx(null))).glob;
    expect(plain.failure?.kind).toBeUndefined();
    const superFailed = value(m.reportFailure(glob({ type: 'super', status: 'in_progress' }), { reason: 'x', runId: null, kind: 'needs_pairing' }, ctx())).glob;
    expect(superFailed.failure?.kind).toBeUndefined();
  });

  it('a watcher that reports needs_pairing is never retried by slop, even with the give-up wording', () => {
    const g = glob({ type: 'sub', status: 'pr_open', implementer: null, runs: [run({ state: 'watching' })] });
    const t = value(m.reportFailure(g, { reason: "Auto-fix didn't respond to failed checks (build)", runId: 'run-0', kind: 'needs_pairing' }, ctx(null)));
    expect(t.glob.runs.filter((r) => r.autoRetry === true)).toHaveLength(0);
    expect(m.currentRun(t.glob)?.state).toBe('ended');
    expect(t.glob.failure?.kind).toBe('needs_pairing');
    expect(m.allowedActions(t.glob, dev)).not.toContain('retry_autofix');
  });

  it('is offered to a developer on a failed sub or same, not to QA or PO, not on other failures, supers or bugs', () => {
    expect(m.allowedActions(pairing(), dev)).toContain('make_super');
    expect(m.allowedActions(pairing({ type: 'same' }), dev)).toContain('make_super');
    expect(m.allowedActions(pairing(), po)).not.toContain('make_super');
    expect(m.allowedActions(pairing({ category: 'bug' }), dev)).not.toContain('make_super');
    const plain = glob({ type: 'same', status: 'failed', failure: { reason: 'stuck', at: NOW } });
    expect(m.allowedActions(plain, dev)).not.toContain('make_super');
    // Sames and subs can always be picked up.
    expect(m.allowedActions(pairing(), dev)).toContain('pick_up');
    expect(m.allowedActions(pairing({ type: 'same' }), dev)).toContain('pick_up');
  });

  it('makes it a super in progress with the person implementing; branch, PR and provisioning stay', () => {
    const failed = pairing({ type: 'same', pr: { number: 7, state: 'draft', headSha: 'aaa' }, provisioning: 'ok' });
    const t = value(m.makeSuper(failed, ctx(other)));
    expect(t.glob).toMatchObject({ type: 'super', status: 'in_progress', implementer: other.email, failure: null, provisioning: 'ok' });
    expect(t.glob.pr).toEqual(failed.pr);
    expect(t.events.map((e) => e.type)).toEqual(expect.arrayContaining(['FieldsChanged', 'PickedUp']));
    expect(t.events.find((e) => e.type === 'FieldsChanged')?.data).toMatchObject({ type: { from: 'same', to: 'super' } });
    expect(effectKinds(t)).toEqual(['sync_pr_labels']);
  });

  it('ends a run still queued as superseded with the cause make_super', () => {
    const t = value(m.makeSuper({ ...pairing(), runs: [run({ state: 'queued' })] }, ctx()));
    expect(m.currentRun(t.glob)?.outcome).toBe('superseded');
    expect(t.events.find((e) => e.type === 'RunEnded')?.data).toMatchObject({ cause: 'make_super' });
  });

  it('is refused without the failure, for QA and PO, for supers and while a run is live', () => {
    expect(errorCode(m.makeSuper(glob({ type: 'sub', status: 'failed', failure: { reason: 'x', at: NOW } }), ctx()))).toBe('invalid_transition');
    expect(errorCode(m.makeSuper(pairing(), ctx(po)))).toBe('forbidden');
    expect(errorCode(m.makeSuper({ ...pairing(), type: 'super' }, ctx()))).toBe('invalid_transition');
    expect(errorCode(m.makeSuper({ ...pairing(), runs: [run({ state: 'active' })] }, ctx()))).toBe('run_active');
  });
});
