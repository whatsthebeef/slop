import { describe, expect, it } from 'vitest';
import type { Result } from '../src/domain/errors.js';
import * as m from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import { NOW, board, ctx, dev, glob, other, po, run } from './fixtures.js';

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

  it('is refused while a run is active or watching', () => {
    for (const state of ['active', 'watching'] as const) {
      const g = glob({ status: 'pr_open', runs: [run({ state })] });
      expect(errorCode(m.pickUp(g, ctx(), board, { takeOver: false }))).toBe('run_active');
    }
  });

  it('row 10: take over supersedes the run and bumps the generation', () => {
    const t = value(
      m.pickUp(glob({ status: 'implementing', runs: [run()] }), ctx(), board, { takeOver: true }),
    );
    expect(t.glob.status).toBe('in_progress');
    expect(t.glob.generation).toBe(2);
    expect(m.currentRun(t.glob)?.outcome).toBe('superseded');

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
    expect(effectKinds(t)).toEqual(['refresh_checks']);
    const pushed = value(m.commitPushed({ ...ready, headChecks: { sha: 'bbb', state: 'passed' } }, { sha: 'ccc', runId: null }, ctx(null)));
    expect(pushed.glob.headChecks).toBeNull();
    expect(effectKinds(pushed)).toEqual(['refresh_checks']);
  });

  it('a sub entering pr_open also looks up a sub gate that finished before the PR was ready', () => {
    const sub = value(m.prReadyForReview(glob({ type: 'sub', status: 'implementing' }), { number: 7, headSha: 'bbb' }, ctx(null)));
    expect(sub.effects).toEqual([
      { kind: 'refresh_checks', globId: 's1t1', generation: 1 },
      { kind: 'refresh_sub_gate', globId: 's1t1', generation: 1 },
    ]);
    const same = value(m.prReadyForReview(glob({ type: 'same', status: 'in_progress' }), { number: 7, headSha: 'bbb' }, ctx(null)));
    expect(effectKinds(same)).toEqual(['refresh_checks']);
    const superGlob = value(m.prReadyForReview(glob({ type: 'super', status: 'in_progress' }), { number: 7, headSha: 'bbb' }, ctx(null)));
    expect(effectKinds(superGlob)).toEqual(['refresh_checks']);
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

describe('supers: Merge and continue (row 31) and Ready for review on the board', () => {
  const HEAD = 'bbbbbbb1234567890';
  const atHead = { postplanSha: HEAD.slice(0, 7) };
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

  it('offers merge_continue only to supers with the latest postplan at the head', () => {
    expect(m.allowedActions(superReady, dev, atHead)).toEqual(expect.arrayContaining(['merge', 'merge_continue']));
    expect(m.allowedActions(superReady, dev, { postplanSha: HEAD })).toContain('merge_continue');
    expect(m.allowedActions(superReady, dev, { postplanSha: 'ccccccc' })).not.toContain('merge_continue');
    expect(m.allowedActions(superReady, dev, { postplanSha: null })).not.toContain('merge_continue');
    expect(m.allowedActions(superReady, dev)).not.toContain('merge_continue');
    // Too short to identify a commit.
    expect(m.allowedActions(superReady, dev, { postplanSha: 'bbb' })).not.toContain('merge_continue');
    const same = { ...superReady, type: 'same' as const };
    expect(m.allowedActions(same, dev, atHead)).toContain('merge');
    expect(m.allowedActions(same, dev, atHead)).not.toContain('merge_continue');
    // The same conditions as merge: checks passed on the current head.
    const pending = { ...superReady, headChecks: null };
    expect(m.allowedActions(pending, dev, atHead)).not.toContain('merge_continue');
  });

  it('merge_continue goes to merging in continue mode; it needs a super and the postplan at the head', () => {
    const t = value(m.requestMerge(superReady, ctx(), { continue: true, facts: atHead }));
    expect(t.glob.status).toBe('merging');
    expect(t.glob.mergeMode).toBe('continue');
    expect(t.effects).toEqual([{ kind: 'squash_merge', globId: 's1t1', generation: 1, sha: HEAD }]);
    expect(errorCode(m.requestMerge(superReady, ctx(), { continue: true, facts: { postplanSha: 'ccccccc' } }))).toBe(
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
    expect(effectKinds(value(m.commitPushed(opened.glob, { sha: 'eee', runId: null }, ctx(null))))).toEqual([]);
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

  it('a failed continue merge clears the merge mode', () => {
    const merging = value(m.requestMerge(superReady, ctx(), { continue: true, facts: atHead })).glob;
    const failed = value(m.mergeFailed(merging, 'conflict', ctx(null))).glob;
    expect(failed.status).toBe('failed');
    expect(failed.mergeMode).toBeNull();
    const checksFailed = value(m.checksCompleted(merging, { sha: HEAD, passed: false }, ctx(null))).glob;
    expect(checksFailed.mergeMode).toBeNull();
  });

  it('mark_ready from the board: supers with a draft PR and the postplan at the head', () => {
    const drafting = glob({
      type: 'super',
      status: 'in_progress',
      implementer: dev.email,
      pr: { number: 7, state: 'draft', headSha: HEAD },
    });
    expect(m.allowedActions(drafting, dev, atHead)).toContain('mark_ready');
    expect(m.allowedActions(drafting, dev, { postplanSha: 'ccccccc' })).not.toContain('mark_ready');
    expect(m.allowedActions(drafting, dev)).not.toContain('mark_ready');
    expect(m.allowedActions({ ...drafting, type: 'same' }, dev, atHead)).not.toContain('mark_ready');

    const board = { from: 'board' as const, facts: atHead };
    expect(effectKinds(value(m.readyRequested(drafting, null, ctx(), board)))).toEqual(['mark_pr_ready']);
    const behind = m.readyRequested(drafting, null, ctx(), { from: 'board', facts: { postplanSha: 'ccccccc' } });
    expect(!behind.ok && behind.error.message).toBe(m.POSTPLAN_NOT_AT_HEAD);
    expect(errorCode(m.readyRequested({ ...drafting, type: 'same' }, null, ctx(), board))).toBe('invalid_transition');
    // QA and PO can't mark a super ready from the board, and aren't offered it.
    for (const actor of [po, { email: 'qa@example.com', role: 'qa' } as const]) {
      expect(errorCode(m.readyRequested(drafting, null, ctx(actor), board))).toBe('forbidden');
      expect(m.allowedActions(drafting, actor, atHead)).not.toContain('mark_ready');
    }
    // The MCP tool (sstor --ready) is unchanged: it needs no postplan.
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
