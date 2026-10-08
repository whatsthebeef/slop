import { FakeEmbedder, GlobService, SearchIndexer, UNPROCESSED } from '@slop/core';
import type { ChangeSource, KbItem, Llm } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const SHA = 'abcdef0123456789';

/** The indexer's backfill on real Postgres: running it again changes nothing. */
describe('search index backfill', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let indexer: SearchIndexer;
  let embedder: FakeEmbedder;
  let boardId: number;
  let globId: string;
  let llmCalls = 0;

  const llm: Llm = {
    complete: () => {
      llmCalls++;
      return Promise.resolve('It makes sync retries back off so the queue no longer stalls.');
    },
  };
  const changes: ChangeSource = { mergedDiff: () => Promise.resolve({ changedLines: 12, files: ['src/sync/retry.ts'] }) };

  const counts = async () => ({
    items: (await database.db.select({ n: sql<number>`count(*)::int` }).from(schema.knowledgeItems))[0]?.n ?? 0,
    chunks: (await database.db.select({ n: sql<number>`count(*)::int` }).from(schema.chunks))[0]?.n ?? 0,
    embedded: (await database.db.select({ n: sql<number>`count(*)::int` }).from(schema.chunks).where(sql`embedding is not null`))[0]?.n ?? 0,
  });

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('search_index'));
    store = new PgStore(database.db);
    embedder = new FakeEmbedder();
    indexer = new SearchIndexer({ store, clock: { now: () => new Date().toISOString() }, embedder, changes, llm });
    const globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({ name: 'search', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
      return board.id;
    });
    const created = await globs.create(DEV, {
      boardId,
      title: 'Sync retries',
      summary: 'Retry failed syncs with backoff.',
      type: 'same',
      category: 'task',
      group: 'sync',
      environment: null,
      autoTrigger: false,
      idempotencyKey: null,
    });
    if (!created.ok) throw new Error(created.error.message);
    globId = created.value.id;
    const provenance = { by: 'human' as const, actor: DEV, runId: null, agentSetVersion: null };
    await store.transaction(async (tx) => {
      const put = (kind: 'plan' | 'postplan' | 'attachment', label: string, content: string) =>
        tx.insertArtifact({ globId, kind, label, content, link: null, commitSha: null, provenance, createdAt: new Date().toISOString() });
      await put('plan', '', '## Approach\n\nRetry with exponential backoff.');
      await put('postplan', '', 'Shipped retries.');
      await put('attachment', 'notes', 'Design notes.');
      await tx.saveKnowledge({
        boardId,
        kind: 'doc',
        name: 'build_test_lint',
        area: 'build',
        audience: [],
        description: 'Build',
        content: '# Build\n\nRun pnpm test.',
        layer: 'file',
        version: 1,
        source: 'edit',
        updatedBy: DEV,
        updatedAt: new Date().toISOString(),
      });
      const learning: KbItem = {
        id: 's1k1',
        boardId,
        status: 'approved',
        type: 'gotcha',
        statement: 'Tests need pgvector.',
        evidence: 'The migration failed without it.',
        suggestedTarget: null,
        sourceGlobIds: [globId],
        source: 'submitted',
        signal: null,
        agentSetVersion: null,
        submittedBy: DEV,
        createdAt: new Date().toISOString(),
        decidedBy: DEV,
        decidedAt: new Date().toISOString(),
        decisionReason: null,
        document: null,
        outcome: null,
        ...UNPROCESSED,
        processing: 'drafted',
        version: 2,
      };
      await tx.insertKbItem(learning);
      await tx.appendEvents([{ type: 'Merged', globId, actor: null, at: new Date().toISOString(), data: { sha: SHA } }]);
    });
  });

  afterAll(async () => {
    await drop();
  });

  it('writes the same rows when run again', async () => {
    const first = await indexer.syncBoard(boardId);
    // Summary, plan, postplan, attachment, document, learning, and the queued change.
    expect(first).toEqual({ written: 6, removed: 0, queued: 1 });
    const before = await counts();
    expect(before.items).toBe(7);
    expect(before.embedded).toBe(0);

    expect(await indexer.syncBoard(boardId)).toEqual({ written: 0, removed: 0, queued: 0 });
    expect(await counts()).toEqual(before);
  });

  it('writes the change summary and embeds every chunk, still without rewriting anything on a later sync', async () => {
    while ((await indexer.processNext()) !== null) {
      // Drain: the change's summary first, then each batch of chunks.
    }
    expect(llmCalls).toBe(1);
    const done = await counts();
    expect(done.embedded).toBe(done.chunks);

    expect(await indexer.syncBoard(boardId)).toEqual({ written: 0, removed: 0, queued: 0 });
    expect(await counts()).toEqual(done);

    const found = await store.transaction((tx) => tx.changeCandidates({ boardId, query: 'src/sync/retry.ts', mode: 'current' }, 5));
    expect(found.map((c) => c.sourceType)).toEqual(['change_summary']);
    expect(found[0]?.text).toContain('Files: src/sync/retry.ts');
    expect(found[0]?.text).toContain('back off');
  });

  it('finds the indexed plan by keyword, and a deleted glob drops out on the next sync', async () => {
    const hits = await store.transaction((tx) => tx.keywordCandidates({ boardId, query: 'exponential backoff', mode: 'current' }, 5));
    expect(hits[0]).toMatchObject({ sourceType: 'glob_plan', globIds: [globId], globGroup: 'sync' });

    await store.transaction(async (tx) => {
      await tx.deleteGlob(globId);
      await tx.deleteEvents(globId);
    });
    const result = await indexer.syncBoard(boardId);
    // The learning (which keeps living without the glob) is written again, now without the deleted glob's link.
    expect(result.written).toBe(1);
    // Only the board document and the learning remain.
    expect((await counts()).items).toBe(2);
    expect(await indexer.syncBoard(boardId)).toEqual({ written: 0, removed: 0, queued: 0 });
  });
});
