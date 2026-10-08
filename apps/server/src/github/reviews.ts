import type { CodeReviewService, FindingsService, Glob } from '@slop/core';
import { codeReview } from '@slop/core';
import { z } from 'zod';

/** CodeRabbit's GitHub App account: only its comments and reviews are stored, and its inline comments become findings. */
export const CODERABBIT_BOT = 'coderabbitai[bot]';

const user = z.object({ login: z.string() });
const repository = z.object({ full_name: z.string() });

const reviewCommentPayload = z.object({
  action: z.string(),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    path: z.string().nullable().optional(),
    line: z.number().nullable().optional(),
    original_line: z.number().nullable().optional(),
    start_line: z.number().nullable().optional(),
    original_start_line: z.number().nullable().optional(),
    commit_id: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    user,
  }),
  pull_request: z.object({ number: z.number().optional(), head: z.object({ ref: z.string() }) }),
  repository,
});

const reviewPayload = z.object({
  action: z.string(),
  review: z.object({
    id: z.number(),
    body: z.string().nullable().optional(),
    commit_id: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
    submitted_at: z.string().nullable().optional(),
    user: user.nullable(),
  }),
  pull_request: z.object({ number: z.number(), head: z.object({ ref: z.string() }) }),
  repository,
});

const issueCommentPayload = z.object({
  action: z.string(),
  issue: z.object({ number: z.number(), pull_request: z.object({}).loose().nullable().optional() }),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    html_url: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    user,
  }),
  repository,
});

type Recorder = Pick<CodeReviewService, 'record' | 'remove'>;

/** A GitHub time as an ISO string; null when it is missing or unreadable. */
const time = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** Only links to GitHub itself are kept: the board renders them. */
const link = (value: string | null | undefined): string | null =>
  value != null && value.startsWith('https://github.com/') ? value : null;

/** An inline comment's line, or `start-end` for a range. */
const lineOf = (comment: z.infer<typeof reviewCommentPayload>['comment']): string | null => {
  const end = comment.line ?? comment.original_line ?? null;
  if (end === null) return null;
  const start = comment.start_line ?? comment.original_start_line ?? null;
  return start === null || start === end ? String(end) : `${String(start)}-${String(end)}`;
};

/**
 * A `pull_request_review_comment` delivery from CodeRabbit on a glob's PR. Created and edited comments are stored
 * verbatim, deleted ones forgotten. Only a new comment is also queued as one finding to classify: an edit or a
 * redelivery never classifies it again.
 */
export const handleReviewComment = async (
  deps: { findings: Pick<FindingsService, 'recordCodeRabbitComment'>; codeReviews: Recorder },
  payload: unknown,
  globFor: (branch: string, repo: string) => Promise<Glob | null>,
): Promise<boolean> => {
  const event = reviewCommentPayload.parse(payload);
  const { comment } = event;
  if (comment.user.login !== CODERABBIT_BOT) return true;
  const externalId = `coderabbit:review_comment:${String(comment.id)}`;
  if (event.action === 'deleted') {
    await deps.codeReviews.remove(externalId);
    return true;
  }
  if (event.action !== 'created' && event.action !== 'edited') return true;
  const glob = await globFor(event.pull_request.head.ref, event.repository.full_name);
  if (glob === null) return true;
  const line = lineOf(comment);
  const prNumber = event.pull_request.number ?? glob.pr?.number;
  if (prNumber !== undefined) {
    await deps.codeReviews.record(glob.id, {
      prNumber,
      externalId,
      kind: 'inline',
      author: comment.user.login,
      commitSha: comment.commit_id ?? null,
      path: comment.path ?? null,
      line,
      body: comment.body,
      url: link(comment.html_url),
      createdAt: time(comment.created_at),
      updatedAt: time(comment.updated_at),
    });
  }
  if (event.action !== 'created') return true;
  const findingLine = comment.line ?? comment.original_line ?? null;
  // A glob deleted meanwhile has nothing to record against. The finding keeps its own (older) external ID.
  await deps.findings.recordCodeRabbitComment(glob.id, {
    externalId: `coderabbit:${String(comment.id)}`,
    body: comment.body,
    path: comment.path ?? null,
    line: findingLine === null ? null : String(findingLine),
    commitSha: comment.commit_id ?? null,
  });
  return true;
};

/** A `pull_request_review` delivery: a review CodeRabbit submitted (or edited) on a glob's PR is stored verbatim. */
export const handleReview = async (
  codeReviews: Recorder,
  payload: unknown,
  globFor: (branch: string, repo: string) => Promise<Glob | null>,
): Promise<boolean> => {
  const event = reviewPayload.parse(payload);
  const { review } = event;
  if (review.user?.login !== CODERABBIT_BOT || (event.action !== 'submitted' && event.action !== 'edited')) return true;
  const glob = await globFor(event.pull_request.head.ref, event.repository.full_name);
  if (glob === null) return true;
  const submitted = time(review.submitted_at);
  // A review without a body still links to where its inline comments are.
  await codeReviews.record(glob.id, {
    prNumber: event.pull_request.number,
    externalId: `coderabbit:review:${String(review.id)}`,
    kind: 'review',
    author: review.user.login,
    commitSha: review.commit_id ?? null,
    path: null,
    line: null,
    body: review.body ?? '',
    url: link(review.html_url),
    createdAt: submitted,
    updatedAt: event.action === 'edited' ? null : submitted,
  });
  return true;
};

/**
 * An `issue_comment` delivery: a comment CodeRabbit posted, edited or deleted on a glob's PR (its walkthrough summary
 * or another note). The payload names no branch, so the glob is found by its PR number.
 */
export const handleIssueComment = async (
  codeReviews: Recorder,
  payload: unknown,
  globForPr: (repo: string, prNumber: number) => Promise<Glob | null>,
): Promise<boolean> => {
  const event = issueCommentPayload.parse(payload);
  const { comment } = event;
  if (comment.user.login !== CODERABBIT_BOT || event.issue.pull_request == null) return true;
  const externalId = `coderabbit:issue_comment:${String(comment.id)}`;
  if (event.action === 'deleted') {
    await codeReviews.remove(externalId);
    return true;
  }
  if (event.action !== 'created' && event.action !== 'edited') return true;
  const glob = await globForPr(event.repository.full_name, event.issue.number);
  if (glob === null) return true;
  await codeReviews.record(glob.id, {
    prNumber: event.issue.number,
    externalId,
    kind: codeReview.issueCommentKind(comment.body),
    author: comment.user.login,
    commitSha: null,
    path: null,
    line: null,
    body: comment.body,
    url: link(comment.html_url),
    createdAt: time(comment.created_at),
    updatedAt: time(comment.updated_at),
  });
  return true;
};
