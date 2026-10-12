import { SpendService } from '@slop/core';
import { sql } from 'drizzle-orm';
import type { NewReviewFeedback, Store } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { spendRecorder } from '../src/llm.js';
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
      // It is named in unpricedBySource instead, with each source's unpriced count.
      expect(again.unpricedBySource).toEqual({ review: 1, 'unpriced-only': 1 });
      expect(
        await store.transaction((tx) =>
          tx.sumLlmSpend(boardId + 1, '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
        ),
      ).toEqual({
        usd: 0,
        unpricedCalls: 0,
        bySource: {},
        unpricedBySource: {},
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

describe('tagged model calls reach the Postgres spend ledger (s15f60)', () => {
  it('writes a row per tagged call with its board, source and glob, prices it or counts it unpriced, and skips untagged calls', async () => {
    const { database: db, drop: dropDb } = await createTestDatabase('spendtag');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const store = new PgStore(db.db);
      const board = await store.transaction((tx) => tx.insertBoard(boardInput));
      const other = await store.transaction((tx) =>
        tx.insertBoard({ ...boardInput, name: 'other' }),
      );
      const spend = new SpendService({ store, clock: { now: () => '2026-10-12T10:00:00.000Z' } });
      const errors: string[] = [];
      const record = spendRecorder(spend, (m) => errors.push(m));

      // Regional Haiku: 1000 * 1.1 + 2000 * 5.5 per million.
      await record(
        { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', input: 1000, output: 2000 },
        { boardId: board.id, source: 'chat' },
      );
      // Global Sonnet: 1000 * 2 + 1000 * 10 per million.
      await record(
        { model: 'global.anthropic.claude-sonnet-5-5', input: 1000, output: 1000 },
        { boardId: board.id, source: 'intake', globId: 's1f2' },
      );
      // An older Claude has no price: the row is kept with a null cost.
      await record(
        { model: 'anthropic.claude-3-haiku-20240307-v1:0', input: 500, output: 100 },
        { boardId: board.id, source: 'kb_draft', globId: 's1f3' },
      );
      // Untagged (review, knowledge page): logged only, no row.
      await record(
        { model: 'global.anthropic.claude-opus-5-5', input: 9000, output: 9000 },
        undefined,
      );
      // Another board's call stays on that board.
      await record(
        { model: 'global.anthropic.claude-opus-5-5', input: 1000, output: 1000 },
        { boardId: other.id, source: 'chat' },
      );
      expect(errors).toEqual([]);

      const month = await spend.monthToDate(board.id);
      expect(month.ok).toBe(true);
      if (!month.ok) return;
      expect(month.value.month).toBe('2026-10');
      expect(month.value.usd).toBeCloseTo(0.0121 + 0.012, 10);
      expect(month.value.unpricedCalls).toBe(1);
      expect(Object.keys(month.value.bySource).sort()).toEqual(['chat', 'intake']);
      expect(month.value.bySource.chat).toBeCloseTo(0.0121, 10);
      expect(month.value.bySource.intake).toBeCloseTo(0.012, 10);
      expect(month.value.unpricedBySource).toEqual({ kb_draft: 1 });

      const rows = await db.db.execute(
        sql`select source, glob_id, model, input_tokens, output_tokens, cost_usd from llm_spend where board_id = ${board.id} order by source`,
      );
      expect(
        rows.map((r) => [
          r.source,
          r.glob_id,
          r.model,
          Number(r.input_tokens),
          Number(r.output_tokens),
          r.cost_usd === null,
        ]),
      ).toEqual([
        ['chat', null, 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 1000, 2000, false],
        ['intake', 's1f2', 'global.anthropic.claude-sonnet-5-5', 1000, 1000, false],
        ['kb_draft', 's1f3', 'anthropic.claude-3-haiku-20240307-v1:0', 500, 100, true],
      ]);

      const otherMonth = await spend.monthToDate(other.id);
      expect(otherMonth.ok && otherMonth.value.bySource).toEqual({
        chat: (1000 * 4 + 1000 * 20) / 1_000_000,
      });
    } finally {
      log.mockRestore();
      await dropDb();
    }
  });
});
