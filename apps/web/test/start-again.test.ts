import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { startAgainConfirmation } from '../src/lib/start-again';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const pr = { number: 63, state: 'draft' as const, headSha: 'abc' };

describe('Discard confirmation', () => {
  it('says what is discarded and that nothing starts, for every type', () => {
    for (const type of ['sub', 'same', 'super'] as const) {
      expect(startAgainConfirmation(view({ branch: 's1t4', type, pr }))).toBe(
        'Closes PR #63 and deletes branch s1t4, clears the implementer and moves the glob back to Planning. Nothing starts; the plan, questions and relations stay.',
      );
    }
  });

  it('leaves out the PR clause when there is no PR', () => {
    expect(startAgainConfirmation(view({ branch: 's1t4', type: 'sub', pr: null }))).toBe(
      'Deletes branch s1t4, clears the implementer and moves the glob back to Planning. Nothing starts; the plan, questions and relations stay.',
    );
  });
});
