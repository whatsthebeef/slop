import { ArtifactService, GlobService, ReviewFeedbackService, findingMarker } from '@slop/core';
import type { Board, Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodeHost, PrReviewComment } from '../src/codehost.js';
import { PgStore } from '../src/db/store.js';
import { ReviewFeedbackPoller } from '../src/review-feedback-poller.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const DEV = 'dev@example.com';
const NOW = '2026-10-07T12:00:00.000Z';

describe('ReviewFeedbackPoller (s15f43)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let store: PgStore;
  let board: Board;
  let globId: string;

  const comment = (patch: Partial<PrReviewComment>): PrReviewComment => ({
    id: 1,
    body: '',
    inReplyTo: null,
    author: 'slop[bot]',
    authorIsBot: true,
    path: 'src/a.ts',
    line: 4,
    thumbsDown: 0,
    createdAt: '2026-10-05T00:00:00.000Z',
    ...patch,
  });
  const finding = (id: number, title: string) =>
    comment({
      id,
      body: `**medium · convention: ${title}**\n\nWhy.\n\n${findingMarker(globId, 1, { file: 'src/a.ts', category: 'convention', title })}`,
    });
  const stored = () =>
    store.transaction((tx) =>
      tx.listReviewFeedback(board.id, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
    );

  beforeAll(async () => {
    db = await createTestDatabase('feedback_poller');
    store = new PgStore(db.database.db);
    const notifier = { publish: () => undefined };
    const clock = { now: () => '2026-10-05T00:00:00.000Z' };
    const globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: DEV, active: true });
      board = await tx.insertBoard({
        name: 'b',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    globId = unwrap(
      await globs.create(DEV, {
        boardId: board.id,
        title: 'Work',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;
    // The glob has a PR and an independent review in the window.
    await store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) throw new Error('missing glob');
      await tx.updateGlob(
        { ...glob, pr: { number: 7, state: 'ready', headSha: 'h1' } },
        glob.version,
      );
    });
    unwrap(
      await new ArtifactService({ store, clock, notifier }).addIndependentReview(globId, {
        content: '# review',
        commitSha: 'm1',
        meta: { stage: 'pre_merge', headSha: 'h1', findings: 2, high: 0, medium: 2, low: 0 },
        model: 'm',
      }),
    );
  });

  afterAll(() => db.drop());

  it('records a thumbs-down and a /wrong reply on slop findings once, however often it polls, and ignores the rest', async () => {
    const host = new FakeCodeHost();
    const comments: PrReviewComment[] = [
      { ...finding(11, 'Use the helper'), thumbsDown: 2 },
      comment({
        id: 12,
        inReplyTo: 11,
        body: '/wrong it is private',
        author: 'dev',
        authorIsBot: false,
      }),
      comment({ id: 13, inReplyTo: 11, body: 'thanks', author: 'dev', authorIsBot: false }),
      comment({ id: 14, inReplyTo: 11, body: '/wrong', author: 'other[bot]', authorIsBot: true }),
      // A finding with no reaction or reply, and a human's own thumbed-down comment, are not feedback.
      finding(21, 'Another'),
      comment({ id: 31, body: 'my own remark', thumbsDown: 3, author: 'dev', authorIsBot: false }),
    ];
    const reviewComments = vi.fn<CodeHost['reviewComments']>(() => Promise.resolve(comments));
    host.reviewComments = reviewComments;
    const poller = new ReviewFeedbackPoller({
      store,
      host,
      feedback: new ReviewFeedbackService({ store }),
      log: () => undefined,
    });
    expect(await poller.collect(board, NOW)).toBe(2);
    expect(reviewComments).toHaveBeenCalledWith({ owner: 'acme', name: 'app', base: 'main' }, 7);
    expect((await stored()).map((f) => [f.verdict, f.source, f.githubCommentId, f.title])).toEqual([
      ['thumbs_down', 'reaction', 11, 'Use the helper'],
      ['wrong', 'reply', 12, 'Use the helper'],
    ]);
    expect(await poller.collect(board, NOW)).toBe(0);
    expect(await stored()).toHaveLength(2);
  });

  it('ignores a finding marker on a person\'s comment and one naming another glob', async () => {
    const host = new FakeCodeHost();
    const forged = { ...finding(41, 'Forged'), author: 'mallory', authorIsBot: false, thumbsDown: 2 };
    const foreign = {
      ...finding(42, 'Foreign'),
      body: finding(42, 'Foreign').body.replace(globId, 's999t999'),
      thumbsDown: 2,
    };
    const comments = [
      forged,
      foreign,
      comment({ id: 43, inReplyTo: 41, body: '/wrong', author: 'dev', authorIsBot: false }),
      comment({ id: 44, inReplyTo: 42, body: '/wrong', author: 'dev', authorIsBot: false }),
    ];
    host.reviewComments = vi.fn<CodeHost['reviewComments']>(() => Promise.resolve(comments));
    const poller = new ReviewFeedbackPoller({
      store,
      host,
      feedback: new ReviewFeedbackService({ store }),
      log: () => undefined,
    });
    expect(await poller.collect(board, NOW)).toBe(0);
    expect((await stored()).filter((f) => f.githubCommentId >= 41)).toEqual([]);
  });

  it('logs a PR it cannot read and carries on, and does nothing for a board without a repo', async () => {
    const host = new FakeCodeHost();
    host.reviewComments = () => Promise.reject(new Error('GitHub 502'));
    const log = vi.fn<(message: string) => void>();
    const poller = new ReviewFeedbackPoller({
      store,
      host,
      feedback: new ReviewFeedbackService({ store }),
      log,
    });
    expect(await poller.collect(board, NOW)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('PR 7 failed: GitHub 502'));
    expect(await poller.collect({ ...board, repo: null }, NOW)).toBe(0);
  });
});
