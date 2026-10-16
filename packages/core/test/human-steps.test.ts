import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput, RelationScanTrigger } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import type { Glob, Relation } from '../src/domain/types.js';
import { hash } from '../src/app/text-hash.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import type { RelationScanRow } from '../src/domain/relation-scan.js';
import { sentenceHash } from '../src/domain/relation-scan.js';
import { HUMAN_STEP_GROUP, HUMAN_STEP_KINDS, isHousekeepingStep, PREDICTED_ROLLOUT_TITLE, blockProgress, compactStep, defaultStepBlocks, derivedSteps, dueText, environmentOf, humanSteps, unknownEnvironmentText, isHumanStepDue, isForViewer, stepsForViewer, storedBlockProgress, upcomingSteps, yourTurn } from '../src/domain/human-steps.js';
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

  describe('once steps (s15t237)', () => {
    const once = (patch: Partial<StoredHumanStep> = {}) => stored({ due: 'once', ...patch });
    const stateIn = (g: ReturnType<typeof glob>, step: StoredHumanStep, facts = {}) => humanSteps(g, facts, [step])[0]?.state;

    it('is due at once without a repo script, before the merge, and when the branch was not checked', () => {
      expect(stateIn(glob({ status: 'in_progress' }), once())).toBe('due');
      expect(stateIn(glob({ status: 'in_progress' }), once({ script: { artifact: 'rollout: x' } }))).toBe('due');
      expect(stateIn(glob({ status: 'in_progress' }), once({ script: { path: 'scripts/rollout/x.sh' } }))).toBe('due');
    });

    it('waits for its script to be on the branch, and is due once it is (or once merged)', () => {
      const step = once({ script: { path: 'scripts/rollout/x.sh' } });
      const draft = glob({ status: 'in_progress', pr: { number: 1, state: 'draft', headSha: 'abc' } });
      expect(stateIn(draft, step, { scriptsOnBranch: new Set<string>() })).toBe('pending');
      expect(stateIn(draft, step, { scriptsOnBranch: new Set(['scripts/rollout/x.sh']) })).toBe('due');
      expect(stateIn(glob({ status: 'reviewing', pr: { number: 1, state: 'merged', headSha: 'abc' } }), step, { scriptsOnBranch: new Set<string>() })).toBe('due');
    });

    it('is done or dismissed whatever the branch has, and is not a deploy step', () => {
      const step = once({ script: { path: 'scripts/rollout/x.sh' } });
      expect(stateIn(glob(), { ...step, state: 'done' }, { scriptsOnBranch: new Set<string>() })).toBe('done');
      expect(stateIn(glob(), { ...step, state: 'dismissed' }, { scriptsOnBranch: new Set<string>() })).toBe('dismissed');
      expect(defaultStepBlocks('once')).toEqual(['sign_off', 'dependants']);
      expect(isHumanStepDue('once')).toBe(true);
      expect(dueText('once')).toBe('once, when its script is on the branch');
    });

    it('holds back sign-off until done', () => {
      const open = [once()];
      expect(storedBlockProgress(open, 'sign_off')).toEqual({ open: 1, total: 1 });
      expect(storedBlockProgress([once({ state: 'done' })], 'sign_off')).toEqual({ open: 0, total: 1 });
    });
  });

  it('names an environment of a deploy step, and the refusal lists the board\'s', () => {
    expect(environmentOf('after_deploy:prod')).toBe('prod');
    expect(environmentOf('after_merge')).toBeNull();
    expect(environmentOf('once')).toBeNull();
    expect(unknownEnvironmentText('eu', ['demo', 'dev'])).toBe("Unknown environment eu: this board's environments are demo, dev");
    expect(unknownEnvironmentText('prod', [])).toContain('defines no environments');
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

describe('a failed step, card suggestions and the automatic apply (GlobService)', () => {
  const ADMIN = 'admin@example.com';
  const DEV = 'dev@example.com';
  const OUTSIDER = 'outsider@example.com';
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let boardId: number;
  let runs: number;
  let requests: { globId: string; newText: string }[];

  const unwrapped = <T>(result: Result<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
  };
  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Work',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const make = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrapped(await globs.create(ADMIN, input(patch)));
  const merge = (id: string) => globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)).then(unwrapped);
  const rows = (from?: string): Relation[] => [...store.state.relations.values()].filter((r) => from === undefined || r.from === from);
  const scans = (): RelationScanRow[] => [...store.state.relationScans.values()];
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const scanRow = (patch: Partial<RelationScanRow> & { globId: string; mentionedId: string; sentence: string }): RelationScanRow => ({
    sentenceHash: sentenceHash(patch.sentence),
    boardId,
    kind: 'mention',
    decision: 'suggested',
    gate: null,
    reason: null,
    relationId: null,
    state: 'open',
    model: null,
    createdAt: NOW,
    decidedAt: null,
    ...patch,
  });
  const seed = (...r: RelationScanRow[]) => store.transaction((tx) => tx.upsertRelationScans(r));
  const planHashOf = async (id: string): Promise<string> => hash(await globs.peekPlan(id));

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    requests = [];
    const relationScan: RelationScanTrigger = { request: (r) => void requests.push(r) };
    boards = new BoardService({ store, notifier });
    globs = new GlobService({ store, notifier, clock: { now: () => '2026-10-15T12:00:00.000Z' }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) }, relationScan });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrapped(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrapped(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  describe('failHumanStep', () => {
    const failed = async () => {
      const g = await make({ title: 'Log data protection' });
      await merge(g.id);
      const step = unwrapped(await globs.addHumanStep(ADMIN, g.id, null, { title: 'Provision the stack', kind: 'rollout' }));
      unwrapped(await globs.failHumanStep(DEV, g.id, step.id, 'the stack did not provision', null));
      return { g, step };
    };

    it('leaves the step open, logs HumanStepFailed and writes one open step_failed suggestion, with no model call', async () => {
      const { g, step } = await failed();
      expect([...store.state.humanSteps.values()].find((s) => s.id === step.id)?.state).toBe('open');
      expect(store.state.events.filter((e) => e.type === 'HumanStepFailed')).toMatchObject([{ globId: g.id, actor: DEV, data: { stepId: step.id, title: 'Provision the stack', note: 'the stack did not provision' } }]);
      expect(scans()).toMatchObject([
        { globId: g.id, mentionedId: step.id, kind: 'step_failed', decision: 'suggested', state: 'open', gate: 'sign_off', sentence: 'This step failed: is there a fix glob? Provision the stack', model: null },
      ]);
      expect(unwrapped(await globs.get(ADMIN, g.id)).suggestions).toMatchObject([{ kind: 'step_failed', stepId: step.id, mentioned: null, text: 'This step failed: is there a fix glob? Provision the stack' }]);
      // Failing it again while the suggestion is open adds nothing.
      unwrapped(await globs.failHumanStep(DEV, g.id, step.id, 'still broken', null));
      expect(scans()).toHaveLength(1);
      // The board list carries it too.
      expect(unwrapped(await globs.listWithArtifacts(ADMIN, boardId, {})).find((r) => r.glob.id === g.id)?.suggestions).toHaveLength(1);
      // Nothing asks the relation scan about a failure.
      expect(requests.filter((r) => r.newText.includes('did not provision'))).toEqual([]);
    });

    it('refuses a step that is not open or does not exist, and a stale version', async () => {
      const g = await make();
      const step = unwrapped(await globs.addHumanStep(ADMIN, g.id, null, { title: 'Do it', kind: 'rollout' }));
      expect((await globs.failHumanStep(ADMIN, g.id, 'hs_nope', 'x', null)).ok).toBe(false);
      const stale = await globs.failHumanStep(ADMIN, g.id, step.id, 'x', g.version + 5);
      expect(!stale.ok && stale.error.code).toBe('version_conflict');
      unwrapped(await globs.completeHumanStep(ADMIN, g.id, step.id, null));
      const done = await globs.failHumanStep(ADMIN, g.id, step.id, 'x', null);
      expect(!done.ok && done.error.message).toContain('already done');
      expect((await globs.failHumanStep(OUTSIDER, g.id, step.id, 'x', null)).ok).toBe(false);
    });

    it('"link a glob" writes sign_off until merged on this glob, pointing at the fix, and closes the suggestion', async () => {
      const { g, step } = await failed();
      const fix = await make({ title: 'Fix the stack', category: 'bug' });
      const [suggestion] = unwrapped(await globs.get(ADMIN, g.id)).suggestions ?? [];
      const none = await globs.resolveSuggestion(ADMIN, g.id, suggestion?.id ?? '', 'accept', {});
      expect(none.ok).toBe(false);
      unwrapped(await globs.resolveSuggestion(ADMIN, g.id, suggestion?.id ?? '', 'accept', { glob: fix.id }));
      expect(rows(g.id)).toMatchObject([{ to: fix.id, gate: 'sign_off', until: 'merged', source: 'person', reason: 'fixes the failed step Provision the stack' }]);
      expect(unwrapped(await globs.get(ADMIN, g.id)).suggestions).toBeUndefined();
      expect(scans()[0]).toMatchObject({ mentionedId: step.id, state: 'done' });
    });

    it('dismissing is remembered: the suggestion is gone and stays gone', async () => {
      const { g } = await failed();
      const [suggestion] = unwrapped(await globs.get(ADMIN, g.id)).suggestions ?? [];
      unwrapped(await globs.resolveSuggestion(ADMIN, g.id, suggestion?.id ?? '', 'dismiss', {}));
      expect(scans()[0]?.state).toBe('dismissed');
      expect(unwrapped(await globs.get(ADMIN, g.id)).suggestions).toBeUndefined();
      expect((await globs.resolveSuggestion(ADMIN, g.id, suggestion?.id ?? '', 'dismiss', {})).ok).toBe(false);
    });
  });

  describe('suggestions from the automatic pass', () => {
    it('accepting a prerequisite adds the relation as the person, with the sentence as its reason', async () => {
      const a = await make();
      const b = await make({ title: 'Needs a' });
      const sentence = `Hand over the profile only after ${a.id} is in place.`;
      await seed(scanRow({ globId: b.id, mentionedId: a.id, sentence, gate: 'sign_off' }));
      const [s] = unwrapped(await globs.get(ADMIN, b.id)).suggestions ?? [];
      expect(s).toMatchObject({ kind: 'prerequisite', mentioned: a.id, gate: 'sign_off' });
      expect(s?.text).toContain(`Mentions ${a.id}`);
      unwrapped(await globs.resolveSuggestion(ADMIN, b.id, s?.id ?? '', 'accept'));
      expect(rows(b.id)).toMatchObject([{ to: a.id, gate: 'sign_off', source: 'person', reason: sentence }]);
      expect(scans()[0]).toMatchObject({ state: 'done', decision: 'added' });
    });

    it('accepting a reverse suggestion writes the relation on the other glob; a supersede suggestion writes the supersession', async () => {
      const served = await make({ title: 'Served' });
      const fix = await make({ title: 'Fix' });
      await seed(scanRow({ globId: fix.id, mentionedId: served.id, sentence: `This fixes ${served.id}.`, gate: 'sign_off' }));
      const [r] = unwrapped(await globs.get(ADMIN, fix.id)).suggestions ?? [];
      expect(r?.kind).toBe('reverse');
      unwrapped(await globs.resolveSuggestion(ADMIN, fix.id, r?.id ?? '', 'accept'));
      expect(rows(served.id)).toMatchObject([{ to: fix.id, gate: 'sign_off', source: 'person' }]);

      const old = await make({ title: 'Old' });
      const fresh = await make({ title: 'Fresh' });
      await seed(scanRow({ globId: fresh.id, mentionedId: old.id, sentence: `This replaces ${old.id}.` }));
      const [x] = unwrapped(await globs.get(ADMIN, fresh.id)).suggestions ?? [];
      expect(x?.kind).toBe('supersedes');
      unwrapped(await globs.resolveSuggestion(ADMIN, fresh.id, x?.id ?? '', 'accept'));
      expect(unwrapped(await globs.get(ADMIN, old.id)).relationGroups.supersededBy).toMatchObject({ id: fresh.id });
    });

    it('adding a covering relation by hand marks the suggestion done', async () => {
      const a = await make();
      const b = await make();
      await seed(scanRow({ globId: b.id, mentionedId: a.id, sentence: `Needs ${a.id} first.` }));
      unwrapped(await globs.addRelation(ADMIN, b.id, null, { to: a.id, reason: 'x' }, 'held_by', 'agent'));
      expect(unwrapped(await globs.get(ADMIN, b.id)).suggestions).toBeUndefined();
      expect(scans()[0]).toMatchObject({ state: 'done', relationId: rows(b.id)[0]?.id });
    });

    it('a suggestion that names a glob on a board the viewer cannot see is not shown', async () => {
      const other = unwrapped(await boards.create(OUTSIDER, { name: 'other', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }));
      const foreign = unwrapped(await globs.create(OUTSIDER, input({ boardId: other.id })));
      const mine = await make();
      await seed(scanRow({ globId: mine.id, mentionedId: foreign.id, sentence: `Waits for ${foreign.id}.` }));
      expect(unwrapped(await globs.get(DEV, mine.id)).suggestions).toBeUndefined();
    });
  });

  describe('applyAutomatic', () => {
    const add = (to: string, patch: Partial<Parameters<GlobService['applyAutomatic']>[2][number]> = {}) => ({
      to,
      gate: 'start' as const,
      until: 'merged' as const,
      reason: `needs ${to}`,
      sentence: `Starts after ${to}.`,
      ...patch,
    });

    it('writes source auto rows with the reason in one go, events carry the source, and returns what it added', async () => {
      const a = await make();
      const b = await make();
      const waiting = await make({ type: 'sub', after: [a.id] });
      const plan = await planHashOf(waiting.id);
      const result = await globs.applyAutomatic(waiting.id, plan, [add(b.id, { gate: 'sign_off', reason: 'hand over after b' })], ADMIN);
      expect(result).toEqual({ added: [b.id], skipped: [], stale: false });
      expect(rows(waiting.id).find((r) => r.to === b.id)).toMatchObject({ gate: 'sign_off', until: 'merged', source: 'auto', reason: 'hand over after b' });
      expect(store.state.events.filter((e) => e.type === 'RelationAdded' && e.globId === waiting.id && e.data.source === 'auto')).toHaveLength(1);
      expect((await current(waiting.id)).version).toBeGreaterThan(waiting.version);
    });

    it('does nothing and says stale when the plan changed', async () => {
      const a = await make();
      const g = await make();
      const result = await globs.applyAutomatic(g.id, 'sha256:not-the-plan', [add(a.id)], ADMIN);
      expect(result).toEqual({ added: [], skipped: [], stale: true });
      expect(rows()).toEqual([]);
    });

    it('skips: a pair that has any row (dismissed too), a glob past its start gate, a target that holds nothing, a cycle, an unknown glob, an empty reason', async () => {
      const a = await make();
      const planning = await make({ type: 'sub', after: [a.id] });
      const plan = await planHashOf(planning.id);
      // Any row for the pair, whatever its gate.
      const existing = await globs.applyAutomatic(planning.id, plan, [add(a.id, { gate: 'sign_off' })], ADMIN);
      expect(existing.skipped).toEqual([{ to: a.id, why: 'already related' }]);
      // A dismissed row also ends the question.
      unwrapped(await globs.dismissRelation(ADMIN, planning.id, null, rows(planning.id)[0]?.id ?? ''));
      expect((await globs.applyAutomatic(planning.id, plan, [add(a.id)], ADMIN)).skipped[0]?.why).toBe('already related');
      // A start gate on a glob that already started.
      const started = await make({ type: 'sub' });
      const b = await make();
      expect((await globs.applyAutomatic(started.id, await planHashOf(started.id), [add(b.id)], ADMIN)).skipped[0]?.why).toContain('already started');
      // A target that is merged and rolled out holds nothing.
      const done = await make();
      await merge(done.id);
      const c = await make();
      expect((await globs.applyAutomatic(c.id, await planHashOf(c.id), [add(done.id, { gate: 'sign_off' })], ADMIN)).skipped[0]?.why).toContain('already');
      // A cycle.
      const x = await make();
      await make({ after: [x.id] });
      const y = rows().find((q) => q.to === x.id)?.from ?? '';
      expect((await globs.applyAutomatic(x.id, await planHashOf(x.id), [add(y)], ADMIN)).skipped[0]?.why).toContain('cycle');
      // Unknown glob, empty reason.
      const r = await globs.applyAutomatic(x.id, await planHashOf(x.id), [add('s1t999'), add(b.id, { reason: ' ' })], ADMIN);
      expect(r.skipped.map((s) => s.why)).toEqual(['No glob s1t999', 'a relation needs a reason']);
      expect(rows().filter((q) => q.source === 'auto')).toEqual([]);
    });

    it("holds_back writes the row on the other glob (the fix or follow-up case)", async () => {
      const served = await make({ title: 'Served' });
      await merge(served.id);
      const fix = await make({ title: 'Fix' });
      const result = await globs.applyAutomatic(fix.id, await planHashOf(fix.id), [add(served.id, { gate: 'sign_off', direction: 'holds_back', reason: 'fixes it' })], ADMIN);
      expect(result.added).toEqual([served.id]);
      expect(rows(served.id)).toMatchObject([{ to: fix.id, gate: 'sign_off', source: 'auto', reason: 'fixes it' }]);
    });

    it("cross-board: allowed when the glob's creator is a member of the other board, a skipped result when not", async () => {
      const other = unwrapped(await boards.create(OUTSIDER, { name: 'other', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }));
      const foreign = unwrapped(await globs.create(OUTSIDER, input({ boardId: other.id })));
      const mine = await make();
      const refused = await globs.applyAutomatic(mine.id, await planHashOf(mine.id), [add(foreign.id, { gate: 'sign_off' })], DEV);
      expect(refused.added).toEqual([]);
      expect(refused.skipped).toEqual([{ to: foreign.id, why: `No glob ${foreign.id}` }]);
      unwrapped(await boards.setMember(OUTSIDER, other.id, ADMIN, 'admin'));
      const allowed = await globs.applyAutomatic(mine.id, await planHashOf(mine.id), [add(foreign.id, { gate: 'sign_off' })], ADMIN);
      expect(allowed.added).toEqual([foreign.id]);
      expect(rows(mine.id)[0]).toMatchObject({ boardId, to: foreign.id, source: 'auto' });
    });

    it('dismissing an automatic relation remembers the pair in the scan cache, so it is never asked again', async () => {
      const a = await make();
      const g = await make();
      await globs.applyAutomatic(g.id, await planHashOf(g.id), [add(a.id)], ADMIN);
      const row = rows(g.id)[0];
      unwrapped(await globs.dismissRelation(ADMIN, g.id, null, row?.id ?? ''));
      expect(scans()).toMatchObject([{ globId: g.id, mentionedId: a.id, decision: 'not_prerequisite', state: 'dismissed', relationId: row?.id }]);
      // A person's own relation, dismissed, leaves no scan row.
      const b = await make();
      const mine = await make({ after: [b.id] });
      unwrapped(await globs.dismissRelation(ADMIN, mine.id, null, rows(mine.id)[0]?.id ?? ''));
      expect(scans()).toHaveLength(1);
    });

    it('a rejected add does not stop the others', async () => {
      const a = await make();
      const b = await make();
      const g = await make();
      const result = await globs.applyAutomatic(g.id, await planHashOf(g.id), [add('s1t404'), add(a.id), add(b.id, { gate: 'merge' })], ADMIN);
      expect(result.added).toEqual([a.id, b.id]);
      expect(result.skipped).toEqual([{ to: 's1t404', why: 'No glob s1t404' }]);
    });
  });

  describe('the automatic pass is told when text arrives', () => {
    it('on create (the plan), on a step added (title, why, detail) and on a rollout record (changed steps only)', async () => {
      const g = await make({ plan: 'Wire it up. It needs s1t9 first.' });
      expect(requests).toEqual([{ globId: g.id, newText: 'Wire it up. It needs s1t9 first.' }]);
      unwrapped(await globs.addHumanStep(ADMIN, g.id, null, { title: 'Turn on push mode', why: 'after s1t9 is deployed', detail: 'flip it' }));
      expect(requests.at(-1)).toEqual({ globId: g.id, newText: 'Turn on push mode\nafter s1t9 is deployed\nflip it' });
      const record = '## Rollout\n- manual: Create the groups\n  - Why: the buildspec needs them\n';
      const source = { commitSha: null, runId: null, agentSetVersion: null };
      await globs.reconcileRollout(ADMIN, g.id, record, source);
      expect(requests.at(-1)?.newText).toContain('Create the groups');
      const count = requests.length;
      // The same record again changes nothing, so nothing is sent.
      await globs.reconcileRollout(ADMIN, g.id, record, source);
      expect(requests).toHaveLength(count);
    });

    it('a request that throws never fails the write', async () => {
      const failing = new GlobService({
        store,
        notifier: new RecordingNotifier(),
        clock: { now: () => NOW },
        ids: { runId: () => `x-${++runs}` },
        routines: { hasRoutine: () => Promise.resolve(true) },
        relationScan: { request: () => Promise.reject(new Error('queue down')) },
      });
      expect((await failing.create(ADMIN, input())).ok).toBe(true);
    });
  });
});

describe('step groups (s15t246)', () => {
  it('puts every kind in one of Decide, Answer, Do or housekeeping', () => {
    expect(Object.keys(HUMAN_STEP_GROUP).sort()).toEqual([...HUMAN_STEP_KINDS].sort());
    expect(HUMAN_STEP_GROUP.review_label).toBe('decide');
    expect(HUMAN_STEP_GROUP.answer).toBe('answer');
    expect(HUMAN_STEP_GROUP.rollout).toBe('do');
    for (const kind of ['merge', 'resolve_conflict', 'upload_file', 'unstick', 'pair'] as const) expect(isHousekeepingStep({ kind })).toBe(true);
  });
});
