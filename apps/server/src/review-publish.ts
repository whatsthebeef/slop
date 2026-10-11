import {
  checkRunText,
  outdatedBody,
  planReviewPublication,
  renderPostMergeComment,
  reviewMarker,
  reviewMarkerPrefix,
} from '@slop/core';
import type { Glob, IndependentReview, ReviewSeverity } from '@slop/core';
import type { CodeHost, Repo } from './codehost.js';
import { REVIEW_CHECK } from './codehost.js';
import type { ResolvedReview } from './review-target.js';

export interface ReviewToPublish {
  readonly review: IndependentReview;
  readonly truncated: boolean;
  /** The stored artifact's version: it makes the marker unique per review run, so an on-demand re-review posts again. */
  readonly version: number;
  readonly minSeverity: ReviewSeverity;
}

/**
 * Publishes one independent review on the glob's PR (spec, "Publishing"). Before merge: one GitHub review on the PR head
 * (summary plus inline comments), the earlier slop review marked outdated, and a neutral "N findings" check run. After
 * merge: one PR comment. Nothing here can block merging: the review is a COMMENT and the check is neutral.
 */
export const publishReview = async (
  host: CodeHost,
  repo: Repo,
  glob: Glob,
  resolved: Extract<ResolvedReview, { outcome: 'ready' }>,
  input: ReviewToPublish,
  log?: (message: string) => void,
): Promise<void> => {
  if (glob.pr === null) return;
  const prNumber = glob.pr.number;
  const sha = resolved.diff.sha;
  const marker = reviewMarker(glob.id, sha, input.version);
  const meta = { stage: resolved.stage, sha, truncated: input.truncated, marker };
  if (resolved.stage === 'post_merge') {
    await host.commentOnce(
      repo,
      glob.pr.number,
      marker,
      renderPostMergeComment(input.review, meta),
    );
    return;
  }
  // Inline comments anchor on the PR head (the test-merge commit isn't part of the PR), and only where the head's own diff
  // shows the same hunks as the reviewed one; without the head's diff every finding goes in the summary.
  const head = glob.pr.headSha;
  if (head === null) return;
  const headDiff = await host.prDiff(repo, head).catch(() => null);
  const plan = planReviewPublication(
    input.review,
    { ...meta, diff: resolved.diff.diff, headDiff },
    input.minSeverity,
  );
  const posted = await host.submitReview(repo, glob.pr.number, {
    commitSha: head,
    body: plan.body,
    comments: plan.inline,
  });
  // The review is posted: nothing below may fail the job, or the outbox would review and post it all again.
  const bestEffort = async (what: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      log?.(
        `review publish: ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  await bestEffort('outdating earlier reviews', () =>
    host.outdateReviews(repo, prNumber, reviewMarkerPrefix(glob.id), posted.id, (body) =>
      outdatedBody(body, head),
    ),
  );
  await bestEffort('check run', () =>
    host.reportCheck(repo, head, { name: REVIEW_CHECK, ...checkRunText(input.review) }),
  );
};
