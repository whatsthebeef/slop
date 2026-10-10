import { describe, expect, it } from 'vitest';
import { MAX_MS, MIN_STEPS, STEP_MS, STEP_PX, stepMotion } from '../src/lib/card-motion';

const stepsOf = (easing: string) => Number(/steps\((\d+)/.exec(easing)?.[1]);

describe('stepMotion', () => {
  it('takes steps of about STEP_PX, each lasting STEP_MS', () => {
    const m = stepMotion(300);
    expect(stepsOf(m.easing)).toBe(Math.ceil(300 / STEP_PX));
    expect(m.duration).toBe(stepsOf(m.easing) * STEP_MS);
  });
  it('takes more steps, not bigger ones, for a longer move', () => {
    expect(stepsOf(stepMotion(400).easing)).toBeGreaterThan(stepsOf(stepMotion(200).easing));
  });
  it('is capped for long moves', () => {
    expect(stepMotion(5000).duration).toBe(MAX_MS);
  });
  it('never has fewer than the minimum steps', () => {
    expect(stepsOf(stepMotion(1).easing)).toBe(MIN_STEPS);
  });
  it('keeps its own small steps but finishes with a given duration', () => {
    const m = stepMotion(60, 800);
    expect(m.duration).toBe(800);
    expect(stepsOf(m.easing)).toBe(3);
  });
});
