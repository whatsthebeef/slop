import { describe, expect, it } from 'vitest';
import { mergeOutcomeText, opensGlobView, outcomeRecorded } from '../src/lib/click-outcome';

describe('mergeOutcomeText', () => {
  it('says which happened: merged, armed, merging, cancelled or why it failed', () => {
    expect(mergeOutcomeText('merge', { status: 'reviewing' })).toBe('Merged');
    expect(mergeOutcomeText('merge_anyway', { status: 'reviewing' })).toBe('Merged');
    expect(mergeOutcomeText('sign_off_anyway', { status: 'signed_off' })).toBeNull();
    expect(mergeOutcomeText('merge', { status: 'pr_open', mergeMode: 'when_green' })).toBe(
      'Will merge when checks pass',
    );
    expect(mergeOutcomeText('merge', { status: 'merging' })).toBe('Merging…');
    expect(
      mergeOutcomeText('merge', { status: 'failed', failure: { reason: 'conflict in a.ts' } }),
    ).toBe("Can't merge: conflict in a.ts");
    const humanSteps = [
      {
        id: 'hs_1',
        kind: 'rollout',
        title: 'Run it',
        state: 'pending',
        who: 'admin',
        due: 'after_merge',
        blocks: [],
        source: 'work',
      },
    ] as never;
    expect(
      mergeOutcomeText('merge', { status: 'pr_open', mergeMode: 'when_green', humanSteps }),
    ).toBe('Will merge when checks pass; the rollout step comes after');
    expect(mergeOutcomeText('merge', { status: 'merging', humanSteps })).toBe(
      'Merging…; the rollout step comes after',
    );
    expect(mergeOutcomeText('cancel_merge', { status: 'pr_open' })).toBe('Merge cancelled');
    expect(mergeOutcomeText('start', { status: 'in_progress' })).toBeNull();
  });
});

describe('opensGlobView', () => {
  it('opens the glob view after Pick up (take_over too) and no other action', () => {
    expect(opensGlobView('pick_up')).toBe(true);
    expect(opensGlobView('take_over')).toBe(true);
    expect(opensGlobView('start')).toBe(false);
    expect(opensGlobView('merge')).toBe(false);
  });
});

describe('outcomeRecorded', () => {
  it('is true once the glob was read again with the refusal stored as its outcome', () => {
    expect(
      outcomeRecorded({ version: 4, lastOutcome: { kind: 'merge' } }, { version: 3 }, 'merge'),
    ).toBe(true);
  });

  it('is false when the version did not move, nothing was stored or it was another click', () => {
    expect(
      outcomeRecorded({ version: 3, lastOutcome: { kind: 'merge' } }, { version: 3 }, 'merge'),
    ).toBe(false);
    expect(outcomeRecorded({ version: 4, lastOutcome: null }, { version: 3 }, 'merge')).toBe(false);
    expect(outcomeRecorded({ version: 4 }, { version: 3 }, 'merge')).toBe(false);
    expect(
      outcomeRecorded({ version: 4, lastOutcome: { kind: 'start' } }, { version: 3 }, 'merge'),
    ).toBe(false);
  });
});
