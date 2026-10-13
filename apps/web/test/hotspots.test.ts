import type { Hotspot } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { hotspotLine } from '../src/components/hotspots';

const hotspot = (patch: Partial<Hotspot>): Hotspot => ({
  path: 'a.ts',
  conflicts: 6,
  globs: ['s1t1', 's1t2', 's1t3', 's1t4', 's1t5'],
  real: 0,
  lastConflictAt: '2026-10-12T00:00:00.000Z',
  merges: 17,
  lines: 1100,
  ...patch,
});

describe('a hotspot in a line', () => {
  it('gives conflicts, globs, merges and lines', () => {
    expect(hotspotLine(hotspot({}))).toBe('6 conflicts · 5 globs · 17 merges · 1,100 lines');
    expect(hotspotLine(hotspot({ real: 2 }))).toContain('5 globs · 2 real · 17 merges');
  });

  it('leaves out what the code host could not say', () => {
    expect(hotspotLine(hotspot({ conflicts: 1, globs: ['s1t1'], merges: null, lines: null }))).toBe(
      '1 conflict · 1 glob',
    );
  });
});
