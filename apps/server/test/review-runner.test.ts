import { LlmBusy, ok } from '@slop/core';
import type { Result } from '@slop/core';
import type { Artifact, Board, Glob, Llm, ReviewInputService, SpendService } from '@slop/core';
import { describe, expect, it, vi } from 'vitest';
import type { CodeHost, PostedReview } from '../src/codehost.js';
import { makeRunReview } from '../src/review-runner.js';
import type { ReviewSettings } from '../src/review-runner.js';
import type { ResolvedReview } from '../src/review-target.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const NOW = '2026-10-11T00:00:00.000Z';
const board = { id: 1, repo: 'o/r', baseBranch: 'main' } as unknown as Board;
const settings: ReviewSettings = {
  model: 'gpt-oss',
  minSeverity: 'medium',
  ignoredPaths: ['docs/**'],
  toolCap: null,
};

const glob = (patch: Partial<Glob> = {}): Glob => ({
  id: 's1t1',
  boardId: 1,
  title: 'Work',
  summary: '',
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  status: 'pr_open',
  version: 1,
  generation: 1,
  creator: 'dev@example.com',
  planner: 'dev@example.com',
  implementer: null,
  labels: {},
  checklists: {},
  pr: { number: 7, state: 'ready', headSha: 'head1' },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: NOW,
  updatedAt: NOW,
  signedOffAt: null,
  doingSince: NOW,
  ...patch,
});

const DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n one\n+two\n';
const resolved = (
  stage: 'pre_merge' | 'post_merge',
): Extract<ResolvedReview, { outcome: 'ready' }> => ({
  outcome: 'ready',
  stage,
  diff: {
    ref: stage === 'pre_merge' ? 'refs/pull/7/merge' : 'main',
    sha: 'm1',
    baseSha: 'b1',
    diff: DIFF,
  },
  target: { boardId: 1, globId: 's1t1', diff: DIFF },
});

const FINDING =
  '{"file":"src/a.ts","line":2,"severity":"high","category":"bug","title":"Breaks","explanation":"It breaks.","suggestedFix":"Fix it."}';

type StoredInput = { content: string; commitSha: string; meta: unknown; model: string };

const setup = (answers: string[], files: string[] = ['src/a.ts'], model = settings.model) => {
  const host = new FakeCodeHost();
  host.prDiff = () => Promise.resolve(DIFF);
  const posted: PostedReview[] = [];
  host.submitReview = (_r, _n, review) => {
    posted.push(review);
    return Promise.resolve({ id: 99, inline: review.comments.length });
  };
  const outdate = vi.fn<CodeHost['outdateReviews']>(() => Promise.resolve(1));
  host.outdateReviews = outdate;
  const check = vi.fn<CodeHost['reportCheck']>(() => Promise.resolve('created'));
  host.reportCheck = check;
  const comment = vi.fn<CodeHost['commentOnce']>(() => Promise.resolve('posted'));
  host.commentOnce = comment;
  const stored: StoredInput[] = [];
  const addIndependentReview = vi.fn<(id: string, input: StoredInput) => Promise<Result<Artifact>>>(
    (id, input) => {
      stored.push(input);
      return Promise.resolve(
        ok({
          id: stored.length,
          globId: id,
          kind: 'independent_review',
          label: '',
          version: stored.length,
          content: input.content,
          link: null,
          commitSha: input.commitSha,
          provenance: { by: 'reviewer', actor: input.model, runId: null, agentSetVersion: null },
          createdAt: NOW,
        }),
      );
    },
  );
  const complete = vi.fn(() => Promise.resolve(answers.shift() ?? ''));
  // Each model call reports 1,000 input and 500 output tokens, as the Bedrock adapter does.
  const onUsages: ((usage: { input: number; output: number }) => void)[] = [];
  const llm: Llm = {
    complete: () => {
      onUsages.forEach((report) => report({ input: 1000, output: 500 }));
      return complete();
    },
  };
  const record = vi.fn<SpendService['record']>(() => Promise.resolve());
  const assemble = vi.fn<ReviewInputService['assemble']>(() =>
    Promise.resolve(ok({ input: { diff: DIFF, plan: 'p', reviewGuide: '' }, files, skipped: [] })),
  );
  const run = makeRunReview({
    host,
    inputs: { assemble },
    artifacts: { addIndependentReview },
    boardOf: () => Promise.resolve(board),
    settings: () => Promise.resolve({ ...settings, model }),
    spend: { record },
    llmFor: (_model, onUsage) => {
      onUsages.push(onUsage);
      return llm;
    },
  });
  return { run, posted, outdate, check, comment, stored, complete, assemble, record };
};

describe('RunReview', () => {
  it('reviews a ready PR, stores the artifact on the reviewed commit and publishes a review, the outdating and the check', async () => {
    const t = setup([
      `{"summary":"Adds a thing.","findings":[${FINDING}]}`,
      '{"verdicts":[{"index":0,"keep":true,"reason":"real"}]}',
    ]);
    await t.run(glob(), resolved('pre_merge'));
    expect(t.stored).toHaveLength(1);
    expect(t.stored[0]).toMatchObject({
      commitSha: 'm1',
      model: 'gpt-oss',
      meta: { stage: 'pre_merge', headSha: 'head1', findings: 1, high: 1 },
    });
    expect(t.stored[0]?.content).toContain('Independent review before merge');
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]).toMatchObject({ commitSha: 'head1' });
    expect(t.posted[0]?.comments).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 2 })]);
    expect(t.outdate).toHaveBeenCalledWith(
      { owner: 'o', name: 'r', base: 'main' },
      7,
      '<!-- slop-review glob=s1t1 ',
      99,
      expect.any(Function),
    );
    expect(t.check).toHaveBeenCalledWith(
      expect.anything(),
      'head1',
      expect.objectContaining({ name: 'slop-review', title: '1 finding' }),
    );
    expect(t.comment).not.toHaveBeenCalled();
    // The board's ignored paths reach the input assembly as patterns.
    const patterns = t.assemble.mock.calls[0]?.[1] ?? [];
    expect(patterns.some((p) => p.test('docs/a.md'))).toBe(true);
  });

  it('posts a merged change as one PR comment, with no review, outdating or check', async () => {
    const t = setup([
      `{"summary":"Adds a thing.","findings":[${FINDING}]}`,
      '{"verdicts":[{"index":0,"keep":true,"reason":"real"}]}',
    ]);
    await t.run(
      glob({
        type: 'sub',
        status: 'reviewing',
        pr: { number: 7, state: 'merged', headSha: 'head1' },
      }),
      resolved('post_merge'),
    );
    expect(t.stored[0]).toMatchObject({ meta: { stage: 'post_merge' } });
    expect(t.comment).toHaveBeenCalledOnce();
    expect(t.comment.mock.calls[0]?.[3]).toContain('slop review after merge');
    expect(t.posted).toEqual([]);
    expect(t.check).not.toHaveBeenCalled();
  });

  it('a change of only skipped files is stored as an empty review without asking the model', async () => {
    const t = setup([], []);
    await t.run(glob(), resolved('pre_merge'));
    expect(t.complete).not.toHaveBeenCalled();
    expect(t.stored[0]).toMatchObject({ meta: { findings: 0 } });
    expect(t.posted).toHaveLength(1);
  });

  it('lets a busy model through so the outbox retries, storing and publishing nothing', async () => {
    const t = setup([]);
    t.complete.mockRejectedValue(new LlmBusy());
    await expect(t.run(glob(), resolved('pre_merge'))).rejects.toBeInstanceOf(LlmBusy);
    expect(t.stored).toEqual([]);
    expect(t.posted).toEqual([]);
  });

  it("records the review's tokens in the spend ledger, with the artifact version, and puts the cost on the review's meta", async () => {
    const t = setup(
      [`{"summary":"Adds a thing.","findings":[${FINDING}]}`, '{"verdicts":[{"index":0,"keep":true,"reason":"real"}]}'],
      ['src/a.ts'],
      'openai.gpt-oss-120b-1:0',
    );
    await t.run(glob(), resolved('pre_merge'));
    // Two calls (findings, verification) of 1,000 in and 500 out each.
    expect(t.record).toHaveBeenCalledOnce();
    expect(t.record).toHaveBeenCalledWith({
      boardId: 1,
      globId: 's1t1',
      source: 'review',
      model: 'openai.gpt-oss-120b-1:0',
      inputTokens: 2000,
      outputTokens: 1000,
      ref: '1',
    });
    expect(t.stored[0]?.meta).toMatchObject({ costUsd: (2000 * 0.15 + 1000 * 0.6) / 1_000_000 });
  });

  it('an unpriced model keeps its tokens but puts no cost on the review', async () => {
    const t = setup([`{"summary":"s","findings":[]}`], ['src/a.ts'], 'some.unpriced-model');
    await t.run(glob(), resolved('pre_merge'));
    expect(t.record).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 1000, outputTokens: 500 }));
    expect(t.stored[0]?.meta).not.toHaveProperty('costUsd');
  });

  it('a failed attempt that called the model still records what it cost, without an artifact version', async () => {
    const t = setup(['not json at all', 'still not json']);
    await expect(t.run(glob(), resolved('pre_merge'))).rejects.toThrow();
    expect(t.stored).toEqual([]);
    expect(t.record).toHaveBeenCalledOnce();
    expect(t.record.mock.calls[0]?.[0]).toMatchObject({ ref: null });
    expect(t.record.mock.calls[0]?.[0].inputTokens).toBeGreaterThan(0);
  });

  it('an empty review makes no model call, so no tokens reach the ledger (which keeps nothing for zero), and a spend write that fails does not fail the review', async () => {
    const t = setup([], []);
    await t.run(glob(), resolved('pre_merge'));
    expect(t.record).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
    t.record.mockRejectedValue(new Error('db down'));
    await expect(t.run(glob(), resolved('pre_merge'))).resolves.toBeUndefined();
  });
});
