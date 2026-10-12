import { describe, expect, it } from 'vitest';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { REVIEW_DIFF_LIMIT, ReviewAnswerInvalid, ReviewEngine } from '../src/app/review-engine.js';
import { isSkippedPath, parseReview, parseVerdicts } from '../src/domain/independent-review.js';
import type { ReviewInput } from '../src/domain/independent-review.js';

class FakeLlm implements Llm {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly answers: (string | Error)[]) {}
  complete(request: LlmRequest): Promise<string> {
    this.calls.push(request);
    const next = this.answers.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

const finding = (over: Record<string, unknown> = {}) => ({
  file: 'src/pay.ts',
  line: 12,
  severity: 'high',
  category: 'bug',
  title: 'Off by one',
  explanation: 'The loop skips the last item.',
  suggestedFix: 'Use <= instead of <.',
  ...over,
});
const review = (findings: unknown[]) => JSON.stringify({ summary: 'Adds payments.', findings });

const input: ReviewInput = {
  diff: '--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -10,3 +10,3 @@\n-for (i = 0; i <= n; i++)\n+for (i = 0; i < n; i++)',
  plan: 'Pay every item. Done when: all items are paid.',
  reviewGuide: 'Prefer early returns.',
};

describe('ReviewEngine', () => {
  it('reports a seeded bug and drops a deliberately weak finding', async () => {
    const weak = finding({ line: 3, severity: 'low', category: 'convention', title: 'Prefer const', explanation: 'Might be nicer.' });
    const llm = new FakeLlm([
      review([finding(), weak]),
      JSON.stringify({
        verdicts: [
          { index: 0, keep: true, reason: 'The diff shows the bound changed.' },
          { index: 1, keep: false, reason: 'A matter of taste.' },
        ],
      }),
    ]);
    const outcome = await new ReviewEngine({ llm }).reviewChange(input);
    expect(outcome.review.findings.map((f) => f.title)).toEqual(['Off by one']);
    expect(outcome.dropped).toHaveLength(1);
    expect(outcome.dropped[0]?.finding.title).toBe('Prefer const');
    expect(outcome.dropped[0]?.reason).toBe('A matter of taste.');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]?.prompt).toContain('Prefer early returns.');
    expect(llm.calls[1]?.prompt).toContain('Findings to verify');
  });

  it('leaves its model calls untagged, since the review runner records its own spend row (s15f60)', async () => {
    const llm = new FakeLlm([review([finding()]), JSON.stringify({ verdicts: [{ index: 0, keep: true, reason: 'Shown.' }] })]);
    await new ReviewEngine({ llm }).reviewChange(input);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls.map((c) => c.spend)).toEqual([undefined, undefined]);
  });

  it('skips verification when there are no findings', async () => {
    const llm = new FakeLlm([review([])]);
    const outcome = await new ReviewEngine({ llm }).reviewChange(input);
    expect(outcome.review.findings).toEqual([]);
    expect(llm.calls).toHaveLength(1);
  });

  it('asks again once with the problem when the answer breaks the schema', async () => {
    const llm = new FakeLlm(['not json', review([])]);
    const outcome = await new ReviewEngine({ llm }).reviewChange(input);
    expect(outcome.review.summary).toBe('Adds payments.');
    expect(llm.calls[1]?.prompt).toContain('previous answer was rejected');
  });

  it('throws after a second invalid answer', async () => {
    const llm = new FakeLlm([review([finding({ severity: 'critical' })]), review([finding({ severity: 'critical' })])]);
    await expect(new ReviewEngine({ llm }).reviewChange(input)).rejects.toBeInstanceOf(ReviewAnswerInvalid);
  });

  it('retries a verification answer that misses a finding', async () => {
    const llm = new FakeLlm([
      review([finding(), finding({ title: 'Other' })]),
      JSON.stringify({ verdicts: [{ index: 0, keep: true, reason: 'ok' }] }),
      JSON.stringify({
        verdicts: [
          { index: 0, keep: true, reason: 'ok' },
          { index: 1, keep: true, reason: 'ok' },
        ],
      }),
    ]);
    const outcome = await new ReviewEngine({ llm }).reviewChange(input);
    expect(outcome.review.findings).toHaveLength(2);
  });

  it('lets an unusable model pass through for the caller to wait on', async () => {
    const llm = new FakeLlm([new LlmUnavailable('AWS sign-in expired', 'Sign in')]);
    await expect(new ReviewEngine({ llm }).reviewChange(input)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('cuts an over-long diff and says so', async () => {
    const llm = new FakeLlm([review([])]);
    const outcome = await new ReviewEngine({ llm }).reviewChange({ ...input, diff: 'x'.repeat(REVIEW_DIFF_LIMIT + 10) });
    expect(outcome.truncated).toBe(true);
    expect(llm.calls[0]?.prompt).toContain('diff cut here');
  });
});

describe('review schema', () => {
  it('accepts a numeric-string line and fenced JSON', () => {
    const parsed = parseReview(`\`\`\`json\n${review([finding({ line: '12' })])}\n\`\`\``);
    expect(parsed.ok && parsed.review.findings[0]?.line).toBe(12);
  });

  it('rejects an unknown category and a missing summary', () => {
    expect(parseReview(review([finding({ category: 'style' })])).ok).toBe(false);
    expect(parseReview(JSON.stringify({ findings: [] })).ok).toBe(false);
  });

  it('rejects out-of-range and repeated verdicts', () => {
    expect(parseVerdicts(JSON.stringify({ verdicts: [{ index: 5, keep: true }] }), 1).ok).toBe(false);
    expect(parseVerdicts(JSON.stringify({ verdicts: [{ index: 0, keep: true }, { index: 0, keep: false }] }), 2).ok).toBe(false);
  });

  it('skips lockfiles, generated files and the board’s ignored paths', () => {
    expect(isSkippedPath('pnpm-lock.yaml')).toBe(true);
    expect(isSkippedPath('apps/server/drizzle/meta/_journal.json')).toBe(true);
    expect(isSkippedPath('apps/server/src/llm.ts')).toBe(false);
    expect(isSkippedPath('docs/api.md', [/^docs\//])).toBe(true);
  });
});
