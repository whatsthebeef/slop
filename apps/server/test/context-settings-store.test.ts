import { DEFAULT_CONTEXT_SETTINGS } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const NOW = '2026-10-12T12:00:00.000Z';

/** Context settings and their history on real Postgres, on boards of their own. */
describe('context settings store', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;
  let otherId: number;

  const board = (name: string) =>
    store.transaction(async (tx) => (await tx.insertBoard({ name, repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] })).id);

  beforeAll(async () => {
    const created = await createTestDatabase('context_settings');
    drop = created.drop;
    store = new PgStore(created.database.db);
    boardId = await board('settings');
    otherId = await board('other');
  });
  afterAll(async () => {
    await drop();
  });

  it('gives the defaults when nothing is stored', async () => {
    expect(await store.transaction((tx) => tx.getContextSettings(boardId))).toEqual(DEFAULT_CONTEXT_SETTINGS);
  });

  it('stores a value per board, replaces it, clamps it on read and resets it', async () => {
    await store.transaction(async (tx) => {
      await tx.setContextSetting(boardId, 'discussion_weight', 0.7, NOW);
      await tx.setContextSetting(boardId, 'recency_half_life_days', 120, NOW);
      await tx.setContextSetting(boardId, 'discussion_weight', 0.75, NOW);
    });
    const settings = await store.transaction((tx) => tx.getContextSettings(boardId));
    expect(settings.discussion_weight).toBe(0.75);
    expect(settings.recency_half_life_days).toBe(120);
    expect((await store.transaction((tx) => tx.getContextSettings(otherId))).discussion_weight).toBe(DEFAULT_CONTEXT_SETTINGS.discussion_weight);

    await store.transaction((tx) => tx.setContextSetting(boardId, 'recency_half_life_days', 9000, NOW));
    expect((await store.transaction((tx) => tx.getContextSettings(boardId))).recency_half_life_days).toBe(365);

    await store.transaction((tx) => tx.resetContextSetting(boardId, 'discussion_weight'));
    expect((await store.transaction((tx) => tx.getContextSettings(boardId))).discussion_weight).toBe(0.6);
  });

  it('records changes and lists them newest first, per board', async () => {
    const first = await store.transaction((tx) =>
      tx.insertContextSettingChange({ boardId, at: '2026-10-01T00:00:00.000Z', key: 'discussion_weight', before: 0.6, after: 0.65, outcome: 'tuned', evidence: 'first' }),
    );
    await store.transaction((tx) =>
      tx.insertContextSettingChange({ boardId, at: '2026-10-08T00:00:00.000Z', key: 'discussion_weight', before: 0.65, after: 0.6, outcome: 'reset', evidence: 'second' }),
    );
    await store.transaction((tx) =>
      tx.insertContextSettingChange({ boardId: otherId, at: NOW, key: 'inbox_candidates', before: 8, after: 9, outcome: 'tuned', evidence: 'elsewhere' }),
    );
    expect(first).toMatchObject({ boardId, key: 'discussion_weight', before: 0.6, after: 0.65 });
    const listed = await store.transaction((tx) => tx.listContextSettingChanges(boardId));
    expect(listed.map((c) => c.evidence)).toEqual(['second', 'first']);
  });
});
