import { beforeEach, describe, expect, it } from 'vitest';
import { SpendService } from '../src/app/spend-service.js';
import { costOf, monthStart, summariseSpend } from '../src/domain/spend.js';
import { MemoryStore } from '../src/testing/memory-store.js';

describe('spend (domain)', () => {
  it('prices tokens per million, by the model id it contains, and is null for an unpriced model', () => {
    expect(costOf('openai.gpt-oss-120b-1:0', 1_000_000, 1_000_000)).toBeCloseTo(0.75);
    expect(costOf('eu.openai.gpt-oss-20b-1:0', 1_000_000, 0)).toBeCloseTo(0.07);
    expect(costOf('some.other-model', 10, 10)).toBeNull();
  });

  it('starts the month in the board time zone', () => {
    expect(monthStart('2026-10-15T12:00:00.000Z', 'UTC')).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      month: '2026-10',
    });
    // 02:00 UTC on 1 Nov is still 31 Oct (22:00) in New York, so still October's month.
    expect(monthStart('2026-11-01T02:00:00.000Z', 'America/New_York')).toEqual({
      from: '2026-10-01T04:00:00.000Z',
      month: '2026-10',
    });
    // Tokyo is already in November, and its month started on 31 Oct 15:00 UTC.
    expect(monthStart('2026-10-31T16:00:00.000Z', 'Asia/Tokyo')).toEqual({
      from: '2026-10-31T15:00:00.000Z',
      month: '2026-11',
    });
    // Daylight saving ends during 1 Nov 2026 (after midnight), so November starts at UTC-4 and December at UTC-5.
    expect(monthStart('2026-11-15T12:00:00.000Z', 'America/New_York')).toEqual({
      from: '2026-11-01T04:00:00.000Z',
      month: '2026-11',
    });
    expect(monthStart('2026-12-15T12:00:00.000Z', 'America/New_York')).toEqual({
      from: '2026-12-01T05:00:00.000Z',
      month: '2026-12',
    });
  });

  it('sums priced cost by source and counts unpriced calls', () => {
    const row = (costUsd: number | null, source = 'review') => ({
      id: 1,
      boardId: 1,
      globId: null,
      source,
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
      ref: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    expect(summariseSpend([row(0.5), row(0.25), row(null), row(1, 'kb')])).toEqual({
      usd: 1.75,
      unpricedCalls: 1,
      bySource: { review: 0.75, kb: 1 },
    });
  });
});

describe('SpendService', () => {
  let store: MemoryStore;
  let now: string;
  let service: SpendService;
  let boardId: number;

  beforeEach(async () => {
    store = new MemoryStore();
    now = '2026-10-15T12:00:00.000Z';
    service = new SpendService({ store, clock: { now: () => now } });
    boardId = (
      await store.transaction((tx) =>
        tx.insertBoard({
          name: 'b',
          repo: null,
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [],
          sensitivePaths: [],
        }),
      )
    ).id;
  });

  const spend = (model: string, inputTokens: number, outputTokens: number) =>
    service.record({
      boardId,
      globId: 's1t1',
      source: 'review',
      model,
      inputTokens,
      outputTokens,
      ref: '1',
    });

  it('shows this month to date: a priced review adds its cost, an unpriced one is counted, last month is left out', async () => {
    now = '2026-09-30T12:00:00.000Z';
    await spend('openai.gpt-oss-120b-1:0', 1_000_000, 0);
    now = '2026-10-10T12:00:00.000Z';
    await spend('openai.gpt-oss-120b-1:0', 2_000_000, 1_000_000);
    await spend('unknown-model', 5, 5);
    now = '2026-10-15T12:00:00.000Z';
    const month = await service.monthToDate(boardId);
    expect(month.ok && month.value.month).toBe('2026-10');
    expect(month.ok && month.value.usd).toBeCloseTo(0.9);
    expect(month.ok && month.value.unpricedCalls).toBe(1);
    expect(month.ok && month.value.bySource.review).toBeCloseTo(0.9);
  });

  it('leaves a source with only unpriced rows out of bySource (the Postgres store does the same)', async () => {
    await spend('unknown-model', 5, 5);
    await service.record({ boardId, globId: 's1t1', source: 'kb', model: 'openai.gpt-oss-20b', inputTokens: 1_000_000, outputTokens: 0, ref: null });
    const month = await service.monthToDate(boardId);
    expect(month.ok && month.value.unpricedCalls).toBe(1);
    expect(month.ok && Object.keys(month.value.bySource)).toEqual(['kb']);
  });

  it('records nothing for a review that made no model call, and is not found for an unknown board', async () => {
    await spend('openai.gpt-oss-120b-1:0', 0, 0);
    const month = await service.monthToDate(boardId);
    expect(month.ok && month.value.usd).toBe(0);
    expect((await service.monthToDate(999)).ok).toBe(false);
  });
});
