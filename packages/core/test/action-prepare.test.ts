import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { ACTION_FAILURE_LABEL, GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { ArtifactService } from '../src/app/artifact-service.js';
import { actionState, hasBranchRecord, preparationOf } from '../src/domain/action-glob.js';
import type { ActionState } from '../src/domain/action-glob.js';
import { doThisCommands, fetchCommandFor } from '../src/domain/action-script.js';
import { validateAttributes } from '../src/domain/attributes.js';
import type { ActionAttributes, ActionRecordKind } from '../src/domain/attributes.js';
import { needsHuman } from '../src/domain/attention.js';
import type { Result } from '../src/domain/errors.js';
import { derivedSteps } from '../src/domain/human-steps.js';
import * as machine from '../src/domain/machine.js';
import type { Transition } from '../src/domain/machine.js';
import type { Glob, Run } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board, ctx, dev, glob, relationFacts, run } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);
const kinds = (t: Transition): string[] => t.effects.map((e) => e.kind);

const attributes = (record: ActionRecordKind | null, rounds: number, patch: Partial<ActionAttributes> = {}): ActionAttributes => ({
  assignee: null,
  outcome: null,
  ...(record === null ? {} : { preparation: { record, rounds } }),
  ...patch,
});

const prepRun = (patch: Partial<Run> = {}): Run => run({ purpose: 'prepare', ...patch });
const ended = (): Run => prepRun({ state: 'ended', outcome: 'completed', endedAt: NOW });

/** A prepared action as the machine leaves it, by state. */
const prepared = (state: 'preparing' | 'ready' | 'recording' | 'failed', record: ActionRecordKind = 'branch', patch: Partial<Glob> = {}): Glob => {
  const hasPr = record === 'branch';
  const base: Partial<Glob> = {
    id: 's1a1',
    category: 'action',
    type: null,
    provisioning: hasPr ? 'ok' : 'none',
    pr: hasPr ? { number: 7, state: 'draft', headSha: 'aaa' } : null,
  };
  switch (state) {
    case 'preparing':
      return glob({ ...base, status: 'implementing', attributes: attributes(record, 1), runs: [prepRun()], doingSince: NOW, ...patch });
    case 'failed':
      return glob({
        ...base,
        status: 'failed',
        attributes: attributes(record, 1),
        runs: [prepRun({ state: 'ended', outcome: 'failed', failureReason: 'boom', endedAt: NOW })],
        failure: { reason: 'boom', at: NOW },
        ...patch,
      });
    case 'ready':
      return glob({
        ...base,
        status: hasPr ? 'pr_open' : 'in_progress',
        attributes: attributes(record, 1),
        runs: [ended()],
        ...(hasPr ? { pr: { number: 7, state: 'ready' as const, headSha: 'aaa' } } : {}),
        ...patch,
      });
    case 'recording':
      return glob({
        ...base,
        status: 'pr_open',
        attributes: attributes(record, 1, { outcome: { kind: 'done', by: dev.email, at: NOW } }),
        runs: [ended()],
        pr: { number: 7, state: 'ready', headSha: 'aaa' },
        ...patch,
      });
  }
};

const create = (patch: Partial<machine.CreateInput> = {}): Result<Transition> =>
  machine.create(
    {
      id: 's1a1',
      boardId: 1,
      title: 'Scope the apigateway permission',
      type: null,
      category: 'action',
      attributes: attributes('branch', 0),
      group: null,
      environment: null,
      autoTrigger: false,
      ...patch,
    },
    board,
    ctx(dev),
  );

describe('A1: creating a prepared action', () => {
  it('starts preparing at once: Doing, a prepare run, the branch provisioned, no labels, no environment', () => {
    const t = unwrap(create());
    expect(t.glob).toMatchObject({ category: 'action', type: null, status: 'implementing', labels: {}, environment: null, provisioning: 'pending', doingSince: NOW });
    expect(t.glob.attributes).toEqual({ assignee: null, outcome: null, preparation: { record: 'branch', rounds: 1 } });
    expect(t.glob.runs).toMatchObject([{ state: 'queued', purpose: 'prepare', generation: 1 }]);
    expect(t.effects.map((e) => e.kind)).toEqual(['provision', 'fire_routine']);
    expect(t.effects[1]).toMatchObject({ kind: 'fire_routine', purpose: 'prepare' });
    expect(t.events.map((e) => e.type)).toEqual(['GlobCreated', 'RunTriggered']);
  });

  it('provisions no branch for an artifact or attachment record', () => {
    for (const record of ['artifact', 'attachment'] as const) {
      const t = unwrap(create({ attributes: attributes(record, 0) }));
      expect(t.glob).toMatchObject({ status: 'implementing', provisioning: 'none' });
      expect(kinds(t)).toEqual(['fire_routine']);
    }
  });

  it('waits in Planning, with no effects, while a start relation is unmet, and starts when released', () => {
    const t = unwrap(create({ waitingFor: ['s1t1'] }));
    expect(t.glob).toMatchObject({ status: 'planning', waiting: { since: NOW }, runs: [], provisioning: 'none' });
    expect(t.effects).toEqual([]);
    expect(actionState(t.glob)).toBe('waiting');
    const r = unwrap(machine.released(t.glob, ctx(dev), relationFacts('s1a1', [['s1t1', 'merged']])));
    expect(r.glob).toMatchObject({ status: 'implementing', waiting: null });
    expect(r.glob.attributes).toMatchObject({ preparation: { record: 'branch', rounds: 1 } });
    expect(kinds(r)).toEqual(['provision', 'fire_routine']);
  });

  it('is unchanged for a plain action, and refuses rounds already counted', () => {
    const plain = unwrap(create({ attributes: attributes(null, 0) }));
    expect(plain.glob).toMatchObject({ status: 'planning', runs: [] });
    expect(plain.effects).toEqual([]);
    expect(code(create({ attributes: attributes('branch', 2) }))).toBe('invalid_input');
  });

  it('validates the preparation attributes', () => {
    expect(validateAttributes('action', { assignee: null, outcome: null, preparation: { record: 'artifact', rounds: 0 } }).ok).toBe(true);
    expect(code(validateAttributes('action', { preparation: { record: 'branchy', rounds: 0 } }))).toBe('invalid_input');
    expect(code(validateAttributes('action', { preparation: { record: 'branch', rounds: -1 } }))).toBe('invalid_input');
    expect(code(validateAttributes('action', { preparation: { record: 'branch', rounds: 1, extra: 1 } }))).toBe('invalid_input');
  });
});

describe('actionState: the states a card shows', () => {
  const states: readonly (readonly [string, Glob, ActionState])[] = [
    ['a plain open action', glob({ category: 'action', type: null, attributes: attributes(null, 0), status: 'planning' }), 'open'],
    ['a plain done action', glob({ category: 'action', type: null, attributes: attributes(null, 0, { outcome: { kind: 'done', by: 'a', at: NOW } }), status: 'signed_off' }), 'closed'],
    ['a prepared action not started', glob({ category: 'action', type: null, attributes: attributes('branch', 0), status: 'planning' }), 'waiting'],
    ['preparing', prepared('preparing'), 'preparing'],
    ['a failed preparation', prepared('failed'), 'preparation_failed'],
    ['ready, a branch record', prepared('ready'), 'ready'],
    ['ready, an artifact record', prepared('ready', 'artifact'), 'ready'],
    ['recording while armed', prepared('recording', 'branch', { mergeMode: 'when_green' }), 'recording'],
    ['recording while merging', prepared('recording', 'branch', { status: 'merging' }), 'recording'],
    ['recording after a failed merge', prepared('recording', 'branch', { status: 'failed' }), 'recording'],
    ['signed off', prepared('recording', 'branch', { status: 'signed_off' }), 'closed'],
    ['dismissed in Planning', prepared('ready', 'branch', { status: 'signed_off', attributes: attributes('branch', 1, { outcome: { kind: 'dismissed', by: 'a', at: NOW, reason: 'x' } }) }), 'closed'],
  ];
  for (const [name, g, state] of states) {
    it(`reads ${name} as ${state}`, () => expect(actionState(g)).toBe(state));
  }

  it('is null for a glob that is not an action', () => {
    expect(actionState(glob())).toBeNull();
    expect(preparationOf(glob())).toBeNull();
    expect(hasBranchRecord(prepared('ready', 'artifact'))).toBe(false);
    expect(hasBranchRecord(prepared('ready'))).toBe(true);
  });

  it('is a person turn when ready, when the preparation failed, and when the record is stuck after Done', () => {
    expect(needsHuman(prepared('ready'))).toBe(true);
    expect(needsHuman(prepared('failed'))).toBe(true);
    expect(needsHuman(prepared('preparing'))).toBe(false);
    expect(needsHuman(prepared('recording', 'branch', { mergeMode: 'when_green' }))).toBe(false);
    // Open after Done and not armed (red checks, disarmed): nothing will merge it, so a person must.
    expect(needsHuman(prepared('recording'))).toBe(true);
    expect(needsHuman(prepared('recording', 'branch', { headChecks: { sha: 'aaa', state: 'failed' } }))).toBe(true);
    expect(needsHuman(prepared('recording', 'branch', { status: 'merging' }))).toBe(false);
    expect(needsHuman(prepared('recording', 'branch', { conflict: { base: 'main', files: [], since: null, at: NOW } }))).toBe(true);
    expect(needsHuman(glob({ category: 'action', type: null, attributes: attributes(null, 0), status: 'planning' }))).toBe(true);
  });
});

describe('A4: prepare (start, retry)', () => {
  it('starts a waiting action once nothing it waits for is unmerged, and refuses while something is', () => {
    const waiting = glob({ category: 'action', type: null, attributes: attributes('branch', 0), status: 'planning', waiting: { since: NOW }, pr: null, provisioning: 'none' });
    const held = relationFacts('s1a1', [['s1t1', 'open']]);
    expect(code(machine.prepareAction(waiting, ctx(dev), held))).toBe('invalid_transition');
    expect(machine.allowedActions(waiting, dev, { relations: held })).not.toContain('prepare_action');
    const t = unwrap(machine.prepareAction(waiting, ctx(dev), relationFacts('s1a1', [['s1t1', 'merged']])));
    expect(t.glob).toMatchObject({ status: 'implementing', waiting: null });
    expect(t.glob.attributes).toMatchObject({ preparation: { rounds: 1 } });
    expect(kinds(t)).toEqual(['provision', 'fire_routine']);
  });

  it('retries a failed preparation on the same branch: a new prepare run, no new generation', () => {
    const failed = prepared('failed');
    expect(machine.allowedActions(failed, dev)).toContain('prepare_action');
    const t = unwrap(machine.prepareAction(failed, ctx(dev)));
    expect(t.glob).toMatchObject({ status: 'implementing', failure: null, generation: 1, pr: failed.pr, provisioning: 'ok' });
    expect(t.glob.attributes).toMatchObject({ preparation: { record: 'branch', rounds: 2 } });
    expect(t.glob.runs.at(-1)).toMatchObject({ state: 'queued', purpose: 'prepare' });
    expect(kinds(t)).toEqual(['fire_routine']);
  });

  it('refuses a plain action, a finished one, a live run and any other state', () => {
    const plain = glob({ category: 'action', type: null, attributes: attributes(null, 0), status: 'planning' });
    expect(code(machine.prepareAction(plain, ctx(dev)))).toBe('invalid_transition');
    expect(code(machine.prepareAction(prepared('ready'), ctx(dev)))).toBe('invalid_transition');
    expect(code(machine.prepareAction(prepared('preparing'), ctx(dev)))).toBe('run_active');
    expect(code(machine.prepareAction(glob(), ctx(dev)))).toBe('invalid_transition');
  });
});

describe('A5: the preparation is ready to run', () => {
  it('a branch record: mark_ready asks the host to mark the PR ready, only for the current run', () => {
    const g = prepared('preparing');
    const t = unwrap(machine.readyRequested(g, 'run-0', ctx(null)));
    expect(kinds(t)).toEqual(['mark_pr_ready']);
    expect(code(machine.readyRequested(g, 'run-9', ctx(null)))).toBe('invalid_transition');
    expect(code(machine.readyRequested(g, null, ctx(dev), { from: 'board', facts: {} }))).toBe('invalid_transition');
  });

  it('a branch record: the ready PR makes it ready to run, ends the run completed and queues no review', () => {
    const t = unwrap(machine.prReadyForReview(prepared('preparing'), { number: 7, headSha: 'bbb' }, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'pr_open', pr: { state: 'ready', headSha: 'bbb' }, labels: {} });
    expect(t.glob.runs.at(-1)).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(kinds(t)).toEqual(['refresh_checks']);
    expect(t.events.map((e) => e.type)).toEqual(['PRReadyForReview', 'RunEnded', 'ActionPrepared', 'StatusChanged']);
    expect(actionState(t.glob)).toBe('ready');
  });

  it('an artifact or attachment record: ready at once, no PR, run completed', () => {
    for (const record of ['artifact', 'attachment'] as const) {
      const g = prepared('preparing', record);
      const t = unwrap(machine.readyRequested(g, 'run-0', ctx(null)));
      expect(t.glob).toMatchObject({ status: 'in_progress', pr: null, failure: null });
      expect(t.glob.runs.at(-1)).toMatchObject({ state: 'ended', outcome: 'completed' });
      expect(t.effects).toEqual([]);
      expect(t.events.map((e) => e.type)).toEqual(['RunEnded', 'StatusChanged', 'ActionPrepared']);
      expect(machine.actionPrepared(t.glob, 'run-0', ctx(null)).ok && unwrap(machine.actionPrepared(t.glob, 'run-0', ctx(null))).changed).toBe(false);
    }
  });

  it('a fix run on a ready or recording record just ends and reads the checks again', () => {
    const g = prepared('recording', 'branch', { runs: [prepRun({ id: 'run-5', state: 'active' })] });
    const t = unwrap(machine.readyRequested(g, 'run-5', ctx(null)));
    expect(t.glob.runs.at(-1)).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(kinds(t)).toEqual(['refresh_checks']);
  });

  it('a preparation run never watches the checks: it goes active, not watching', () => {
    const g = prepared('ready', 'branch', { runs: [prepRun({ state: 'queued', startedAt: null })] });
    const t = unwrap(machine.runProgress(g, 'run-0', ctx(null)));
    expect(t.glob.runs.at(-1)?.state).toBe('active');
  });

  it('a preparation run that reports failure ends failed and leaves the action failed (preparation failed)', () => {
    const t = unwrap(machine.reportFailure(prepared('preparing'), { reason: 'could not write it', runId: 'run-0' }, ctx(null)));
    expect(t.glob.status).toBe('failed');
    expect(actionState(t.glob)).toBe('preparation_failed');
    expect(t.glob.runs.at(-1)).toMatchObject({ state: 'ended', outcome: 'failed' });
  });
});

describe('A6: Failed starts another round on the same branch', () => {
  it('goes back to Doing with the same PR and generation, a counted round and a prepare run', () => {
    const t = unwrap(machine.failAction(prepared('ready', 'branch', { mergeMode: 'when_green', headChecks: { sha: 'aaa', state: 'passed' } }), ctx(dev)));
    expect(t.glob).toMatchObject({ status: 'implementing', generation: 1, mergeMode: null, headChecks: null, failure: null, provisioning: 'ok' });
    expect(t.glob.pr).toEqual({ number: 7, state: 'ready', headSha: 'aaa' });
    expect(t.glob.attributes).toMatchObject({ outcome: null, preparation: { record: 'branch', rounds: 2 } });
    expect(t.glob.runs.at(-1)).toMatchObject({ state: 'queued', purpose: 'prepare', generation: 1 });
    expect(kinds(t)).toEqual(['fire_routine']);
    expect(t.events.map((e) => e.type)).toContain('ActionRunFailed');
    expect(t.effects.some((e) => e.kind === 'reopen_pr' || e.kind === 'close_pr')).toBe(false);
  });

  it('works for an artifact record too, with no branch to provision', () => {
    const t = unwrap(machine.failAction(prepared('ready', 'artifact'), ctx(dev)));
    expect(t.glob).toMatchObject({ status: 'implementing', provisioning: 'none' });
    expect(kinds(t)).toEqual(['fire_routine']);
  });

  it('the next mark_ready on the ready PR takes the already-ready path', () => {
    const second = unwrap(machine.failAction(prepared('ready'), ctx(dev))).glob;
    const t = unwrap(machine.prReadyForReview(second, { number: 7, headSha: 'aaa' }, ctx(null)));
    expect(t.glob.status).toBe('pr_open');
    expect(actionState(t.glob)).toBe('ready');
  });

  it('is refused after Done, while preparing, on a plain action and on work', () => {
    expect(code(machine.failAction(prepared('recording'), ctx(dev)))).toBe('invalid_transition');
    expect(code(machine.failAction(prepared('preparing'), ctx(dev)))).toBe('invalid_transition');
    expect(code(machine.failAction(glob({ category: 'action', type: null, attributes: attributes(null, 0) }), ctx(dev)))).toBe('invalid_transition');
    expect(code(machine.failAction(glob(), ctx(dev)))).toBe('invalid_transition');
  });
});

describe('A7: Done on a prepared action', () => {
  it('a branch record with passed checks starts the merge itself: merging, squash_merge, waiters released', () => {
    const g = prepared('ready', 'branch', { headChecks: { sha: 'aaa', state: 'passed' } });
    const t = unwrap(machine.completeAction(g, { note: 'applied in the console' }, ctx(dev)));
    expect(t.glob.status).toBe('merging');
    expect(t.glob.attributes).toMatchObject({ outcome: { kind: 'done', by: dev.email, note: 'applied in the console' } });
    expect(kinds(t)).toEqual(['release_waiting', 'squash_merge']);
    expect(actionState(t.glob)).toBe('recording');
  });

  it('a branch record with checks still running arms the merge for when they pass', () => {
    const t = unwrap(machine.completeAction(prepared('ready'), {}, ctx(dev)));
    expect(t.glob).toMatchObject({ status: 'pr_open', mergeMode: 'when_green' });
    expect(kinds(t)).toEqual(['release_waiting', 'refresh_checks']);
    expect(t.events.map((e) => e.type)).toEqual(['ActionDone', 'MergeArmed']);
  });

  it('is never refused for red checks or a conflict: it records the run and waits for the fix', () => {
    const red = prepared('ready', 'branch', { headChecks: { sha: 'aaa', state: 'failed' } });
    const t = unwrap(machine.completeAction(red, {}, ctx(dev)));
    expect(t.glob).toMatchObject({ status: 'pr_open', mergeMode: null });
    expect(kinds(t)).toEqual(['release_waiting']);
    expect(actionState(t.glob)).toBe('recording');
    const conflicted = unwrap(machine.completeAction(prepared('ready', 'branch', { conflict: { base: 'main', files: ['a'], since: null, at: NOW } }), {}, ctx(dev)));
    expect(conflicted.glob.mergeMode).toBeNull();
    // Fix checks and Fix conflict are the ways forward; a plain Merge is offered once nothing blocks it.
    expect(machine.allowedActions(t.glob, dev)).toContain('retry_autofix');
    expect(machine.allowedActions(conflicted.glob, dev)).toContain('resolve_conflict');
  });

  it('an artifact or attachment record closes at once, signed off, with only the waiters released', () => {
    for (const record of ['artifact', 'attachment'] as const) {
      const t = unwrap(machine.completeAction(prepared('ready', record), {}, ctx(dev)));
      expect(t.glob).toMatchObject({ status: 'signed_off', signedOffAt: NOW });
      expect(kinds(t)).toEqual(['release_waiting']);
      expect(actionState(t.glob)).toBe('closed');
    }
  });

  it('a branch whose PR was merged by hand closes at Done without arming anything', () => {
    const t = unwrap(machine.completeAction(prepared('ready', 'branch', { pr: { number: 7, state: 'merged', headSha: 'aaa' } }), {}, ctx(dev)));
    expect(t.glob.status).toBe('signed_off');
    expect(kinds(t)).toEqual(['release_waiting']);
  });

  it('is refused while preparing, failed or waiting, and a repeat after Done changes nothing', () => {
    for (const state of ['preparing', 'failed'] as const) {
      expect(code(machine.completeAction(prepared(state), {}, ctx(dev)))).toBe('invalid_transition');
      expect(machine.allowedActions(prepared(state), dev)).not.toContain('complete_action');
    }
    const waiting = glob({ category: 'action', type: null, attributes: attributes('branch', 0), status: 'planning' });
    expect(code(machine.completeAction(waiting, {}, ctx(dev)))).toBe('invalid_transition');
    expect(unwrap(machine.completeAction(prepared('recording'), {}, ctx(dev))).changed).toBe(false);
  });

  it('does not apply the script-on-base rule to a prepared action', () => {
    const t = machine.completeAction(prepared('ready', 'artifact'), {}, ctx(dev), { script: { path: 'scripts/x.sh', onBase: false } });
    expect(t.ok).toBe(true);
  });
});

describe('A8: the record merges', () => {
  it('after Done the merge signs the action off: no labels, no review, no rollout check, only the waiters released', () => {
    const t = unwrap(machine.merged(prepared('recording', 'branch', { status: 'merging' }), { sha: 'abc' }, ctx(null)));
    expect(t.glob).toMatchObject({ status: 'signed_off', labels: {}, signedOffAt: NOW, pr: { state: 'merged' }, mergeMode: null });
    expect(kinds(t)).toEqual(['release_waiting']);
    expect(t.events.map((e) => e.type)).toEqual(['Merged', 'StatusChanged']);
    expect(actionState(t.glob)).toBe('closed');
  });

  it('is noticed once more without effect, and a merge before Done is only recorded', () => {
    const closed = unwrap(machine.merged(prepared('recording', 'branch', { status: 'merging' }), { sha: 'abc' }, ctx(null))).glob;
    expect(unwrap(machine.merged(closed, { sha: 'abc' }, ctx(null))).changed).toBe(false);
    const early = unwrap(machine.merged(prepared('ready'), { sha: 'abc' }, ctx(null)));
    expect(early.glob).toMatchObject({ status: 'pr_open', pr: { state: 'merged' } });
    expect(early.effects).toEqual([]);
    expect(unwrap(machine.merged(early.glob, { sha: 'abc' }, ctx(null))).changed).toBe(false);
    expect(unwrap(machine.completeAction(early.glob, {}, ctx(dev))).glob.status).toBe('signed_off');
  });

  it('an armed merge goes on when the checks pass, and a push after Done keeps it armed', () => {
    const armed = unwrap(machine.completeAction(prepared('ready'), {}, ctx(dev))).glob;
    const pass = unwrap(machine.checksCompleted(armed, { sha: 'aaa', passed: true }, ctx(null)));
    expect(pass.glob.status).toBe('merging');
    expect(kinds(pass)).toEqual(['squash_merge']);
    const pushed = unwrap(machine.commitPushed(armed, { sha: 'bbb', runId: null }, ctx(null)));
    expect(pushed.glob.mergeMode).toBe('when_green');
    const red = unwrap(machine.checksCompleted(armed, { sha: 'aaa', passed: false }, ctx(null)));
    expect(red.glob.mergeMode).toBeNull();
    // The fix that follows re-arms it: the person's Done already said the run worked.
    const fixed = unwrap(machine.commitPushed(red.glob, { sha: 'ccc', runId: null }, ctx(null)));
    expect(fixed.glob.mergeMode).toBe('when_green');
  });
});

describe('A9: dismiss', () => {
  it('while preparing it ends the run, closes the PR and deletes the branch, and never merges', () => {
    const t = unwrap(machine.dismissAction(prepared('preparing'), { reason: 'not needed' }, ctx(dev)));
    expect(t.glob).toMatchObject({ status: 'signed_off', pr: { state: 'closed' } });
    expect(t.glob.runs.at(-1)).toMatchObject({ state: 'ended', outcome: 'superseded' });
    expect(t.glob.attributes).toMatchObject({ outcome: { kind: 'dismissed', reason: 'not needed' } });
    expect(kinds(t)).toEqual(['close_pr', 'delete_branch', 'release_waiting']);
    expect(kinds(t)).not.toContain('squash_merge');
  });

  it('is offered in every open state and refused once done', () => {
    for (const state of ['preparing', 'ready', 'failed'] as const) {
      expect(machine.allowedActions(prepared(state), dev)).toContain('dismiss_action');
      expect(unwrap(machine.dismissAction(prepared(state), { reason: 'x' }, ctx(dev))).glob.status).toBe('signed_off');
    }
    expect(code(machine.dismissAction(prepared('recording'), { reason: 'x' }, ctx(dev)))).toBe('invalid_transition');
    expect(machine.allowedActions(prepared('recording'), dev)).not.toContain('dismiss_action');
  });

  it('an artifact record has no PR or branch to close; a waiting action has none either', () => {
    expect(kinds(unwrap(machine.dismissAction(prepared('ready', 'artifact'), { reason: 'x' }, ctx(dev))))).toEqual(['release_waiting']);
    const waiting = glob({ category: 'action', type: null, attributes: attributes('branch', 0), status: 'planning', pr: null, provisioning: 'none' });
    expect(kinds(unwrap(machine.dismissAction(waiting, { reason: 'x' }, ctx(dev))))).toEqual(['release_waiting']);
  });

  it('a plain action keeps its rule: only in Planning', () => {
    const plain = glob({ category: 'action', type: null, attributes: attributes(null, 0), status: 'in_progress' });
    expect(code(machine.dismissAction(plain, { reason: 'x' }, ctx(dev)))).toBe('invalid_transition');
  });
});

describe('A10: pick up reads the branch', () => {
  it('a ready or recording branch action is returned unchanged, with no implementer', () => {
    for (const state of ['ready', 'recording'] as const) {
      const g = prepared(state);
      const t = unwrap(machine.pickUp(g, ctx(dev), board, { takeOver: false }));
      expect(t.changed).toBe(false);
      expect(t.glob.implementer).toBeNull();
      expect(machine.allowedActions(g, dev)).toContain('pick_up');
    }
  });

  it('is refused while preparing, for an artifact record and for a plain action', () => {
    expect(code(machine.pickUp(prepared('preparing'), ctx(dev), board, { takeOver: false }))).toBe('invalid_transition');
    expect(code(machine.pickUp(prepared('ready', 'artifact'), ctx(dev), board, { takeOver: false }))).toBe('invalid_transition');
    const plain = glob({ category: 'action', type: null, attributes: attributes(null, 0), status: 'planning' });
    expect(code(machine.pickUp(plain, ctx(dev), board, { takeOver: false }))).toBe('invalid_transition');
  });
});

describe('what a person can do with a prepared action', () => {
  it('lists the actions of each state', () => {
    expect(machine.allowedActions(prepared('preparing'), dev)).toEqual(['dismiss_action', 'delete']);
    expect(machine.allowedActions(prepared('failed'), dev)).toEqual(['prepare_action', 'dismiss_action', 'delete']);
    expect(machine.allowedActions(prepared('ready'), dev)).toEqual(['complete_action', 'fail_action', 'pick_up', 'dismiss_action', 'delete']);
    expect(machine.allowedActions(prepared('ready', 'artifact'), dev)).toEqual(['complete_action', 'fail_action', 'dismiss_action', 'delete']);
    expect(machine.allowedActions(prepared('recording', 'branch', { mergeMode: 'when_green' }), dev)).toEqual(['cancel_merge', 'pick_up', 'delete']);
  });

  it('offers Merge on a recording record whose merge is not armed and nothing blocks, but never before Done', () => {
    expect(machine.allowedActions(prepared('recording'), dev)).toContain('merge');
    expect(machine.allowedActions(prepared('ready'), dev)).not.toContain('merge');
    expect(code(machine.requestMerge(prepared('ready'), ctx(dev)))).toBe('invalid_transition');
    expect(unwrap(machine.requestMerge(prepared('recording'), ctx(dev))).glob.mergeMode).toBe('when_green');
  });

  it('QA and PO members may prepare and run an action like anyone', () => {
    expect(machine.allowedActions(prepared('ready'), { email: 'qa@example.com', role: 'qa' })).toContain('complete_action');
    expect(unwrap(machine.resolveConflict(prepared('ready', 'branch', { conflict: { base: 'main', files: [], since: null, at: NOW } }), ctx({ email: 'po@example.com', role: 'po' }))).glob.runs.at(-1)).toMatchObject({
      purpose: 'resolve_conflict',
    });
  });

  it('Fix checks on an action queues a preparation-kind run, which never watches', () => {
    const red = prepared('ready', 'branch', { headChecks: { sha: 'aaa', state: 'failed' } });
    const t = unwrap(machine.retryAutofix(red, ctx(dev)));
    expect(t.glob.runs.at(-1)).toMatchObject({ state: 'queued', purpose: 'prepare' });
  });
});

describe('a push to an action branch', () => {
  it('queues no independent review, no deploy and no sub gate', () => {
    const t = unwrap(machine.commitPushed(prepared('ready'), { sha: 'bbb', runId: null }, ctx(null)));
    expect(kinds(t)).not.toContain('review_change');
    expect(kinds(t)).not.toContain('request_deploy');
    expect(kinds(t)).not.toContain('evaluate_sub_gate');
    expect(t.glob.pr?.headSha).toBe('bbb');
  });

  it('a push in Doing with a ready PR does not send the action back to review', () => {
    const t = unwrap(machine.commitPushed(prepared('preparing', 'branch', { pr: { number: 7, state: 'ready', headSha: 'aaa' }, runs: [prepRun({ state: 'ended', outcome: 'completed' })] }), { sha: 'bbb', runId: null }, ctx(null)));
    expect(t.glob.status).toBe('implementing');
  });
});

describe('the run step the person sees', () => {
  const plan = ['# Scope it', '', '## Why', 'x', '', '## Do this', '', '```', '$ aws sso login', 'bash scripts/iam/apply.sh --check', '', 'bash scripts/iam/apply.sh', '```', '', '```', 'not this one', '```', '', '## Check it worked', '```', 'nor this', '```'].join('\n');

  it('reads the commands of the first block under Do this', () => {
    expect(doThisCommands(plan)).toEqual(['aws sso login', 'bash scripts/iam/apply.sh --check', 'bash scripts/iam/apply.sh']);
    expect(doThisCommands('## Why\nno block')).toEqual([]);
    expect(doThisCommands('## Do this\n\nprose only\n\n## Next\n```\nx\n```')).toEqual([]);
  });

  it('names the fetch of the script by record kind', () => {
    expect(fetchCommandFor('s1a1', 'branch')).toBe('sstor --glob s1a1');
    expect(fetchCommandFor('s1a1', 'artifact', 'action: iam')).toBe('slop get-artifact s1a1 rollout_script --label "action: iam" --out s1a1-run.sh');
    expect(fetchCommandFor('s1a1', 'attachment')).toBeNull();
  });

  it('is one Run step with the fetch line first when ready, and none while preparing or recording', () => {
    const steps = derivedSteps(prepared('ready'), { actionPlan: plan });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'action', title: 'Run: Fix login timeout', id: 'machine:action', blocks: [] });
    expect(steps[0]?.commands).toEqual(['sstor --glob s1a1', 'aws sso login', 'bash scripts/iam/apply.sh --check', 'bash scripts/iam/apply.sh']);
    expect(derivedSteps(prepared('preparing'), { actionPlan: plan })).toEqual([]);
    expect(derivedSteps(prepared('recording'), { actionPlan: plan })).toEqual([]);
    expect(derivedSteps(prepared('ready', 'attachment'), { actionPlan: plan })[0]?.commands).toEqual(['aws sso login', 'bash scripts/iam/apply.sh --check', 'bash scripts/iam/apply.sh']);
  });
});

describe('prepared actions through the service', () => {
  const ADMIN = 'admin@example.com';
  const DEV = 'dev@example.com';
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boards: BoardService;
  let store: MemoryStore;
  let boardId: number;
  let runs = 0;
  let onBase: ReadonlySet<string>;

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    onBase = new Set();
    boards = new BoardService({ store, notifier });
    const codeView = {
      read: (_board: number, _ref: string | null, path: string) =>
        Promise.resolve(onBase.has(path) ? { path, content: '', startLine: 1, endLine: 1, totalLines: 1, truncated: false, binary: false } : null),
    };
    globs = new GlobService({ store, notifier, clock: { now: () => NOW }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) }, codeView });
    artifacts = new ArtifactService({ store, notifier, clock: { now: () => NOW } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Scope the apigateway permission',
    type: null,
    category: 'action',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const current = async (id: string): Promise<Glob> => unwrap(await globs.get(DEV, id)).glob;
  const outbox = (kind: string) => store.state.outbox.filter((e) => e.kind === kind);

  it('an IAM-style request becomes a prepared action: Doing, a prepare run fired, the branch provisioned, no labels', async () => {
    const made = unwrap(await globs.create(DEV, input({ prepare: true, plan: '# Scope it\n\n## Do this\n\n```\nbash scripts/iam/apply.sh\n```\n' })));
    expect(made).toMatchObject({ id: `s${boardId}a1`, category: 'action', type: null, status: 'implementing', provisioning: 'pending', labels: {}, environment: null });
    expect(made.attributes).toEqual({ assignee: null, outcome: null, preparation: { record: 'branch', rounds: 1 } });
    expect(outbox('provision')).toHaveLength(1);
    expect(outbox('fire_routine')).toMatchObject([{ globId: made.id, purpose: 'prepare', runId: 'run-1' }]);
    expect(unwrap(await globs.get(DEV, made.id)).allowedActions).toEqual(['dismiss_action', 'delete']);
  });

  it('a plain action is unchanged: Planning, no effects, and a record kind is refused without prepare', async () => {
    const plain = unwrap(await globs.create(DEV, input()));
    expect(plain).toMatchObject({ status: 'planning', provisioning: 'none' });
    expect(store.state.outbox.filter((e) => e.kind === 'provision' || e.kind === 'fire_routine')).toEqual([]);
    expect(code(await globs.create(DEV, input({ record: 'artifact' })))).toBe('invalid_input');
  });

  it('an action held by a start relation waits, prepares when its glob merges, and Prepare is refused meanwhile', async () => {
    const work = unwrap(await globs.create(ADMIN, input({ title: 'Builds the script', type: 'same', category: 'task' })));
    const a = unwrap(await globs.create(DEV, input({ prepare: true, after: [work.id] })));
    expect(a).toMatchObject({ status: 'planning', provisioning: 'none' });
    expect(store.state.outbox.filter((e) => e.kind === 'provision' || e.kind === 'fire_routine' && e.globId === a.id)).toEqual([]);
    expect(code(await globs.prepareAction(DEV, a.id, a.version))).toBe('invalid_transition');
    expect(actionState(await current(a.id))).toBe('waiting');
    // The glob it waits for merges: the release starts the first preparation round.
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(work.id);
      if (g === null) throw new Error('missing');
      await tx.updateGlob({ ...g, status: 'signed_off', pr: { number: 3, state: 'merged', headSha: 'x' }, version: g.version + 1 }, g.version);
    });
    // The outbox's release_waiting job calls releaseDependents (an action used to be skipped there).
    expect(await globs.releaseDependents(work.id, work.boardId)).toEqual([a.id]);
    const started = await current(a.id);
    expect(started).toMatchObject({ status: 'implementing', waiting: null });
    expect(outbox('fire_routine').filter((e) => e.globId === a.id)).toMatchObject([{ purpose: 'prepare' }]);
  });

  it('Failed stores the masked output as an attachment, starts a round on the same branch and the next run reads it', async () => {
    const made = unwrap(await globs.create(DEV, input({ prepare: true, plan: '# Scope it\n\n## Do this\n\n```\nexport TOKEN=abcd1234abcd1234abcd1234\nbash scripts/iam/apply.sh\n```\n' })));
    // The routine's work is done: the provisioned branch and its PR are ready to run.
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(made.id);
      if (g === null) throw new Error('missing');
      const done = machine.prReadyForReview({ ...g, provisioning: 'ok', pr: { number: 7, state: 'draft', headSha: 'aaa' } }, { number: 7, headSha: 'aaa' }, ctx(null));
      await tx.updateGlob({ ...unwrap(done).glob, version: g.version + 1 }, g.version);
    });
    const ready = await current(made.id);
    expect(actionState(ready)).toBe('ready');
    const failed = unwrap(await globs.failAction(DEV, made.id, 'AccessDenied: apigateway:GET is not allowed\nAWS_SECRET_ACCESS_KEY=abcdefghijklmnop1234567890', ready.version));
    expect(failed).toMatchObject({ status: 'implementing', generation: 1, provisioning: 'ok' });
    expect(failed.pr).toEqual(ready.pr);
    expect(failed.attributes).toMatchObject({ preparation: { rounds: 2 } });
    expect(outbox('fire_routine').at(-1)).toMatchObject({ globId: made.id, purpose: 'prepare', runId: 'run-2' });
    const note = (await store.transaction((tx) => tx.artifactVersions(made.id, 'attachment', `${ACTION_FAILURE_LABEL} (round 1)`))).at(-1)?.content ?? '';
    expect(note).toContain('AccessDenied: apigateway:GET is not allowed');
    expect(note).not.toContain('abcdefghijklmnop1234567890');
    expect(note).toContain('bash scripts/iam/apply.sh');
    expect(note).not.toContain('abcd1234abcd1234abcd1234');
    // get_context carries the masked failure output inline, not just a listing line.
    const context = unwrap(await artifacts.context(DEV, made.id));
    expect(context.attachments.find((a) => a.label === `${ACTION_FAILURE_LABEL} (round 1)`)?.content).toContain('AccessDenied: apigateway:GET is not allowed');
    expect(context.available.map((a) => a.label)).not.toContain(`${ACTION_FAILURE_LABEL} (round 1)`);
    // Nothing merged: no generation bump, no reopened or closed PR.
    expect(store.state.outbox.filter((e) => e.kind === 'reopen_pr' || e.kind === 'close_pr' || e.kind === 'delete_branch')).toEqual([]);
  });

  it('Done on a branch record queues the merge and the merge closes the action', async () => {
    const made = unwrap(await globs.create(DEV, input({ prepare: true })));
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(made.id);
      if (g === null) throw new Error('missing');
      const ready = unwrap(machine.prReadyForReview({ ...g, provisioning: 'ok', pr: { number: 7, state: 'draft', headSha: 'aaa' } }, { number: 7, headSha: 'aaa' }, ctx(null))).glob;
      await tx.updateGlob({ ...ready, headChecks: { sha: 'aaa', state: 'passed' }, version: g.version + 1 }, g.version);
    });
    const ready = await current(made.id);
    const done = unwrap(await globs.completeAction(DEV, made.id, ready.version, 'applied'));
    expect(done).toMatchObject({ status: 'merging' });
    expect(outbox('squash_merge')).toHaveLength(1);
    expect(outbox('release_waiting').some((e) => e.globId === made.id)).toBe(true);
    const merged = unwrap(await globs.applyEvent(made.id, (g, c) => machine.merged(g, { sha: 'abc' }, c)));
    expect(merged).toMatchObject({ status: 'signed_off', labels: {} });
    expect(actionState(merged)).toBe('closed');
  });

  it('an artifact-only action: mark_ready needs the stored script, then Done closes it with no merge', async () => {
    const made = unwrap(await globs.create(DEV, input({ prepare: true, record: 'artifact', plan: '# Run it\n\n## Do this\n\n```\nbash run.sh\n```\n' })));
    expect(made).toMatchObject({ status: 'implementing', provisioning: 'none' });
    expect(outbox('provision')).toEqual([]);
    expect(code(await globs.requestReady(DEV, made.id, 'run-1'))).toBe('invalid_input');
    unwrap(await artifacts.putArtifact(DEV, made.id, 'rollout_script', '#!/bin/bash\necho hi', { commitSha: null, runId: 'run-1', agentSetVersion: null }, 'action: scope-iam'));
    const ready = unwrap(await globs.requestReady(DEV, made.id, 'run-1'));
    expect(ready).toMatchObject({ status: 'in_progress', pr: null });
    expect(actionState(ready)).toBe('ready');
    const view = unwrap(await globs.get(DEV, made.id));
    expect(view.humanSteps[0]?.commands).toEqual([`slop get-artifact ${made.id} rollout_script --label "action: scope-iam" --out ${made.id}-run.sh`, 'bash run.sh']);
    const done = unwrap(await globs.completeAction(DEV, made.id, ready.version));
    expect(done.status).toBe('signed_off');
    expect(outbox('squash_merge')).toEqual([]);
  });

  it('stores a rollout_script only on an action prepared with an artifact record', async () => {
    const plain = unwrap(await globs.create(DEV, input()));
    const branch = unwrap(await globs.create(DEV, input({ prepare: true })));
    const work = unwrap(await globs.create(ADMIN, input({ title: 'Work', type: 'same', category: 'task' })));
    for (const id of [plain.id, branch.id, work.id]) {
      expect(code(await artifacts.putArtifact(DEV, id, 'rollout_script', 'echo', { commitSha: null, runId: null, agentSetVersion: null }, 'action: x'))).toBe('invalid_input');
    }
    const art = unwrap(await globs.create(DEV, input({ prepare: true, record: 'artifact' })));
    expect(code(await artifacts.putArtifact(DEV, art.id, 'rollout_script', 'echo', { commitSha: null, runId: null, agentSetVersion: null }))).toBe('invalid_input');
    expect(code(await artifacts.putArtifact(DEV, art.id, 'local_review', 'x', { commitSha: null, runId: null, agentSetVersion: null }, 'label'))).toBe('invalid_input');
  });

  it('s15f175 still holds a plain action that uses another glob script, and does not hold a prepared one', async () => {
    const plan = '# Run it\n\n## Do this\n\nscript: scripts/rollout/s1t1-x.sh\nbash scripts/rollout/s1t1-x.sh\n';
    const plain = unwrap(await globs.create(DEV, input({ plan })));
    const check = await globs.scriptCheckFor(plain.id);
    expect(check?.script).toEqual({ path: 'scripts/rollout/s1t1-x.sh', onBase: false });
    const refused = await globs.completeAction(DEV, plain.id, plain.version);
    expect(code(refused)).toBe('invalid_transition');
    expect(!refused.ok && refused.error.message).toContain('script not on main yet');
    expect((await globs.scriptChecksOf(boardId)).has(plain.id)).toBe(true);
    // A prepared action's own script runs from its branch or artifact first: nothing is looked up on the base branch.
    const own = unwrap(await globs.create(DEV, input({ prepare: true, record: 'artifact', plan })));
    expect(await globs.scriptCheckFor(own.id)).toBeNull();
    const waiting = unwrap(await globs.create(DEV, input({ prepare: true, after: [plain.id], plan })));
    expect(await globs.scriptCheckFor(waiting.id)).toBeNull();
    expect((await globs.scriptChecksOf(boardId)).has(waiting.id)).toBe(false);
    // Once the script reaches the base branch the plain action can be done.
    onBase = new Set(['scripts/rollout/s1t1-x.sh']);
    await globs.baseMoved(boardId);
    expect(unwrap(await globs.completeAction(DEV, plain.id, plain.version)).status).toBe('signed_off');
  });

  it('work commands stay refused on a plain action but the PR commands apply to a prepared one', async () => {
    const plain = unwrap(await globs.create(DEV, input()));
    const prep = unwrap(await globs.create(DEV, input({ prepare: true })));
    expect(code(await globs.resolveConflict(DEV, plain.id, plain.version))).toBe('invalid_transition');
    expect(code(await globs.cancelMerge(DEV, prep.id, prep.version))).toBe('invalid_transition');
    expect(code(await globs.retrigger(DEV, prep.id, prep.version))).toBe('invalid_transition');
  });
});
