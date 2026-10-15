import { describe, expect, it } from 'vitest';
import { classifyMergeState } from '../src/github/merge-state.js';

const run = (status: string, conclusion: string | null) => ({ status, conclusion });

describe('classifyMergeState', () => {
  it('clean passes once a check run succeeded; with no check runs yet it is pending', () => {
    expect(classifyMergeState('clean', [run('completed', 'success')])).toBe('passed');
    expect(classifyMergeState('clean', [])).toBe('pending');
    expect(classifyMergeState('has_hooks', [])).toBe('pending');
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

  it('a behind head is judged by its own check runs, never passed on `behind` alone', () => {
    expect(classifyMergeState('behind', [])).toBe('pending');
    expect(classifyMergeState('behind', [run('in_progress', null)])).toBe('pending');
    expect(classifyMergeState('behind', [run('completed', 'success'), run('in_progress', null)])).toBe('pending');
    expect(classifyMergeState('behind', [run('completed', 'skipped')])).toBe('pending');
    expect(classifyMergeState('behind', [run('in_progress', null), run('completed', 'failure')])).toBe('failed');
    expect(classifyMergeState('behind', [run('completed', 'success')])).toBe('passed');
  });

  it('keeps the other mappings', () => {
    expect(classifyMergeState('dirty', [])).toBe('conflict');
    expect(classifyMergeState('draft', [])).toBe('pending');
    expect(classifyMergeState('unknown', [])).toBe('unknown');
  });

  it('a cancelled run is not a failure: the head waits for the newer run', () => {
    expect(classifyMergeState('unstable', [run('completed', 'cancelled')])).toBe('pending');
    expect(classifyMergeState('blocked', [run('completed', 'success'), run('completed', 'cancelled')])).toBe('pending');
    // A real failure beside it still fails the head.
    expect(classifyMergeState('unstable', [run('completed', 'cancelled'), run('completed', 'failure')])).toBe('failed');
  });

  it('a clean head whose runs were all skipped (a draft PR) is pending, not passed', () => {
    expect(classifyMergeState('clean', [run('completed', 'skipped'), run('completed', 'skipped')])).toBe('pending');
    expect(classifyMergeState('clean', [run('completed', 'neutral')])).toBe('pending');
    expect(classifyMergeState('clean', [run('completed', 'skipped'), run('completed', 'success')])).toBe('passed');
  });

  it('skipped runs, then real runs: no pass until a run succeeds, and a failure fails', () => {
    expect(classifyMergeState('clean', [run('completed', 'skipped')])).toBe('pending');
    expect(classifyMergeState('blocked', [run('completed', 'skipped'), run('in_progress', null)])).toBe('pending');
    expect(classifyMergeState('unstable', [run('completed', 'failure')])).toBe('failed');
    expect(classifyMergeState('clean', [run('completed', 'success')])).toBe('passed');
  });
});

describe('classifyMergeState with a merge queue', () => {
  const named = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });

  it('a blocked head passes when every required check succeeded (the queue rule makes a green PR blocked)', () => {
    const runs = [named('checks', 'completed', 'success')];
    expect(classifyMergeState('blocked', runs, { required: ['checks'] })).toBe('passed');
    // Without queue mode the same read stays pending.
    expect(classifyMergeState('blocked', runs)).toBe('pending');
  });

  it('stays pending when a required check has not run, and with no names needs one success', () => {
    expect(classifyMergeState('blocked', [named('lint', 'completed', 'success')], { required: ['checks'] })).toBe('pending');
    expect(classifyMergeState('blocked', [named('lint', 'completed', 'success')], { required: [] })).toBe('passed');
    expect(classifyMergeState('blocked', [named('lint', 'completed', 'skipped')], { required: [] })).toBe('pending');
  });

  it('a failed or unfinished run still decides first', () => {
    const queue = { required: ['checks'] };
    expect(classifyMergeState('blocked', [named('checks', 'completed', 'success'), named('x', 'completed', 'failure')], queue)).toBe('failed');
    expect(classifyMergeState('blocked', [named('checks', 'completed', 'success'), named('x', 'in_progress', null)], queue)).toBe('pending');
  });

  it('leaves clean, unstable and conflict untouched', () => {
    const queue = { required: ['checks'] };
    expect(classifyMergeState('unstable', [named('checks', 'completed', 'success')], queue)).toBe('failed');
    expect(classifyMergeState('dirty', [], queue)).toBe('conflict');
    expect(classifyMergeState('clean', [named('checks', 'completed', 'success')], queue)).toBe('passed');
  });
});
