import type { Glob, ReviewTarget } from '@slop/core';
import type { CodeHost, Repo, ReviewDiff } from './codehost.js';

/** What the reviewer is pointed at, or why it can't be yet. */
export type ResolvedReview =
  | { readonly outcome: 'ready'; readonly stage: 'pre_merge' | 'post_merge'; readonly diff: ReviewDiff; readonly target: ReviewTarget }
  /** The PR conflicts with the latest base branch: there is no merged result to review. */
  | { readonly outcome: 'conflict' }
  /** The host is still computing the test merge: retry shortly. */
  | { readonly outcome: 'undecided' }
  | { readonly outcome: 'unavailable'; readonly reason: string };

/**
 * Points a review at the change as it applies to the latest base branch. An open PR is read from the host's test-merge
 * ref (the PR merged into the current base), so findings match how it will land even when its branch is behind. A merged
 * change is the glob's squash commit, with surrounding files read from the current base branch.
 */
export const resolveReviewTarget = async (host: CodeHost, repo: Repo, glob: Glob, signal?: AbortSignal): Promise<ResolvedReview> => {
  if (glob.pr === null) return { outcome: 'unavailable', reason: `Glob ${glob.id} has no pull request to review` };
  const snapshot = await host.prState(repo, glob.pr.number);
  const scope = { boardId: glob.boardId, globId: glob.id };
  if (snapshot.state === 'merged') {
    if (snapshot.mergeSha === null) return { outcome: 'unavailable', reason: `PR ${String(glob.pr.number)} is merged but the host gave no merge commit` };
    const diff = await host.mergedTarget(repo, snapshot.mergeSha, signal);
    return { outcome: 'ready', stage: 'post_merge', diff, target: { ...scope, diff: diff.diff } };
  }
  if (snapshot.state === 'closed') return { outcome: 'unavailable', reason: `PR ${String(glob.pr.number)} is closed without merging` };
  const merged = await host.testMergeTarget(repo, glob.pr.number, signal);
  if (merged.outcome === 'ready') return { outcome: 'ready', stage: 'pre_merge', diff: merged, target: { ...scope, diff: merged.diff } };
  if (merged.outcome === 'not_open') return { outcome: 'undecided' };
  return { outcome: merged.outcome };
};
