import { describe, expect, it } from 'vitest';
import { ACTION_LABELS } from '../src/lib/api';
import type { GlobView } from '../src/lib/api';
import { actionLabel, startAgainConfirmation } from '../src/lib/start-again';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const pr = { number: 63, state: 'draft' as const, headSha: 'abc' };

describe('Start again labels', () => {
  it('names the action by glob type', () => {
    expect(actionLabel('start_again', 'sub', ACTION_LABELS)).toBe('Start over (new run)');
    expect(actionLabel('start_again', 'same', ACTION_LABELS)).toBe('Back to Planning');
    expect(actionLabel('start_again', 'super', ACTION_LABELS)).toBe('Start over');
  });

  it('does not say Back to Planning for a glob already in Planning', () => {
    expect(actionLabel('start_again', 'same', ACTION_LABELS, 'planning')).toBe('Start over');
    expect(actionLabel('start_again', 'same', ACTION_LABELS, 'in_progress')).toBe('Back to Planning');
    expect(actionLabel('start_again', 'sub', ACTION_LABELS, 'planning')).toBe('Start over (new run)');
  });

  it('leaves other actions alone', () => {
    expect(actionLabel('merge', 'sub', ACTION_LABELS)).toBe('Merge');
  });
});

describe('Start again confirmation', () => {
  it('says a sub closes the PR, deletes the branch and starts a run', () => {
    expect(
      startAgainConfirmation(view({ id: 's15t18', branch: 's15t18', type: 'sub', pr }), 'main'),
    ).toBe('Closes PR #63 and deletes branch s15t18; a new routine run starts from main.');
  });

  it('says a same goes back to Planning', () => {
    expect(startAgainConfirmation(view({ branch: 's1f2', type: 'same', pr }), 'main')).toBe(
      'Closes PR #63 and deletes branch s1f2; it goes back to Planning.',
    );
  });

  it('says a super stays in Doing', () => {
    expect(startAgainConfirmation(view({ branch: 's1f3', type: 'super', pr }), 'main')).toBe(
      'Closes PR #63 and deletes branch s1f3; it stays in Doing with its creator.',
    );
  });

  it('leaves out the PR clause when there is no PR', () => {
    expect(startAgainConfirmation(view({ branch: 's1t4', type: 'sub', pr: null }), 'develop')).toBe(
      'Deletes branch s1t4; a new routine run starts from develop.',
    );
    expect(startAgainConfirmation(view({ branch: 's1f2', type: 'same', pr: null }), 'main')).toBe(
      'Deletes branch s1f2; it goes back to Planning.',
    );
  });
});
