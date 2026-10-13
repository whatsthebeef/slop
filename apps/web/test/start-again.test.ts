import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { startAgainConfirmation } from '../src/lib/start-again';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const pr = { number: 63, state: 'draft' as const, headSha: 'abc' };

describe('Discard confirmation', () => {
  it('says a sub closes the PR, deletes the branch and starts a run', () => {
    expect(
      startAgainConfirmation(view({ id: 's15t18', branch: 's15t18', type: 'sub', pr }), 'main'),
    ).toBe('Closes PR #63 and deletes branch s15t18; a new machine run starts from main.');
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
      'Deletes branch s1t4; a new machine run starts from develop.',
    );
    expect(startAgainConfirmation(view({ branch: 's1f2', type: 'same', pr: null }), 'main')).toBe(
      'Deletes branch s1f2; it goes back to Planning.',
    );
  });
});
