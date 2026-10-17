import { failedRepeatedly, mainAction, mainVariant, promotedAction } from '@slop/core';
import type { Action, PullRequest } from '@slop/core';
import { describe, expect, it } from 'vitest';

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

  it('leads with Pick up for typeless human work (a learning or an action)', () => {
    expect(pick(['pick_up'], glob({ type: null }), true)).toBe('pick_up');
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

  it('leads with Merge and continue for a same that offers it instead of Merge, and not for a super', () => {
    const ready = glob({ status: 'pr_open', pr: pr('ready') });
    expect(pick(['merge_continue', 'review_now'], ready)).toBe('merge_continue');
    expect(pick(['merge_continue', 'merge'], ready)).toBe('merge_continue');
    expect(pick(['merge_continue', 'merge'], glob({ ...ready, type: 'super' }))).toBe('merge');
    expect(pick(['merge_continue'], glob({ ...ready, type: 'super' }))).toBeNull();
  });

  it('walks a decision glob: Pick up, then Decide, then Sign off', () => {
    expect(pick(['pick_up', 'delete'], glob(), true)).toBe('pick_up');
    expect(pick(['decide', 'delete'], glob({ status: 'in_progress' }), true)).toBe('decide');
    expect(pick(['sign_off', 'reopen'], glob({ status: 'reviewing' }), true)).toBe('sign_off');
  });

  it('never picks Start now, Merge anyway, Sign off anyway, Discard or Delete', () => {
    expect(pick(['start_anyway', 'start_again', 'delete'])).toBeNull();
    expect(pick(['merge_anyway', 'sign_off_anyway'])).toBeNull();
  });

  it('has no main button when nothing qualifies', () => {
    expect(pick([])).toBeNull();
    expect(pick(['investigate', 'review_now', 'merge_continue'], glob({ type: 'super' }))).toBeNull();
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

  it('leads with Merge once a person has fixed it, with Pick up in the menu', () => {
    expect(pick(['merge', 'pick_up'], failed)).toBe('merge');
    expect(pick(['mark_ready', 'pick_up'], failed)).toBe('mark_ready');
    expect(pick(['retrigger', 'pick_up'], failed)).toBe('pick_up');
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
  const g = glob();
  const retry = glob({ type: 'sub', status: 'reviewing', pr: pr('merged') });

  it('leads with Cancel merge, then a Retry review, then Pick up', () => {
    expect(promotedAction(['review_now', 'take_over', 'cancel_merge'], retry)).toBe('cancel_merge');
    expect(promotedAction(['take_over', 'investigate', 'review_now'], retry)).toBe('review_now');
    expect(promotedAction(['investigate', 'pick_up'], g)).toBe('pick_up');
  });

  it("never leads with a person's own Review code while something else is left", () => {
    const own = glob({ status: 'in_progress', implementer: 'a@b.c', pr: pr('draft') });
    expect(promotedAction(['review_now', 'investigate', 'pick_up'], own)).toBe('pick_up');
    expect(promotedAction(['review_now', 'investigate'], own)).toBe('investigate');
    expect(promotedAction(['review_now', 'delete'], own)).toBe('review_now');
  });

  it('promotes nothing while the glob is merging', () => {
    const merging = glob({ type: 'sub', status: 'merging', pr: pr('ready') });
    expect(promotedAction(['review_now', 'start_again', 'delete'], merging)).toBeNull();
    expect(pick(['review_now', 'start_again', 'delete'], merging)).toBeNull();
  });

  it('falls back to the first remaining item', () => {
    expect(promotedAction(['investigate', 'merge_continue'], g)).toBe('investigate');
  });

  it('promotes Merge anyway or Sign off anyway only when nothing else is left, so the way to force it through stays reachable', () => {
    expect(promotedAction(['merge_anyway', 'pick_up', 'delete'], g)).toBe('pick_up');
    expect(promotedAction(['sign_off_anyway', 'delete'], g)).toBe('sign_off_anyway');
    expect(promotedAction(['merge_anyway', 'start_again', 'delete'], g)).toBe('merge_anyway');
  });

  it('never promotes a Reset action, and is null when nothing is left', () => {
    expect(promotedAction(['start_again', 'delete', 'start_anyway'], g)).toBeNull();
    expect(promotedAction([], g)).toBeNull();
  });
});

describe('mainVariant', () => {
  const sub = glob({ type: 'sub', status: 'implementing', pr: pr('draft') });

  it('is an outline Pick up on a sub the machine is implementing', () => {
    expect(mainVariant('take_over', sub, false)).toBe('outline');
    expect(mainVariant('pick_up', glob({ type: 'sub', status: 'pr_open', pr: pr('ready') }), false)).toBe('outline');
  });

  it('turns black once the sub is stalled', () => {
    expect(mainVariant('take_over', sub, true)).toBe('default');
  });

  it('stays black for a same or super, and for any other main', () => {
    expect(mainVariant('take_over', glob({ type: 'same', status: 'implementing' }), false)).toBe('default');
    expect(mainVariant('retrigger', sub, false)).toBe('default');
    expect(mainVariant(null, sub, false)).toBe('default');
  });
});

describe('mainAction after a Re-run answer with nothing working', () => {
  it('leads with Start, with Pick up and Start anyway never the main button', () => {
    const g = glob({ type: 'sub', status: 'pr_open', pr: pr('ready') });
    expect(pick(['start', 'take_over', 'start_again', 'delete'], g)).toBe('start');
    expect(pick(['start_anyway', 'take_over', 'start_again', 'delete'], g)).toBeNull();
  });
});
