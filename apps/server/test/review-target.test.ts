import type { Glob } from '@slop/core';
import { describe, expect, it } from 'vitest';
import type { Repo } from '../src/codehost.js';
import { resolveReviewTarget } from '../src/review-target.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const NOW = '2026-10-11T00:00:00.000Z';
const repo: Repo = { owner: 'o', name: 'r', base: 'main' };

const glob = (patch: Partial<Glob> = {}): Glob => ({
  id: 's1t1',
  boardId: 1,
  title: 'Work',
  summary: '',
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  status: 'in_progress',
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

describe('resolveReviewTarget', () => {
  it('reviews an open PR as merged into the current base, from the test-merge ref', async () => {
    const host = new FakeCodeHost();
    host.testMergeTarget = () => Promise.resolve({ outcome: 'ready', ref: 'refs/pull/7/merge', sha: 'm1', baseSha: 'b1', diff: 'diff --git a/x b/x' });
    host.mergedTarget = () => Promise.reject(new Error('not merged'));
    const result = await resolveReviewTarget(host, repo, glob());
    expect(result).toMatchObject({ outcome: 'ready', stage: 'pre_merge', diff: { ref: 'refs/pull/7/merge', sha: 'm1' }, target: { boardId: 1, globId: 's1t1', diff: 'diff --git a/x b/x' } });
  });

  it('reviews a merged change as its squash commit with files read from the current base', async () => {
    const host = new FakeCodeHost();
    host.prState = () => Promise.resolve({ state: 'merged', draft: false, headSha: 'aaa', mergeSha: 'sq1' });
    host.mergedTarget = (r, sha) => Promise.resolve({ ref: r.base, sha, baseSha: 'p1', diff: 'squash diff' });
    host.testMergeTarget = () => Promise.reject(new Error('merged'));
    const result = await resolveReviewTarget(host, repo, glob());
    expect(result).toMatchObject({ outcome: 'ready', stage: 'post_merge', diff: { ref: 'main', sha: 'sq1' }, target: { diff: 'squash diff' } });
  });

  it('reports a conflict and a test merge still being computed instead of reviewing the branch alone', async () => {
    const host = new FakeCodeHost();
    host.testMergeTarget = () => Promise.resolve({ outcome: 'conflict' });
    expect(await resolveReviewTarget(host, repo, glob())).toEqual({ outcome: 'conflict' });
    host.testMergeTarget = () => Promise.resolve({ outcome: 'undecided' });
    expect(await resolveReviewTarget(host, repo, glob())).toEqual({ outcome: 'undecided' });
  });

  it('has nothing to review for a glob without a PR, a closed PR, or a merged PR with no merge commit', async () => {
    const host = new FakeCodeHost();
    expect(await resolveReviewTarget(host, repo, glob({ pr: null }))).toMatchObject({ outcome: 'unavailable' });
    host.prState = () => Promise.resolve({ state: 'closed', draft: false, headSha: 'aaa', mergeSha: null });
    expect(await resolveReviewTarget(host, repo, glob())).toMatchObject({ outcome: 'unavailable' });
    host.prState = () => Promise.resolve({ state: 'merged', draft: false, headSha: 'aaa', mergeSha: null });
    expect(await resolveReviewTarget(host, repo, glob())).toMatchObject({ outcome: 'unavailable' });
  });
});
