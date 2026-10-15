import { describe, expect, it } from 'vitest';
import { GLOB_VIEW_SECTIONS, LEARNING_VIEW_SECTIONS } from '../src/components/glob-view/sections';
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

  it('leaves a work glob’s sections out of a learning’s view, with the action row first and the decision block next', () => {
    for (const name of ['plan', 'artifacts', 'deploys', 'environments', 'tests', 'findings', 'size'] as const) {
      expect(LEARNING_VIEW_SECTIONS).not.toContain(name);
    }
    expect(LEARNING_VIEW_SECTIONS.slice(0, 2)).toEqual(['actions', 'decision']);
    expect(new Set(LEARNING_VIEW_SECTIONS).size).toBe(LEARNING_VIEW_SECTIONS.length);
    for (const name of LEARNING_VIEW_SECTIONS) expect(GLOB_SECTIONS).toContain(name);
  });
});
