import type { KnowledgeDoc } from './knowledge.js';

/**
 * CodeRabbit's results on a glob's PR, stored verbatim (spec R3): its summary (the walkthrough comment it edits in
 * place), its reviews, its inline comments and any other PR comment it posts. Nothing here interprets them; turning
 * an inline comment into a classified finding is the findings pipeline's job (one finding per comment, on creation
 * only). Every rule here is pure.
 */

export const CODE_REVIEW_KINDS = ['summary', 'review', 'inline', 'comment'] as const;
export type CodeReviewKind = (typeof CODE_REVIEW_KINDS)[number];

/**
 * GitHub caps a comment at 65,536 characters; anything longer than this was not written by GitHub's rules, so it is
 * cut rather than stored whole.
 */
export const CODE_REVIEW_BODY_LIMIT = 70_000;

/** The marker CodeRabbit puts at the top of its walkthrough (summary) comment. */
export const CODERABBIT_SUMMARY_MARKER = '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';

/** A board knowledge document in this area is the board's review guide (`get_review_guide`). */
export const REVIEW_GUIDE_AREA = 'review_guide';

/** One stored CodeRabbit item. */
export interface CodeReviewComment {
  readonly id: number;
  readonly boardId: number;
  readonly globId: string;
  readonly prNumber: number;
  /** Unique per GitHub object: `coderabbit:<review|review_comment|issue_comment>:<id>`. */
  readonly externalId: string;
  readonly kind: CodeReviewKind;
  readonly author: string;
  readonly commitSha: string | null;
  /** Inline comments: the file and line (a range as `start-end`). */
  readonly path: string | null;
  readonly line: string | null;
  readonly body: string;
  /** The item on GitHub. */
  readonly url: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NewCodeReviewComment = Omit<CodeReviewComment, 'id'>;

/** An issue comment from CodeRabbit is its summary when it carries the walkthrough marker; else a plain comment. */
export const isCodeRabbitSummary = (body: string): boolean => body.includes(CODERABBIT_SUMMARY_MARKER);

export const issueCommentKind = (body: string): CodeReviewKind => (isCodeRabbitSummary(body) ? 'summary' : 'comment');

/** What the card shows: the inline comment count, and where the review opens on GitHub. */
export interface CodeReviewBadge {
  /** Inline comments. */
  readonly count: number;
  /** The latest review, else the latest item of any kind; null when nothing has a link. */
  readonly url: string | null;
  readonly hasSummary: boolean;
}

const newestFirst = (a: CodeReviewComment, b: CodeReviewComment): number =>
  b.createdAt.localeCompare(a.createdAt) || b.id - a.id;

/** The card's badge for one glob's stored items; null when there are none. */
export const codeReviewBadge = (comments: readonly CodeReviewComment[]): CodeReviewBadge | null => {
  if (comments.length === 0) return null;
  const sorted = [...comments].sort(newestFirst);
  const review = sorted.find((c) => c.kind === 'review' && c.url !== null);
  return {
    count: comments.filter((c) => c.kind === 'inline').length,
    url: review?.url ?? sorted.find((c) => c.url !== null)?.url ?? null,
    hasSummary: comments.some((c) => c.kind === 'summary'),
  };
};

/** The glob view and context bundle: the stored items grouped, oldest first within each group. */
export interface GlobCodeReview {
  readonly badge: CodeReviewBadge | null;
  /** The latest summary (CodeRabbit keeps one and edits it); null before it posts one. */
  readonly summary: CodeReviewComment | null;
  readonly reviews: readonly CodeReviewComment[];
  readonly inline: readonly CodeReviewComment[];
  readonly comments: readonly CodeReviewComment[];
}

export const globCodeReview = (stored: readonly CodeReviewComment[]): GlobCodeReview => {
  const oldestFirst = [...stored].sort((a, b) => -newestFirst(a, b));
  const of = (kind: CodeReviewKind) => oldestFirst.filter((c) => c.kind === kind);
  return {
    badge: codeReviewBadge(stored),
    summary: of('summary').at(-1) ?? null,
    reviews: of('review'),
    inline: of('inline'),
    comments: of('comment'),
  };
};

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (Object.entries(value).find(([k]) => k === key)?.[1]) : undefined;

/**
 * Whether a parsed `.coderabbit.yaml` turns CodeRabbit's automatic reviews off (`reviews.auto_review.enabled: false`).
 * Anything else, including a file that isn't a mapping, leaves them on: slop then posts nothing (the safe default).
 */
export const autoReviewOff = (config: unknown): boolean =>
  field(field(field(config, 'reviews'), 'auto_review'), 'enabled') === false;

/** Whether a knowledge document is a review guide. */
export const isReviewGuide = (doc: Pick<KnowledgeDoc, 'kind' | 'area'>): boolean =>
  doc.kind === 'doc' && doc.area?.toLowerCase() === REVIEW_GUIDE_AREA;
