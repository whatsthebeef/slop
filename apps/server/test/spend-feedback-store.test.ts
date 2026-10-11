import type { NewReviewFeedback, Store } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const feedback = (patch: Partial<NewReviewFeedback> = {}): NewReviewFeedback => ({
  boardId: 1,
  globId: 's1t1',
  artifactVersion: 1,
  fingerprint: 'abc',
  severity: 'high',
  category: 'bug',
  title: 'Breaks',
  path: 'src/a.ts',
  line: null,
  verdict: 'wrong',
  source: 'reply',
  githubCommentId: 5_000_000_000,
  actor: 'dev',
  createdAt: '2026-10-05T12:00:00.000Z',
  ...patch,
});

/** The checks the core tests make against the in-memory store (`review-feedback.test.ts`, `spend.test.ts`), here against Postgres. */
const behaves = (
  name: string,
  make: () => Promise<{ store: Store; boardId: number; done: () => Promise<void> }>,
) =>
  describe(`${name}: spend ledger and review feedback (s15f43)`, () => {
    let store: Store;
    let boardId: number;
    let done: () => Promise<void>;
    beforeAll(async () => ({ store, boardId, done } = await make()));
    afterAll(() => done());

    it('sums priced spend by source in a period, counts unpriced calls, and leaves out other boards and periods', async () => {
      const row = (patch: object) => ({
        boardId,
        globId: 's1t1',
        source: 'review',
        model: 'm',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.5,
        ref: null,
        createdAt: '2026-10-05T00:00:00.000Z',
        ...patch,
      });
      await store.transaction(async (tx) => {
        await tx.insertLlmSpend(row({}));
        await tx.insertLlmSpend(row({ costUsd: 0.25, ref: '2' }));
        await tx.insertLlmSpend(row({ costUsd: null }));
        await tx.insertLlmSpend(row({ source: 'kb', costUsd: 1 }));
        await tx.insertLlmSpend(row({ createdAt: '2026-09-30T00:00:00.000Z', costUsd: 100 }));
      });
      const sum = await store.transaction((tx) =>
        tx.sumLlmSpend(boardId, '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
      );
      expect(sum.usd).toBeCloseTo(1.75);
      expect(sum.unpricedCalls).toBe(1);
      expect(sum.bySource.review).toBeCloseTo(0.75);
      expect(sum.bySource.kb).toBeCloseTo(1);
      // A source whose rows are all unpriced is left out of bySource, as the in-memory store does.
      await store.transaction((tx) => tx.insertLlmSpend(row({ source: 'unpriced-only', costUsd: null })));
      const again = await store.transaction((tx) =>
        tx.sumLlmSpend(boardId, '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
      );
      expect(again.unpricedCalls).toBe(2);
      expect(Object.keys(again.bySource).sort()).toEqual(['kb', 'review']);
      expect(
        await store.transaction((tx) =>
          tx.sumLlmSpend(boardId + 1, '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
        ),
      ).toEqual({
        usd: 0,
        unpricedCalls: 0,
        bySource: {},
      });
    });

    it('stores feedback once per comment and source, and lists a window oldest first', async () => {
      const first = feedback({ boardId });
      expect(await store.transaction((tx) => tx.insertReviewFeedback(first))).toBe(true);
      expect(await store.transaction((tx) => tx.insertReviewFeedback(first))).toBe(false);
      // The same comment's reaction is its own verdict.
      expect(
        await store.transaction((tx) =>
          tx.insertReviewFeedback({
            ...first,
            verdict: 'thumbs_down',
            source: 'reaction',
            createdAt: '2026-10-04T00:00:00.000Z',
          }),
        ),
      ).toBe(true);
      await store.transaction((tx) =>
        tx.insertReviewFeedback({
          ...first,
          githubCommentId: 2,
          createdAt: '2026-08-01T00:00:00.000Z',
        }),
      );
      const listed = await store.transaction((tx) =>
        tx.listReviewFeedback(boardId, '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
      );
      expect(listed.map((f) => [f.source, f.githubCommentId, f.createdAt])).toEqual([
        ['reaction', 5_000_000_000, '2026-10-04T00:00:00.000Z'],
        ['reply', 5_000_000_000, '2026-10-05T12:00:00.000Z'],
      ]);
      expect(listed[0]).toMatchObject({
        severity: 'high',
        category: 'bug',
        title: 'Breaks',
        path: 'src/a.ts',
        line: null,
        actor: 'dev',
      });
    });
  });

const boardInput = {
  name: 'b',
  repo: null,
  baseBranch: 'main',
  timeZone: 'UTC',
  defaultRoutineOwner: null,
  environments: [],
  sensitivePaths: [],
};

let database: Database;
let drop: () => Promise<void>;
behaves('PgStore', async () => {
  ({ database, drop } = await createTestDatabase('spend'));
  const store = new PgStore(database.db);
  const board = await store.transaction((tx) => tx.insertBoard(boardInput));
  return { store, boardId: board.id, done: drop };
});

describe('board review settings in the store (s15f43)', () => {
  it('Postgres stores the review settings with the board, reading a missing key as its default', async () => {
    const { database: db, drop: dropDb } = await createTestDatabase('reviewsettings');
    try {
      const store = new PgStore(db.db);
      const board = await store.transaction((tx) => tx.insertBoard(boardInput));
      expect(board.review).toEqual({
        enabled: true,
        model: null,
        minSeverity: 'medium',
        ignoredPaths: [],
        toolCap: null,
      });
      const next = {
        ...board,
        review: {
          enabled: false,
          model: 'm1',
          minSeverity: 'low' as const,
          ignoredPaths: ['gen/**'],
          toolCap: 9,
        },
        version: board.version + 1,
      };
      expect(await store.transaction((tx) => tx.updateBoard(next, board.version))).toBe(true);
      expect((await store.transaction((tx) => tx.getBoard(board.id)))?.review).toEqual(next.review);
    } finally {
      await dropDb();
    }
  });
});
