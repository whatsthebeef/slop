import type { BoardJobResult, BoardJobStatus } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { isJobRunning, JOB_LABELS, jobSummary } from '../src/components/job-status';

const status = (running: boolean): BoardJobStatus => ({ boardId: 1, job: 'mining', lastRunAt: null, lastResult: null, runningUntil: null, running });

const consolidation = (patch: Partial<Extract<BoardJobResult, { kind: 'consolidation' }>>): BoardJobResult => ({
  kind: 'consolidation',
  candidates: 5,
  proposed: 0,
  verified: 0,
  merged: [],
  skipped: 0,
  flaggedStale: 0,
  clearedStale: 0,
  ...patch,
});

describe('a board job in a few words', () => {
  it('says what a mining, effect-check and consolidation run did', () => {
    expect(jobSummary({ kind: 'mining', measured: 12, crossed: 3, raised: ['s1k1', 's1k2'], refreshed: [] })).toBe('12 signals measured, 2 raised');
    expect(jobSummary({ kind: 'effect_check', watching: 3, decided: [{ id: 's1k3', state: 'improved' }], raised: [] })).toBe(
      '3 watching, 1 decided, 0 revise-or-revert items raised',
    );
    expect(jobSummary(consolidation({ proposed: 4, alreadyChecked: 1, merged: [{ id: 'a', into: 'b' }], flaggedStale: 2 }))).toBe(
      '4 pairs proposed (1 already checked), 1 merged, 2 flagged stale',
    );
    expect(jobSummary(consolidation({ unchanged: true }))).toBe('candidates unchanged since the last run, 0 flagged stale');
  });

  it('says why a run failed or waits', () => {
    expect(jobSummary({ kind: 'failed', error: 'boom' })).toBe('the last run failed: boom');
    expect(jobSummary({ kind: 'skipped', reason: 'no repository' })).toBe('waiting: no repository; it tries again within the hour');
  });

  it('knows a job is running only when its lease is held', () => {
    expect(isJobRunning(undefined)).toBe(false);
    expect(isJobRunning(status(true))).toBe(true);
    expect(isJobRunning(status(false))).toBe(false);
  });

  it('labels every job the board runs', () => {
    expect(Object.keys(JOB_LABELS).sort()).toEqual(['consolidation', 'context_tuning', 'effect_check', 'hotspots', 'intake_outcome', 'mining', 'size_threshold', 'sub_limit']);
  });
});

describe('conflict hotspots', () => {
  it('summarises a hotspots run', () => {
    expect(jobSummary({ kind: 'hotspots', hot: 2, files: [] })).toBe('2 conflict hotspots');
    expect(jobSummary({ kind: 'hotspots', hot: 1, files: [] })).toBe('1 conflict hotspot');
  });
});
