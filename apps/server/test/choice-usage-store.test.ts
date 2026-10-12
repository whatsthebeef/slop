import { NO_GLOB } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const NOW = '2026-10-12T12:00:00.000Z';

/** Choice usage counters on real Postgres, on a board of their own. */
describe('choice usage store', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;
  let choiceItem: number;
  let choiceId: number;
  let planItem: number;

  const item = (ref: string, sourceType: 'decision' | 'glob_plan') =>
    store.transaction(async (tx) => {
      await tx.replaceItem(
        { boardId, sourceType, externalRef: ref, title: ref, occurredAt: NOW, authority: 'decision', status: 'active', supersededBy: null, globIds: [], globGroup: null, externalUrl: null, contentHash: ref, state: 'ready' },
        [{ position: 0, header: `[${ref}]`, text: ref }],
      );
      const [found] = await tx.keywordCandidates({ boardId, query: ref, mode: 'all_time' }, 1);
      return found?.itemId ?? -1;
    });

  beforeAll(async () => {
    const created = await createTestDatabase('choice_usage');
    drop = created.drop;
    store = new PgStore(created.database.db);
    boardId = await store.transaction(async (tx) => {
      const board = await tx.insertBoard({ name: 'usage', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      return board.id;
    });
    choiceItem = await item('retrybackoffchoice', 'decision');
    planItem = await item('retrybackoffplan', 'glob_plan');
    choiceId = (
      await store.transaction((tx) =>
        tx.upsertDecision({
          boardId,
          itemId: choiceItem,
          globId: null,
          group: null,
          statement: 'retrybackoffchoice',
          quote: 'retry backoff is exponential',
          decidedBy: null,
          decidedAt: NOW,
          sourceKind: 'plan',
          sourceRef: 'artifact:s1t1:plan:',
          sourceLabel: 'plan',
          sourceUrl: null,
          createdAt: NOW,
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('counts each return once per choice, day and glob, and ignores items that are not choices', async () => {
    await store.transaction(async (tx) => {
      await tx.recordChoiceUsage(boardId, [choiceItem, planItem], 's1t1', '2026-10-11');
      await tx.recordChoiceUsage(boardId, [choiceItem], 's1t1', '2026-10-11');
      await tx.recordChoiceUsage(boardId, [choiceItem], 's1t2', '2026-10-11');
      await tx.recordChoiceUsage(boardId, [choiceItem], null, '2026-10-12');
      await tx.recordChoiceUsage(boardId, [], 's1t1', '2026-10-12');
    });
    const rows = await store.transaction((tx) => tx.listChoiceUsage(boardId, '2026-10-01'));
    expect(rows.sort((a, b) => a.day.localeCompare(b.day) || a.globId.localeCompare(b.globId))).toEqual([
      { decisionId: choiceId, day: '2026-10-11', globId: 's1t1', count: 2 },
      { decisionId: choiceId, day: '2026-10-11', globId: 's1t2', count: 1 },
      { decisionId: choiceId, day: '2026-10-12', globId: NO_GLOB, count: 1 },
    ]);
  });

  it('lists from a day on, prunes before a day, and goes with the choice', async () => {
    expect(await store.transaction((tx) => tx.listChoiceUsage(boardId, '2026-10-12'))).toHaveLength(1);
    await store.transaction((tx) => tx.pruneChoiceUsage(boardId, '2026-10-12'));
    expect(await store.transaction((tx) => tx.listChoiceUsage(boardId, '2000-01-01'))).toHaveLength(1);
    await store.transaction((tx) => tx.deleteDecision(choiceId));
    expect(await store.transaction((tx) => tx.listChoiceUsage(boardId, '2000-01-01'))).toEqual([]);
  });
});
