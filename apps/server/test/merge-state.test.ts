import { describe, expect, it } from 'vitest';
import { classifyMergeState } from '../src/github/merge-state.js';

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
});
