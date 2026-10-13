import { describe, expect, it } from 'vitest';
import { barClass, barLabel, boxClass, COLLAPSED_REM, FADE_STYLE, needsCollapse } from '../src/lib/collapsible';

describe('collapsible markdown', () => {
  it('collapses only documents taller than the collapsed height', () => {
    expect(needsCollapse(COLLAPSED_REM * 16, 16)).toBe(false);
    expect(needsCollapse(COLLAPSED_REM * 16 + 1, 16)).toBe(true);
    expect(needsCollapse(100, 16)).toBe(false);
  });
});

describe('clamped box', () => {
  it('has a Show more bar joined to a bordered box, with a faint separator and a mask fade only while clipped', () => {
    expect(barLabel(false)).toBe('Show more');
    expect(barLabel(true)).toBe('Show less');
    expect(barClass(true)).toContain('w-full');
    expect(boxClass(true)).toContain('border-b-0');
    expect(barClass(true)).toContain('border-t-border/40');
    expect(barClass(false)).not.toContain('border-t-border/40');
    expect(FADE_STYLE.maskImage).toContain('linear-gradient');
    for (const c of [barClass(true), boxClass(true), boxClass(false)]) expect(c).not.toMatch(/gradient|fade/);
  });

  it('adds no border for short content, and the box always carries the solid background', () => {
    expect(boxClass(false)).not.toContain('border');
    expect(boxClass(true)).toContain('bg-muted');
    expect(boxClass(false)).toContain('bg-muted');
  });
});
