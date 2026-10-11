import { BoardService, DependencyLearningService } from '@slop/core';
import type { Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { FsCatalog } from '../src/catalog.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOW = '2026-10-11T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('Dependency rules in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let learning: DependencyLearningService;
  let boardId: number;

  beforeAll(async () => {
    const created = await createTestDatabase('dependency_rules');
    drop = created.drop;
    store = new PgStore(created.database.db);
    const notifier = { publish: () => undefined };
    const boards = new BoardService({ store, notifier });
    learning = new DependencyLearningService({
      store,
      notifier,
      clock: { now: () => NOW },
      catalog: new FsCatalog(new URL('../../../catalog', import.meta.url).pathname),
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });
  afterAll(async () => {
    await drop();
  });

  it('shows the catalog defaults for a new board, with nothing learned', async () => {
    const view = unwrap(await learning.view(DEV, boardId));
    const byPattern = new Map(view.rules.map((r) => [r.pattern, r]));
    expect(byPattern.get('**/pnpm-lock.yaml')).toMatchObject({ state: 'default', predicted: false });
    expect(byPattern.get('**/drizzle/**')).toMatchObject({ state: 'default', predicted: true, weight: 1 });
    expect(view.history).toEqual([]);
  });

  it('stores a learned weight, records each outcome once, and resets it', async () => {
    const change = { boardId, at: NOW, pattern: '**/drizzle/**', from: 1, to: 0.75, cause: 'clean_overlap' as const, globId: 's1t1', evidence: 'merged cleanly' };
    await store.transaction(async (tx) => {
      expect(await tx.insertDependencyRuleChange(change)).toBe(true);
      expect(await tx.insertDependencyRuleChange(change)).toBe(false);
      await tx.upsertDependencyRule({ boardId, pattern: '**/drizzle/**', weight: 0.75, cleanCount: 1, conflictCount: 0, updatedAt: NOW });
      await tx.upsertDependencyRule({ boardId, pattern: '**/drizzle/**', weight: 0.5, cleanCount: 2, conflictCount: 0, updatedAt: NOW });
    });
    const learned = unwrap(await learning.view(DEV, boardId));
    expect(learned.rules.find((r) => r.pattern === '**/drizzle/**')).toMatchObject({ state: 'learned', weight: 0.5, cleanCount: 2, defaultWeight: 1 });
    expect(learned.history).toHaveLength(1);

    expect((await learning.reset(DEV, boardId)).ok).toBe(false);
    unwrap(await learning.reset(ADMIN, boardId, '**/drizzle/**'));
    unwrap(await learning.reset(ADMIN, boardId));
    const reset = unwrap(await learning.view(DEV, boardId));
    expect(reset.rules.find((r) => r.pattern === '**/drizzle/**')).toMatchObject({ state: 'default', weight: 1 });
    expect(reset.history.map((h) => h.cause)).toEqual(['reset', 'clean_overlap']);
  });
});
