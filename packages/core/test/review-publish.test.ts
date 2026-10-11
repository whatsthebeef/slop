import { describe, expect, it } from 'vitest';
import type { IndependentFinding, IndependentReview } from '../src/domain/independent-review.js';
import {
  checkRunText,
  diffNewLines,
  findingsLabel,
  outdatedBody,
  planReviewPublication,
  renderPostMergeComment,
  renderReviewArtifact,
  reviewMarker,
  reviewMarkerPrefix,
  reviewMetaOf,
  reviewOutdated,
  safeAnchors,
} from '../src/domain/review-publish.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
-two
+two changed
+three
 four
@@ -20,2 +21,2 @@
 keep
-gone
+new
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;

const finding = (patch: Partial<IndependentFinding> = {}): IndependentFinding => ({
  file: 'src/a.ts',
  line: 2,
  severity: 'medium',
  category: 'bug',
  title: 'Wrong condition',
  explanation: 'It compares the wrong thing.',
  suggestedFix: 'Compare the id.',
  ...patch,
});

const review = (findings: IndependentFinding[]): IndependentReview => ({
  summary: 'Adds a thing.',
  findings,
});
const meta = {
  stage: 'pre_merge' as const,
  sha: 'abcdef1234567',
  truncated: false,
  marker: reviewMarker('s1t1', 'abcdef1234567', 3),
  diff: DIFF,
  headDiff: DIFF,
};

describe('diffNewLines', () => {
  it('lists the new-side lines of added and context lines per file, and none for deleted files', () => {
    const lines = diffNewLines(DIFF);
    expect([...(lines.get('src/a.ts') ?? [])]).toEqual([1, 2, 3, 4, 21, 22]);
    expect(lines.has('src/old.ts')).toBe(false);
  });
});

describe('anchoring on the PR head', () => {
  // The base moved: the merged tree has two more lines above the PR's hunk, so its line numbers are shifted.
  const DRIFTED = DIFF.replace('@@ -1,3 +1,4 @@', '@@ -3,3 +5,4 @@');

  it('keeps a file whose hunks are the same in both diffs, and drops one the base shifted', () => {
    expect(safeAnchors(DIFF, DIFF).has('src/a.ts')).toBe(true);
    expect(safeAnchors(DRIFTED, DIFF).has('src/a.ts')).toBe(false);
    expect(safeAnchors(DIFF, null).size).toBe(0);
  });

  it('puts a finding in the summary, not inline, when the base drifted or the head diff is unknown', () => {
    const r = review([finding({ line: 2, title: 'Shifted' })]);
    for (const headDiff of [DIFF, null, ''] as const) {
      const plan = planReviewPublication(r, { ...meta, diff: DRIFTED, headDiff });
      expect(plan.inline).toEqual([]);
      expect(plan.body).toContain('Shifted');
    }
    expect(planReviewPublication(r, meta).inline).toHaveLength(1);
  });

  it('does not take an added line that reads "++ x" for a file header', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,3 @@',
      ' keep',
      '+++ not a header',
      '+last',
      '',
    ].join('\n');
    expect([...(diffNewLines(diff).get('x.ts') ?? [])]).toEqual([1, 2, 3]);
    expect(diffNewLines(diff).size).toBe(1);
  });
});

describe('planReviewPublication', () => {
  it('puts medium and high findings on lines in the diff inline, and the rest in the summary', () => {
    const plan = planReviewPublication(
      review([
        finding({ severity: 'low', title: 'Nit', line: 3 }),
        finding({ severity: 'high', title: 'Breaks', line: 2 }),
        finding({ title: 'Off the diff', line: 99 }),
        finding({ title: 'Other file', file: 'src/other.ts', line: 1 }),
      ]),
      meta,
    );
    expect(plan.inline.map((c) => `${c.path}:${String(c.line)}`)).toEqual(['src/a.ts:2']);
    expect(plan.inline[0]?.body).toContain('**high · bug: Breaks**');
    expect(plan.inline[0]?.body).toContain('**Suggested fix:** Compare the id.');
    expect(plan.body.startsWith('<!-- slop-review glob=s1t1 sha=abcdef1234567 v=3 -->')).toBe(true);
    expect(plan.body).toContain('4 findings');
    for (const title of ['Nit', 'Off the diff', 'Other file']) expect(plan.body).toContain(title);
    expect(plan.body).not.toContain('Breaks');
    expect(plan.body).toContain('never blocks merging');
  });

  it('respects the minimum severity', () => {
    const findings = review([
      finding({ severity: 'low', line: 3 }),
      finding({ severity: 'medium', line: 2 }),
    ]);
    expect(planReviewPublication(findings, meta, 'low').inline).toHaveLength(2);
    expect(planReviewPublication(findings, meta, 'high').inline).toHaveLength(0);
  });

  it('a review with no findings is a short body with no comments', () => {
    const plan = planReviewPublication(review([]), meta);
    expect(plan.inline).toEqual([]);
    expect(plan.body).toContain('No findings');
  });
});

describe('outdating', () => {
  it('marks a review body outdated once, keeping its marker first', () => {
    const body = `${reviewMarker('s1t1', 'a1', 1)}\n**slop review**\n\nText`;
    const outdated = outdatedBody(body, 'bbbbbbbbb');
    expect(outdated.startsWith(reviewMarkerPrefix('s1t1'))).toBe(true);
    expect(outdated).toContain('Outdated');
    expect(outdated).toContain('bbbbbbb');
    expect(outdated).toContain('Text');
    expect(outdatedBody(outdated, 'ccc')).toBe(outdated);
  });

  it('a card is outdated only for a pre-merge review of an older head', () => {
    const base = reviewMetaOf(review([finding()]), 'pre_merge', 'h1');
    expect(reviewOutdated(base, 'h1')).toBe(false);
    expect(reviewOutdated(base, 'h2')).toBe(true);
    expect(reviewOutdated(reviewMetaOf(review([]), 'post_merge', 'h1'), 'h2')).toBe(false);
    expect(reviewOutdated(base, null)).toBe(false);
  });
});

describe('labels and texts', () => {
  it('counts findings for the card and the check run', () => {
    expect(findingsLabel(0)).toBe('No findings');
    expect(findingsLabel(1)).toBe('1 finding');
    expect(findingsLabel(3)).toBe('3 findings');
    const text = checkRunText(
      review([finding({ severity: 'high' }), finding(), finding({ severity: 'low' })]),
    );
    expect(text.title).toBe('3 findings');
    expect(text.summary).toContain('1 high, 1 medium, 1 low');
    expect(
      reviewMetaOf(review([finding(), finding({ severity: 'low' })]), 'post_merge', null),
    ).toEqual({ stage: 'post_merge', headSha: null, findings: 2, high: 0, medium: 1, low: 1 });
  });

  it('renders the artifact and the post-merge comment with the findings, worst first', () => {
    const r = review([
      finding({ severity: 'low', title: 'Minor' }),
      finding({ severity: 'high', title: 'Major' }),
    ]);
    const artifact = renderReviewArtifact(r, {
      stage: 'post_merge',
      sha: 'abcdef1234567',
      truncated: true,
    });
    expect(artifact).toContain('Independent review after merge');
    expect(artifact).toContain('2 findings');
    expect(artifact.indexOf('Major')).toBeLessThan(artifact.indexOf('Minor'));
    expect(artifact).toContain('too long to read whole');
    const comment = renderPostMergeComment(r, {
      stage: 'post_merge',
      sha: 'abcdef1234567',
      truncated: false,
      marker: reviewMarker('s1t1', 'abcdef1234567', 1),
    });
    expect(comment).toContain('slop review after merge');
    expect(comment.indexOf('Major')).toBeLessThan(comment.indexOf('Minor'));
  });
});
