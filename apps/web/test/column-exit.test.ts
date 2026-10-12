import { describe, expect, it } from 'vitest';
import { stepMotion } from '../src/lib/card-motion';
import {
  enterDone,
  exitDistance,
  exitDone,
  exitKeyframes,
  nextPhase,
} from '../src/lib/column-exit';

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

  it('steps it back in when shown, also mid-exit, and a finished move changes nothing else', () => {
    const entering = nextPhase('gone', false, true);
    expect(entering).toBe('entering');
    expect(nextPhase(entering, false, true)).toBe('entering');
    expect(enterDone(entering)).toBe('present');
    expect(enterDone('gone')).toBe('gone');
    expect(nextPhase('leaving', false, true)).toBe('present');
    expect(nextPhase('entering', true, true)).toBe('leaving');
    expect(nextPhase('entering', true, false)).toBe('gone');
    expect(exitDone('present')).toBe('present');
    expect(exitDone('gone')).toBe('gone');
  });

  it('stays gone while hidden', () => {
    expect(nextPhase('gone', true, true)).toBe('gone');
  });

  it('returns at once under reduced motion', () => {
    expect(nextPhase('gone', false, false)).toBe('present');
  });

  it('moves in discrete steps with no fade, at least the column width', () => {
    const distance = exitDistance(300);
    expect(distance).toBeGreaterThanOrEqual(300);
    const frames = exitKeyframes(distance);
    for (const frame of frames) expect(frame).not.toHaveProperty('opacity');
    expect(frames[1]).toEqual({ transform: `translateX(${String(distance)}px)` });
    expect(stepMotion(distance).easing).toMatch(/^steps\(\d+, end\)$/);
  });
});
