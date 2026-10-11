import { hash } from '../app/text-hash.js';
import { REVIEW_CATEGORIES, REVIEW_SEVERITIES } from './independent-review.js';
import type { IndependentFinding, ReviewCategory, ReviewSeverity } from './independent-review.js';

/**
 * What people say about the independent reviewer's inline comments. A comment is tied to its finding by a hidden marker
 * in its body; findings listed only in the review summary have no comment, so they take no feedback.
 */

/** `wrong` and `thumbs_down` count as a false positive; a plain `resolved` thread says nothing about whether the finding was right. */
export const REVIEW_VERDICTS = ['wrong', 'thumbs_down', 'resolved'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_FEEDBACK_SOURCES = ['thread', 'reply', 'reaction'] as const;
export type ReviewFeedbackSource = (typeof REVIEW_FEEDBACK_SOURCES)[number];

export const isFalsePositive = (verdict: ReviewVerdict): boolean =>
  verdict === 'wrong' || verdict === 'thumbs_down';

export interface NewReviewFeedback {
  readonly boardId: number;
  readonly globId: string;
  /** The `independent_review` artifact version the comment came from. */
  readonly artifactVersion: number;
  readonly fingerprint: string;
  readonly severity: ReviewSeverity;
  readonly category: ReviewCategory;
  readonly title: string;
  readonly path: string;
  readonly line: number | null;
  readonly verdict: ReviewVerdict;
  readonly source: ReviewFeedbackSource;
  readonly githubCommentId: number;
  /** The person's GitHub login; null when it is not known. */
  readonly actor: string | null;
  readonly createdAt: string;
}

export interface ReviewFeedback extends NewReviewFeedback {
  readonly id: number;
}

/** Stable across versions: the same problem in the same file reads the same however the model words the explanation. */
export const findingFingerprint = (
  f: Pick<IndependentFinding, 'file' | 'category' | 'title'>,
): string => hash(`${f.file}\n${f.category}\n${f.title.toLowerCase().replace(/\s+/g, ' ').trim()}`);

const MARKER = /<!-- slop-finding glob=(\S+) v=(\d+) f=([0-9a-f]+) -->/;

export const findingMarker = (
  globId: string,
  version: number,
  f: Pick<IndependentFinding, 'file' | 'category' | 'title'>,
): string => `<!-- slop-finding glob=${globId} v=${String(version)} f=${findingFingerprint(f)} -->`;

/** The marker in an inline comment's body; null for a comment slop did not post as a finding. */
export const parseFindingMarker = (
  body: string,
): { readonly globId: string; readonly version: number; readonly fingerprint: string } | null => {
  const m = MARKER.exec(body);
  if (m === null) return null;
  const [, globId, version, fingerprint] = m;
  if (globId === undefined || version === undefined || fingerprint === undefined) return null;
  return { globId, version: Number(version), fingerprint };
};

/** The first line of an inline comment, `**severity · category: title**`. */
export const parseFindingHeader = (
  body: string,
): {
  readonly severity: ReviewSeverity;
  readonly category: ReviewCategory;
  readonly title: string;
} | null => {
  const m = /^\*\*(\w+) · (\w+): (.+?)\*\*/.exec(body);
  if (m === null) return null;
  const severity = REVIEW_SEVERITIES.find((s) => s === m[1]);
  const category = REVIEW_CATEGORIES.find((c) => c === m[2]);
  const title = m[3];
  return severity === undefined || category === undefined || title === undefined
    ? null
    : { severity, category, title };
};

/** The documented gesture: GitHub has no "wrong" reason on resolving a thread, so a reply starting `/wrong` or "false positive" says it. */
export const isWrongReply = (body: string): boolean =>
  /^\s*(\/wrong\b|false[ -]positive\b)/i.test(body);
