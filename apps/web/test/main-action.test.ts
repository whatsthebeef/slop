import type { Action, PullRequest } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { mainAction } from '../src/lib/main-action';

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
