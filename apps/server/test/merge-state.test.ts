import { describe, expect, it } from 'vitest';
import { classifyMergeState, staleCancelledRuns } from '../src/github/merge-state.js';

const run = (status: string, conclusion: string | null) => ({ status, conclusion });

describe('classifyMergeState', () => {
  it('clean passes', () => {
    expect(classifyMergeState('clean', [])).toBe('passed');
  });

  it('unstable with a failed check run (a non-required sub-gate) fails', () => {
    expect(classifyMergeState('unstable', [run('completed', 'success'), run('completed', 'failure')])).toBe('failed');
  });

  it('unstable with a run still going is pending, not failed', () => {
    expect(classifyMergeState('unstable', [run('completed', 'success'), run('in_progress', null)])).toBe('pending');
  });

  it('unstable with no failed run (a failing commit status) fails', () => {
    expect(classifyMergeState('unstable', [run('completed', 'success')])).toBe('failed');
  });

  it('blocked by a failed required check fails; otherwise pending', () => {
    expect(classifyMergeState('blocked', [run('completed', 'timed_out')])).toBe('failed');
    expect(classifyMergeState('blocked', [run('completed', 'success')])).toBe('pending');
  });

  it('keeps the other mappings', () => {
    expect(classifyMergeState('behind', [])).toBe('behind');
    expect(classifyMergeState('dirty', [])).toBe('conflict');
    expect(classifyMergeState('draft', [])).toBe('pending');
    expect(classifyMergeState('unknown', [])).toBe('unknown');
  });

  it('a cancelled run is not a failure: the head stays pending for the newer run', () => {
    expect(classifyMergeState('unstable', [run('completed', 'success'), run('completed', 'cancelled')])).toBe('pending');
    expect(classifyMergeState('blocked', [run('completed', 'cancelled')])).toBe('pending');
  });

  it('a failure elsewhere still fails the head next to a cancelled run', () => {
    expect(classifyMergeState('unstable', [run('completed', 'cancelled'), run('completed', 'failure')])).toBe('failed');
  });

  it('a later success on the head passes it', () => {
    // GitHub lists only the latest run per check name, so the replacement hides the cancelled one.
    expect(classifyMergeState('clean', [run('completed', 'success')])).toBe('passed');
    expect(classifyMergeState('unstable', [run('completed', 'success')])).toBe('failed');
  });
});

describe('staleCancelledRuns', () => {
  const now = Date.parse('2026-10-08T12:10:00Z');
  const cancelled = (completed_at: string) => ({ status: 'completed', conclusion: 'cancelled', completed_at });

  it('picks cancelled runs with no replacement after the wait', () => {
    const old = cancelled('2026-10-08T12:00:00Z');
    expect(staleCancelledRuns([old, cancelled('2026-10-08T12:08:00Z'), { status: 'completed', conclusion: 'success', completed_at: '2026-10-08T12:00:00Z' }], now)).toEqual([old]);
  });
});
