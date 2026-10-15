import { describe, expect, it } from 'vitest';
import { PREDICTED_ROLLOUT_TITLE, blockProgress, compactStep, defaultStepBlocks, derivedSteps, dueText, humanSteps, isHumanStepDue, isForViewer, stepsForViewer, storedBlockProgress, upcomingSteps, yourTurn } from '../src/domain/human-steps.js';
import { armOf, armView, armsStored, rolloutStages } from '../src/domain/rollout-stages.js';
import type { StoredHumanStep } from '../src/domain/human-steps.js';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import { NOW, board, glob, run } from './fixtures.js';

const head = 'a2a88c8aaaa';
const ready = (patch = {}) =>
  glob({
    status: 'pr_open',
    pr: { number: 49, state: 'ready', headSha: head },
    headChecks: { sha: head, state: 'passed' },
    ...patch,
  });
const attributes = (outcome: DecisionAttributes['outcome']): DecisionAttributes => ({
  scope: { kind: 'project', ref: null },
  origin: { kind: 'submitted' },
  channel: 'agent',
  outcome,
});
const decision = (patch = {}) => glob({ category: 'decision', type: null, attributes: attributes(null), ...patch });

const stored = (patch: Partial<StoredHumanStep> = {}): StoredHumanStep => ({
  id: 'hs-1',
  boardId: 1,
  globId: 's1t1',
  kind: 'rollout',
  title: 'Deploy the host stack',
  detail: null,
  who: 'admin',
  due: 'after_merge',
  state: 'open',
  blocks: ['sign_off'],
  check: null,
  script: null,
  why: null,
  permissions: null,
  commands: [],
  verify: null,
  origin: 'rollout-section',
  createdBy: 'dev@example.com',
  createdAt: NOW,
  doneBy: null,
  doneAt: null,
  dismissedReason: null,
  dueSince: null,
  ...patch,
});

const kinds = (g = glob(), facts = {}, rows: StoredHumanStep[] = []) => humanSteps(g, facts, rows).map((s) => s.kind);

describe('derived steps', () => {
  it('merge: a ready same or super with passed head checks, and nothing failed or being fixed', () => {
    expect(kinds(ready())).toEqual(['merge']);
    expect(kinds(ready({ type: 'super' }))).toEqual(['merge']);
    const [merge] = derivedSteps(ready());
    expect(merge).toMatchObject({ id: 'machine:merge', source: 'machine', state: 'due', who: 'anyone', blocks: ['reviewing'] });
  });

  it('merge: not for subs, checks still running, a conflict, a failure or an active run', () => {
    expect(kinds(ready({ type: 'sub' }))).toEqual([]);
    expect(kinds(ready({ headChecks: { sha: head, state: 'pending' } }))).toEqual([]);
    expect(kinds(ready({ conflict: { base: 'main', files: [], since: null, at: NOW } }))).toEqual([]);
    expect(kinds(ready({ failure: { reason: 'boom', at: NOW } }))).toEqual([]);
    expect(kinds(ready({ runs: [run({ state: 'active' })] }))).toEqual([]);
  });

  it('merge: done once Merge was pressed and slop merges when the checks pass', () => {
    expect(kinds(ready({ mergeMode: 'when_green' }))).toEqual([]);
    expect(kinds(ready({ mergeMode: 'when_green', headChecks: { sha: head, state: 'pending' } }))).toEqual([]);
  });

  it('resolve conflict: only when a person implements the glob', () => {
    const conflict = { base: 'main', files: ['a.ts'], since: null, at: NOW };
    expect(kinds(ready({ implementer: 'dev@example.com', conflict }))).toEqual(['resolve_conflict']);
    expect(kinds(ready({ implementer: null, conflict }))).toEqual([]);
    expect(
      kinds(glob({ status: 'failed', implementer: 'dev@example.com', failure: { reason: 'merge failed', at: NOW, kind: 'merge' } })),
    ).toEqual(['resolve_conflict']);
  });

  it('done (mark ready): a draft PR in progress whose record is at the head', () => {
    const g = glob({ status: 'in_progress', implementer: 'dev@example.com' });
    expect(kinds(g, { recordAtHead: true })).toEqual(['done']);
    expect(kinds(g, { recordAtHead: false })).toEqual([]);
    expect(kinds(g)).toEqual([]);
  });

  it('decide and sign off: decision globs only', () => {
    expect(kinds(decision({ status: 'in_progress' }))).toEqual(['decide']);
    expect(kinds(decision({ status: 'in_progress', attributes: attributes({ kind: 'needs_work', reason: 'x', by: 'po@example.com', at: NOW }) }))).toEqual(['decide']);
    expect(kinds(decision({ status: 'in_progress', attributes: attributes({ kind: 'accept', by: 'po@example.com', at: NOW }) }))).toEqual([]);
    expect(kinds(decision({ status: 'reviewing' }))).toEqual(['sign_off']);
    expect(kinds(decision({ status: 'planning' }))).toEqual([]);
  });

  it('pair: a super in Planning', () => {
    expect(kinds(glob({ type: 'super', status: 'planning' }))).toEqual(['pair']);
    expect(kinds(glob({ type: 'super', status: 'in_progress', pr: null }))).toEqual([]);
    expect(kinds(glob({ type: 'same', status: 'planning' }))).toEqual([]);
  });

  it('upload: one step per missing file', () => {
    const steps = humanSteps(glob(), { missingUploads: [{ key: 'k1', fileName: 'a.png' }, { key: 'k2', fileName: 'b.pdf' }] });
    expect(steps.map((s) => [s.id, s.title])).toEqual([
      ['machine:upload_file:k1', 'Upload a.png'],
      ['machine:upload_file:k2', 'Upload b.pdf'],
    ]);
  });
});

describe('answer steps (open questions)', () => {
  const question = (patch = {}) => ({
    id: 'q1',
    text: 'Does the scope include prod?',
    raisedBy: { kind: 'intake' as const, actor: null },
    source: 'create' as const,
    blocking: 'start' as const,
    raisedAt: NOW,
    ...patch,
  });

  it('one step per open question that holds the start or the merge, and none for notices, answered or overridden ones', () => {
    const g = glob({
      questions: [
        question(),
        question({ id: 'q2', text: 'Keep the PR as is?', blocking: 'merge' }),
        question({ id: 'q3', blocking: 'none' }),
        question({ id: 'q4', answer: { text: 'yes', by: 'dev@example.com', at: NOW } }),
        question({ id: 'q5', startOverridden: { by: 'dev@example.com', at: NOW } }),
      ],
    });
    expect(derivedSteps(g).map((s) => [s.id, s.kind, s.title, s.who, s.state])).toEqual([
      ['machine:answer:q1', 'answer', 'Answer: Does the scope include prod?', 'anyone', 'due'],
      ['machine:answer:q2', 'answer', 'Answer: Keep the PR as is?', 'anyone', 'due'],
    ]);
  });

  it('a start question is a person\'s turn only while the glob has not started', () => {
    expect(derivedSteps(glob({ status: 'in_progress', questions: [question()] }))).toEqual([]);
  });
});

describe('work steps and due-ness', () => {
  it('after_merge steps are pending until the PR merges, then due', () => {
    const open = stored();
    expect(humanSteps(glob({ status: 'pr_open' }), {}, [open])[0]).toMatchObject({ source: 'work', state: 'pending', title: 'Deploy the host stack' });
    expect(humanSteps(glob({ status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'x' } }), {}, [open])[0]?.state).toBe('due');
    expect(humanSteps(glob({ status: 'in_progress', pr: { number: 7, state: 'merged', headSha: 'x' } }), {}, [open])[0]?.state).toBe('due');
    expect(humanSteps(glob({ status: 'signed_off' }), {}, [open])[0]?.state).toBe('due');
  });

  it('now steps are due at once; after_deploy steps stay pending', () => {
    expect(humanSteps(glob(), {}, [stored({ due: 'now' })])[0]?.state).toBe('due');
    expect(humanSteps(glob({ status: 'signed_off' }), {}, [stored({ due: 'after_deploy:prod' })])[0]?.state).toBe('pending');
  });

  it('done and dismissed steps keep their state and who ticked them', () => {
    const [done, dismissed] = humanSteps(glob(), {}, [
      stored({ id: 'a', state: 'done', doneBy: 'po@example.com', doneAt: NOW }),
      stored({ id: 'b', state: 'dismissed', dismissedReason: 'not needed' }),
    ]);
    expect(done).toMatchObject({ id: 'a', state: 'done', doneBy: 'po@example.com', doneAt: NOW });
    expect(dismissed).toMatchObject({ id: 'b', state: 'dismissed' });
  });

  it("another glob's steps are left out", () => {
    expect(humanSteps(glob(), {}, [stored({ globId: 's1t2' })])).toEqual([]);
  });

  it('merges derived and stored steps, most pressing first', () => {
    const g = ready();
    const steps = humanSteps(g, {}, [
      stored({ id: 'late', kind: 'rollout' }),
      stored({ id: 'now', kind: 'rollout', due: 'now', blocks: [] }),
      stored({ id: 'ticked', state: 'done', doneBy: 'x', doneAt: NOW }),
    ]);
    // Due and blocking first (merge), then due, then pending, then done.
    expect(steps.map((s) => s.id)).toEqual(['machine:merge', 'now', 'late', 'ticked']);
  });

  it('recognises valid due values', () => {
    expect(['now', 'after_merge', 'after_deploy:prod'].every(isHumanStepDue)).toBe(true);
    expect(isHumanStepDue('after_deploy:')).toBe(false);
    expect(isHumanStepDue('later')).toBe(false);
    expect(dueText('after_deploy:prod')).toBe('after the deploy to prod');
    expect(dueText('after_merge')).toBe('after the merge');
  });
});

describe('for the viewer', () => {
  const dev = { email: 'dev@example.com', role: 'dev' } as const;
  const admin = { email: 'admin@example.com', role: 'admin' } as const;
  const po = { email: 'po@example.com', role: 'po' } as const;
  const qa = { email: 'qa@example.com', role: 'qa' } as const;
  const g = glob({ implementer: 'dev@example.com' });

  it('matches who a step is for', () => {
    expect(isForViewer({ who: 'anyone' }, g, qa)).toBe(true);
    expect(isForViewer({ who: 'implementer' }, g, dev)).toBe(true);
    expect(isForViewer({ who: 'implementer' }, g, admin)).toBe(false);
    expect(isForViewer({ who: 'admin' }, g, admin)).toBe(true);
    expect(isForViewer({ who: 'admin' }, g, po)).toBe(true);
    expect(isForViewer({ who: 'admin' }, g, dev)).toBe(false);
    expect(isForViewer({ who: 'po' }, g, po)).toBe(true);
    expect(isForViewer({ who: 'po' }, g, admin)).toBe(false);
    expect(isForViewer({ who: 'qa' }, g, qa)).toBe(true);
    expect(isForViewer({ who: 'Someone@Example.com' }, g, { email: 'someone@example.com', role: 'dev' })).toBe(true);
  });

  it("the planner stands in as implementer while nobody implements", () => {
    expect(isForViewer({ who: 'implementer' }, glob({ implementer: null, planner: 'dev@example.com' }), dev)).toBe(true);
  });

  it('filters steps, and Your turn is the first due step for the viewer', () => {
    const merged = glob({ status: 'reviewing', implementer: 'dev@example.com', pr: { number: 7, state: 'merged', headSha: 'x' } });
    const steps = humanSteps(merged, {}, [
      stored({ id: 'a', who: 'admin' }),
      stored({ id: 'b', who: 'implementer', title: 'Tell the team' }),
      stored({ id: 'c', who: 'implementer', state: 'done', doneBy: 'x', doneAt: NOW }),
    ]);
    expect(stepsForViewer(steps, merged, dev).map((s) => s.id)).toEqual(['b', 'c']);
    expect(yourTurn(steps, merged, dev)?.id).toBe('b');
    expect(yourTurn(steps, merged, admin)?.id).toBe('a');
    expect(yourTurn(steps, merged, qa)).toBeNull();
  });

  it('a pending step is not your turn yet', () => {
    const steps = humanSteps(glob({ status: 'pr_open' }), {}, [stored({ who: 'anyone' })]);
    expect(yourTurn(steps, g, dev)).toBeNull();
  });
});

describe('upcoming marker and compact form', () => {
  it('lists pending kinds, deduped, with the step count', () => {
    const steps = humanSteps(glob({ status: 'pr_open' }), {}, [
      stored({ id: 'a' }),
      stored({ id: 'b' }),
      stored({ id: 'c', kind: 'review_label' }),
      stored({ id: 'd', due: 'now' }),
    ]);
    expect(upcomingSteps(steps)).toEqual({ kinds: ['rollout', 'review_label'], count: 3 });
  });

  it('is null when nothing is pending', () => {
    expect(upcomingSteps(humanSteps(glob(), {}, [stored({ due: 'now' }), stored({ id: 'x', state: 'done', doneBy: 'a', doneAt: NOW })]))).toBeNull();
  });

  it('a compact dismissed step keeps its reason, who and when', () => {
    const [step] = humanSteps(glob(), {}, [stored({ state: 'dismissed', dismissedReason: 'Wrong', doneBy: 'a@x.com', doneAt: NOW })]);
    expect(step === undefined ? null : compactStep(step)).toMatchObject({ state: 'dismissed', dismissedReason: 'Wrong', doneBy: 'a@x.com', doneAt: NOW });
  });

  it('compact steps drop the detail, script and check', () => {
    const [step] = humanSteps(glob(), {}, [stored({ detail: 'long text', check: 'fileAttachments', script: { path: 'infra/deploy/host-deploy.sh' } })]);
    expect(step).toBeDefined();
    if (step === undefined) return;
    expect(compactStep(step)).toEqual({ id: 'hs-1', kind: 'rollout', title: 'Deploy the host stack', state: 'pending', who: 'admin', due: 'after_merge', blocks: ['sign_off'] });
  });

  describe('the investigator\'s predicted rollout', () => {
    const placeholder = stored({ id: 'hs-p', title: PREDICTED_ROLLOUT_TITLE, origin: 'investigation', blocks: ['sign_off', 'dependants'] });

    it('is flagged while open, and the flag reaches the compact step', () => {
      const [step] = humanSteps(glob(), {}, [placeholder]);
      expect(step?.predicted).toBe(true);
      expect(step === undefined ? null : compactStep(step).predicted).toBe(true);
      expect(humanSteps(glob(), {}, [stored({ blocks: ['sign_off'] })])[0]?.predicted).toBeUndefined();
      expect(humanSteps(glob(), {}, [{ ...placeholder, state: 'dismissed' }])[0]?.predicted).toBeUndefined();
    });

    it('does not count towards sign-off before the merge, and does once merged', () => {
      expect(blockProgress(humanSteps(glob(), {}, [placeholder]), 'sign_off')).toEqual({ open: 0, total: 0 });
      expect(blockProgress(humanSteps(glob({ status: 'reviewing' }), {}, [placeholder]), 'sign_off')).toEqual({ open: 1, total: 1 });
    });
  });
});

describe('after-deploy steps and the arm stage (s15f176)', () => {
  const merged = (patch = {}) => glob({ status: 'reviewing', pr: { number: 1, state: 'merged', headSha: head }, ...patch });
  const stateOfSteps = (g = merged(), rows: StoredHumanStep[] = []) => humanSteps(g, {}, rows).map((s) => [s.title, s.state]);
  const prod = (patch: Partial<StoredHumanStep> = {}) => stored({ id: 'p', title: 'Prod', due: 'after_deploy:production', blocks: [], ...patch });
  const stage = (patch: Partial<StoredHumanStep> = {}) => stored({ id: 's', title: 'Stage', due: 'after_deploy:staging', blocks: [], ...patch });
  const main = (patch: Partial<StoredHumanStep> = {}) => stored({ id: 'm', title: 'Main', due: 'after_merge', blocks: ['sign_off', 'dependants'], ...patch });

  it('an after-deploy step is pending until its dueSince is set, per environment, even on a signed-off glob', () => {
    const g = merged({ status: 'signed_off' });
    expect(stateOfSteps(g, [prod(), stage({ dueSince: NOW })])).toEqual([['Stage', 'due'], ['Prod', 'pending']]);
    expect(stateOfSteps(g, [prod({ dueSince: NOW }), stage()])).toEqual([['Prod', 'due'], ['Stage', 'pending']]);
    // A deploy cannot make a step due before the glob merged either way: the mark is what counts, so it stays due.
    expect(stateOfSteps(glob({ status: 'in_progress' }), [prod({ dueSince: NOW })])).toEqual([['Prod', 'due']]);
  });

  it('a done or dismissed after-deploy step stays done or dismissed whatever its dueSince', () => {
    expect(stateOfSteps(merged(), [prod({ state: 'done', dueSince: NOW }), stage({ state: 'dismissed', dueSince: NOW })]).map(([, state]) => state)).toEqual(['done', 'dismissed']);
  });

  it('an after-merge step is due once merged, but not while the glob is in Merging, even with the PR shown as merged', () => {
    expect(stateOfSteps(merged(), [main()])).toEqual([['Main', 'due']]);
    expect(stateOfSteps(merged({ status: 'signed_off' }), [main()])).toEqual([['Main', 'due']]);
    expect(stateOfSteps(merged({ status: 'merging' }), [main()])).toEqual([['Main', 'pending']]);
    expect(stateOfSteps(glob({ status: 'pr_open' }), [main()])).toEqual([['Main', 'pending']]);
  });

  it('defaults to no blocks after a deploy and sign-off plus dependants after the merge', () => {
    expect(defaultStepBlocks('after_deploy:production')).toEqual([]);
    expect(defaultStepBlocks('after_merge')).toEqual(['sign_off', 'dependants']);
    expect(defaultStepBlocks('now')).toEqual(['sign_off', 'dependants']);
  });

  it('gates: an after-deploy step holds sign-off only when it says blocks, and dependants only when blocks includes them', () => {
    const open = [main({ state: 'done' }), prod(), stage({ blocks: ['sign_off'] }), stored({ id: 'x', title: 'X', due: 'after_deploy:production', blocks: ['dependants'] })];
    expect(storedBlockProgress(open, 'sign_off')).toEqual({ open: 1, total: 2 });
    expect(storedBlockProgress(open, 'dependants')).toEqual({ open: 1, total: 2 });
    expect(storedBlockProgress([prod()], 'sign_off')).toEqual({ open: 0, total: 0 });
    // A non-blocking step does not keep the glob in Doing; a blocking one does, due or not.
    expect(blockProgress(humanSteps(merged(), {}, [prod()]), 'sign_off').open).toBe(0);
    expect(blockProgress(humanSteps(merged(), {}, [stage({ blocks: ['sign_off'] })]), 'sign_off').open).toBe(1);
  });

  it('stages are after the merge, then the board environments in order', () => {
    expect(rolloutStages({ environments: [{ name: 'staging', allowBranchDeploy: false }, { name: 'production', allowBranchDeploy: false }] })).toEqual(['after_merge', 'staging', 'production']);
    expect(rolloutStages({ environments: [] })).toEqual(['after_merge']);
  });

  const order = ['after_merge', 'staging', 'production'];
  const arm = (rows: StoredHumanStep[], g = merged({ status: 'signed_off' })) => armOf(humanSteps(g, {}, rows), order);

  it('arms the first stage with an open step: after the merge, then each environment, even after sign-off', () => {
    const rows = [prod(), stage(), main()];
    expect(arm(rows)).toEqual({ stage: 'after_merge', title: 'Main' });
    expect(arm([prod(), stage(), main({ state: 'done' })])).toEqual({ stage: 'staging', title: 'Stage' });
    expect(arm([prod(), stage({ state: 'dismissed' }), main({ state: 'done' })])).toEqual({ stage: 'production', title: 'Prod' });
    expect(arm([prod({ state: 'done' }), stage({ state: 'done' }), main({ state: 'done' })])).toBeNull();
    expect(arm([])).toBeNull();
  });

  it('arms on a pending step too, not only a due one', () => {
    expect(arm([prod()], merged({ status: 'merging' }))).toEqual({ stage: 'production', title: 'Prod' });
  });

  it('skips the predicted placeholder and machine steps', () => {
    const placeholder = stored({ id: 'ph', title: PREDICTED_ROLLOUT_TITLE, origin: 'investigation', blocks: ['sign_off'] });
    expect(arm([placeholder])).toBeNull();
    expect(armOf(derivedSteps(ready()), order)).toBeNull();
    expect(armsStored(placeholder)).toBe(false);
    expect(armsStored(prod())).toBe(true);
    expect(armsStored(prod({ state: 'done' }))).toBe(false);
  });

  it('puts an environment the board does not list after the listed ones, and a step due now with the after-merge stage', () => {
    const odd = stored({ id: 'o', title: 'Odd', due: 'after_deploy:eu', blocks: [] });
    expect(arm([odd, prod()])).toEqual({ stage: 'production', title: 'Prod' });
    expect(arm([odd])).toEqual({ stage: 'eu', title: 'Odd' });
    expect(arm([stored({ id: 'n', title: 'Now', due: 'now' }), stage()])).toEqual({ stage: 'after_merge', title: 'Now' });
  });

  it('names the after-merge stage after the base branch, and keeps environment names', () => {
    const b = { ...board, baseBranch: 'trunk', environments: [{ name: 'production', allowBranchDeploy: false }] };
    const steps = (rows: StoredHumanStep[]) => humanSteps(merged(), {}, rows);
    expect(armView(steps([main(), prod()]), b)).toEqual({ stage: 'trunk', title: 'Main' });
    expect(armView(steps([main({ state: 'done' }), prod()]), b)).toEqual({ stage: 'production', title: 'Prod' });
    expect(armView(steps([]), b)).toBeNull();
  });

  it('keeps the compact due of an after-deploy step', () => {
    const [step] = humanSteps(merged(), {}, [prod()]);
    expect(step && compactStep(step)).toMatchObject({ due: 'after_deploy:production', state: 'pending' });
  });
});
