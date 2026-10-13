import { describe, expect, it } from 'vitest';
import { COLLAPSED_REM, needsCollapse } from '../src/lib/collapsible';

describe('collapsible markdown', () => {
  it('collapses only documents taller than the collapsed height', () => {
    expect(needsCollapse(COLLAPSED_REM * 16, 16)).toBe(false);
    expect(needsCollapse(COLLAPSED_REM * 16 + 1, 16)).toBe(true);
    expect(needsCollapse(100, 16)).toBe(false);
  });
});
