import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { CodeReviewService } from '../src/app/code-review-service.js';
import type { ReceivedCodeReview } from '../src/app/code-review-service.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import * as codeReview from '../src/domain/code-review.js';
import type { CodeReviewComment } from '../src/domain/code-review.js';
import type { Result } from '../src/domain/errors.js';
import type { KnowledgeDoc } from '../src/domain/knowledge.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board, glob } from './fixtures.js';

const DEV = 'dev@example.com';
const STRANGER = 'stranger@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const stored = (patch: Partial<CodeReviewComment> = {}): CodeReviewComment => ({
  id: 1,
  boardId: board.id,
  globId: 's1t1',
  prNumber: 7,
  externalId: 'coderabbit:review_comment:1',
  kind: 'inline',
  author: 'coderabbitai[bot]',
  commitSha: 'abc',
  path: 'src/a.ts',
  line: '12',
  body: 'Missing await.',
  url: 'https://github.com/acme/app/pull/7#discussion_r1',
  createdAt: NOW,
  updatedAt: NOW,
  ...patch,
});

const SUMMARY = `${codeReview.CODERABBIT_SUMMARY_MARKER}\n<!-- walkthrough_start -->\n\n## Walkthrough\n\nAdds a thing.`;

describe('CodeRabbit rules', () => {
  it('tells its summary from its other PR comments by the walkthrough marker', () => {
    expect(codeReview.isCodeRabbitSummary(SUMMARY)).toBe(true);
    expect(codeReview.issueCommentKind(SUMMARY)).toBe('summary');
    expect(codeReview.issueCommentKind('<!-- This is an auto-generated comment: review in progress by coderabbit.ai -->')).toBe('comment');
  });

  it('counts inline comments on the badge and links the latest review, else the latest item', () => {
    expect(codeReview.codeReviewBadge([])).toBeNull();
    const inline = [stored({ id: 1 }), stored({ id: 2, externalId: 'x2', createdAt: '2026-10-05T13:00:00.000Z', url: 'https://x/2' })];
    expect(codeReview.codeReviewBadge(inline)).toEqual({ count: 2, url: 'https://x/2', hasSummary: false });
    const reviews = [
      stored({ id: 3, kind: 'review', externalId: 'r1', url: 'https://x/r1', createdAt: '2026-10-05T11:00:00.000Z' }),
      stored({ id: 4, kind: 'review', externalId: 'r2', url: 'https://x/r2', createdAt: '2026-10-05T12:30:00.000Z' }),
      stored({ id: 5, kind: 'summary', externalId: 's', url: 'https://x/s', createdAt: '2026-10-05T14:00:00.000Z' }),
    ];
    expect(codeReview.codeReviewBadge([...inline, ...reviews])).toEqual({ count: 2, url: 'https://x/r2', hasSummary: true });
  });

  it('groups a glob view: the latest summary, then reviews, inline comments and other comments oldest first', () => {
    const grouped = codeReview.globCodeReview([
      stored({ id: 2, externalId: 'b', createdAt: '2026-10-05T13:00:00.000Z' }),
      stored({ id: 1, externalId: 'a' }),
      stored({ id: 3, kind: 'summary', externalId: 's', body: SUMMARY }),
      stored({ id: 4, kind: 'comment', externalId: 'c' }),
    ]);
    expect(grouped.summary?.body).toBe(SUMMARY);
    expect(grouped.inline.map((c) => c.externalId)).toEqual(['a', 'b']);
    expect(grouped.comments.map((c) => c.externalId)).toEqual(['c']);
    expect(grouped.reviews).toEqual([]);
  });

  it('reads auto reviews as off only for reviews.auto_review.enabled: false', () => {
    expect(codeReview.autoReviewOff({ reviews: { auto_review: { enabled: false } } })).toBe(true);
    expect(codeReview.autoReviewOff({ reviews: { auto_review: { enabled: true } } })).toBe(false);
    expect(codeReview.autoReviewOff({ reviews: { auto_review: { enabled: 'false' } } })).toBe(false);
    expect(codeReview.autoReviewOff({ reviews: { auto_review: {} } })).toBe(false);
    expect(codeReview.autoReviewOff({ reviews: {} })).toBe(false);
    expect(codeReview.autoReviewOff({ auto_review: { enabled: false } })).toBe(false);
    expect(codeReview.autoReviewOff(null)).toBe(false);
    expect(codeReview.autoReviewOff('reviews')).toBe(false);
    expect(codeReview.autoReviewOff([{ reviews: { auto_review: { enabled: false } } }])).toBe(false);
  });

  it('knows a review guide by its area', () => {
    expect(codeReview.isReviewGuide({ kind: 'doc', area: 'review_guide' })).toBe(true);
    expect(codeReview.isReviewGuide({ kind: 'doc', area: 'Review_Guide' })).toBe(true);
    // The change_reviewer's checklist is a different document.
    expect(codeReview.isReviewGuide({ kind: 'doc', area: 'review' })).toBe(false);
    expect(codeReview.isReviewGuide({ kind: 'agent', area: 'review_guide' })).toBe(false);
  });
});

describe('CodeReviewService', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let service: CodeReviewService;

  const received = (patch: Partial<ReceivedCodeReview> = {}): ReceivedCodeReview => ({
    prNumber: 7,
    externalId: 'coderabbit:review_comment:1',
    kind: 'inline',
    author: 'coderabbitai[bot]',
    commitSha: 'abc',
    path: 'src/a.ts',
    line: '12',
    body: 'Missing await.',
    url: 'https://github.com/acme/app/pull/7#discussion_r1',
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    service = new CodeReviewService({ store, notifier, clock: { now: () => NOW } });
    await store.transaction(async (tx) => {
      await tx.insertBoard({ ...board, environments: [...board.environments], sensitivePaths: [] });
      await tx.insertGlob(glob({ id: 's1t1', status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'abc' } }), null);
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
    });
  });

  const all = () => store.transaction((tx) => tx.listCodeReviewComments(board.id, ['s1t1']));

  it('stores an item verbatim once, and an edit replaces its body and kind', async () => {
    expect(await service.record('s1t1', received())).toBe(true);
    expect(await service.record('s1t1', received())).toBe(false);
    expect(notifier.hints).toEqual([{ kind: 'glob.reviews', boardId: board.id, globId: 's1t1' }]);

    const later = '2026-10-05T13:00:00.000Z';
    expect(await service.record('s1t1', received({ body: 'Missing await (edited).', updatedAt: later }))).toBe(true);
    // An older copy delivered late doesn't undo the edit.
    expect(await service.record('s1t1', received({ body: 'Missing await.', updatedAt: NOW }))).toBe(false);
    expect(await all()).toEqual([expect.objectContaining({ body: 'Missing await (edited).', createdAt: NOW, updatedAt: later })]);

    // CodeRabbit posts "review in progress" and edits it into its summary.
    const comment = { externalId: 'coderabbit:issue_comment:9', kind: 'comment' as const, path: null, line: null };
    await service.record('s1t1', received({ ...comment, body: 'in progress' }));
    await service.record('s1t1', received({ ...comment, kind: 'summary', body: SUMMARY, updatedAt: later }));
    expect((await all()).find((c) => c.externalId === comment.externalId)).toMatchObject({ kind: 'summary', body: SUMMARY });
  });

  it('caps an over-long body, and ignores a glob that is gone', async () => {
    await service.record('s1t1', received({ body: 'x'.repeat(codeReview.CODE_REVIEW_BODY_LIMIT + 10) }));
    expect((await all())[0]?.body).toHaveLength(codeReview.CODE_REVIEW_BODY_LIMIT);
    expect(await service.record('s9t9', received({ externalId: 'other' }))).toBe(false);
  });

  it('removes a deleted item, and a late redelivery of it does not bring it back', async () => {
    await service.record('s1t1', received());
    expect(await service.remove('coderabbit:review_comment:1')).toBe(true);
    expect(await service.remove('coderabbit:review_comment:1')).toBe(false);
    expect(await all()).toEqual([]);
    expect(notifier.hints).toHaveLength(2);
    expect(await service.record('s1t1', received())).toBe(false);
    expect(await service.record('s1t1', received({ body: 'Edited.', updatedAt: '2026-10-05T13:00:00.000Z' }))).toBe(false);
    expect(await all()).toEqual([]);
    expect(notifier.hints).toHaveLength(2);
  });

  it('gives members the badges and the glob view, and strangers nothing', async () => {
    await service.record('s1t1', received());
    await service.record('s1t1', received({ externalId: 'coderabbit:review:5', kind: 'review', path: null, line: null, url: 'https://x/review' }));
    const badges = unwrap(await service.boardBadges(DEV, board.id, ['s1t1', 's1t2']));
    expect([...badges]).toEqual([['s1t1', { count: 1, url: 'https://x/review', hasSummary: false }]]);
    expect(unwrap(await service.forGlob(DEV, 's1t1')).reviews).toHaveLength(1);
    expect((await service.boardBadges(STRANGER, board.id, ['s1t1'])).ok).toBe(false);
    expect((await service.forGlob(STRANGER, 's1t1')).ok).toBe(false);
  });

  it('is deleted with its glob', async () => {
    await service.record('s1t1', received());
    await store.transaction((tx) => tx.deleteGlob('s1t1'));
    expect(await all()).toEqual([]);
  });

  it('lists CodeRabbit in the context bundle, and includes it in full when asked', async () => {
    const artifacts = new ArtifactService({ store, clock: { now: () => NOW }, notifier });
    expect(unwrap(await artifacts.context(DEV, 's1t1')).available).toEqual([]);
    await service.record('s1t1', received());
    await service.record('s1t1', received({ externalId: 'coderabbit:issue_comment:3', kind: 'summary', path: null, line: null, body: SUMMARY }));
    const lean = unwrap(await artifacts.context(DEV, 's1t1'));
    expect(lean.codeReview).toBeNull();
    expect(lean.available).toEqual([
      expect.objectContaining({ kind: 'code_review', size: 'Missing await.'.length + SUMMARY.length, description: 'CodeRabbit: 1 inline comments, a summary, 0 reviews' }),
    ]);
    for (const include of [['code_review'], ['all']]) {
      const full = unwrap(await artifacts.context(DEV, 's1t1', include));
      expect(full.available).toEqual([]);
      expect(full.codeReview).toEqual({
        summary: SUMMARY,
        reviews: [],
        inline: [{ path: 'src/a.ts', line: '12', body: 'Missing await.', url: 'https://github.com/acme/app/pull/7#discussion_r1' }],
        comments: [],
      });
    }
  });
});

describe('review guide', () => {
  let store: MemoryStore;
  let knowledge: KnowledgeService;

  const doc = (patch: Partial<KnowledgeDoc>): KnowledgeDoc => ({
    boardId: board.id,
    kind: 'doc',
    name: 'review_guide',
    area: 'review_guide',
    audience: [],
    description: 'What reviewers look for.',
    content: '# Review guide\n\nCheck the outbox.',
    layer: 'file',
    version: 1,
    source: 'upload',
    updatedBy: DEV,
    updatedAt: NOW,
    ...patch,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    knowledge = new KnowledgeService({
      store,
      clock: { now: () => NOW },
      catalog: { kbEntries: () => Promise.resolve([]), agentSet: () => Promise.resolve({ hash: 'h', files: [] }) },
      notifier: new RecordingNotifier(),
    });
    await store.transaction(async (tx) => {
      await tx.insertBoard({ ...board, environments: [...board.environments], sensitivePaths: [] });
      await tx.insertBoard({ ...board, name: 'other', repo: 'acme/other', environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: 1, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId: 2, email: DEV, role: 'dev' });
    });
  });

  it('is a board document with area review_guide, found by repo for members only', async () => {
    expect(await knowledge.hasReviewGuide(1)).toBe(false);
    expect(unwrap(await knowledge.reviewGuides(DEV, 'acme/app'))).toEqual([]);
    await store.transaction(async (tx) => {
      await tx.saveKnowledge(doc({}));
      await tx.saveKnowledge(doc({ name: 'review_checklist', area: 'review', content: 'checklist' }));
      await tx.saveKnowledge(doc({ boardId: 2, name: 'other_guide' }));
    });
    expect(await knowledge.hasReviewGuide(1)).toBe(true);
    const guides = unwrap(await knowledge.reviewGuides(DEV, 'ACME/App'));
    expect(guides).toEqual([{ boardId: 1, boardName: 'demo', documents: [expect.objectContaining({ name: 'review_guide' })] }]);
    expect(unwrap(await knowledge.reviewGuides(STRANGER, 'acme/app'))).toEqual([]);
  });
});
