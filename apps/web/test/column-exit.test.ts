import { describe, expect, it } from 'vitest';
import { exitDone, nextPhase } from '../src/lib/column-exit';

describe('column exit phases', () => {
  it('keeps a hidden column mounted while it leaves, then removes it', () => {
    const leaving = nextPhase('present', true, true);
    expect(leaving).toBe('leaving');
    expect(nextPhase(leaving, true, true)).toBe('leaving');
    expect(exitDone(leaving)).toBe('gone');
  });

  it('removes the column at once under reduced motion', () => {
    expect(nextPhase('present', true, false)).toBe('gone');
  });

  it('brings it back at once, also mid-exit, and a finished exit changes nothing else', () => {
    expect(nextPhase('gone', false, true)).toBe('present');
    expect(nextPhase('leaving', false, true)).toBe('present');
    expect(exitDone('present')).toBe('present');
    expect(exitDone('gone')).toBe('gone');
  });

  it('stays gone while hidden', () => {
    expect(nextPhase('gone', true, true)).toBe('gone');
  });
});
