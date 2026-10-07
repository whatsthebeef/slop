import type { FindingsService, Glob } from '@slop/core';
import { z } from 'zod';

/** CodeRabbit's GitHub App account: only its inline comments become findings. */
export const CODERABBIT_BOT = 'coderabbitai[bot]';

const reviewCommentPayload = z.object({
  action: z.string(),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    path: z.string().nullable().optional(),
    line: z.number().nullable().optional(),
    original_line: z.number().nullable().optional(),
    commit_id: z.string().nullable().optional(),
    user: z.object({ login: z.string() }),
  }),
  pull_request: z.object({ head: z.object({ ref: z.string() }) }),
  repository: z.object({ full_name: z.string() }),
});

/**
 * A `pull_request_review_comment` delivery: a new CodeRabbit inline comment on a glob's PR is
 * queued as one finding (through core). Other authors and actions (edits, deletions) are ignored;
 * storing CodeRabbit's summaries and reviews verbatim comes with slice 7.
 */
export const handleReviewComment = async (
  findings: Pick<FindingsService, 'recordCodeRabbitComment'>,
  payload: unknown,
  globFor: (branch: string, repo: string) => Promise<Glob | null>,
): Promise<boolean> => {
  const event = reviewCommentPayload.parse(payload);
  const { comment } = event;
  if (event.action !== 'created' || comment.user.login !== CODERABBIT_BOT) return true;
  const glob = await globFor(event.pull_request.head.ref, event.repository.full_name);
  if (glob === null) return true;
  const line = comment.line ?? comment.original_line ?? null;
  // A glob deleted meanwhile has nothing to record against.
  await findings.recordCodeRabbitComment(glob.id, {
    externalId: `coderabbit:${String(comment.id)}`,
    body: comment.body,
    path: comment.path ?? null,
    line: line === null ? null : String(line),
    commitSha: comment.commit_id ?? null,
  });
  return true;
};
