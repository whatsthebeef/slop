import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Effect, GlobService } from '@slop/core';
import { laneOf } from '@slop/core';
import * as schema from '../src/db/schema.js';
import type { Database } from '../src/db/store.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import type { Executor } from '../src/jobs/outbox.js';
import { createTestDatabase } from './support/database.js';

const deps = { globs: {} as GlobService };
const slow: Effect = { kind: 'refresh_base_checks', globId: 'board-1', boardId: 1 };
const quick: Effect = { kind: 'recheck_overlaps', globId: 'board-2', boardId: 2 };

describe('outbox lanes', () => {
  let database: Database;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('outboxlanes'));
  });

  afterAll(() => drop());

  const insert = async (effect: Effect, lane: string) => {
    const [row] = await database.db.insert(schema.outbox).values({ kind: effect.kind, lane, globId: effect.globId, effect }).returning();
    if (row === undefined) throw new Error('insert failed');
    return row.id;
  };
  const row = async (id: number) => {
    const [found] = await database.db.select().from(schema.outbox).where(eq(schema.outbox.id, id));
    if (found === undefined) throw new Error('missing row');
    return found;
  };

  it('puts every effect kind in the default lane', () => {
    expect(laneOf('start_deploy')).toBe('default');
    expect(laneOf('review_change')).toBe('default');
  });

  it('a stuck llm-lane job does not delay a default-lane job', async () => {
    const stuck = await insert(slow, 'llm');
    const fast = await insert(quick, 'default');
    const executors: Partial<Record<Effect['kind'], Executor>> = {
      refresh_base_checks: () => new Promise(() => undefined),
      recheck_overlaps: () => Promise.resolve('done'),
    };
    const llm = new OutboxRunner(database.db, deps, executors, () => undefined, 'llm');
    const fastRunner = new OutboxRunner(database.db, deps, executors, () => undefined, 'default');
    void llm.drain();
    await fastRunner.drain();
    expect((await row(fast)).state).toBe('done');
    expect((await row(stuck)).state).toBe('pending');
  });

  it('retryAfterMs reschedules without spending an attempt', async () => {
    const id = await insert(slow, 'default');
    await database.db.update(schema.outbox).set({ attempts: 2 }).where(eq(schema.outbox.id, id));
    const executors: Partial<Record<Effect['kind'], Executor>> = {
      refresh_base_checks: () => Promise.resolve({ state: 'pending', retryAfterMs: 60_000 }),
    };
    const before = Date.now();
    await new OutboxRunner(database.db, deps, executors, () => undefined).drain();
    const after = await row(id);
    expect(after.state).toBe('pending');
    expect(after.attempts).toBe(2);
    expect(after.runAfter.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    expect(after.runAfter.getTime()).toBeLessThan(before + 65_000);
  });
});
