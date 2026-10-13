import { describe, expect, it } from 'vitest';
import { compactStep, derivedSteps, dueText, humanSteps, isHumanStepDue, isForViewer, stepsForViewer, upcomingSteps, yourTurn } from '../src/domain/human-steps.js';
import type { StoredHumanStep } from '../src/domain/human-steps.js';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import { NOW, glob, run } from './fixtures.js';

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
const decision = (patch = {}) => glob({ category: 'decision', type: 'same', attributes: attributes(null), ...patch });

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
  origin: 'rollout-section',
  createdBy: 'dev@example.com',
  createdAt: NOW,
  doneBy: null,
  doneAt: null,
  dismissedReason: null,
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

  it('compact steps drop the detail, script and check', () => {
    const [step] = humanSteps(glob(), {}, [stored({ detail: 'long text', check: 'fileAttachments', script: { path: 'infra/deploy/host-deploy.sh' } })]);
    expect(step).toBeDefined();
    if (step === undefined) return;
    expect(compactStep(step)).toEqual({ id: 'hs-1', kind: 'rollout', title: 'Deploy the host stack', state: 'pending', who: 'admin', due: 'after_merge', blocks: ['sign_off'] });
  });
});
