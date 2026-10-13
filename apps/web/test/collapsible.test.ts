import { describe, expect, it } from 'vitest';
import { BAR_CLASS, barLabel, boxClass, COLLAPSED_REM, needsCollapse } from '../src/lib/collapsible';

describe('collapsible markdown', () => {
  it('collapses only documents taller than the collapsed height', () => {
    expect(needsCollapse(COLLAPSED_REM * 16, 16)).toBe(false);
    expect(needsCollapse(COLLAPSED_REM * 16 + 1, 16)).toBe(true);
    expect(needsCollapse(100, 16)).toBe(false);
  });
});

describe('clamped box', () => {
  it('has a Show more bar joined to a bordered box, with no fade', () => {
    expect(barLabel(false)).toBe('Show more');
    expect(barLabel(true)).toBe('Show less');
    expect(BAR_CLASS).toContain('w-full');
    expect(boxClass(true)).toContain('border-b-0');
    for (const c of [BAR_CLASS, boxClass(true), boxClass(false)]) expect(c).not.toMatch(/gradient|fade/);
  });

  it('adds no border for short content', () => {
    expect(boxClass(false)).toBe('');
  });
});
