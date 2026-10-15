import { describe, expect, it } from 'vitest';
import { flagsOf } from '../src/lib/assessment-flags';

describe('the flags of an assessment', () => {
  it('lists the flag lines and nothing of the other fields', () => {
    const markdown = '## Assessment\n\n- Scope: All new globs\n- Channel: agent\n\n### Flags\n\n- May already be covered by existing knowledge.\n- Stale draft.\n\n### Suggested outcome\n\nApprove.\n';
    expect(flagsOf(markdown)).toEqual(['May already be covered by existing knowledge.', 'Stale draft.']);
  });
  it('is empty for None. or no Flags section', () => {
    expect(flagsOf('### Flags\n\nNone.\n')).toEqual([]);
    expect(flagsOf('nothing')).toEqual([]);
  });
});
