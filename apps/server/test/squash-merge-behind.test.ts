import type { Glob } from '@slop/core';
import { describe, expect, it } from 'vitest';
import type { MergeState, Repo } from '../src/codehost.js';
import { GitHub } from '../src/github/client.js';

const REPO: Repo = { owner: 'acme', name: 'app', base: 'main' };
const GLOB = { id: 's1t1', title: 'T' } as Glob;

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A GitHub client whose octokit answers `merge` and `update` from the given handlers, and whose PR reads as given. */
const client = (read: { state: MergeState; behind?: boolean; sha?: string }, merge: () => unknown, update: () => unknown) => {
  const calls: string[] = [];
  const gh = Object.create(GitHub.prototype) as GitHub;
  Object.assign(gh, {
    octokit: () =>
      Promise.resolve({
        request: (route: string) => {
          calls.push(route.includes('update-branch') ? 'update' : 'merge');
          const answer = route.includes('update-branch') ? update() : merge();
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve({ data: answer });
        },
      }),
    mergeState: () => Promise.resolve({ sha: read.sha ?? 'h', state: read.state, behind: read.behind ?? false }),
  });
  return { gh, calls };
};

describe('GitHub.squashMerge enforces green checks on an up-to-date head (slop bypasses the ruleset)', () => {
  const ok = () => ({ sha: 'm1' });
  const none = () => ({});

  it('updates a behind head whose checks passed, and never merges it behind', async () => {
    for (const state of ['passed', 'pending', 'failed'] as const) {
      const { gh, calls } = client({ state, behind: true }, ok, none);
      expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'updating' });
      expect(calls).toEqual(['update']);
    }
  });

  it('does not merge a head whose checks are running or failed', async () => {
    for (const state of ['pending', 'failed'] as const) {
      const { gh, calls } = client({ state }, ok, none);
      expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'checks_not_green', state });
      expect(calls).toEqual([]);
    }
  });

  it('refuses a head that is not the one slop was asked to merge, without calling the merge API', async () => {
    const { gh, calls } = client({ state: 'passed', sha: 'newer' }, ok, none);
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toMatchObject({ outcome: 'refused', reason: 'Head branch was modified' });
    expect(calls).toEqual([]);
  });

  it('merges an up-to-date green head, pinned to the checked sha', async () => {
    const { gh, calls } = client({ state: 'passed' }, ok, none);
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'merged', sha: 'm1' });
    expect(calls).toEqual(['merge']);
  });

  it('retries a 405 (the base moved since the read), so the next look updates the branch', async () => {
    const { gh } = client({ state: 'passed' }, () => httpError(405, 'Base branch was modified. Review and try the merge again.'), none);
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'undecided' });
  });

  it('reports a conflict from the update, or from the read', async () => {
    const conflict = client({ state: 'passed', behind: true }, ok, () => httpError(422, 'merge conflict'));
    expect(await conflict.gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'conflict' });
    const dirty = client({ state: 'conflict' }, ok, none);
    expect(await dirty.gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'conflict' });
  });
});
