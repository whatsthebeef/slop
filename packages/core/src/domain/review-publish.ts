import type { ReviewStage } from './events.js';
import type {
  IndependentFinding,
  IndependentReview,
  ReviewSeverity,
} from './independent-review.js';
import { REVIEW_SEVERITIES } from './independent-review.js';
import type { IndependentReviewMeta } from './knowledge.js';

/**
 * How an independent review is shown (spec, "Publishing"): the glob artifact's text, the GitHub review with its inline
 * comments, the post-merge PR comment and the check run. Pure: the server's publisher only sends what is planned here.
 */

/** Findings at or above this severity are posted as inline comments; the rest go in the review's summary. */
export const DEFAULT_REVIEW_MIN_SEVERITY: ReviewSeverity = 'medium';

/** GitHub refuses a review or comment body above 65,536 characters. */
const BODY_LIMIT = 60_000;

const RANK: Readonly<Record<ReviewSeverity, number>> = { high: 0, medium: 1, low: 2 };

export const atLeast = (severity: ReviewSeverity, min: ReviewSeverity): boolean =>
  RANK[severity] <= RANK[min];

export const reviewMetaOf = (
  review: IndependentReview,
  stage: ReviewStage,
  headSha: string | null,
): IndependentReviewMeta => ({
  stage,
  headSha,
  findings: review.findings.length,
  high: review.findings.filter((f) => f.severity === 'high').length,
  medium: review.findings.filter((f) => f.severity === 'medium').length,
  low: review.findings.filter((f) => f.severity === 'low').length,
});

/** The card's status for a review: "3 findings", "1 finding" or "No findings". */
export const findingsLabel = (count: number): string =>
  count === 0 ? 'No findings' : `${String(count)} finding${count === 1 ? '' : 's'}`;

/** Whether a later push left the review behind: it was made for a different PR head than the glob has now. */
export const reviewOutdated = (
  meta: IndependentReviewMeta,
  currentHeadSha: string | null,
): boolean =>
  meta.stage === 'pre_merge' &&
  meta.headSha !== null &&
  currentHeadSha !== null &&
  meta.headSha !== currentHeadSha;

const STAGE_LABEL: Readonly<Record<ReviewStage, string>> = {
  pre_merge: 'before merge',
  post_merge: 'after merge',
};

const short = (sha: string): string => sha.slice(0, 7);

const clip = (text: string, limit = BODY_LIMIT): string =>
  text.length > limit ? `${text.slice(0, limit - 40)}\n\n[cut: too long for GitHub]` : text;

const bySeverity = (findings: readonly IndependentFinding[]): IndependentFinding[] =>
  [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);

const findingBlock = (f: IndependentFinding): string =>
  `**${f.severity} · ${f.category}: ${f.title}**\n\n${f.explanation}${f.suggestedFix === '' ? '' : `\n\n**Suggested fix:** ${f.suggestedFix}`}`;

export interface ReviewMeta {
  readonly stage: ReviewStage;
  /** The reviewed commit: the test-merge commit before merge, the squash commit after. */
  readonly sha: string;
  readonly truncated: boolean;
}

/** The glob artifact's text (shown under the review icon, and indexed for search). */
export const renderReviewArtifact = (review: IndependentReview, meta: ReviewMeta): string => {
  const lines = [
    `# Independent review ${STAGE_LABEL[meta.stage]}`,
    '',
    `Commit \`${short(meta.sha)}\` · ${findingsLabel(review.findings.length)}`,
    '',
    review.summary,
  ];
  if (meta.truncated)
    lines.push('', '_The diff was too long to read whole; the end of it was not reviewed._');
  for (const f of bySeverity(review.findings)) {
    lines.push(
      '',
      `## ${f.severity} · ${f.category}: ${f.title}`,
      '',
      `\`${f.file}:${String(f.line)}\``,
      '',
      f.explanation,
    );
    if (f.suggestedFix !== '') lines.push('', `Suggested fix: ${f.suggestedFix}`);
  }
  return `${lines.join('\n')}\n`;
};

/**
 * Walks a unified diff by its hunk headers (so an added line that reads `++ x` is never taken for a file header) and
 * calls `onRow` with each hunk row and its new-side line number (null for removed lines).
 */
const walkHunks = (
  diff: string,
  onFile: (path: string | null) => void,
  onRow: (row: string, newLine: number | null) => void,
): void => {
  let oldLeft = 0;
  let newLeft = 0;
  let next = 0;
  for (const row of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (row.startsWith('\\')) continue;
      if (row.startsWith('-')) {
        oldLeft -= 1;
        onRow(row, null);
      } else if (row.startsWith('+')) {
        newLeft -= 1;
        onRow(row, next);
        next += 1;
      } else {
        oldLeft -= 1;
        newLeft -= 1;
        onRow(row, next);
        next += 1;
      }
      continue;
    }
    if (row.startsWith('+++ ')) {
      onFile(row === '+++ /dev/null' ? null : row.replace(/^\+\+\+ b\//, ''));
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (hunk === null) continue;
    oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
    next = Number(hunk[2]);
    newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    onRow(row, null);
  }
};

/** The new-side line numbers a unified diff shows (added and context lines), by file: where GitHub accepts an inline comment. */
export const diffNewLines = (diff: string): Map<string, Set<number>> => {
  const out = new Map<string, Set<number>>();
  let lines: Set<number> | null = null;
  walkHunks(
    diff,
    (path) => {
      lines = path === null ? null : (out.get(path) ?? new Set<number>());
      if (path !== null && lines !== null) out.set(path, lines);
    },
    (_row, line) => {
      if (line !== null) lines?.add(line);
    },
  );
  return out;
};

/** Each file's hunks as text (headers and rows, without the index line), to compare one file across two diffs. */
const fileHunks = (diff: string): Map<string, string> => {
  const out = new Map<string, string[]>();
  let rows: string[] | null = null;
  walkHunks(
    diff,
    (path) => {
      rows = path === null ? null : (out.get(path) ?? []);
      if (path !== null && rows !== null) out.set(path, rows);
    },
    (row) => rows?.push(row),
  );
  return new Map([...out].map(([path, r]) => [path, r.join('\n')]));
};

/**
 * Where an inline comment can be anchored safely. Findings carry line numbers from the test-merge tree, but a comment is
 * posted against the PR head, where GitHub reads the line in the head's file. The two agree only for a file whose hunks
 * are identical in both diffs (the base didn't change that file's lines above the PR's); any other file, or no head
 * diff, gets no anchors, and its findings go in the summary.
 */
export const safeAnchors = (
  mergeDiff: string,
  headDiff: string | null,
): Map<string, Set<number>> => {
  if (headDiff === null) return new Map();
  const head = fileHunks(headDiff);
  const merged = fileHunks(mergeDiff);
  const lines = diffNewLines(mergeDiff);
  return new Map(
    [...lines].filter(([path]) => head.has(path) && head.get(path) === merged.get(path)),
  );
};

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface ReviewPublication {
  /** The GitHub review's summary text, marker first. */
  readonly body: string;
  /** Medium and high findings (or what `minSeverity` lets through) whose line is in the diff. */
  readonly inline: readonly InlineComment[];
}

/** Marks every review slop posts for a glob, so an older one can be found and outdated. */
export const reviewMarkerPrefix = (globId: string): string => `<!-- slop-review glob=${globId} `;
export const reviewMarker = (globId: string, sha: string, version: number): string =>
  `${reviewMarkerPrefix(globId)}sha=${sha} v=${String(version)} -->`;

const OUTDATED_MARK = '<!-- slop-review-outdated -->';

/** The review's body once a later commit was reviewed: said first, so it reads as superseded. Idempotent. */
export const outdatedBody = (body: string, newerSha: string): string => {
  if (body.includes(OUTDATED_MARK)) return body;
  const [marker = '', ...rest] = body.split('\n');
  return `${marker}\n${OUTDATED_MARK}\n> **Outdated.** A later commit (\`${short(newerSha)}\`) was reviewed; see the newer review.\n\n${rest.join('\n')}`;
};

const header = (review: IndependentReview, meta: ReviewMeta): string =>
  `**slop review ${STAGE_LABEL[meta.stage]}** of \`${short(meta.sha)}\` · ${findingsLabel(review.findings.length)}\n\n${review.summary}`;

/**
 * Splits a review for GitHub: findings at or above `minSeverity` whose line is in the diff become inline comments;
 * everything else (lower severities, lines GitHub can't anchor) is listed in the summary body, so nothing is lost.
 */
export const planReviewPublication = (
  review: IndependentReview,
  meta: ReviewMeta & {
    readonly marker: string;
    readonly diff: string;
    readonly headDiff: string | null;
  },
  minSeverity: ReviewSeverity = DEFAULT_REVIEW_MIN_SEVERITY,
): ReviewPublication => {
  const anchors = safeAnchors(meta.diff, meta.headDiff);
  const inline: InlineComment[] = [];
  const inSummary: IndependentFinding[] = [];
  for (const f of bySeverity(review.findings)) {
    if (atLeast(f.severity, minSeverity) && anchors.get(f.file)?.has(f.line) === true)
      inline.push({ path: f.file, line: f.line, body: findingBlock(f) });
    else inSummary.push(f);
  }
  const parts = [meta.marker, header(review, meta)];
  if (meta.truncated)
    parts.push('_The diff was too long to read whole; the end of it was not reviewed._');
  if (inline.length > 0)
    parts.push(`${String(inline.length)} of the findings are commented on the lines below.`);
  if (inSummary.length > 0) {
    parts.push(
      inSummary
        .map(
          (f) =>
            `- **${f.severity} · ${f.category}** \`${f.file}:${String(f.line)}\`: ${f.title}. ${f.explanation}${f.suggestedFix === '' ? '' : ` Suggested fix: ${f.suggestedFix}`}`,
        )
        .join('\n'),
    );
  }
  parts.push('_The independent review is advice: it never blocks merging._');
  return { body: clip(parts.join('\n\n')), inline };
};

/** The post-merge PR comment: the whole review, as the change is already on the base branch. */
export const renderPostMergeComment = (
  review: IndependentReview,
  meta: ReviewMeta & { readonly marker: string },
): string => {
  const parts = [meta.marker, header(review, meta)];
  if (meta.truncated)
    parts.push('_The diff was too long to read whole; the end of it was not reviewed._');
  for (const f of bySeverity(review.findings))
    parts.push(`${findingBlock(f)}\n\n\`${f.file}:${String(f.line)}\``);
  return clip(parts.join('\n\n'));
};

/** The check run's title and summary: "N findings", with the counts by severity. */
export const checkRunText = (
  review: IndependentReview,
): { readonly title: string; readonly summary: string } => {
  const meta = reviewMetaOf(review, 'pre_merge', null);
  const counts = REVIEW_SEVERITIES.filter((s) => meta[s] > 0)
    .map((s) => `${String(meta[s])} ${s}`)
    .join(', ');
  return {
    title: findingsLabel(meta.findings),
    summary: `${counts === '' ? '' : `${counts}. `}${review.summary}`,
  };
};
