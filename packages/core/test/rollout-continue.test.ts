import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import { ESCALATION_CRITERIA, escalationCandidates } from '../src/domain/escalation-learning.js';
import type { EscalationFacts } from '../src/domain/escalation-learning.js';
import type { DomainEvent } from '../src/domain/events.js';
import { openRolloutSteps, stateOf } from '../src/domain/human-steps.js';
import type { StoredHumanStep } from '../src/domain/human-steps.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { admin, board, ctx, dev, glob as fixture, NOW, po } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const readyPr = { number: 7, state: 'ready' as const, headSha: 'abc1234' };
const passed = { sha: 'abc1234', state: 'passed' as const };
/** A same with a ready PR whose checks passed, in the state Merge is offered. */
const ready = (patch: Partial<Glob> = {}): Glob => fixture({ status: 'pr_open', pr: readyPr, headChecks: passed, provisioning: 'ok', ...patch });
/** A same merged and open for its rollout steps. */
const merged = (patch: Partial<Glob> = {}): Glob =>
  fixture({ status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'abc1234' }, labels: { FR: 'required', CR: 'required', QA: 'required' }, ...patch });
const types = (t: machine.Transition): string[] => t.events.map((e) => e.type);
const effectKinds = (t: machine.Transition): string[] => t.effects.map((e) => e.kind);

describe('Merge and continue for a same with rollout steps (allowed actions)', () => {
  it('offers merge, never merge_continue, once the checks passed', () => {
    const actions = machine.allowedActions(ready(), dev, { rolloutSteps: 2 });
    expect(actions).toContain('merge');
    expect(actions).not.toContain('merge_continue');
  });

  it('offers neither while the checks are still running: no arming for it', () => {
    const actions = machine.allowedActions(ready({ headChecks: { sha: 'abc1234', state: 'pending' } }), dev, { rolloutSteps: 1 });
    expect(actions).not.toContain('merge_continue');
    expect(actions).not.toContain('merge');
  });

  it('offers merge and not merge_continue without steps', () => {
    const actions = machine.allowedActions(ready(), dev, { rolloutSteps: 0 });
    expect(actions).toContain('merge');
    expect(actions).not.toContain('merge_continue');
    expect(machine.allowedActions(ready(), dev)).toContain('merge');
  });

  it('leaves a super as it is: merge, and merge_continue with the record at the head', () => {
    const super_ = ready({ type: 'super' });
    expect(machine.allowedActions(super_, dev, { rolloutSteps: 2, recordSha: 'abc1234' })).toEqual(expect.arrayContaining(['merge', 'merge_continue']));
    const noRecord = machine.allowedActions(super_, dev, { rolloutSteps: 2 });
    expect(noRecord).toContain('merge');
    expect(noRecord).not.toContain('merge_continue');
  });

  it('a same escalated for its steps cannot be made a sub again while they are open', () => {
    const escalated = ready({ escalation: { reason: machine.ROLLOUT_ESCALATION_REASON, criterion: 'risk_path', by: 'slop', at: NOW } });
    expect(machine.allowedActions(escalated, admin, { rolloutSteps: 1 })).not.toContain('deescalate');
    expect(machine.allowedActions(escalated, admin, { rolloutSteps: 0 })).toContain('deescalate');
  });
});

describe('requestMerge with rollout steps', () => {
  it('Merge and continue merges a same now, as a plain merge: no continue mode, no record needed', () => {
    const t = unwrap(machine.requestMerge(ready(), ctx(dev), { continue: true, facts: { rolloutSteps: 1 } }));
    expect(t.glob.status).toBe('merging');
    expect(t.glob.mergeMode).toBeNull();
    expect(effectKinds(t)).toEqual(['advance_merge_line']);
    expect(machine.squashTitle(t.glob)).toBe('s1t1: Fix login timeout');
  });

  it('lands in Reviewing when the merge is observed', () => {
    const merging = unwrap(machine.requestMerge(ready(), ctx(dev), { continue: true, facts: { rolloutSteps: 1 } })).glob;
    const landed = unwrap(machine.merged(merging, { sha: 'sha1', number: 7 }, ctx(null)));
    expect(landed.glob.status).toBe('reviewing');
    expect(landed.glob.pr?.state).toBe('merged');
    expect(landed.glob.prs).toEqual([]);
  });

  it('Merge with steps keeps the glob for them, as the alias does, and never arms it', () => {
    const t = unwrap(machine.requestMerge(ready(), ctx(dev), { continue: false, facts: { rolloutSteps: 1 } }));
    expect(t.glob.status).toBe('merging');
    expect(t.glob.mergeMode).toBeNull();
    expect(effectKinds(t)).toEqual(['advance_merge_line']);
    const pending = machine.requestMerge(ready({ headChecks: { sha: 'abc1234', state: 'pending' } }), ctx(dev), { continue: false, facts: { rolloutSteps: 1 } });
    expect(pending.ok).toBe(false);
  });

  it('refuses Merge and continue for a same without steps, and for a sub', () => {
    expect(machine.requestMerge(ready(), ctx(dev), { continue: true, facts: { rolloutSteps: 0 } }).ok).toBe(false);
    expect(machine.requestMerge(ready(), ctx(dev), { continue: true }).ok).toBe(false);
    expect(machine.requestMerge(ready({ type: 'sub' }), ctx(dev), { continue: true, facts: { rolloutSteps: 1 } }).ok).toBe(false);
  });

  it('refuses Merge and continue until the checks passed', () => {
    const refused = machine.requestMerge(ready({ headChecks: { sha: 'abc1234', state: 'pending' } }), ctx(dev), { continue: true, facts: { rolloutSteps: 1 } });
    expect(refused.ok).toBe(false);
  });

  it('leaves a super as it was: continue needs the record, mode continue, plain merge allowed', () => {
    const super_ = ready({ type: 'super' });
    const refused = machine.requestMerge(super_, ctx(dev), { continue: true, facts: { rolloutSteps: 3 } });
    expect(!refused.ok && refused.error.message).toBe(machine.RECORD_NOT_AT_HEAD);
    const continued = unwrap(machine.requestMerge(super_, ctx(dev), { continue: true, facts: { rolloutSteps: 3, recordSha: 'abc1234' } }));
    expect(continued.glob.mergeMode).toBe('continue');
    expect(unwrap(machine.requestMerge(super_, ctx(dev), { continue: false, facts: { rolloutSteps: 3 } })).glob.status).toBe('merging');
  });

  it('merges a same without steps as before', () => {
    expect(unwrap(machine.requestMerge(ready(), ctx(dev), { continue: false, facts: { rolloutSteps: 0 } })).glob.status).toBe('merging');
  });
});

describe('Pick up on a merged glob with open rollout steps (row 9a)', () => {
  const pick = (g: Glob, rolloutSteps: number | undefined, actor = dev) =>
    machine.pickUp(g, ctx(actor), board, { takeOver: false, ...(rolloutSteps === undefined ? {} : { rolloutSteps }) });

  it('is offered with steps and not without, nor once signed off', () => {
    expect(machine.allowedActions(merged(), dev, { rolloutSteps: 1 })).toContain('pick_up');
    expect(machine.allowedActions(merged(), dev, { rolloutSteps: 0 })).not.toContain('pick_up');
    expect(machine.allowedActions(merged(), dev)).not.toContain('pick_up');
    expect(machine.allowedActions(merged({ status: 'signed_off' }), dev, { rolloutSteps: 1 })).not.toContain('pick_up');
    expect(machine.allowedActions(merged(), po, { rolloutSteps: 1 })).not.toContain('pick_up');
  });

  it('sets the implementer and keeps the status', () => {
    const t = unwrap(pick(merged(), 2));
    expect(t.glob).toMatchObject({ status: 'reviewing', implementer: dev.email });
    expect(types(t)).toEqual(['PickedUp']);
    expect(t.effects).toEqual([]);
  });

  it('is a no-op for the implementer who already holds it', () => {
    expect(unwrap(pick(merged({ implementer: dev.email }), 1)).changed).toBe(false);
  });

  it('is refused without steps and when signed off', () => {
    expect(pick(merged(), 0).ok).toBe(false);
    expect(pick(merged(), undefined).ok).toBe(false);
    expect(pick(merged({ status: 'signed_off' }), 1).ok).toBe(false);
  });
});

describe('deescalate with open rollout steps', () => {
  const escalated = ready({ escalation: { reason: machine.ROLLOUT_ESCALATION_REASON, criterion: 'risk_path', by: 'slop', at: NOW } });

  it('is refused while rollout steps are open, with a message that says it must be merged', () => {
    const refused = machine.deescalate(escalated, ctx(admin), { rolloutSteps: 1 });
    expect(!refused.ok && refused.error.code).toBe('invalid_transition');
    expect(!refused.ok && refused.error.message).toContain('must be merged');
  });

  it('works once no step is open, and for an escalation of another criterion', () => {
    expect(unwrap(machine.deescalate(escalated, ctx(admin), { rolloutSteps: 0 })).glob.type).toBe('sub');
    expect(unwrap(machine.deescalate(escalated, ctx(admin))).glob.type).toBe('sub');
    const other = ready({ escalation: { reason: 'x', criterion: 'design_decision', by: 'agent', at: NOW } });
    expect(unwrap(machine.deescalate(other, ctx(admin), { rolloutSteps: 1 })).glob.type).toBe('sub');
  });
});

describe('rolloutStepsAdded (row 13d)', () => {
  it('turns a sub into a same escalated for risk_path and clears its merge hold', () => {
    const sub = ready({ type: 'sub', mergeHold: { since: NOW, sha: 'abc1234', for: ['s1t9'] } });
    const t = unwrap(machine.rolloutStepsAdded(sub, ctx(null)));
    expect(t.glob).toMatchObject({ type: 'same', escalation: { criterion: 'risk_path', by: 'slop', reason: machine.ROLLOUT_ESCALATION_REASON }, mergeHold: null });
    expect(types(t)).toEqual(['FieldsChanged', 'Escalated']);
    expect(effectKinds(t)).toEqual(['sync_pr_labels']);
    expect(machine.ROLLOUT_ESCALATION_REASON).toBe('Has rollout steps: a person merges it, and it stays open for them');
  });

  it('converts a sub in any state before its merge, and leaves a merged one alone', () => {
    for (const status of ['planning', 'implementing', 'in_progress'] as const)
      expect(unwrap(machine.rolloutStepsAdded(fixture({ type: 'sub', status, pr: null }), ctx(null))).glob.type).toBe('same');
    expect(unwrap(machine.rolloutStepsAdded(merged({ type: 'sub' }), ctx(null))).changed).toBe(false);
  });

  it('disarms an armed merge of a same', () => {
    const armed = ready({ mergeMode: 'when_green', headChecks: { sha: 'abc1234', state: 'pending' } });
    const t = unwrap(machine.rolloutStepsAdded(armed, ctx(null)));
    expect(t.glob.mergeMode).toBeNull();
    expect(t.events).toEqual([expect.objectContaining({ type: 'MergeDisarmed', data: { reason: 'rollout_steps' } })]);
  });

  it('changes nothing for a same (or super) that is not armed, and for human work', () => {
    expect(unwrap(machine.rolloutStepsAdded(ready(), ctx(null))).changed).toBe(false);
    expect(unwrap(machine.rolloutStepsAdded(ready({ type: 'super' }), ctx(null))).changed).toBe(false);
    expect(unwrap(machine.rolloutStepsAdded(fixture({ category: 'decision', type: null }), ctx(null))).changed).toBe(false);
  });

  it('a converted sub is a same the sub gate leaves alone: it has no sub status to merge from', () => {
    const t = unwrap(machine.rolloutStepsAdded(ready({ type: 'sub' }), ctx(null)));
    expect(machine.allowedActions(t.glob, dev, { rolloutSteps: 1 })).toContain('merge');
    expect(machine.allowedActions(t.glob, dev, { rolloutSteps: 1 })).not.toContain('merge_continue');
  });
});

describe('rolloutStepFailed (row 31a)', () => {
  const failed = (g: Glob, patch: Partial<Parameters<typeof machine.rolloutStepFailed>[1]> = {}, actor = dev) =>
    machine.rolloutStepFailed(g, { stepId: 'hs_1', title: 'Roll out the stack', stepState: 'open', mergeSha: 'sha1', ...patch }, ctx(actor));

  it('turns a merged sub that gained steps into a same, so the next generation never goes through the sub gate', () => {
    const t = unwrap(failed(merged({ type: 'sub', mergeHold: { reason: 'x' } as never })));
    expect(t.glob).toMatchObject({ type: 'same', escalation: { criterion: 'risk_path', reason: machine.ROLLOUT_ESCALATION_REASON }, mergeHold: null });
    expect(types(t)).toEqual(expect.arrayContaining(['FieldsChanged', 'Escalated', 'RolloutStepFailed']));
    const next = { ...t.glob, status: 'implementing' as const };
    const ready = unwrap(machine.prReadyForReview(next, { number: 8, headSha: 'def5678' }, ctx(null)));
    expect(effectKinds(ready)).not.toContain('evaluate_sub_gate');
  });

  it('leaves a same as it is (no second escalation)', () => {
    const t = unwrap(failed(merged()));
    expect(types(t)).not.toContain('Escalated');
  });

  it('starts the next generation on a fresh branch with a new run', () => {
    const g = merged({ generation: 2, labels: { FR: 'added' }, checklists: { FR: [{ id: 'c1', text: 'x', done: false, addedBy: dev.email, addedAt: NOW, doneBy: null, doneAt: null }] } });
    const t = unwrap(failed(g));
    expect(t.glob).toMatchObject({
      status: 'implementing',
      generation: 3,
      pr: null,
      headChecks: null,
      provisioning: 'pending',
      labels: {},
      checklists: {},
      failure: null,
      mergeMode: null,
      implementer: null,
    });
    expect(t.glob.prs).toEqual([{ number: 7, mergeSha: 'sha1', mergedAt: NOW }]);
    expect(types(t)).toEqual(['RolloutStepFailed', 'StatusChanged', 'RunTriggered']);
    expect(t.events[0]?.data).toEqual({ step: 'hs_1', title: 'Roll out the stack', generation: 3 });
    // The old branch goes first (at the new generation), then the fresh one is provisioned and the run queued.
    expect(t.effects.map((e) => [e.kind, 'generation' in e ? e.generation : null])).toEqual([
      ['delete_branch', 3],
      ['provision', 3],
      ['fire_routine', 3],
    ]);
    expect(t.glob.runs.at(-1)).toMatchObject({ state: 'queued', generation: 3, triggeredBy: dev.email });
  });

  it('clears the conflict and keeps earlier merged PRs', () => {
    const g = merged({ prs: [{ number: 3, mergeSha: 's0', mergedAt: NOW }], conflict: { since: NOW } as never });
    const t = unwrap(failed(g));
    expect(t.glob.prs.map((p) => p.number)).toEqual([3, 7]);
    expect(t.glob.conflict).toBeNull();
  });

  it('a person implementing keeps it: in_progress, no run', () => {
    const t = unwrap(failed(merged({ implementer: dev.email })));
    expect(t.glob).toMatchObject({ status: 'in_progress', implementer: dev.email, provisioning: 'pending' });
    expect(types(t)).toEqual(['RolloutStepFailed', 'StatusChanged']);
    expect(effectKinds(t)).toEqual(['delete_branch', 'provision']);
  });

  it('a super goes back to its creator, with no run', () => {
    const t = unwrap(failed(merged({ type: 'super' })));
    expect(t.glob).toMatchObject({ status: 'in_progress', implementer: dev.email });
    expect(effectKinds(t)).not.toContain('fire_routine');
  });

  it('is refused unless the glob is merged and reviewing', () => {
    for (const g of [ready(), merged({ status: 'signed_off' }), merged({ status: 'implementing', pr: null }), merged({ pr: { number: 7, state: 'ready', headSha: 'a' } })])
      expect(failed(g).ok).toBe(false);
  });

  it('is refused for a dismissed step, and takes an open or done one', () => {
    expect(failed(merged(), { stepState: 'dismissed' }).ok).toBe(false);
    expect(failed(merged(), { stepState: 'done' }).ok).toBe(true);
  });

  it('is closed to QA and PO on a same or super, open to them on a sub', () => {
    const refused = failed(merged(), {}, po);
    expect(!refused.ok && refused.error.code).toBe('forbidden');
    expect(failed(merged({ type: 'super' }), {}, po).ok).toBe(false);
    expect(failed(merged({ type: 'sub' }), {}, po).ok).toBe(true);
    expect(failed(merged(), {}, admin).ok).toBe(true);
  });

  it('makes the step pending until the next merge, then due again', () => {
    const step = { state: 'open' as const, due: 'after_merge' as const, dueSince: null };
    const before = merged();
    expect(stateOf(before, step)).toBe('due');
    const next = unwrap(failed(before)).glob;
    expect(stateOf(next, step)).toBe('pending');
    // The next generation goes through its PR and a plain merge, as any same does.
    const open = { ...next, status: 'pr_open' as const, pr: { number: 9, state: 'ready' as const, headSha: 'def5678' }, headChecks: { sha: 'def5678', state: 'passed' as const } };
    expect(machine.allowedActions(open, dev, { rolloutSteps: 1 })).toContain('merge');
    const merging = unwrap(machine.requestMerge(open, ctx(dev), { continue: true, facts: { rolloutSteps: 1 } })).glob;
    expect(stateOf(merging, step)).toBe('pending');
    const landed = unwrap(machine.merged(merging, { sha: 'sha2', number: 9 }, ctx(null))).glob;
    expect(landed.status).toBe('reviewing');
    expect(stateOf(landed, step)).toBe('due');
    expect(landed.generation).toBe(2);
  });

  it('a late observation of the old merged PR after the next generation is a no-op', () => {
    const next = unwrap(failed(merged())).glob;
    const late = unwrap(machine.merged(next, { sha: 'sha1', number: 7 }, ctx(null)));
    expect(late.changed).toBe(false);
    expect(late.glob.status).toBe('implementing');
    expect(late.effects).toEqual([]);
  });
});

describe('escalation criterion risk_path', () => {
  const event = (type: DomainEvent['type'], at: string, data: DomainEvent['data'] = {}): DomainEvent => ({ type, globId: 's1t1', actor: null, at, data });
  const facts = (events: DomainEvent[], globs: Glob[]): EscalationFacts => ({ events, globs, recorded: new Set(), now: '2027-01-01T00:00:00.000Z' });

  it('is a criterion agents and slop can name', () => {
    expect(ESCALATION_CRITERIA).toContain('risk_path');
  });

  it('is skipped by the outcome learning, merged clean, de-escalated or reverted', () => {
    const escalated = event('Escalated', '2026-10-01T00:00:00.000Z', { reason: machine.ROLLOUT_ESCALATION_REASON, criterion: 'risk_path' });
    const g = fixture({ status: 'signed_off' });
    expect(escalationCandidates(facts([escalated, event('Merged', '2026-10-02T00:00:00.000Z')], [g]))).toEqual([]);
    expect(escalationCandidates(facts([escalated, event('Deescalated', '2026-10-02T00:00:00.000Z')], [g]))).toEqual([]);
    expect(escalationCandidates(facts([escalated, event('Merged', '2026-10-02T00:00:00.000Z'), event('MergeReverted', '2026-10-03T00:00:00.000Z')], [g]))).toEqual([]);
  });

  it('liftRiskAreaEscalation leaves it alone', () => {
    const escalated = fixture({ type: 'same', status: 'planning', pr: null, escalation: { reason: machine.ROLLOUT_ESCALATION_REASON, criterion: 'risk_path', by: 'slop', at: NOW } });
    expect(unwrap(machine.liftRiskAreaEscalation(escalated, ctx(null), undefined, ['infra'])).changed).toBe(false);
  });

  it('keeps QA and PO closed on the escalated same', () => {
    const escalated = fixture({ type: 'same', status: 'planning', escalation: { reason: machine.ROLLOUT_ESCALATION_REASON, criterion: 'risk_path', by: 'slop', at: NOW } });
    expect(machine.start(escalated, ctx(po)).ok).toBe(false);
    expect(machine.pickUp(escalated, ctx(po), board, { takeOver: false }).ok).toBe(false);
    expect(machine.allowedActions(escalated, po)).not.toContain('pick_up');
    expect(machine.allowedActions(escalated, po)).not.toContain('start');
    expect(machine.startAgain(escalated, ctx(po)).ok).toBe(false);
  });
});

describe('openRolloutSteps', () => {
  const step = (patch: Partial<StoredHumanStep> = {}): StoredHumanStep => ({
    id: 'hs_1',
    boardId: 1,
    globId: 's1t1',
    kind: 'rollout',
    title: 'Roll out',
    detail: null,
    who: 'anyone',
    due: 'after_merge',
    state: 'open',
    blocks: ['sign_off', 'dependants'],
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

  it('counts open rollout steps that hold back sign-off', () => {
    expect(openRolloutSteps([step(), step({ id: 'hs_2' })])).toBe(2);
  });

  it('skips done and dismissed steps, other kinds, steps that do not block sign-off, and the prediction', () => {
    expect(
      openRolloutSteps([
        step({ state: 'done' }),
        step({ state: 'dismissed' }),
        step({ kind: 'action' }),
        step({ blocks: [] }),
        step({ due: 'after_deploy:prod', blocks: [] }),
        step({ origin: 'investigation', title: 'Rollout: steps to be written' }),
      ]),
    ).toBe(0);
  });
});

describe('through the service', () => {
  const DEV = 'dev@example.com';
  const PO = 'po@example.com';
  const ADMIN = 'admin@example.com';
  let store: MemoryStore;
  let globs: GlobService;
  let boardId: number;
  let runs: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Ship it',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const update = async (id: string, patch: Partial<Glob>): Promise<Glob> =>
    store.transaction(async (tx) => {
      const current = (await tx.getGlob(id)) as Glob;
      const next = { ...current, ...patch, version: current.version + 1 };
      await tx.updateGlob(next, current.version);
      return next;
    });
  const peek = async (id: string): Promise<Glob> => {
    const g = await globs.peek(id);
    if (g === null) throw new Error('missing');
    return g;
  };
  /** A same with a ready PR whose checks passed. */
  const readyGlob = async (type: 'sub' | 'same' = 'same'): Promise<Glob> => {
    const created = unwrap(await globs.create(type === 'sub' ? ADMIN : DEV, input({ type })));
    return update(created.id, { status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'abc1234' }, headChecks: { sha: 'abc1234', state: 'passed' }, provisioning: 'ok' });
  };
  const landed = (id: string): Promise<Glob> =>
    update(id, { status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'abc1234' }, labels: { CR: 'required' } });
  const attachments = (id: string) => store.transaction((tx) => tx.listArtifacts(id, 'attachment'));
  const stepsOf = (id: string) => store.transaction((tx) => tx.listHumanSteps(boardId, [id]));

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => '2026-10-13T12:00:00.000Z' },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, PO, 'outsider@example.com']) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [{ name: 'staging', allowBranchDeploy: false }, { name: 'production', allowBranchDeploy: false }, { name: 'prod', allowBranchDeploy: false }] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardId, PO, 'po'));
  });

  it('a step written for a sub makes it a same escalated for risk_path', async () => {
    const g = await readyGlob('sub');
    unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out the stack' }));
    const after = await peek(g.id);
    expect(after).toMatchObject({ type: 'same', escalation: { criterion: 'risk_path' } });
    const view = unwrap(await globs.get(DEV, g.id));
    expect(view.allowedActions).toContain('merge');
    expect(view.allowedActions).not.toContain('merge_continue');
    expect(view.humanSteps.find((s) => s.kind === 'merge')).toMatchObject({ title: 'Merge' });
  });

  it('de-escalating a rollout same is refused through the service while a step is open', async () => {
    const g = await readyGlob('sub');
    unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out the stack' }));
    const same = await peek(g.id);
    const refused = await globs.deescalate(ADMIN, g.id, same.version);
    expect(!refused.ok && refused.error.message).toContain('must be merged');
    expect((await peek(g.id)).type).toBe('same');
  });

  it('a step that holds nothing back (after a deploy) or a prediction leaves a sub alone', async () => {
    const g = await readyGlob('sub');
    unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Later', due: 'after_deploy:prod' }));
    expect((await peek(g.id)).type).toBe('sub');
  });

  it('a step written while merge is armed disarms it', async () => {
    const g = await readyGlob();
    const armed = await update(g.id, { mergeMode: 'when_green', headChecks: { sha: 'abc1234', state: 'pending' } });
    unwrap(await globs.addHumanStep(DEV, armed.id, null, { title: 'Roll out the stack' }));
    expect((await peek(g.id)).mergeMode).toBeNull();
  });

  it('merge with steps keeps the glob open for them and merge_continue is an alias; without steps merge works', async () => {
    const withSteps = await readyGlob();
    unwrap(await globs.addHumanStep(DEV, withSteps.id, null, { title: 'Roll out' }));
    const merging = unwrap(await globs.merge(DEV, withSteps.id, (await peek(withSteps.id)).version));
    expect(merging).toMatchObject({ status: 'merging', mergeMode: null });
    // It joins the board's line; its turn queues the merge.
    expect(store.state.outbox.filter((e) => e.kind === 'advance_merge_line')).toHaveLength(1);
    expect((await globs.advanceMergeLine(withSteps.boardId))?.id).toBe(withSteps.id);
    expect(store.state.outbox.filter((e) => e.kind === 'squash_merge' && e.globId === withSteps.id)).toHaveLength(1);
    const without = await readyGlob();
    expect(unwrap(await globs.merge(DEV, without.id, without.version)).status).toBe('merging');
  });

  it('merge anyway loads the rollout steps: a same with steps is merged and kept open for them, not closed', async () => {
    const held = await readyGlob();
    const blocker = unwrap(await globs.create(DEV, input({ title: 'Blocker' })));
    unwrap(await globs.addHumanStep(DEV, held.id, null, { title: 'Roll out' }));
    unwrap(await globs.addRelation(DEV, held.id, null, { to: blocker.id, gate: 'merge', reason: 'merges after it' }, 'held_by', 'person'));
    const merging = unwrap(await globs.mergeAnyway(DEV, held.id, (await peek(held.id)).version, 'the blocker is unrelated'));
    expect(merging).toMatchObject({ status: 'merging', mergeMode: null });
    const status = store.state.events.filter((e) => e.globId === held.id && e.type === 'StatusChanged').at(-1);
    expect(status?.data).toMatchObject({ to: 'merging', mode: 'rollout' });
  });

  it('pick up works on a merged glob while a step is open, and not after', async () => {
    const g = await readyGlob();
    const step = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out' }));
    const done = await landed(g.id);
    const picked = unwrap(await globs.pickUp(DEV, g.id, done.version, false));
    expect(picked).toMatchObject({ status: 'reviewing', implementer: DEV });
    unwrap(await globs.completeHumanStep(DEV, g.id, step.id, null));
    const signedOff = await peek(g.id);
    expect((await globs.pickUp(DEV, g.id, signedOff.version, false)).ok).toBe(false);
  });

  describe('once steps (s15t237)', () => {
    const mergedWithOnce = async () => {
      const g = await readyGlob();
      const once = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Grant the Lambda access', once: true, commands: ['aws iam put-role-policy'] }));
      const rollout = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out the host stack' }));
      const done = await update(g.id, { status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'abc1234' }, labels: { CR: 'required' } });
      return { glob: done, once, rollout };
    };

    it('is stored as due once, with no environment, holding back sign-off and dependants like an after-merge step', async () => {
      const { once } = await mergedWithOnce();
      expect(once).toMatchObject({ due: 'once', dueSince: null, blocks: ['sign_off', 'dependants'], kind: 'rollout' });
    });

    it('stays done when a later step fails and the glob starts its next generation, while the failed step comes back open', async () => {
      const { glob, once, rollout } = await mergedWithOnce();
      unwrap(await globs.completeHumanStep(DEV, glob.id, once.id, null));
      unwrap(await globs.failHumanStep(DEV, glob.id, rollout.id, 'Policy refused.', (await peek(glob.id)).version));
      expect((await peek(glob.id)).generation).toBe(glob.generation + 1);
      const steps = await stepsOf(glob.id);
      expect(steps.find((s) => s.id === once.id)).toMatchObject({ state: 'done', doneBy: DEV });
      expect(steps.find((s) => s.id === rollout.id)).toMatchObject({ state: 'open' });
    });

    it('is never reopened by its own failure: a done once step is refused the next generation', async () => {
      const { glob, once } = await mergedWithOnce();
      unwrap(await globs.completeHumanStep(DEV, glob.id, once.id, null));
      const failed = await globs.failRolloutStep(DEV, glob.id, once.id, 'It broke.', (await peek(glob.id)).version);
      expect(!failed.ok && failed.error.message).toContain('once');
      expect((await peek(glob.id)).generation).toBe(glob.generation);
      expect((await stepsOf(glob.id)).find((s) => s.id === once.id)?.state).toBe('done');
    });

    it('failing an open once step asks for a fix glob instead of starting a generation', async () => {
      const { glob, once } = await mergedWithOnce();
      unwrap(await globs.failHumanStep(DEV, glob.id, once.id, 'Access denied.', (await peek(glob.id)).version));
      expect((await peek(glob.id)).generation).toBe(glob.generation);
      expect((await stepsOf(glob.id)).find((s) => s.id === once.id)?.state).toBe('open');
    });

    it('is pending until its script path is on the glob branch, then due', async () => {
      const g = await readyGlob();
      unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Grant access', once: true, script: { path: 'scripts/rollout/x-grant.sh' } }));
      const onBranch = new Set<string>();
      const seen: (string | null)[] = [];
      const withView = new GlobService({
        store,
        notifier: new RecordingNotifier(),
        clock: { now: () => '2026-10-13T12:00:00.000Z' },
        ids: { runId: () => `view-${++runs}` },
        routines: { hasRoutine: () => Promise.resolve(true) },
        codeView: {
          read: (_board, ref, path) => {
            seen.push(ref);
            return Promise.resolve(onBranch.has(path) ? ({ path } as never) : null);
          },
        },
      });
      const stateNow = async () => unwrap(await withView.get(DEV, g.id)).humanSteps.find((s) => s.title === 'Grant access')?.state;
      expect(await stateNow()).toBe('pending');
      onBranch.add('scripts/rollout/x-grant.sh');
      expect(await stateNow()).toBe('due');
      expect(seen.every((ref) => ref === g.id)).toBe(true);
    });

    it('refuses once with another due', async () => {
      const g = await readyGlob();
      const refused = await globs.addHumanStep(DEV, g.id, null, { title: 'x', once: true, due: 'after_deploy:prod' });
      expect(!refused.ok && refused.error.message).toContain('once');
    });

    it('is due before the merge when it has no script, and still holds back sign-off', async () => {
      const g = await readyGlob();
      unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Grant access', due: 'once' }));
      const view = unwrap(await globs.get(DEV, g.id));
      expect(view.humanSteps.find((s) => s.title === 'Grant access')).toMatchObject({ due: 'once', state: 'due' });
      expect(view.rolloutSteps).toBe(1);
    });
  });

  it('refuses a step for an environment the board does not define, naming the ones it has', async () => {
    const g = await readyGlob();
    const refused = await globs.addHumanStep(DEV, g.id, null, { title: 'Later', due: 'after_deploy:eu' });
    expect(!refused.ok && refused.error.message).toBe("Unknown environment eu: this board's environments are staging, production, prod");
    expect(await stepsOf(g.id)).toHaveLength(0);
  });

  it('flags an open step whose environment the board no longer has in the glob view', async () => {
    const g = await readyGlob();
    const step = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Later', due: 'after_deploy:prod' }));
    await store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board !== null) await tx.updateBoard({ ...board, environments: [{ name: 'staging', allowBranchDeploy: false }] }, board.version);
    });
    const view = unwrap(await globs.get(DEV, g.id));
    expect(view.humanSteps.find((s) => s.id === step.id)).toMatchObject({ unknownEnvironment: 'prod', state: 'pending' });
  });

  describe('failHumanStep routes a failed step', () => {
    const mergedWith = async (patch: Partial<Glob> = {}) => {
      const g = await readyGlob();
      const rollout = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out the host stack' }));
      const other = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Tell support', kind: 'action' }));
      // A required label keeps sign-off waiting once the rollout step is ticked.
      const done = await update(g.id, { status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'abc1234' }, labels: { CR: 'required' }, ...patch });
      return { glob: done, rollout, other };
    };
    const suggestions = (id: string) => store.transaction((tx) => tx.listOpenSuggestions([id]));

    it('a rollout step of a merged glob starts the next generation and comes back open', async () => {
      const { glob, rollout } = await mergedWith();
      const step = unwrap(await globs.failHumanStep(DEV, glob.id, rollout.id, 'Policy refused.', (await peek(glob.id)).version));
      expect(step).toMatchObject({ id: rollout.id, state: 'open' });
      expect((await peek(glob.id)).generation).toBe(glob.generation + 1);
      expect((await attachments(glob.id)).map((a) => a.label)).toEqual([`Rollout step failed (generation ${glob.generation})`]);
      expect(await suggestions(glob.id)).toHaveLength(0);
    });

    it('a done rollout step of a merged glob is reopened', async () => {
      const { glob, rollout } = await mergedWith();
      unwrap(await globs.completeHumanStep(DEV, glob.id, rollout.id, null));
      const step = unwrap(await globs.failHumanStep(DEV, glob.id, rollout.id, 'it broke', null));
      expect(step).toMatchObject({ state: 'open', doneBy: null });
      expect((await peek(glob.id)).generation).toBe(glob.generation + 1);
    });

    it('any other step of the same merged glob gets the fix-glob suggestion and no new generation', async () => {
      const { glob, other } = await mergedWith();
      const step = unwrap(await globs.failHumanStep(DEV, glob.id, other.id, 'support was not told', null));
      expect(step.state).toBe('open');
      expect((await peek(glob.id)).generation).toBe(glob.generation);
      expect((await suggestions(glob.id)).map((s) => [s.kind, s.mentionedId])).toEqual([['step_failed', other.id]]);
      expect(await attachments(glob.id)).toHaveLength(0);
    });

    it('a rollout step of a glob that is not merged, or is signed off, takes the suggestion path', async () => {
      for (const patch of [{ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'abc1234' } }, { status: 'signed_off' }] as Partial<Glob>[]) {
        const { glob, rollout } = await mergedWith(patch);
        unwrap(await globs.failHumanStep(DEV, glob.id, rollout.id, 'it broke', null));
        expect((await peek(glob.id)).generation).toBe(glob.generation);
        expect((await suggestions(glob.id)).map((s) => s.kind)).toEqual(['step_failed']);
      }
    });

    it('a stale version on the routed path is a version conflict', async () => {
      const { glob, rollout } = await mergedWith();
      const stale = await globs.failHumanStep(DEV, glob.id, rollout.id, 'x', glob.version + 5);
      expect(!stale.ok && stale.error.code).toBe('version_conflict');
      expect((await peek(glob.id)).generation).toBe(glob.generation);
    });
  });

  describe('failRolloutStep', () => {
    const setup = async (patch: Partial<Glob> = {}) => {
      const g = await readyGlob();
      const step = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out the host stack', commands: ['./scripts/rollout/host.sh', 'export TOKEN=hunter2secret'] }));
      await store.transaction(async (tx) => {
        await tx.appendEvents([{ type: 'Merged', globId: g.id, actor: null, at: '2026-10-13T11:00:00.000Z', data: { sha: 'merge-sha-1' } }]);
      });
      const done = await update(g.id, { status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'abc1234' }, labels: { CR: 'required' }, ...patch });
      return { glob: done, step };
    };

    it('serves the failure attachment in full through get_context, without an include', async () => {
      const { glob, step } = await setup();
      unwrap(await globs.failRolloutStep(DEV, glob.id, step.id, 'Policy refused.', (await peek(glob.id)).version));
      const artifacts = new ArtifactService({ store, clock: { now: () => '2026-10-13T12:00:00.000Z' }, notifier: new RecordingNotifier() });
      const context = unwrap(await artifacts.context(DEV, glob.id));
      expect(context.attachments.map((a) => a.label)).toEqual(['Rollout step failed (generation 1)']);
      expect(context.attachments[0]?.content).toContain('Policy refused.');
      expect(context.available.map((a) => a.label)).not.toContain('Rollout step failed (generation 1)');
    });

    it('starts the next generation, with a masked attachment for the next run, and reopens a done step', async () => {
      const { glob, step } = await setup();
      unwrap(await globs.completeHumanStep(DEV, glob.id, step.id, null));
      expect((await stepsOf(glob.id))[0]?.state).toBe('done');
      const note = 'Policy refused.\nAKIAABCDEFGHIJKLMNOP and aws_secret_access_key=abcdEFGH1234abcdEFGH1234abcdEFGH1234';
      const next = unwrap(await globs.failRolloutStep(DEV, glob.id, step.id, note, (await peek(glob.id)).version));
      expect(next).toMatchObject({ status: 'implementing', generation: 2, pr: null, implementer: null });
      expect(next.prs).toEqual([{ number: 7, mergeSha: 'merge-sha-1', mergedAt: '2026-10-13T12:00:00.000Z' }]);
      expect(next.runs.at(-1)).toMatchObject({ state: 'queued', generation: 2 });
      expect(store.state.outbox.filter((e) => e.globId === glob.id && 'generation' in e && e.generation === 2).map((e) => e.kind)).toEqual(['delete_branch', 'provision', 'fire_routine']);
      const kept = await attachments(glob.id);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.label).toBe('Rollout step failed (generation 1)');
      expect(kept[0]?.content).toContain('Roll out the host stack');
      expect(kept[0]?.content).toContain('Policy refused.');
      expect(kept[0]?.content).toContain('./scripts/rollout/host.sh');
      expect(kept[0]?.content).toContain('merge-sha-1');
      expect(kept[0]?.content).not.toContain('AKIAABCDEFGHIJKLMNOP');
      expect(kept[0]?.content).not.toContain('abcdEFGH1234');
      expect(kept[0]?.content).not.toContain('hunter2secret');
      expect(kept[0]?.content).toContain('[masked]');
      const [reopened] = await stepsOf(glob.id);
      expect(reopened).toMatchObject({ state: 'open', doneBy: null, doneAt: null });
      const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['HumanStepChanged', 'RolloutStepFailed'], [glob.id]));
      expect(events.some((e) => e.type === 'RolloutStepFailed' && e.data.generation === 2)).toBe(true);
      expect(events.some((e) => e.type === 'HumanStepChanged' && e.data.change === 'failed')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('Policy refused');
    });

    it('caps a long note after masking', async () => {
      const { glob, step } = await setup();
      unwrap(await globs.failRolloutStep(DEV, glob.id, step.id, 'x'.repeat(20000), null));
      const content = (await attachments(glob.id))[0]?.content ?? '';
      expect(content.length).toBeLessThan(9000);
      expect(content).toContain('note cut at 8000');
    });

    it('a person implementing keeps the glob: in_progress and no run', async () => {
      const { glob, step } = await setup({ implementer: DEV });
      const next = unwrap(await globs.failRolloutStep(DEV, glob.id, step.id, 'it broke', null));
      expect(next).toMatchObject({ status: 'in_progress', implementer: DEV, generation: 2 });
      expect(store.state.outbox.filter((e) => e.kind === 'fire_routine' && e.globId === glob.id)).toHaveLength(0);
    });

    it('is for members, for a merged glob, and for a step of the glob', async () => {
      const { glob, step } = await setup();
      expect((await globs.failRolloutStep('outsider@example.com', glob.id, step.id, 'x', null)).ok).toBe(false);
      const missing = await globs.failRolloutStep(DEV, glob.id, 'hs_nope', 'x', null);
      expect(!missing.ok && missing.error.code).toBe('not_found');
      const stale = await globs.failRolloutStep(DEV, glob.id, step.id, 'x', 999);
      expect(!stale.ok && stale.error.code).toBe('version_conflict');
      const qa = await globs.failRolloutStep(PO, glob.id, step.id, 'x', null);
      expect(!qa.ok && qa.error.code).toBe('forbidden');
      expect(await attachments(glob.id)).toHaveLength(0);
      const open = await readyGlob();
      const s = unwrap(await globs.addHumanStep(DEV, open.id, null, { title: 'Roll out' }));
      expect((await globs.failRolloutStep(DEV, open.id, s.id, 'x', null)).ok).toBe(false);
      expect(await attachments(open.id)).toHaveLength(0);
      expect((await stepsOf(open.id))[0]?.state).toBe('open');
    });

    it('the step is due again after the next merge, and sign-off waits for it', async () => {
      const { glob, step } = await setup();
      const next = unwrap(await globs.failRolloutStep(DEV, glob.id, step.id, 'it broke', null));
      const [stored] = await stepsOf(glob.id);
      if (stored === undefined) throw new Error('missing step');
      expect(stateOf(next, stored)).toBe('pending');
      const pr = await update(glob.id, { status: 'pr_open', pr: { number: 9, state: 'ready', headSha: 'def5678' }, headChecks: { sha: 'def5678', state: 'passed' } });
      const merging = unwrap(await globs.merge(DEV, glob.id, pr.version, true));
      const again = unwrap(machine.merged(merging, { sha: 'sha2', number: 9 }, ctx(null)));
      const second = await update(glob.id, again.glob);
      expect(stateOf(second, stored)).toBe('due');
      expect(second.generation).toBe(2);
      // The old PR's late merged observation changes nothing.
      expect(unwrap(machine.merged(second, { sha: 'merge-sha-1', number: 7 }, ctx(null))).changed).toBe(false);
      const refused = await globs.reviewLabel(PO, glob.id, second.version, 'CR', { kind: 'approve' });
      expect(!refused.ok && refused.error.message).toContain('Rollout pending (1 of 1)');
    });
  });

  it('completeHumanStep keeps a masked note in the event only', async () => {
    const g = await readyGlob();
    const step = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out' }));
    await landed(g.id);
    unwrap(await globs.completeHumanStep(DEV, g.id, step.id, null, 'Ran it by hand on the branch. password=hunter2pass'));
    const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['HumanStepChanged'], [g.id]));
    const done = events.find((e) => e.data.change === 'done');
    expect(done?.data.note).toBe('Ran it by hand on the branch. password=[masked]');
    expect((await stepsOf(g.id))[0]).not.toHaveProperty('note');
  });
});
