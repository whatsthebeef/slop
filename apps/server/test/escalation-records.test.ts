import { BoardService, EscalationLearningService } from '@slop/core';
import type { Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const NOW = '2026-10-11T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('Escalation records in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;

  beforeAll(async () => {
    const created = await createTestDatabase('escalation_records');
    drop = created.drop;
    store = new PgStore(created.database.db);
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier: { publish: () => undefined } }).create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('records an outcome once per glob and outcome, and a reset moves the criteria back to the defaults', async () => {
    const record = { boardId, at: NOW, globId: 's1t1', criterion: 'risk_area', outcome: 'unnecessary', weight: -1, cause: 'Approved unchanged' } as const;
    expect(await store.transaction((tx) => tx.insertEscalationRecord(record))).toBe(true);
    expect(await store.transaction((tx) => tx.insertEscalationRecord({ ...record, cause: 'again' }))).toBe(false);
    expect(await store.transaction((tx) => tx.insertEscalationRecord({ ...record, outcome: 'justified', weight: 1 }))).toBe(true);
    const service = new EscalationLearningService({ store, clock: { now: () => '2026-10-12T00:00:00.000Z' } });
    const before = unwrap(await service.view(ADMIN, boardId));
    expect(before.history).toHaveLength(2);
    expect(before.criteria.find((c) => c.criterion === 'risk_area')).toMatchObject({ score: 0, unnecessary: 1, justified: 1 });
    const after = unwrap(await service.reset(ADMIN, boardId));
    expect(after.history).toHaveLength(3);
    expect(after.history[0]).toMatchObject({ outcome: 'reset', globId: null });
    expect(after.criteria.find((c) => c.criterion === 'risk_area')).toMatchObject({ unnecessary: 0, justified: 0 });
  });
});
