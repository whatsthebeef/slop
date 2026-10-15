import type { Glob } from '@slop/core';
import { describe, expect, it } from 'vitest';
import type { MergeState, Repo } from '../src/codehost.js';
import { GitHub } from '../src/github/client.js';

const REPO: Repo = { owner: 'acme', name: 'app', base: 'main' };
const GLOB = { id: 's1t1', title: 'T' } as Glob;

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A GitHub client whose octokit answers `merge` and `update` from the given handlers. */
const client = (state: MergeState, merge: () => unknown, update: () => unknown) => {
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
    mergeState: () => Promise.resolve({ sha: 'h', state }),
  });
  return { gh, calls };
};

describe('GitHub.squashMerge on a branch that is behind', () => {
  const ok = () => ({ sha: 'm1' });
  const outOfDate = () => httpError(405, 'Head branch is out of date. The branch is behind the base.');

  it('updates it the first time', async () => {
    const { gh, calls } = client('behind', ok, () => ({}));
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h', 0)).toEqual({ outcome: 'updating' });
    expect(calls).toEqual(['update']);
  });

  it('merges it behind once it was updated', async () => {
    const { gh, calls } = client('behind', ok, () => ({}));
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h', 1)).toEqual({ outcome: 'merged', sha: 'm1' });
    expect(calls).toEqual(['merge']);
  });

  it('updates once more when branch protection needs an up-to-date branch, then refuses', async () => {
    const first = client('behind', outOfDate, () => ({}));
    expect(await first.gh.squashMerge(REPO, GLOB, 7, 'h', 1)).toEqual({ outcome: 'updating' });
    expect(first.calls).toEqual(['merge', 'update']);
    const second = client('behind', outOfDate, () => ({}));
    expect(await second.gh.squashMerge(REPO, GLOB, 7, 'h', 2)).toMatchObject({ outcome: 'refused' });
    expect(second.calls).toEqual(['merge']);
  });

  it('refuses an unrelated 405, retries when the base was modified, and reports a conflict from the fallback update', async () => {
    const other = client('behind', () => httpError(405, 'Required status check is expected'), () => ({}));
    expect(await other.gh.squashMerge(REPO, GLOB, 7, 'h', 1)).toMatchObject({ outcome: 'refused' });
    const modified = client('behind', () => httpError(405, 'Base branch was modified. Review and try the merge again.'), () => ({}));
    expect(await modified.gh.squashMerge(REPO, GLOB, 7, 'h', 1)).toEqual({ outcome: 'undecided' });
    const conflict = client('behind', outOfDate, () => httpError(422, 'merge conflict'));
    expect(await conflict.gh.squashMerge(REPO, GLOB, 7, 'h', 1)).toEqual({ outcome: 'conflict' });
  });
});
