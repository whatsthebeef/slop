import { describe, expect, it } from 'vitest';
import type { Result } from '../src/domain/errors.js';
import * as m from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import { board, ctx, dev, glob, other, po, run } from './fixtures.js';

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
  summary: '',
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

  it('row 4: a same with an explicit auto-trigger starts implementing', () => {
    const t = value(m.create(createInput({ autoTrigger: true }), board, ctx()));
    expect(t.glob.status).toBe('implementing');
    expect(effectKinds(t)).toContain('fire_routine');
  });

  it('enforces the type/category matrix', () => {
    expect(errorCode(m.create(createInput({ type: 'sub', category: 'feature' }), board, ctx()))).toBe(
      'invalid_combination',
    );
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

describe('pick up (rows 6–10)', () => {
  it('row 6: from planning, the picker becomes implementer and a queued run is cancelled', () => {
    const t = value(
      m.pickUp(glob({ runs: [run({ state: 'queued', startedAt: null })] }), ctx(), { takeOver: false }),
    );
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.implementer).toBe(dev.email);
    expect(m.currentRun(t.glob)).toMatchObject({ state: 'ended', outcome: 'superseded' });
  });

  it('row 6: from failed, clears the failure', () => {
    const t = value(
      m.pickUp(glob({ status: 'failed', failure: { reason: 'x', at: 'y' } }), ctx(), { takeOver: false }),
    );
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.failure).toBeNull();
  });

  it('row 7: from pr_open, status is unchanged', () => {
    const t = value(m.pickUp(glob({ status: 'pr_open' }), ctx(), { takeOver: false }));
    expect(t.glob.status).toBe('pr_open');
    expect(t.glob.implementer).toBe(dev.email);
  });

  it('row 8: the current implementer picking up again is a no-op', () => {
    const t = value(
      m.pickUp(glob({ status: 'in_progress', implementer: dev.email }), ctx(), { takeOver: false }),
    );
    expect(t.changed).toBe(false);
  });

  it('row 9: someone else picking up changes the implementer', () => {
    const t = value(
      m.pickUp(glob({ status: 'in_progress', implementer: dev.email }), ctx(other), { takeOver: false }),
    );
    expect(t.glob.implementer).toBe(other.email);
  });

  it('is refused while a run is active or watching', () => {
    for (const state of ['active', 'watching'] as const) {
      const g = glob({ status: 'pr_open', runs: [run({ state })] });
      expect(errorCode(m.pickUp(g, ctx(), { takeOver: false }))).toBe('run_active');
    }
  });

  it('row 10: take over supersedes the run and bumps the generation', () => {
    const t = value(
      m.pickUp(glob({ status: 'implementing', runs: [run()] }), ctx(), { takeOver: true }),
    );
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.generation).toBe(2);
    expect(m.currentRun(t.glob)?.outcome).toBe('superseded');

    const watching = value(
      m.pickUp(glob({ status: 'pr_open', runs: [run({ state: 'watching' })] }), ctx(), { takeOver: true }),
    );
    expect(watching.glob.status).toBe('pr_open');
  });

  it('QA and PO cannot pick up or take over sames', () => {
    expect(errorCode(m.pickUp(glob(), ctx(po), { takeOver: false }))).toBe('forbidden');
    const sub = glob({ type: 'sub', status: 'failed' });
    expect(value(m.pickUp(sub, ctx(po), { takeOver: false })).glob.implementer).toBe(po.email);
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

  it('row 14: Merge needs passing checks on the current head', () => {
    const g = glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'bbb' } });
    expect(errorCode(m.requestMerge(g, ctx()))).toBe('invalid_transition');
    const stale = { ...g, headChecks: { sha: 'aaa', state: 'passed' as const } };
    expect(errorCode(m.requestMerge(stale, ctx()))).toBe('invalid_transition');
    const passing = { ...g, headChecks: { sha: 'bbb', state: 'passed' as const } };
    expect(value(m.requestMerge(passing, ctx())).glob.status).toBe('merging');
    expect(m.allowedActions(passing, dev)).toContain('merge');
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

    const sup = value(m.startAgain(glob({ type: 'super', status: 'failed', implementer: other.email, creator: dev.email }), ctx()));
    expect(sup.glob.status).toBe('in_progress');
    expect(sup.glob.implementer).toBe(dev.email);

    expect(errorCode(m.startAgain(glob({ status: 'reviewing' }), ctx()))).toBe('invalid_transition');
  });

  it('row 24: delete supersedes the run and queues the clean-up', () => {
    const t = value(m.remove(glob({ status: 'implementing', runs: [run()] }), ctx()));
    expect(effectKinds(t)).toEqual(['delete_glob_data']);
    expect(t.events.map((e) => e.type)).toContain('GlobDeleted');
  });
});

describe('labels (rows 21–22)', () => {
  const reviewing = glob({ status: 'reviewing', labels: { FR: 'added', CR: 'added', QA: 'required' } });

  it('row 21: the last required label switched to Added signs off', () => {
    const t = value(m.setLabel(reviewing, 'QA', 'added', ctx()));
    expect(t.glob.status).toBe('signed_off');
    expect(t.glob.signedOffAt).not.toBeNull();
  });

  it('row 22: switching back to Required returns to reviewing', () => {
    const signedOff = value(m.setLabel(reviewing, 'QA', 'added', ctx())).glob;
    const t = value(m.setLabel(signedOff, 'FR', 'required', ctx()));
    expect(t.glob.status).toBe('reviewing');
    expect(t.glob.signedOffAt).toBeNull();
  });

  it('labels that are not required cannot be switched', () => {
    expect(errorCode(m.setLabel(glob({ status: 'reviewing', labels: { QA: 'required' } }), 'FR', 'added', ctx()))).toBe(
      'invalid_transition',
    );
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
    expect(errorCode(m.changeFields(glob({ type: 'sub' }), { category: 'feature' }, board, ctx()))).toBe(
      'invalid_combination',
    );
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
    expect(errorCode(m.changeFields(glob({ status: 'planning' }), { type: 'super' }, board, ctx()))).toBe(
      'invalid_transition',
    );
    expect(
      errorCode(m.changeFields(glob({ status: 'pr_open', runs: [run({ state: 'watching' })] }), { type: 'super' }, board, ctx())),
    ).toBe('invalid_transition');
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
    expect(effectKinds(value(m.pickUp(planning, ctx(), { takeOver: false })))).toEqual(['provision']);
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
    expect(effectKinds(t)).toEqual(['refresh_checks']);
    const pushed = value(m.commitPushed({ ...ready, headChecks: { sha: 'bbb', state: 'passed' } }, { sha: 'ccc', runId: null }, ctx(null)));
    expect(pushed.glob.headChecks).toBeNull();
    expect(effectKinds(pushed)).toEqual(['refresh_checks']);
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

describe('mark ready', () => {
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
    const limits = { runNoProgressHours: 2, runReadyHours: 8 };
    const at = (hours: number) => new Date(Date.parse('2026-10-05T00:00:00.000Z') + hours * 3_600_000).toISOString();
    const active = (lastProgress: number) =>
      glob({ status: 'implementing', runs: [run({ state: 'active', startedAt: at(0), lastProgressAt: at(lastProgress) })] });
    expect(m.runTimeoutReason(active(0), limits, at(1))).toBeNull();
    expect(m.runTimeoutReason(active(0), limits, at(3))).toMatch(/No progress/);
    expect(m.runTimeoutReason(active(8.5), limits, at(9))).toMatch(/not marked ready/);
    const watching = glob({ status: 'pr_open', runs: [run({ state: 'watching', startedAt: at(0), lastProgressAt: at(8.5) })] });
    expect(m.runTimeoutReason(watching, limits, at(9))).toBeNull();
    expect(m.runTimeoutReason(glob({ runs: [run({ state: 'queued' })] }), limits, at(30))).toBeNull();
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
