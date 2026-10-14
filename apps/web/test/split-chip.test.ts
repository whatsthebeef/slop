import { describe, expect, it } from 'vitest';
import { splitChip } from '../src/lib/split-chip';

const parts = ['s15f78', 's15f82', 's15f83'];

describe('splitChip', () => {
  it('has nothing for a glob that was not split', () => {
    expect(splitChip({ id: 's15f1' })).toBeNull();
  });

  it('has no chip on the first part', () => {
    expect(splitChip({ id: 's15f78', split: { source: 's15f78', part: 0, parts } })).toBeNull();
  });

  it('names the source on a later part, with the part number and the other parts in the tooltip', () => {
    const chip = splitChip({ id: 's15f83', split: { source: 's15f78', part: 2, parts } });
    expect(chip?.source).toBe('s15f78');
    expect(chip?.tip).toBe('Split from s15f78; part 3 of 3; the other parts: s15f78, s15f82');
  });

  it('still shows the source on a middle part of an older split', () => {
    const chip = splitChip({ id: 's15f82', split: { source: 's15f78', part: 1, parts } });
    expect(chip?.tip).toBe('Split from s15f78; part 2 of 3; the other parts: s15f78, s15f83');
  });
});
