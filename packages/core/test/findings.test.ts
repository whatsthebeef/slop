import { describe, expect, it } from 'vitest';
import { coderabbitSeverity, coderabbitText, fingerprint, globFindings, splitReview } from '../src/domain/findings.js';
import type { ReviewFinding, ReviewSource } from '../src/domain/findings.js';
import { LLM_WAITING_PREFIX } from '../src/domain/kb.js';

/** Like s15f5's stored review: two rounds, a status table, and a section compiling earlier items. */
const CHANGE_REVIEWER = `# Review: s1f5

## Review — KB pipeline (round 1)

#### IN-SCOPE

1. **[apps/server/src/llm.ts:22, packages/core/src/app/kb-pipeline.ts:40]** Nothing limits how long the
   pipeline's LLM calls can take.
   A stalled call holds the worker.
2. **[packages/core/src/app/kb-pipeline.ts:256-268]** \`parseDedupe\` accepts a duplicateOf that the
   model didn't class as same fact.
3. Missing test for the reopen path.

#### SUGGESTIONS

- **[apps/web/src/components/kb-proposals.tsx]** The retry button shows while an item waits.

## Review — KB pipeline (round 2)

### Round-1 items

| # | Item | Status |
|---|------|--------|
| 1. | Nothing limits how long | fixed |

#### IN-SCOPE

None.

#### SUGGESTIONS (1)

1. **[docs/spec.md:12]** The spec still says embeddings.

\`\`\`
1. not an item: inside a fence
\`\`\`

## Potential adjustments

### Suggestions

1. Restates round 1's retry button item.
`;

describe('splitReview', () => {
  it('takes IN-SCOPE and SUGGESTIONS items with their rounds and locations, skipping tables and compiled sections', () => {
    const { structured, findings } = splitReview(CHANGE_REVIEWER);
    expect(structured).toBe(true);
    expect(findings.map((f) => ({ severity: f.severity, round: f.round, path: f.path, line: f.line }))).toEqual([
      { severity: 'in_scope', round: 1, path: 'apps/server/src/llm.ts', line: '22' },
      { severity: 'in_scope', round: 1, path: 'packages/core/src/app/kb-pipeline.ts', line: '256-268' },
      { severity: 'in_scope', round: 1, path: null, line: null },
      { severity: 'suggestion', round: 1, path: 'apps/web/src/components/kb-proposals.tsx', line: null },
      { severity: 'suggestion', round: 2, path: 'docs/spec.md', line: '12' },
    ]);
    // Continuation lines stay with their item, without the list marker or the common indent.
    expect(findings[0]?.text).toBe(
      "**[apps/server/src/llm.ts:22, packages/core/src/app/kb-pipeline.ts:40]** Nothing limits how long the\npipeline's LLM calls can take.\nA stalled call holds the worker.",
    );
    expect(findings[2]?.text).toBe('Missing test for the reopen path.');
  });

  it('reads a plain Suggestions section and ignores the notes around it', () => {
    const review = `# s1f4 review\n\n## Findings\n\nAll checks passed. The plan was followed.\n\n## Suggestions\n\n1. Rename \`x\` to \`count\`.\n2. **[a/b.ts:3]** Drop the unused import.\n\nThanks!\n`;
    const { structured, findings } = splitReview(review);
    expect(structured).toBe(true);
    expect(findings).toEqual([
      { severity: 'suggestion', round: null, path: null, line: null, text: 'Rename `x` to `count`.' },
      { severity: 'suggestion', round: null, path: 'a/b.ts', line: '3', text: '**[a/b.ts:3]** Drop the unused import.' },
    ]);
  });

  it('reports a free-form summary as unstructured', () => {
    const summary = `# Finalise summary\n\n| Key finding fixed | Where |\n|---|---|\n| Retry loop | job.ts |\n\n## Round 1\n\n1. The job retried forever.\n\n## Round 2\n\n1. Fixed.\n`;
    expect(splitReview(summary)).toEqual({ structured: false, findings: [] });
  });

  it('gives no findings for a structured section that says None.', () => {
    expect(splitReview('## Review\n\n#### IN-SCOPE\n\nNone.\n\n#### SUGGESTIONS\n\nNone.\n')).toEqual({ structured: true, findings: [] });
  });
});

describe('splitReview edge cases (s15f8)', () => {
  /** Shaped like s15f5's stored review: dated round headings, status and checks tables, a closing Potential Adjustments list. */
  const REAL_SHAPED = `# Review: s1f5, Slice 8

## Review — 2026-10-06 (round 1)

### Acceptance Criteria Status

| Criterion | Status | Notes |
|-----------|--------|-------|
| 1. Items are routed | PASS | fine |

### Findings

#### IN-SCOPE

1. **[apps/server/src/jobs/kb-pipeline.ts:32-45, packages/core/src/app/kb-pipeline.ts:256, 305; apps/server/src/llm.ts:22]** No deadline.
   Calls can hang.
2. **[packages/core/src/app/knowledge-service.ts:219 and apps/web/src/components/kb-proposals.tsx]** A location that isn't a plain list.

#### SUGGESTIONS

1. **[docs/spec.md, Processing step 1]** "retried with backoff" is out of date.

### Quality Checks

| Check | Result | Notes |
|-------|--------|-------|
| Build | PASS | ok |

### Summary
- **In-scope items**: 2
- **Verdict**: CHANGES_REQUIRED

## Round 2 — Review 2026-10-06 (round 2)

### Round-1 items

| Item | Status | Notes |
|------|--------|-------|
| IN-SCOPE 1: deadline | FIXED | |

### Findings

#### IN-SCOPE

1. **[apps/server/src/db/store.ts:421-431]** The decided list orders by creation.

#### SUGGESTIONS

None.

## Round 3 — Review 2026-10-06 (round 3, final)

#### IN-SCOPE

None.

#### SUGGESTIONS

None.

## Potential Adjustments

- None outstanding.
`;

  it('splits a real-shaped multi-round review: dated round headings, tables and summaries ignored', () => {
    const { structured, findings } = splitReview(REAL_SHAPED);
    expect(structured).toBe(true);
    expect(findings.map((f) => [f.severity, f.round, f.path, f.line])).toEqual([
      ['in_scope', 1, 'apps/server/src/jobs/kb-pipeline.ts', '32-45'],
      // "X and Y": the first location.
      ['in_scope', 1, 'packages/core/src/app/knowledge-service.ts', '219'],
      // A path without a line number.
      ['suggestion', 1, 'docs/spec.md', null],
      ['in_scope', 2, 'apps/server/src/db/store.ts', '421-431'],
    ]);
    expect(findings[0]?.text.endsWith('No deadline.\nCalls can hang.')).toBe(true);
  });

  it('keeps no location rather than a wrong one when the first entry is not a single path (s15f8)', () => {
    const review = `#### IN-SCOPE\n\n1. **[the retry path, src/job.ts:10]** Odd.\n2. **[src/a.ts:3 and src/b.ts:4]** Both.\n`;
    expect(splitReview(review).findings.map((f) => [f.path, f.line])).toEqual([
      [null, null],
      ['src/a.ts', '3'],
    ]);
  });

  it('skips IN-SCOPE and SUGGESTIONS sections under deferred and known, accepted headings', () => {
    const review = `## Review (round 1)\n\n#### IN-SCOPE\n\n1. Real one.\n\n## Deferred\n\n#### IN-SCOPE\n\n1. Deferred restatement.\n\n## Known, accepted risks\n\n### Suggestions\n\n- Accepted restatement.\n`;
    expect(splitReview(review).findings.map((f) => f.text)).toEqual(['Real one.']);
  });

  it('accepts heading variants: "In scope (3)", bold, and a trailing colon', () => {
    const review = `### In scope (3)\n\n1. A.\n\n### **SUGGESTIONS**\n\n- B.\n\n### Suggestion:\n\n* C.\n`;
    const { structured, findings } = splitReview(review);
    expect(structured).toBe(true);
    expect(findings.map((f) => [f.severity, f.text, f.round])).toEqual([
      ['in_scope', 'A.', null],
      ['suggestion', 'B.', null],
      ['suggestion', 'C.', null],
    ]);
  });

  it('keeps indented sub-items with their parent and ends an item at a column-0 paragraph or table', () => {
    const review = `#### SUGGESTIONS\n\n1. Parent item.\n   - nested detail\n   - another\n2. Second item.\nA closing paragraph, not part of item 2.\n\n| a | b |\n|---|---|\n`;
    expect(splitReview(review).findings.map((f) => f.text)).toEqual(['Parent item.\n- nested detail\n- another', 'Second item.']);
  });

  it('stops a section at the next heading of the same level, but keeps going through deeper ones', () => {
    const review = `### IN-SCOPE\n\n1. One.\n\n#### Detail\n\n2. Two, under a deeper heading.\n\n### Notes\n\n1. Not a finding.\n`;
    expect(splitReview(review).findings.map((f) => f.text)).toEqual(['One.', 'Two, under a deeper heading.']);
  });

  it('caps an item at 4,000 characters', () => {
    const [only] = splitReview(`#### IN-SCOPE\n\n1. ${'z'.repeat(5000)}\n`).findings;
    expect(only?.text).toHaveLength(4000);
  });

  it('ignores a heading-looking line inside a fenced block', () => {
    expect(splitReview('Notes\n\n```\n#### IN-SCOPE\n1. not real\n```\n')).toEqual({ structured: false, findings: [] });
  });
});

describe('fingerprint', () => {
  it('matches across whitespace, markdown and line-number changes, keeping the path', () => {
    const a = fingerprint('**[src/llm.ts:22]** Nothing limits how long\n   the `call` can take.');
    const b = fingerprint('**[src/llm.ts:40-52]**  nothing limits how long the call can take.');
    expect(a).toBe(b);
    expect(a).toBe('[src/llm.ts] nothing limits how long the call can take.');
    expect(fingerprint('**[src/other.ts:22]** Nothing limits how long the call can take.')).not.toBe(a);
  });

  it('keeps the first 300 characters', () => {
    expect(fingerprint('x'.repeat(500))).toHaveLength(300);
  });
});

describe('CodeRabbit comments', () => {
  it('reads the severity from the label', () => {
    expect(coderabbitSeverity('_⚠️ Potential issue_\n\n**Unchecked null**')).toBe('in_scope');
    expect(coderabbitSeverity('_🔴 Critical_\n\nSQL injection')).toBe('in_scope');
    expect(coderabbitSeverity('_🛠️ Refactor suggestion_\n\nExtract a helper')).toBe('suggestion');
    expect(coderabbitSeverity('**Nitpick:** rename')).toBe('suggestion');
    expect(coderabbitSeverity('🧹 tidy')).toBe('suggestion');
    expect(coderabbitSeverity('Looks odd')).toBe('unknown');
  });

  it('ignores severity words outside the label line, in the text and the details blocks (s15f8)', () => {
    const body = [
      '_🛠️ Refactor suggestion_',
      '',
      'Hold the lock for the whole critical section; a Potential issue otherwise.',
      '',
      '<details>',
      '<summary>Committable suggestion</summary>',
      'const critical_path = true; // critical',
      '</details>',
    ].join('\n');
    expect(coderabbitSeverity(body)).toBe('suggestion');
    expect(coderabbitSeverity('<details>critical</details>')).toBe('unknown');
  });

  it('cuts the text at the first details block and caps it', () => {
    expect(coderabbitText('  Missing await on save.\n\n<details>\n<summary>🤖 Prompt for AI Agents</summary>\nFix it\n</details>')).toBe(
      'Missing await on save.',
    );
    expect(coderabbitText('y'.repeat(5000))).toHaveLength(4000);
  });
});

describe('globFindings', () => {
  const finding = (patch: Partial<ReviewFinding>): ReviewFinding => ({
    id: 1,
    boardId: 1,
    globId: 's1f1',
    sourceId: 1,
    source: 'local_review',
    commitSha: 'abc',
    agentSetVersion: 3,
    severity: 'in_scope',
    round: 1,
    path: null,
    line: null,
    text: 'x',
    fingerprint: 'x',
    class: null,
    classNote: null,
    state: 'pending',
    attempts: 0,
    processAfter: null,
    error: null,
    createdAt: '2026-10-05T12:00:00.000Z',
    classifiedAt: null,
    version: 1,
    ...patch,
  });
  const source = (state: ReviewSource['state']): ReviewSource => ({
    id: 1,
    boardId: 1,
    globId: 's1f1',
    kind: 'local_review',
    artifactId: 1,
    externalId: null,
    commitSha: null,
    agentSetVersion: null,
    content: null,
    path: null,
    line: null,
    state,
    attempts: 0,
    processAfter: null,
    error: null,
    createdAt: '2026-10-05T12:00:00.000Z',
    version: 1,
  });

  it('counts classified findings per class, most first, and the pending and failed ones', () => {
    const view = globFindings(
      [
        finding({ id: 1, state: 'classified', class: 'edge-case', severity: 'suggestion' }),
        finding({ id: 2, state: 'classified', class: 'missing-test' }),
        finding({ id: 3, state: 'classified', class: 'missing-test', severity: 'suggestion' }),
        finding({ id: 4, state: 'classified', class: 'missing-test', severity: 'unknown' }),
        finding({ id: 5 }),
        finding({ id: 6, state: 'failed', error: 'unusable' }),
      ],
      [source('split'), source('pending'), source('failed')],
    );
    expect(view.byClass).toEqual([
      { class: 'missing-test', total: 3, inScope: 1, suggestions: 1 },
      { class: 'edge-case', total: 1, inScope: 0, suggestions: 1 },
    ]);
    expect(view).toMatchObject({ pending: 1, failed: 1, sources: { pending: 1, failed: 1 } });
    expect(view.findings[0]).not.toHaveProperty('fingerprint');
    expect(view.findings[0]).not.toHaveProperty('version');
    expect(view.findings[5]).toMatchObject({ state: 'failed', error: 'unusable' });
  });

  it('gives the waiting reason only from a pending item whose error is an AI-unavailable wait (s15f8)', () => {
    const waitingSource = { ...source('pending'), error: `${LLM_WAITING_PREFIX}AWS sign-in expired` };
    // An ordinary retry error, or a wait reason left on a finished item, isn't a stall.
    expect(globFindings([finding({ error: 'The model did not answer within 30 s' })], [source('pending')]).waiting).toBeNull();
    expect(
      globFindings(
        [finding({ state: 'failed', error: `${LLM_WAITING_PREFIX}old` })],
        [{ ...source('split'), error: `${LLM_WAITING_PREFIX}old` }],
      ).waiting,
    ).toBeNull();
    expect(globFindings([finding({ error: `${LLM_WAITING_PREFIX}No model access` })], []).waiting).toBe('No model access');
    // A waiting review is reported before a waiting finding.
    expect(globFindings([finding({ error: `${LLM_WAITING_PREFIX}No model access` })], [waitingSource]).waiting).toBe('AWS sign-in expired');
  });
});
