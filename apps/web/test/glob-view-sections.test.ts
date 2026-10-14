import { describe, expect, it } from 'vitest';
import { GLOB_VIEW_SECTIONS } from '../src/components/glob-view/sections';
import { GLOB_SECTIONS } from '../src/lib/glob-section';

describe('glob view section registry', () => {
  it('has a unique data-section id per section', () => {
    expect(new Set(GLOB_VIEW_SECTIONS).size).toBe(GLOB_VIEW_SECTIONS.length);
  });

  it('lists every section a deep link can open', () => {
    expect([...GLOB_VIEW_SECTIONS].sort()).toEqual([...GLOB_SECTIONS].sort());
  });

  it('renders Related directly below Artifacts', () => {
    expect(GLOB_VIEW_SECTIONS.indexOf('related')).toBe(GLOB_VIEW_SECTIONS.indexOf('artifacts') + 1);
  });
});
