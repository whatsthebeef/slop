import { readFile } from 'node:fs/promises';
import { FakeEmbedder, GlobService, vectorOf } from '@slop/core';
import type { Candidate, NewKnowledgeItem, SearchQuery, SourceType } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { PgStore, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

/** The search store on real Postgres with pgvector and pg_trgm (`pgvector/pgvector:pg17`, as compose and CI use). */
describe('search store', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let url: string;
  let store: PgStore;
  let globs: GlobService;
  let boardId: number;
  let otherBoardId: number;

  beforeAll(async () => {
    ({ database, drop, url } = await createTestDatabase('search_store'));
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const make = (name: string) =>
        tx.insertBoard({ name, repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      boardId = (await make('search')).id;
      otherBoardId = (await make('other')).id;
      await tx.upsertMember({ boardId, email: DEV, role: 'admin' });
    });
  });

  afterAll(async () => {
    await drop();
  });

  const count = async (table: typeof schema.chunks | typeof schema.knowledgeItems) =>
    (await database.db.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n ?? 0;

  let refs = 0;
  const item = (patch: Partial<NewKnowledgeItem> = {}): NewKnowledgeItem => ({
    boardId,
    sourceType: 'glob_plan',
    externalRef: `ref:${String(++refs)}`,
    title: 'Sync retry design',
    occurredAt: '2026-09-14T08:00:00.000Z',
    authority: 'approved_plan',
    status: 'active',
    supersededBy: null,
    globIds: ['s1t1'],
    globGroup: null,
    externalUrl: '/boards/1?glob=s1t1',
    contentHash: 'h1',
    state: 'ready',
    ...patch,
  });
  const chunk = (position: number, text: string) => ({ position, header: '[Plan · 2026-09-14 · "Sync retry design"]', text });
  const put = (i: NewKnowledgeItem, ...texts: string[]) =>
    store.transaction((tx) => tx.replaceItem(i, texts.map((t, p) => chunk(p, t))));
  const embedAll = async () => {
    const pending = await store.transaction((tx) => tx.chunksToEmbed(1000));
    await store.transaction((tx) => tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: vectorOf(`${c.header}\n${c.text}`) }))));
    return pending.length;
  };
  const query = (q: string, patch: Partial<SearchQuery> = {}): SearchQuery => ({ boardId, query: q, mode: 'current', ...patch });
  const keyword = (q: SearchQuery) => store.transaction((tx) => tx.keywordCandidates(q, 20));
  const titles = (candidates: readonly Candidate[]) => candidates.map((c) => c.title);

  it('applies its migration twice without error', async () => {
    const folder = new URL('../drizzle', import.meta.url).pathname;
    // The migrator skips a recorded migration, so run the file's statements again by hand: they must be idempotent.
    const statements = (await readFile(`${folder}/0023_search_store.sql`, 'utf8')).split('--> statement-breakpoint');
    for (const statement of statements) await database.db.execute(sql.raw(statement));
    await runMigrations(url, folder);
    expect(await count(schema.knowledgeItems)).toBeGreaterThanOrEqual(0);
  });

  it('upserts an item by board and ref, replaces its chunks, and reports hashes', async () => {
    const a = item({ externalRef: 'upsert:a' });
    await put(a, 'first chunk about upserts', 'second chunk about upserts');
    expect((await store.transaction((tx) => tx.itemHashes(boardId))).get('upsert:a')).toBe('h1');
    const before = await count(schema.chunks);

    await put({ ...a, contentHash: 'h2', title: 'Renamed' }, 'only chunk now');
    expect((await store.transaction((tx) => tx.itemHashes(boardId))).get('upsert:a')).toBe('h2');
    expect(await count(schema.chunks)).toBe(before - 1);
    const hits = await keyword(query('upserts'));
    expect(hits).toEqual([]);
    expect(titles(await keyword(query('chunk')))).toContain('Renamed');
    // Another board has no such ref.
    expect((await store.transaction((tx) => tx.itemHashes(otherBoardId))).has('upsert:a')).toBe(false);
  });

  it('deletes an item and its chunks when its source is gone, per board and source type', async () => {
    const keep = item({ externalRef: 'gone:keep', sourceType: 'kb_doc' });
    const drop1 = item({ externalRef: 'gone:drop', sourceType: 'kb_doc' });
    const otherType = item({ externalRef: 'gone:other-type', sourceType: 'postplan' });
    const otherBoard = item({ externalRef: 'gone:drop', sourceType: 'kb_doc', boardId: otherBoardId });
    for (const i of [keep, drop1, otherType, otherBoard]) await put(i, 'text that goes');
    const chunksBefore = await count(schema.chunks);
    const removed = await store.transaction((tx) => tx.deleteItemsNotIn(boardId, 'kb_doc', new Set(['gone:keep'])));
    expect(removed).toBe(1);
    expect(await count(schema.chunks)).toBe(chunksBefore - 1);
    const hashes = await store.transaction((tx) => tx.itemHashes(boardId));
    expect(hashes.has('gone:keep') && hashes.has('gone:other-type') && !hashes.has('gone:drop')).toBe(true);
    expect((await store.transaction((tx) => tx.itemHashes(otherBoardId))).has('gone:drop')).toBe(true);
    // An empty set removes every item of the type on the board.
    expect(await store.transaction((tx) => tx.deleteItemsNotIn(boardId, 'kb_doc', new Set()))).toBe(1);
  });

  describe('keyword search', () => {
    beforeAll(async () => {
      await put(item({ externalRef: 'kw:stem', title: 'Stemming' }), 'The sync job retries failed requests with backoff.');
      await put(item({ externalRef: 'kw:path', title: 'Path', sourceType: 'change_summary' }), 'Files: apps/server/src/jobs/outbox.ts, apps/server/src/db/store.ts\n\nTightened the outbox.');
      await put(item({ externalRef: 'kw:camel', title: 'Identifier' }), 'Rename getUserProfileById to loadProfile.');
      await put(item({ externalRef: 'kw:other', title: 'Other board', boardId: otherBoardId }), 'The sync job retries failed requests with backoff.');
    });

    it('matches word forms with relevance in [0, 1], ranked, on one board only', async () => {
      const hits = await keyword(query('retry failing request'));
      expect(titles(hits)).toEqual(['Stemming']);
      expect(hits[0]?.relevance).toBeGreaterThan(0);
      expect(hits[0]?.relevance).toBeLessThanOrEqual(1);
      expect(hits[0]).toMatchObject({ sourceType: 'glob_plan', authority: 'approved_plan', status: 'active', supersededByTitle: null });
    });

    it('matches a file path and an identifier the full-text search would split', async () => {
      expect(titles(await keyword(query('apps/server/src/jobs/outbox.ts')))).toEqual(['Path']);
      expect(titles(await keyword(query('getUserProfileById')))).toEqual(['Identifier']);
    });

    it('returns nothing for words that are nowhere', async () => {
      expect(await keyword(query('zebra quartz'))).toEqual([]);
    });

    it('treats the query as text, not as a pattern', async () => {
      expect(await keyword(query("100% _ \\ ' ; --"))).toEqual([]);
    });
  });

  describe('filters', () => {
    beforeAll(async () => {
      const base = { sourceType: 'glob_plan' as SourceType };
      await put(item({ ...base, externalRef: 'f:old', title: 'Old', occurredAt: '2026-01-10T00:00:00.000Z', globIds: ['s1t1'], globGroup: 'billing' }), 'filterword alpha');
      await put(item({ ...base, externalRef: 'f:mid', title: 'Mid', occurredAt: '2026-06-10T00:00:00.000Z', globIds: ['s1t2'], globGroup: 'billing' }), 'filterword beta');
      await put(item({ ...base, externalRef: 'f:new', title: 'New', occurredAt: '2026-09-10T00:00:00.000Z', globIds: ['s1t1', 's1t3'], globGroup: 'sync', sourceType: 'postplan' }), 'filterword gamma');
      await put(item({ ...base, externalRef: 'f:foreign', title: 'Foreign', boardId: otherBoardId, globIds: ['s1t1'], globGroup: 'billing' }), 'filterword delta');
    });

    it('limits by date range (inclusive), glob, group and source types, always within the board', async () => {
      const all = async (patch: Partial<SearchQuery>) => titles(await keyword(query('filterword', patch))).sort();
      expect(await all({})).toEqual(['Mid', 'New', 'Old']);
      expect(await all({ from: '2026-06-10T00:00:00.000Z' })).toEqual(['Mid', 'New']);
      expect(await all({ to: '2026-06-10T00:00:00.000Z' })).toEqual(['Mid', 'Old']);
      expect(await all({ from: '2026-02-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' })).toEqual(['Mid']);
      expect(await all({ globId: 's1t1' })).toEqual(['New', 'Old']);
      expect(await all({ globId: 's1t3' })).toEqual(['New']);
      expect(await all({ group: 'billing' })).toEqual(['Mid', 'Old']);
      expect(await all({ sourceTypes: ['postplan'] })).toEqual(['New']);
      expect(await all({ sourceTypes: [] })).toEqual(['Mid', 'New', 'Old']);
      expect(await all({ globId: 's1t1', group: 'sync', sourceTypes: ['postplan'] })).toEqual(['New']);
    });

    it('never returns another board, whatever the glob or group filter says', async () => {
      const foreign = await store.transaction((tx) => tx.keywordCandidates({ boardId: otherBoardId, query: 'filterword', mode: 'current', globId: 's1t2' }, 20));
      expect(foreign).toEqual([]);
      const own = await store.transaction((tx) => tx.keywordCandidates({ boardId: otherBoardId, query: 'filterword', mode: 'current' }, 20));
      expect(titles(own)).toEqual(['Foreign']);
    });

    it('applies the same filters to vector search', async () => {
      await embedAll();
      const vec = vectorOf('filterword');
      const near = async (patch: Partial<SearchQuery>) => titles(await store.transaction((tx) => tx.vectorCandidates(query('filterword', patch), vec, 20))).sort();
      expect(await near({})).toEqual(expect.arrayContaining(['Mid', 'New', 'Old']));
      expect(await near({ from: '2026-06-10T00:00:00.000Z', globId: 's1t1' })).toEqual(['New']);
      expect(await near({ group: 'sync' })).toEqual(['New']);
      expect(await near({})).not.toContain('Foreign');
    });
  });

  describe('vector search', () => {
    it('orders by cosine similarity and skips chunks with no embedding yet', async () => {
      await put(item({ externalRef: 'v:billing', title: 'Billing' }), 'invoices billing payments ledger');
      await put(item({ externalRef: 'v:sync', title: 'Sync' }), 'retries backoff queue worker');
      await put(item({ externalRef: 'v:pending', title: 'Pending' }), 'invoices billing payments ledger waiting');
      const pending = await store.transaction((tx) => tx.chunksToEmbed(1000));
      expect(pending.length).toBeGreaterThanOrEqual(3);
      // Embed all but the "Pending" item's chunk.
      const waiting = pending.find((c) => c.text.endsWith('waiting'));
      await store.transaction((tx) =>
        tx.setEmbeddings(pending.filter((c) => c.id !== waiting?.id).map((c) => ({ id: c.id, embedding: vectorOf(`${c.header}\n${c.text}`) }))),
      );

      const embedder = new FakeEmbedder();
      const [vec] = await embedder.embed(['billing invoices ledger']);
      const hits = await store.transaction((tx) => tx.vectorCandidates(query('billing invoices ledger', { sourceTypes: ['glob_plan'] }), vec ?? [], 5));
      expect(titles(hits)[0]).toBe('Billing');
      expect(titles(hits)).not.toContain('Pending');
      const relevances = hits.map((h) => h.relevance);
      expect(relevances).toEqual([...relevances].sort((a, b) => b - a));
      expect(relevances[0]).toBeGreaterThan(relevances[1] ?? 1);
      for (const r of relevances) expect(r).toBeGreaterThanOrEqual(0);
      expect(await store.transaction((tx) => tx.chunksToEmbed(1000))).toEqual([expect.objectContaining({ id: waiting?.id })]);
    });
  });

  describe('changes', () => {
    beforeAll(async () => {
      const change = (n: number, day: string, text: string) =>
        put(item({ externalRef: `change:sha${String(n)}`, sourceType: 'change_summary', authority: 'merged_code', title: `Change ${String(n)}`, occurredAt: `2026-09-${day}T00:00:00.000Z` }), text);
      await change(1, '01', 'Files: src/alpha/one.ts\n\nWhy one.');
      await change(2, '05', 'Files: src/beta/two.ts, src/alpha/three.ts\n\nWhy two.');
      await change(3, '09', 'Files: src/gamma/four.ts\n\nWhy zebrafish.');
      await put(item({ externalRef: 'change:not', title: 'Not a change', sourceType: 'postplan' }), 'Files: src/alpha/one.ts');
    });

    it('lists merged-change summaries newest first, only that source', async () => {
      const all = await store.transaction((tx) => tx.changeCandidates(query(''), 10));
      // Other tests keep their own change items on the board: look at this describe's.
      expect(titles(all).filter((t) => t.startsWith('Change '))).toEqual(['Change 3', 'Change 2', 'Change 1']);
      expect(all.every((c) => c.sourceType === 'change_summary' && c.relevance === 1)).toBe(true);
      expect(all.map((c) => c.occurredAt)).toEqual([...all.map((c) => c.occurredAt)].sort().reverse());
    });

    it('finds changes by path or words, within a date range', async () => {
      expect(titles(await store.transaction((tx) => tx.changeCandidates(query('src/alpha'), 10)))).toEqual(['Change 2', 'Change 1']);
      expect(titles(await store.transaction((tx) => tx.changeCandidates(query('src/alpha', { to: '2026-09-03T00:00:00.000Z' }), 10)))).toEqual(['Change 1']);
      expect(titles(await store.transaction((tx) => tx.changeCandidates(query('zebrafish'), 10)))).toEqual(['Change 3']);
    });
  });

  describe('status', () => {
    it('reports the title of the item that replaced a superseded one', async () => {
      await put(item({ externalRef: 's:new', title: 'New design' }), 'supersedeword new design');
      const newId = (await store.transaction((tx) => tx.keywordCandidates(query('supersedeword'), 5)))[0]?.itemId;
      expect(newId).toBeDefined();
      await put(item({ externalRef: 's:old', title: 'Old design', status: 'superseded', supersededBy: newId ?? null }), 'supersedeword old design');
      const hits = await keyword(query('supersedeword'));
      const old = hits.find((h) => h.title === 'Old design');
      expect(old).toMatchObject({ status: 'superseded', supersededByTitle: 'New design' });
      expect(hits.find((h) => h.title === 'New design')?.supersededByTitle).toBeNull();
    });
  });

  describe('summary queue', () => {
    it('hands out due pending items oldest first and records progress', async () => {
      await put(item({ externalRef: 'q:late', title: 'Late', state: 'pending_summary', occurredAt: '2026-09-02T00:00:00.000Z', sourceType: 'change_summary' }), 'late');
      await put(item({ externalRef: 'q:early', title: 'Early', state: 'pending_summary', occurredAt: '2026-09-01T00:00:00.000Z', sourceType: 'change_summary' }), 'early');
      const now = '2026-10-01T00:00:00.000Z';
      const first = await store.transaction((tx) => tx.nextItemToSummarise(now));
      expect(first).toMatchObject({ title: 'Early', state: 'pending_summary', attempts: 0, processAfter: null, lastError: null });
      await store.transaction((tx) => tx.setItemProgress(first?.id ?? 0, { attempts: 1, processAfter: '2026-10-01T00:05:00.000Z', lastError: 'waiting' }));
      expect((await store.transaction((tx) => tx.nextItemToSummarise(now)))?.title).toBe('Late');
      const later = await store.transaction((tx) => tx.nextItemToSummarise('2026-10-01T00:05:00.000Z'));
      expect(later?.title).toBe('Early');
      expect(later).toMatchObject({ attempts: 1, processAfter: '2026-10-01T00:05:00.000Z', lastError: 'waiting' });
      // Writing the item again (its summary arrived) resets the queue state.
      await put(item({ externalRef: 'q:early', title: 'Early', state: 'ready', sourceType: 'change_summary' }), 'early summary');
      expect((await store.transaction((tx) => tx.nextItemToSummarise('2027-01-01T00:00:00.000Z')))?.title).toBe('Late');
    });
  });

  it('deletes a glob\'s own items with it, and a learning it fed only loses the link', async () => {
    const created = await globs.create(DEV, {
      boardId,
      title: 'Doomed',
      summary: '',
      type: 'same',
      category: 'task',
      group: null,
      environment: null,
      autoTrigger: false,
      idempotencyKey: null,
    });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.id;
    await put(item({ externalRef: `del:plan`, sourceType: 'glob_plan', globIds: [id] }), 'doomed plan');
    await put(item({ externalRef: `del:change`, sourceType: 'change_summary', globIds: [id] }), 'doomed change');
    await put(item({ externalRef: `del:learning`, sourceType: 'learning', globIds: [id, 's1t9'] }), 'a learning');
    await put(item({ externalRef: `del:kb`, sourceType: 'kb_doc', globIds: [] }), 'a document');
    await store.transaction((tx) => tx.deleteGlob(id));
    const hashes = await store.transaction((tx) => tx.itemHashes(boardId));
    expect([hashes.has('del:plan'), hashes.has('del:change'), hashes.has('del:learning'), hashes.has('del:kb')]).toEqual([false, false, true, true]);
    const learning = await store.transaction((tx) => tx.keywordCandidates(query('learning'), 5));
    expect(learning.find((c) => c.title === 'Sync retry design')?.globIds).toContain('s1t9');
    expect(learning.flatMap((c) => c.globIds)).not.toContain(id);
  });

  it('lists the latest version of each artifact on a board, with content', async () => {
    const created = await globs.create(DEV, {
      boardId,
      title: 'Artifacts',
      summary: '',
      type: 'same',
      category: 'task',
      group: null,
      environment: null,
      autoTrigger: false,
      idempotencyKey: null,
    });
    if (!created.ok) throw new Error(created.error.message);
    const provenance = { by: 'human' as const, actor: DEV, runId: null, agentSetVersion: null };
    const add = (kind: 'plan' | 'attachment', label: string, content: string) =>
      store.transaction((tx) => tx.insertArtifact({ globId: created.value.id, kind, label, content, link: null, commitSha: null, provenance, createdAt: new Date().toISOString() }));
    await add('plan', '', 'v1');
    await add('plan', '', 'v2');
    await add('attachment', 'Notes', 'n1');
    const latest = (await store.transaction((tx) => tx.listLatestArtifacts(boardId))).filter((a) => a.globId === created.value.id);
    expect(latest.map((a) => `${a.kind}:${a.label}:${a.content}`).sort()).toEqual(['attachment:Notes:n1', 'plan::v2']);
    expect(await store.transaction((tx) => tx.listLatestArtifacts(otherBoardId))).toEqual([]);
  });
});
