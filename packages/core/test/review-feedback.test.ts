import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewFeedbackService } from '../src/app/review-feedback-service.js';
import type { ReviewCommentFeedback } from '../src/app/review-feedback-service.js';
import {
  findingMarker,
  isFalsePositive,
  isWrongReply,
  parseFindingHeader,
  parseFindingMarker,
} from '../src/domain/review-feedback.js';
import { planReviewPublication, reviewMarker } from '../src/domain/review-publish.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { glob as makeGlob } from './fixtures.js';

const finding = { file: 'src/a.ts', category: 'convention' as const, title: 'Use  the helper' };
const BODY = `**medium · convention: Use  the helper**\n\nExplanation.\n\n${findingMarker('s1t1', 2, finding)}`;

describe('review feedback markers', () => {
  it('round-trips the marker and the header, and a marker needs the exact shape', () => {
    const marker = parseFindingMarker(BODY);
    expect(marker).toMatchObject({ globId: 's1t1', version: 2 });
    expect(marker?.fingerprint).toMatch(/^[0-9a-f]+$/);
    expect(parseFindingHeader(BODY)).toEqual({
      severity: 'medium',
      category: 'convention',
      title: 'Use  the helper',
    });
    expect(parseFindingMarker('plain comment')).toBeNull();
    expect(parseFindingHeader('**odd · thing: x**')).toBeNull();
  });

  it('the fingerprint ignores case and spacing in the title but not the file', () => {
    const same = findingMarker('s1t1', 9, { ...finding, title: 'use the HELPER' });
    expect(parseFindingMarker(same)?.fingerprint).toBe(parseFindingMarker(BODY)?.fingerprint);
    const other = findingMarker('s1t1', 2, { ...finding, file: 'src/b.ts' });
    expect(parseFindingMarker(other)?.fingerprint).not.toBe(parseFindingMarker(BODY)?.fingerprint);
  });

  it('reads /wrong and "false positive" replies, and only at the start', () => {
    for (const reply of [
      '/wrong',
      '  /Wrong this is fine',
      'False positive, the helper is private',
      'false-positive',
    ])
      expect(isWrongReply(reply), reply).toBe(true);
    for (const reply of ['this is wrong', 'thanks, fixed', '/wrongdoing'])
      expect(isWrongReply(reply), reply).toBe(false);
  });

  it('counts wrong and thumbs-down as false positives, not a plain resolve', () => {
    expect([
      isFalsePositive('wrong'),
      isFalsePositive('thumbs_down'),
      isFalsePositive('resolved'),
    ]).toEqual([true, true, false]);
  });

  it('puts the marker on inline comments only, never on the summary', () => {
    const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n one\n+two\n';
    const review = {
      summary: 's',
      findings: [
        {
          file: 'src/a.ts',
          line: 2,
          severity: 'high' as const,
          category: 'bug' as const,
          title: 'Inline',
          explanation: 'e',
          suggestedFix: '',
        },
        {
          file: 'src/a.ts',
          line: 2,
          severity: 'low' as const,
          category: 'bug' as const,
          title: 'Summary only',
          explanation: 'e',
          suggestedFix: '',
        },
      ],
    };
    const meta = {
      stage: 'pre_merge' as const,
      sha: 'abcdef1234567',
      truncated: false,
      marker: reviewMarker('s1t1', 'abcdef1234567', 4),
      diff,
      headDiff: diff,
    };
    const plan = planReviewPublication(review, {
      ...meta,
      feedbackIds: { globId: 's1t1', version: 4 },
    });
    expect(plan.inline).toHaveLength(1);
    expect(parseFindingMarker(plan.inline[0]?.body ?? '')).toMatchObject({
      globId: 's1t1',
      version: 4,
    });
    expect(plan.body).not.toContain('slop-finding');
    // Without ids (an older caller) there is no marker.
    expect(planReviewPublication(review, meta).inline[0]?.body).not.toContain('slop-finding');
  });
});

describe('ReviewFeedbackService', () => {
  let store: MemoryStore;
  let service: ReviewFeedbackService;
  const boardId = 1;
  const at = '2026-10-05T12:00:00.000Z';

  const feedback = (patch: Partial<ReviewCommentFeedback> = {}): ReviewCommentFeedback => ({
    boardId,
    prGlobId: 's1t1',
    rootIsBot: true,
    body: BODY,
    path: 'src/a.ts',
    line: 2,
    verdict: 'wrong',
    source: 'reply',
    githubCommentId: 101,
    actor: 'dev',
    actorIsBot: false,
    at,
    ...patch,
  });
  const stored = () =>
    store.transaction((tx) =>
      tx.listReviewFeedback(boardId, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
    );

  beforeEach(async () => {
    store = new MemoryStore();
    service = new ReviewFeedbackService({ store });
    await store.transaction((tx) => tx.insertGlob(makeGlob({ boardId, id: 's1t1' }), null));
  });

  it('stores a verdict with the finding it is about', async () => {
    expect(await service.record(feedback())).toBe('recorded');
    expect(await stored()).toMatchObject([
      {
        globId: 's1t1',
        artifactVersion: 2,
        severity: 'medium',
        category: 'convention',
        title: 'Use  the helper',
        path: 'src/a.ts',
        line: 2,
        verdict: 'wrong',
        source: 'reply',
        actor: 'dev',
      },
    ]);
  });

  it('is idempotent per comment and source, so a redelivery or a second poll adds nothing', async () => {
    expect(await service.record(feedback())).toBe('recorded');
    expect(await service.record(feedback())).toBe('duplicate');
    // The same comment's reaction is a different source.
    expect(await service.record(feedback({ verdict: 'thumbs_down', source: 'reaction' }))).toBe(
      'recorded',
    );
    expect(await stored()).toHaveLength(2);
  });

  it("ignores bots, comments that are not slop findings and another board's glob", async () => {
    expect(await service.record(feedback({ actorIsBot: true }))).toBe('ignored');
    expect(await service.record(feedback({ body: 'a human comment' }))).toBe('ignored');
    expect(await service.record(feedback({ boardId: 2 }))).toBe('ignored');
    expect(await service.record(feedback({ body: BODY.replace('s1t1', 's9t9') }))).toBe('ignored');
    expect(await stored()).toEqual([]);
  });

  it("ignores a marker on a person's comment and a marker naming another PR's glob", async () => {
    await store.transaction((tx) => tx.insertGlob(makeGlob({ boardId, id: 's1t2' }), null));
    expect(await service.record(feedback({ rootIsBot: false }))).toBe('ignored');
    // The marker copied from s1t1's comment onto s1t2's PR.
    expect(await service.record(feedback({ prGlobId: 's1t2' }))).toBe('ignored');
    expect(await stored()).toEqual([]);
    expect(await service.record(feedback({ prGlobId: 's1t1' }))).toBe('recorded');
  });

  it("the store lists a window of feedback oldest first, and keeps a comment's reply and reaction apart", async () => {
    await service.record(feedback({ at: '2026-10-05T12:00:00.000Z' }));
    await service.record(
      feedback({ verdict: 'thumbs_down', source: 'reaction', at: '2026-10-04T12:00:00.000Z' }),
    );
    await service.record(feedback({ githubCommentId: 102, at: '2026-08-01T00:00:00.000Z' }));
    const window = await store.transaction((tx) =>
      tx.listReviewFeedback(boardId, '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
    );
    expect(window.map((f) => f.source)).toEqual(['reaction', 'reply']);
  });
});
