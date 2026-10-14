import type { Action, PullRequest } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { failedRepeatedly, mainAction, promotedAction } from '../src/lib/main-action';

const glob = (over: Partial<Parameters<typeof mainAction>[1]> = {}) => ({
  type: 'same' as const,
  status: 'planning' as const,
  implementer: null,
  pr: null,
  ...over,
});
const pr = (state: PullRequest['state'] = 'draft'): PullRequest => ({
  number: 7,
  state,
  headSha: 'abc',
});

const pick = (actions: Action[], g = glob(), decision = false) => mainAction(actions, g, decision);

describe('mainAction', () => {
  it('prefers fixes, most specific first', () => {
    const all: Action[] = [
      'retrigger',
      'retry_merge',
      'retry_autofix',
      'resolve_conflict',
      'merge',
    ];
    expect(pick(all)).toBe('resolve_conflict');
    expect(pick(all.filter((a) => a !== 'resolve_conflict'))).toBe('retry_autofix');
    expect(pick(['retrigger', 'retry_merge'])).toBe('retry_merge');
    expect(pick(['retrigger', 'merge'])).toBe('retrigger');
  });

  it('starts a same in Planning but picks up a super', () => {
    expect(pick(['start', 'pick_up', 'start_anyway', 'delete'])).toBe('start');
    expect(pick(['pick_up', 'delete'], glob({ type: 'super' }))).toBe('pick_up');
  });

  it('offers Pick up only in More for a same with no Start', () => {
    expect(pick(['pick_up', 'delete'])).toBeNull();
  });

  it('is Done for a human draft PR and Merge for a ready one', () => {
    const g = glob({ status: 'in_progress', implementer: 'a@b.c', pr: pr() });
    expect(pick(['mark_ready', 'review_now', 'start_anyway'], g)).toBe('mark_ready');
    expect(pick(['merge', 'review_now'], glob({ status: 'pr_open', pr: pr('ready') }))).toBe(
      'merge',
    );
  });

  it('walks a decision glob: Pick up, then Decide, then Sign off', () => {
    expect(pick(['pick_up', 'delete'], glob(), true)).toBe('pick_up');
    expect(pick(['decide', 'delete'], glob({ status: 'in_progress' }), true)).toBe('decide');
    expect(pick(['sign_off', 'reopen'], glob({ status: 'reviewing' }), true)).toBe('sign_off');
  });

  it('never picks Start now, Discard or Delete', () => {
    expect(pick(['start_anyway', 'start_again', 'delete'])).toBeNull();
  });

  it('has no main button when nothing qualifies', () => {
    expect(pick([])).toBeNull();
    expect(pick(['investigate', 'review_now', 'merge_continue'])).toBeNull();
  });

  it('leaves only recoveries ahead of a due blocking step', () => {
    expect(mainAction(['merge', 'resolve_conflict'], glob({ status: 'pr_open', pr: pr('ready') }), false, true)).toBe('resolve_conflict');
    expect(mainAction(['merge'], glob({ status: 'pr_open', pr: pr('ready') }), false, true)).toBeNull();
    expect(mainAction(['merge'], glob({ status: 'pr_open', pr: pr('ready') }))).toBe('merge');
  });
});

describe('mainAction after repeated failures', () => {
  const run = (outcome: 'failed' | 'completed' | 'superseded' | null, purpose?: 'resolve_conflict', state: 'ended' | 'active' = 'ended') =>
    ({ id: 'r', state, outcome, purpose }) as NonNullable<Parameters<typeof failedRepeatedly>[0]['runs']>[number];
  const failed = glob({ status: 'in_progress', runs: [run('failed'), run('failed')] });

  it('keeps Retry as main after the first failure', () => {
    expect(pick(['retrigger', 'pick_up'], glob({ status: 'in_progress', runs: [run('failed')] }))).toBe('retrigger');
  });

  it('makes Pick up main once a retry failed again', () => {
    expect(pick(['retrigger', 'pick_up'], failed)).toBe('pick_up');
    expect(pick(['resolve_conflict', 'pick_up'], glob({ status: 'in_progress', runs: [run('failed', 'resolve_conflict'), run('failed', 'resolve_conflict')] }))).toBe('pick_up');
  });

  it('uses take_over while it is the only way in, and keeps Retry when no one can pick it up', () => {
    expect(pick(['retrigger', 'take_over'], failed)).toBe('take_over');
    expect(pick(['retrigger'], failed)).toBe('retrigger');
  });

  it('counts failures of any cause since the last success', () => {
    expect(failedRepeatedly({ runs: [run('failed', 'resolve_conflict'), run('failed')] })).toBe(true);
    expect(failedRepeatedly({ runs: [run('failed'), run('completed'), run('failed')] })).toBe(false);
    expect(failedRepeatedly({ runs: [run('failed'), run('superseded'), run('failed')] })).toBe(true);
  });

  it('leaves a due blocking step as the main button, even after repeated failures', () => {
    expect(mainAction(['retrigger', 'pick_up'], failed, false, true)).toBe('retrigger');
    expect(mainAction(['pick_up'], failed, false, true)).toBeNull();
  });

  it('does not count while a run is in progress', () => {
    expect(failedRepeatedly({ runs: [run('failed'), run('failed'), run(null, undefined, 'active')] })).toBe(false);
  });
});

describe('mainAction while the machine implements', () => {
  const implementing = (type: 'same' | 'sub' | 'super') => glob({ type, status: 'implementing' });
  const all: Action[] = ['review_now', 'take_over', 'delete'];

  it('leads with Pick up on a same or super', () => {
    expect(pick(all, implementing('same'))).toBe('take_over');
    expect(pick(all, implementing('super'))).toBe('take_over');
  });

  it('leaves a sub to the machine', () => {
    expect(pick(all, implementing('sub'))).toBeNull();
  });

  it('needs a live run to take over', () => {
    expect(pick(['review_now', 'delete'], implementing('same'))).toBeNull();
  });
});

describe('promotedAction', () => {
  it('leads with Cancel merge, then Review code, then Pick up', () => {
    expect(promotedAction(['review_now', 'take_over', 'cancel_merge'])).toBe('cancel_merge');
    expect(promotedAction(['take_over', 'investigate', 'review_now'])).toBe('review_now');
    expect(promotedAction(['investigate', 'pick_up'])).toBe('pick_up');
  });

  it('falls back to the first remaining item', () => {
    expect(promotedAction(['investigate', 'merge_continue'])).toBe('investigate');
  });

  it('never promotes a Reset action, and is null when nothing is left', () => {
    expect(promotedAction(['start_again', 'delete', 'start_anyway'])).toBeNull();
    expect(promotedAction([])).toBeNull();
    expect(promotedAction(['review_now', 'delete'])).toBe('review_now');
  });
});
