import type { Board, Effect, Glob } from '@slop/core';
import { describe, expect, it, vi } from 'vitest';
import type { GlobService } from '@slop/core';
import { reviewExecutors } from '../src/review-executors.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const NOW = '2026-10-11T00:00:00.000Z';
const board = { id: 1, repo: 'o/r', baseBranch: 'main' } as unknown as Board;

const glob = (patch: Partial<Glob> = {}): Glob => ({
  id: 's1t1',
  boardId: 1,
  title: 'Work',
  summary: '',
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  status: 'pr_open',
  version: 1,
  generation: 1,
  creator: 'dev@example.com',
  planner: 'dev@example.com',
  implementer: null,
  labels: {},
  checklists: {},
  pr: { number: 7, state: 'ready', headSha: 'aaa' },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: NOW,
  updatedAt: NOW,
  signedOffAt: null,
  doingSince: NOW,
  ...patch,
});

const pre: Effect = { kind: 'review_change', globId: 's1t1', generation: 1, stage: 'pre_merge', sha: 'aaa' };
const post: Effect = { kind: 'review_change', globId: 's1t1', generation: 1, stage: 'post_merge', sha: 'sq1' };
const deps = { globs: {} as GlobService };

const setup = () => {
  const host = new FakeCodeHost();
  host.testMergeTarget = () => Promise.resolve({ outcome: 'ready', ref: 'refs/pull/7/merge', sha: 'm1', baseSha: 'b1', diff: 'd' });
  host.mergedTarget = (r, sha) => Promise.resolve({ ref: r.base, sha, baseSha: 'p1', diff: 'squash' });
  const run = vi.fn(() => Promise.resolve());
  const execute = reviewExecutors(host, () => Promise.resolve(board), run).review_change;
  if (execute === undefined) throw new Error('missing executor');
  return { host, run, execute };
};

describe('review_change executor', () => {
  it('reviews a ready PR whose head is the queued commit', async () => {
    const { run, execute } = setup();
    expect(await execute(pre, glob(), deps)).toBe('done');
    expect(run).toHaveBeenCalledOnce();
  });

  it('drops a job whose head a newer push replaced, a PR no longer ready, and a missing glob', async () => {
    const { run, execute } = setup();
    expect(await execute(pre, glob({ pr: { number: 7, state: 'ready', headSha: 'bbb' } }), deps)).toBe('dropped');
    expect(await execute(pre, glob({ status: 'in_progress', pr: { number: 7, state: 'draft', headSha: 'aaa' } }), deps)).toBe('dropped');
    expect(await execute(pre, null, deps)).toBe('dropped');
    expect(run).not.toHaveBeenCalled();
  });

  it('reviews a merged PR after the merge', async () => {
    const { host, run, execute } = setup();
    host.prState = () => Promise.resolve({ state: 'merged', draft: false, headSha: 'aaa', mergeSha: 'sq1' });
    expect(await execute(post, glob({ type: 'sub', status: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'aaa' } }), deps)).toBe('done');
    expect(run).toHaveBeenCalledOnce();
  });

  it('retries while the test merge is undecided and drops a conflicting PR', async () => {
    const { host, run, execute } = setup();
    host.testMergeTarget = () => Promise.resolve({ outcome: 'not_open' });
    await expect(execute(pre, glob(), deps)).rejects.toThrow('test merge');
    host.testMergeTarget = () => Promise.resolve({ outcome: 'conflict' });
    expect(await execute(pre, glob(), deps)).toBe('dropped');
    expect(run).not.toHaveBeenCalled();
  });
});
