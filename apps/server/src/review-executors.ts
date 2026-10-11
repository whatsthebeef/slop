import type { Board, EffectKind, Glob } from '@slop/core';
import type { Executor } from './jobs/outbox.js';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';
import { resolveReviewTarget } from './review-target.js';
import type { ResolvedReview } from './review-target.js';

/** Runs one review against its resolved target (the findings and verification passes, then storing and publishing). */
export type RunReview = (glob: Glob, resolved: Extract<ResolvedReview, { outcome: 'ready' }>) => Promise<void>;

/**
 * Outbox executor for `review_change`. An automatic job is dropped when its target is no longer current: a pre-merge review
 * needs the PR still ready with the queued commit as its head (a newer push queued its own job), a post-merge review needs
 * the PR merged. An on-demand job (Review now, it has a `requestId`) reviews the PR as it is when it runs, at whichever
 * stage that is: an open PR (draft or ready) before merge, a merged one after; only a PR closed without merging drops it.
 * A test merge the host hasn't computed yet is retried; a conflicting PR has no merged result and is dropped.
 * A board with its reviewer turned off drops its automatic jobs, those queued before it was turned off too; "Review now"
 * still runs, so a person can ask for a review of a board that doesn't review by itself.
 */
export const reviewExecutors = (
  host: CodeHost,
  boardOf: (id: number) => Promise<Board | null>,
  run: RunReview,
  /** Whether the board's automatic reviews are on (its review settings). */
  enabled: (boardId: number) => Promise<boolean> = () => Promise.resolve(true),
): Partial<Record<EffectKind, Executor>> => ({
  review_change: async (effect, glob) => {
    if (effect.kind !== 'review_change' || glob === null || glob.pr === null) return 'dropped';
    const onDemand = effect.requestId !== undefined;
    if (!onDemand && !(await enabled(glob.boardId))) return 'dropped';
    if (onDemand) {
      if (glob.pr.state === 'closed') return 'dropped';
    } else {
      if (effect.stage === 'pre_merge' && (glob.status !== 'pr_open' || glob.pr.state !== 'ready' || glob.pr.headSha !== effect.sha)) return 'dropped';
      if (effect.stage === 'post_merge' && glob.pr.state !== 'merged') return 'dropped';
    }
    const board = await boardOf(glob.boardId);
    const repo = board === null ? null : repoOf(board);
    if (repo === null) return 'dropped';
    const resolved = await resolveReviewTarget(host, repo, glob);
    if (resolved.outcome === 'undecided') throw new Error('The host has not computed the test merge yet');
    if (resolved.outcome !== 'ready' || (!onDemand && resolved.stage !== effect.stage)) return 'dropped';
    await run(glob, resolved);
    return 'done';
  },
});
