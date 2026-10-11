import { parseFindingMarker } from '@slop/core';
import type { Glob, IndependentReview } from '@slop/core';
import { describe, expect, it, vi } from 'vitest';
import type { Repo } from '../src/codehost.js';
import { publishReview } from '../src/review-publish.js';
import type { ResolvedReview } from '../src/review-target.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const repo: Repo = { owner: 'o', name: 'r', base: 'main' };
const DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n one\n+two\n';
const review: IndependentReview = {
  summary: 'Adds a thing.',
  findings: [
    {
      file: 'src/a.ts',
      line: 2,
      severity: 'medium',
      category: 'bug',
      title: 'Wrong',
      explanation: 'Because.',
      suggestedFix: '',
    },
  ],
};
const target = (
  stage: 'pre_merge' | 'post_merge',
): Extract<ResolvedReview, { outcome: 'ready' }> => ({
  outcome: 'ready',
  stage,
  diff: { ref: 'r', sha: 'merge1', baseSha: null, diff: DIFF },
  target: { boardId: 1, globId: 's1t1', diff: DIFF },
});
const glob = (headSha: string | null): Glob =>
  ({ id: 's1t1', pr: { number: 7, state: 'ready', headSha } }) as unknown as Glob;
const input = { review, truncated: false, version: 2, minSeverity: 'medium' as const };

describe('publishReview', () => {
  it('a second review outdates the first: the old body is rewritten and the new review is excluded', async () => {
    const host = new FakeCodeHost();
    host.submitReview = () => Promise.resolve({ id: 42, inline: 1 });
    const outdate = vi.fn<(...args: Parameters<FakeCodeHost['outdateReviews']>) => Promise<number>>(
      () => Promise.resolve(1),
    );
    host.outdateReviews = outdate;
    await publishReview(host, repo, glob('head2'), target('pre_merge'), input);
    const call = outdate.mock.calls[0];
    if (call === undefined) throw new Error('outdateReviews was not called');
    const [, pr, prefix, except, rewrite] = call;
    expect([pr, prefix, except]).toEqual([7, '<!-- slop-review glob=s1t1 ', 42]);
    const rewritten = rewrite('<!-- slop-review glob=s1t1 sha=old v=1 -->\nBody');
    expect(rewritten).toContain('Outdated');
    expect(rewritten).toContain('head2');
  });

  it('a failing outdating or check run after the review is posted does not fail the publish, so the job is not retried', async () => {
    const host = new FakeCodeHost();
    host.submitReview = () => Promise.resolve({ id: 42, inline: 0 });
    host.outdateReviews = () => Promise.reject(new Error('GitHub 502'));
    host.reportCheck = () => Promise.reject(new Error('GitHub 500'));
    const log = vi.fn<(message: string) => void>();
    await expect(
      publishReview(host, repo, glob('head2'), target('pre_merge'), input, log),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("anchors inline comments only where the PR head's own diff has the same hunks", async () => {
    const posted: number[] = [];
    const host = new FakeCodeHost();
    host.submitReview = (_r, _n, r) => {
      posted.push(r.comments.length);
      return Promise.resolve({ id: 1, inline: r.comments.length });
    };
    host.prDiff = () => Promise.resolve(DIFF);
    await publishReview(host, repo, glob('head2'), target('pre_merge'), input);
    host.prDiff = () => Promise.resolve(DIFF.replace('@@ -1,1 +1,2 @@', '@@ -1,1 +3,2 @@'));
    await publishReview(host, repo, glob('head2'), target('pre_merge'), input);
    host.prDiff = () => Promise.reject(new Error('boom'));
    await publishReview(host, repo, glob('head2'), target('pre_merge'), input);
    expect(posted).toEqual([1, 0, 0]);
  });

  it('reports the check run as a neutral "N findings" on the PR head, and a missing permission does not fail the publish', async () => {
    const host = new FakeCodeHost();
    const check = vi.fn<FakeCodeHost['reportCheck']>(() => Promise.resolve('unavailable'));
    host.reportCheck = check;
    await expect(
      publishReview(host, repo, glob('head2'), target('pre_merge'), input),
    ).resolves.toBeUndefined();
    expect(check.mock.calls[0]?.[1]).toBe('head2');
    expect(check.mock.calls[0]?.[2]).toMatchObject({ name: 'slop-review', title: '1 finding' });
    expect(check.mock.calls[0]?.[2].summary).toContain('1 medium');
  });

  it('posts nothing before merge without a PR head, and a comment once with a per-run marker after merge', async () => {
    const host = new FakeCodeHost();
    const submit = vi.fn<FakeCodeHost['submitReview']>(() => Promise.resolve({ id: 1, inline: 0 }));
    host.submitReview = submit;
    const comment = vi.fn<FakeCodeHost['commentOnce']>(() => Promise.resolve('posted'));
    host.commentOnce = comment;
    await publishReview(host, repo, glob(null), target('pre_merge'), input);
    expect(submit).not.toHaveBeenCalled();
    await publishReview(host, repo, glob('h'), target('post_merge'), input);
    expect(comment).toHaveBeenCalledWith(
      repo,
      7,
      '<!-- slop-review glob=s1t1 sha=merge1 v=2 -->',
      expect.stringContaining('slop review after merge'),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('marks the inline comments with the finding marker, the glob and the artifact version, and the summary with none (s15f43)', async () => {
    const host = new FakeCodeHost();
    host.prDiff = () => Promise.resolve(DIFF);
    const submit = vi.fn<FakeCodeHost['submitReview']>(() => Promise.resolve({ id: 1, inline: 1 }));
    host.submitReview = submit;
    await publishReview(host, repo, glob('head2'), target('pre_merge'), input);
    const posted = submit.mock.calls[0]?.[2];
    expect(posted?.comments).toHaveLength(1);
    expect(parseFindingMarker(posted?.comments[0]?.body ?? '')).toMatchObject({ globId: 's1t1', version: 2 });
    expect(posted?.body).not.toContain('slop-finding');
  });
});
