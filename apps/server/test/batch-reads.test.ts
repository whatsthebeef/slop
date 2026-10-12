import type { Artifact, Effect } from '@slop/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const NOW = '2026-10-05T12:00:00.000Z';

describe('batch reads for many globs', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('batchreads'));
    store = new PgStore(database.db);
  });

  afterAll(() => drop());

  const artifact = (globId: string, kind: Artifact['kind'], label: string, content: string): Omit<Artifact, 'id' | 'version'> => ({
    globId,
    kind,
    label,
    content,
    link: null,
    commitSha: null,
    provenance: { by: 'human', actor: 'dev@example.com', runId: null, agentSetVersion: null },
    createdAt: NOW,
  });

  it('returns the latest version of each artifact per glob, kind and label, of the asked globs and kinds only', async () => {
    await store.transaction(async (tx) => {
      await tx.insertArtifact(artifact('s1k1', 'plan', '', 'plan v1'));
      await tx.insertArtifact(artifact('s1k1', 'plan', '', 'plan v2'));
      await tx.insertArtifact(artifact('s1k1', 'draft', '', 'draft v1'));
      await tx.insertArtifact(artifact('s1k1', 'attachment', 'evidence:s1k4', 'evidence a'));
      await tx.insertArtifact(artifact('s1k1', 'attachment', 'evidence:s1k5', 'evidence b'));
      await tx.insertArtifact(artifact('s1k2', 'plan', '', 'other plan'));
      await tx.insertArtifact(artifact('s1k3', 'plan', '', 'not asked'));
    });
    const latest = await store.transaction((tx) => tx.latestArtifacts(['s1k1', 's1k2'], ['plan', 'attachment']));
    expect(latest.map((a) => [a.globId, a.kind, a.label, a.version, a.content]).sort()).toEqual(
      [
        ['s1k1', 'attachment', 'evidence:s1k4', 1, 'evidence a'],
        ['s1k1', 'attachment', 'evidence:s1k5', 1, 'evidence b'],
        ['s1k1', 'plan', '', 2, 'plan v2'],
        ['s1k2', 'plan', '', 1, 'other plan'],
      ].sort(),
    );
    expect(await store.transaction((tx) => tx.latestArtifacts([], ['plan']))).toEqual([]);
  });

  it('returns the newest outbox job per glob and kind, in any state, with its attempts and last error', async () => {
    const insert = async (effect: Effect, patch: Partial<typeof schema.outbox.$inferInsert> = {}) => {
      const [row] = await database.db.insert(schema.outbox).values({ kind: effect.kind, globId: effect.globId, effect, ...patch }).returning();
      if (row === undefined) throw new Error('insert failed');
      return row.id;
    };
    const runAfter = new Date('2026-10-05T12:05:00.000Z');
    await insert({ kind: 'reconcile_pr', globId: 's2t1', generation: 1 }, { state: 'failed', attempts: 8, lastError: 'old' });
    const newest = await insert({ kind: 'reconcile_pr', globId: 's2t1', generation: 1 }, { attempts: 2, lastError: 'busy', runAfter });
    const done = await insert({ kind: 'refresh_checks', globId: 's2t1', generation: 1 }, { state: 'done' });
    await insert({ kind: 'reconcile_pr', globId: 's2t9', generation: 1 });
    const jobs = await store.transaction((tx) => tx.latestOutboxJobs(['s2t1'], ['reconcile_pr', 'refresh_checks']));
    expect(jobs.sort((a, b) => a.id - b.id)).toEqual([
      { id: newest, globId: 's2t1', kind: 'reconcile_pr', state: 'pending', attempts: 2, lastError: 'busy', runAfter: runAfter.toISOString() },
      { id: done, globId: 's2t1', kind: 'refresh_checks', state: 'done', attempts: 0, lastError: null, runAfter: expect.any(String) as string },
    ]);
    const [row] = await database.db.select().from(schema.outbox).where(eq(schema.outbox.id, newest));
    expect(row?.state).toBe('pending');
  });
});
