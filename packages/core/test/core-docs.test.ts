import { describe, expect, it } from 'vitest';
import { missingCoreAreas, missingCoreDocNotice } from '../src/domain/core-docs.js';

describe('core documents', () => {
  it('lists the core areas no document has, in order', () => {
    expect(missingCoreAreas([])).toEqual(['build', 'conventions', 'architecture']);
    expect(missingCoreAreas([{ area: 'build' }, { area: 'review' }, { area: null }])).toEqual(['conventions', 'architecture']);
    expect(missingCoreAreas([{ area: 'architecture' }, { area: 'conventions' }, { area: 'build' }])).toEqual([]);
  });

  it('says how to fix a missing one', () => {
    expect(missingCoreDocNotice('architecture', 15)).toBe(
      "No architecture document. Run `/kb-bootstrap 15` in a checkout of the board's repo; it proposes one for you to approve.",
    );
  });
});
