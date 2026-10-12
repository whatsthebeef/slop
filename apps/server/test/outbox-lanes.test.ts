import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Effect, GlobService } from '@slop/core';
import { laneOf, LLM_CLAIM_LEASE_MS } from '@slop/core';
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

  it('puts every effect kind in the default lane but the KB pipeline\'s steps, which go in llm', () => {
    expect(laneOf('start_deploy')).toBe('default');
    expect(laneOf('review_change')).toBe('default');
    expect(laneOf('kb_route')).toBe('llm');
    expect(laneOf('kb_draft')).toBe('llm');
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

  it('keeps a retry-later reason as the last error, or the error it had when there is none', async () => {
    const effect: Effect = { kind: 'refresh_base_checks', globId: 'board-7', boardId: 7 };
    const id = await insert(effect, 'default');
    await database.db.update(schema.outbox).set({ lastError: 'Bedrock is down' }).where(eq(schema.outbox.id, id));
    const reasons: (string | undefined)[] = [undefined, 'AI unavailable: AWS sign-in expired'];
    const executors: Partial<Record<Effect['kind'], Executor>> = {
      refresh_base_checks: () => Promise.resolve({ state: 'pending', retryAfterMs: 60_000, reason: reasons.shift() }),
    };
    const runner = new OutboxRunner(database.db, deps, executors, () => undefined);
    await runner.drain(effect.globId);
    expect(await row(id)).toMatchObject({ state: 'pending', attempts: 0, lastError: 'Bedrock is down' });
    await database.db.update(schema.outbox).set({ runAfter: new Date() }).where(eq(schema.outbox.id, id));
    await runner.drain(effect.globId);
    expect(await row(id)).toMatchObject({ state: 'pending', attempts: 0, lastError: 'AI unavailable: AWS sign-in expired' });
  });

  it('gives up on an llm-lane job after three attempts (default: eight), and tells onSettled when a job ends or its error changes', async () => {
    const effect: Effect = { kind: 'kb_route', globId: 's9k1' };
    const id = await insert(effect, 'llm');
    const settled: Effect[] = [];
    const executors: Partial<Record<Effect['kind'], Executor>> = { kb_route: () => Promise.reject(new Error('Unusable answer')) };
    const runner = new OutboxRunner(database.db, deps, executors, () => undefined, 'llm', (e) => settled.push(e));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await runner.drain(effect.globId);
      await database.db.update(schema.outbox).set({ runAfter: new Date() }).where(eq(schema.outbox.id, id));
    }
    expect(await row(id)).toMatchObject({ state: 'failed', attempts: 3, lastError: 'Unusable answer' });
    // Each failed attempt is news (the count changed); the job had no glob and no generation and still ran.
    expect(settled).toEqual([effect, effect, effect]);

    const waiting: Effect = { kind: 'kb_draft', globId: 's9k2' };
    const waitingId = await insert(waiting, 'llm');
    const heard: Effect[] = [];
    const waits = new OutboxRunner(
      database.db,
      deps,
      { kb_draft: () => Promise.resolve({ state: 'pending', retryAfterMs: 60_000, reason: 'AI unavailable: no access' }) },
      () => undefined,
      'llm',
      (e) => heard.push(e),
    );
    // A wait that repeats its reason is no news: only the first is heard.
    for (let probe = 0; probe < 3; probe++) {
      await waits.drain(waiting.globId);
      await database.db.update(schema.outbox).set({ runAfter: new Date() }).where(eq(schema.outbox.id, waitingId));
    }
    expect(await row(waitingId)).toMatchObject({ state: 'pending', attempts: 0, lastError: 'AI unavailable: no access' });
    expect(heard).toEqual([waiting]);
  });

  it('holds a claimed llm-lane job for the lease, then backs a thrown failure off by the lane\'s backoff (30 s), one attempt spent', async () => {
    const effect: Effect = { kind: 'kb_route', globId: 's9k7' };
    const id = await insert(effect, 'llm');
    const seen: { leased: Date | null } = { leased: null };
    const executors: Partial<Record<Effect['kind'], Executor>> = {
      kb_route: async () => {
        // Inside the step: the claim holds the job for the lane's lease.
        seen.leased = (await row(id)).runAfter;
        throw new Error('Unusable answer');
      },
    };
    const before = Date.now();
    await new OutboxRunner(database.db, deps, executors, () => undefined, 'llm').drain(effect.globId);
    const after = await row(id);
    expect(seen.leased).not.toBeNull();
    expect((seen.leased ?? new Date(0)).getTime()).toBeGreaterThanOrEqual(before + LLM_CLAIM_LEASE_MS - 1_000);
    expect(after).toMatchObject({ state: 'pending', attempts: 1, lastError: 'Unusable answer' });
    expect(after.runAfter.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(after.runAfter.getTime()).toBeLessThan(Date.now() + 31_000);
  });
});
