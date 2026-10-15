import { describe, expect, it } from 'vitest';
import { DECISION_VIEW_SECTIONS, GLOB_VIEW_SECTIONS, LEARNING_VIEW_SECTIONS, viewSections } from '../src/components/glob-view/sections';
import { GLOB_SECTIONS } from '../src/lib/glob-section';
import type { GlobSection } from '../src/lib/glob-section';

describe('glob view section registry', () => {
  it('has a unique data-section id per section', () => {
    expect(new Set(GLOB_VIEW_SECTIONS).size).toBe(GLOB_VIEW_SECTIONS.length);
  });

  it('lists every section a deep link can open', () => {
    // 'due-steps' is not in the fixed order: viewSections adds it while a step is due.
    expect([...GLOB_VIEW_SECTIONS].sort()).toEqual(GLOB_SECTIONS.filter((s) => s !== 'due-steps').sort());
  });

  it('lists the blocks above the actions in one order: problems, then what needs a person, then information', () => {
    for (const order of [GLOB_VIEW_SECTIONS, DECISION_VIEW_SECTIONS]) {
      const at = (name: GlobSection) => order.indexOf(name);
      expect(at('conflict')).toBeLessThan(at('problem'));
      expect(at('problem')).toBeLessThan(at('decision'));
      expect(at('decision')).toBeLessThan(at('labels'));
      expect(at('labels')).toBeLessThan(at('escalation'));
      expect(at('escalation')).toBeLessThan(at('size'));
      expect(at('size')).toBeLessThan(at('actions'));
    }
  });

  it('puts the due Human steps after the labels and before the information blocks', () => {
    for (const [decision, learning] of [[false, false], [true, false], [false, true]] as const) {
      const order = viewSections(decision, true, learning);
      expect(order.indexOf('due-steps')).toBeGreaterThan(order.indexOf('labels'));
      expect(order.indexOf('due-steps')).toBeLessThan(order.indexOf('escalation'));
      expect(order.indexOf('due-steps')).toBeLessThan(order.indexOf('actions'));
      expect(order.indexOf('human-steps')).toBeGreaterThan(order.indexOf('actions'));
      expect(new Set(order).size).toBe(order.length);
    }
  });

  it('puts every block that needs a person above the actions, in every view kind, with and without a due step', () => {
    const needsPerson: GlobSection[] = ['conflict', 'problem', 'decision', 'labels', 'due-steps'];
    for (const order of [
      viewSections(false, false),
      viewSections(false, true),
      viewSections(true, false),
      viewSections(true, true),
      viewSections(false, false, true),
      viewSections(false, true, true),
    ]) {
      for (const name of needsPerson) {
        if (order.includes(name)) expect(order.indexOf(name)).toBeLessThan(order.indexOf('actions'));
      }
    }
  });

  it('renders Related directly below Artifacts', () => {
    expect(GLOB_VIEW_SECTIONS.indexOf('related')).toBe(GLOB_VIEW_SECTIONS.indexOf('artifacts') + 1);
  });

  it('leaves a work glob’s sections out of a learning’s view, and keeps the decision block above the action row', () => {
    for (const name of ['plan', 'artifacts', 'deploys', 'environments', 'tests', 'findings', 'size'] as const) {
      expect(LEARNING_VIEW_SECTIONS).not.toContain(name);
    }
    expect(LEARNING_VIEW_SECTIONS.indexOf('decision')).toBeLessThan(LEARNING_VIEW_SECTIONS.indexOf('actions'));
    expect(new Set(LEARNING_VIEW_SECTIONS).size).toBe(LEARNING_VIEW_SECTIONS.length);
    for (const name of LEARNING_VIEW_SECTIONS) expect(GLOB_SECTIONS).toContain(name);
  });
});
