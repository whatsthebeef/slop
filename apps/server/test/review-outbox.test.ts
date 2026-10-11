import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Effect } from '@slop/core';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const review = (sha: string, stage: 'pre_merge' | 'post_merge' = 'pre_merge', globId = 's1t1'): Effect => ({ kind: 'review_change', globId, generation: 1, stage, sha });

describe('review_change outbox jobs', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('reviewoutbox'));
    store = new PgStore(database.db);
  });

  afterAll(() => drop());

  const enqueue = (...effects: Effect[]) => store.transaction((tx) => tx.enqueueEffects(effects));
  const jobs = async (globId: string) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId)).orderBy(schema.outbox.id)).filter((r) => r.kind === 'review_change');
  const states = async (globId: string) => (await jobs(globId)).map((r) => [r.effect.kind === 'review_change' ? r.effect.sha : '', r.state]);

  it('queues one job per reviewed commit, however often the same commit is announced', async () => {
    await enqueue(review('aaa'), review('aaa'));
    await enqueue(review('aaa'));
    expect(await states('s1t1')).toEqual([['aaa', 'pending']]);
  });

  it('cancels the pending job of an older head when a newer push queues its own', async () => {
    await enqueue(review('bbb'));
    expect(await states('s1t1')).toEqual([['aaa', 'dropped'], ['bbb', 'pending']]);
  });

  it('keeps a finished review of a commit from running again', async () => {
    await database.db.update(schema.outbox).set({ state: 'done' }).where(eq(schema.outbox.globId, 's1t1'));
    await enqueue(review('bbb'));
    expect((await jobs('s1t1')).filter((r) => r.state === 'pending')).toHaveLength(0);
  });

  it('leaves other globs and the post-merge stage alone', async () => {
    await enqueue(review('ccc', 'pre_merge', 's1t2'));
    await enqueue(review('m1', 'post_merge', 's1t2'), review('ddd', 'pre_merge', 's1t2'));
    expect(await states('s1t2')).toEqual([['ccc', 'dropped'], ['m1', 'pending'], ['ddd', 'pending']]);
  });
});
