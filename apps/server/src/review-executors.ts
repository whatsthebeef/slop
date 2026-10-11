import type { Board, EffectKind, Glob } from '@slop/core';
import type { Executor } from './jobs/outbox.js';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';
import { resolveReviewTarget } from './review-target.js';
import type { ResolvedReview } from './review-target.js';

/** Runs one review against its resolved target (the findings and verification passes, then storing and publishing). */
export type RunReview = (glob: Glob, resolved: Extract<ResolvedReview, { outcome: 'ready' }>) => Promise<void>;

/**
 * Outbox executor for `review_change`. The job is dropped when its target is no longer current: a pre-merge review needs
 * the PR still ready with the queued commit as its head (a newer push queued its own job), a post-merge review needs the
 * PR merged. A test merge the host hasn't computed yet is retried; a conflicting PR has no merged result and is dropped.
 */
export const reviewExecutors = (
  host: CodeHost,
  boardOf: (id: number) => Promise<Board | null>,
  run: RunReview,
): Partial<Record<EffectKind, Executor>> => ({
  review_change: async (effect, glob) => {
    if (effect.kind !== 'review_change' || glob === null || glob.pr === null) return 'dropped';
    if (effect.stage === 'pre_merge' && (glob.status !== 'pr_open' || glob.pr.state !== 'ready' || glob.pr.headSha !== effect.sha)) return 'dropped';
    if (effect.stage === 'post_merge' && glob.pr.state !== 'merged') return 'dropped';
    const board = await boardOf(glob.boardId);
    const repo = board === null ? null : repoOf(board);
    if (repo === null) return 'dropped';
    const resolved = await resolveReviewTarget(host, repo, glob);
    if (resolved.outcome === 'undecided') throw new Error('The host has not computed the test merge yet');
    if (resolved.outcome !== 'ready' || resolved.stage !== effect.stage) return 'dropped';
    await run(glob, resolved);
    return 'done';
  },
});
