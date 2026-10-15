import type { Glob } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { QueueDetectionError } from '../src/codehost.js';
import type { MergeState, Repo } from '../src/codehost.js';
import { GitHub } from '../src/github/client.js';

const REPO: Repo = { owner: 'acme', name: 'app', base: 'main' };
const GLOB = { id: 's1t1', title: 'T' } as Glob;

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const graphqlError = (message: string, type: string) => Object.assign(new Error(message), { errors: [{ type, message }] });

interface Setup {
  state?: MergeState;
  behind?: boolean;
  sha?: string;
  /** What the rules read does; absent: the queue rule is on. */
  rules?: 'queue' | 'none' | Error;
  graphql?: (query: string, vars: Record<string, unknown>) => unknown;
}

/** A GitHub client with a stubbed octokit: it records every REST route and GraphQL document slop sends. */
const client = (setup: Setup = {}) => {
  const calls: string[] = [];
  const graphqlVars: Record<string, unknown>[] = [];
  const gh = Object.create(GitHub.prototype) as GitHub;
  const rules = setup.rules ?? 'queue';
  Object.assign(gh, {
    queueRulesCache: new Map(),
    octokit: () =>
      Promise.resolve({
        request: (route: string) => {
          calls.push(route);
          if (route.includes('/rules/branches/')) {
            if (rules instanceof Error) return Promise.reject(rules);
            return Promise.resolve({ data: rules === 'queue' ? [{ type: 'merge_queue' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'checks' }] } }] : [] });
          }
          if (route.includes('/pulls/{pull_number}') && route.startsWith('GET')) return Promise.resolve({ data: { node_id: 'PR_node' } });
          return Promise.resolve({ data: { sha: 'm1' } });
        },
        graphql: (query: string, vars: Record<string, unknown>) => {
          calls.push(`graphql:${query.slice(0, query.indexOf('(')).trim()}`);
          graphqlVars.push(vars);
          const answer = setup.graphql?.(query, vars) ?? { enqueuePullRequest: { mergeQueueEntry: { position: 2, state: 'QUEUED' } } };
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve(answer);
        },
      }),
    mergeState: () => Promise.resolve({ sha: setup.sha ?? 'h', state: setup.state ?? 'passed', behind: setup.behind ?? false }),
  });
  return { gh, calls, graphqlVars };
};

const writes = (calls: readonly string[]) => calls.filter((c) => c.includes('/merge') || c.includes('update-branch'));

describe('GitHub.squashMerge on a branch with a merge queue', () => {
  it('enqueues a green head at the checked sha, and never merges or updates the branch', async () => {
    const { gh, calls, graphqlVars } = client();
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'queued', position: 2, state: 'queued' });
    expect(calls).toContain('graphql:mutation');
    expect(graphqlVars[0]).toEqual({ id: 'PR_node', oid: 'h' });
    expect(writes(calls)).toEqual([]);
  });

  it('enqueues a head that is behind the base as it is: the queue tests the combined result', async () => {
    const { gh, calls } = client({ behind: true });
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toMatchObject({ outcome: 'queued' });
    expect(writes(calls)).toEqual([]);
  });

  it('reads an entry whose group is being merged (LOCKED) as merging', async () => {
    const { gh } = client({ graphql: () => ({ enqueuePullRequest: { mergeQueueEntry: { position: 1, state: 'LOCKED' } } }) });
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'queued', position: 1, state: 'merging' });
  });

  it('does not enqueue a head whose checks are not green', async () => {
    for (const state of ['pending', 'failed'] as const) {
      const { gh, calls } = client({ state });
      expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'checks_not_green', state });
      expect(calls.some((c) => c.startsWith('graphql'))).toBe(false);
    }
  });

  it('refuses a head that is not the one slop was asked to merge', async () => {
    const { gh, calls } = client({ sha: 'newer' });
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toMatchObject({ outcome: 'refused', reason: 'Head branch was modified' });
    expect(calls.some((c) => c.startsWith('graphql'))).toBe(false);
  });

  it('reads "already in the queue" as queued, with the entry the host has', async () => {
    const { gh } = client({
      graphql: (query) =>
        query.startsWith('mutation')
          ? graphqlError('Pull request is already in the merge queue', 'UNPROCESSABLE')
          : { repository: { pullRequest: { mergeQueueEntry: { id: 'E1', position: 4, state: 'QUEUED' } } } },
    });
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'queued', position: 4, state: 'queued' });
  });

  it('maps a moved head to the head-modified refusal the executor already handles', async () => {
    const { gh } = client({ graphql: () => graphqlError('Expected head OID does not match the pull request head', 'UNPROCESSABLE') });
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toMatchObject({ outcome: 'refused', reason: 'Head branch was modified' });
  });

  it('names the Merge queues permission when the App is not allowed to enqueue', async () => {
    const { gh } = client({ graphql: () => graphqlError('Resource not accessible by integration', 'FORBIDDEN') });
    const result = await gh.squashMerge(REPO, GLOB, 7, 'h');
    expect(result).toMatchObject({ outcome: 'refused' });
    expect(result.outcome === 'refused' ? result.reason : '').toMatch(/Merge queues/);
  });

  it('rethrows any other failure so the outbox retries', async () => {
    const { gh } = client({ graphql: () => new Error('GitHub is down') });
    await expect(gh.squashMerge(REPO, GLOB, 7, 'h')).rejects.toThrow('GitHub is down');
  });

  it('fails closed when the rules cannot be read: no merge, no update, no enqueue', async () => {
    for (const [code, message] of [[403, 'Forbidden'], [500, 'boom']] as const) {
      const error = httpError(code, message);
      const { gh, calls } = client({ rules: error });
      await expect(gh.squashMerge(REPO, GLOB, 7, 'h')).rejects.toThrow(QueueDetectionError);
      await expect(gh.squashMerge(REPO, GLOB, 7, 'h')).rejects.toThrow(new RegExp(`HTTP ${String(code)}`));
      expect(writes(calls)).toEqual([]);
      expect(calls.some((c) => c.startsWith('graphql'))).toBe(false);
    }
  });

  it('merges directly when the rules show no queue', async () => {
    const { gh, calls } = client({ rules: 'none' });
    expect(await gh.squashMerge(REPO, GLOB, 7, 'h')).toEqual({ outcome: 'merged', sha: 'm1' });
    expect(calls.some((c) => c.startsWith('graphql'))).toBe(false);
  });

  it('reuses the rules read for a few minutes', async () => {
    const { gh, calls } = client();
    await gh.squashMerge(REPO, GLOB, 7, 'h');
    await gh.squashMerge(REPO, GLOB, 7, 'h');
    expect(calls.filter((c) => c.includes('/rules/branches/'))).toHaveLength(1);
  });
});

describe('GitHub.dequeue and mergeQueueEntry', () => {
  it('removes a queued PR by its entry id', async () => {
    const { gh, calls, graphqlVars } = client({
      graphql: (query) => (query.startsWith('mutation') ? { dequeuePullRequest: { clientMutationId: null } } : { repository: { pullRequest: { mergeQueueEntry: { id: 'E1', position: 2, state: 'QUEUED' } } } }),
    });
    expect(await gh.dequeue(REPO, 7)).toBe('dequeued');
    expect(calls.filter((c) => c === 'graphql:mutation')).toHaveLength(1);
    expect(graphqlVars[1]).toEqual({ id: 'E1' });
  });

  it('says not_queued when there is no entry, without calling the mutation', async () => {
    const { gh, calls } = client({ graphql: () => ({ repository: { pullRequest: { mergeQueueEntry: null } } }) });
    expect(await gh.dequeue(REPO, 7)).toBe('not_queued');
    expect(calls).not.toContain('graphql:mutation');
    expect(await gh.mergeQueueEntry(REPO, 7)).toBeNull();
  });

  it('reads position and state of an entry', async () => {
    const { gh } = client({ graphql: () => ({ repository: { pullRequest: { mergeQueueEntry: { id: 'E1', position: 3, state: 'AWAITING_CHECKS' } } } }) });
    expect(await gh.mergeQueueEntry(REPO, 7)).toEqual({ position: 3, state: 'queued' });
  });
});
