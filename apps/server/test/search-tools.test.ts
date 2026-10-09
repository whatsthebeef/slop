import { FakeEmbedder, LlmUnavailable, SearchService, vectorOf } from '@slop/core';
import type { NewKnowledgeItem } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PgStore } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountSearch } from '../src/http/search.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const STRANGER = 'stranger@example.com';
const NOW = new Date().toISOString();
const DAY = 86_400_000;

const hitsOf = z.array(z.object({ citation: z.object({ title: z.string(), source: z.string(), link: z.string().nullable() }), label: z.string().nullable() }));
const errorOf = z.object({ code: z.string() });

/** The search tools and the board search route on real Postgres (pgvector) with a fake embedder. */
describe('search tools and route', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let embedder: FakeEmbedder;
  let search: SearchService;
  let boardId: number;
  let otherBoardId: number;
  let app: Hono<Env>;

  const put = async (board: number, ref: string, text: string, patch: Partial<NewKnowledgeItem> = {}) => {
    const item: NewKnowledgeItem = {
      boardId: board,
      sourceType: 'glob_plan',
      externalRef: ref,
      title: ref,
      occurredAt: NOW,
      authority: 'approved_plan',
      status: 'active',
      supersededBy: null,
      globIds: [],
      globGroup: null,
      externalUrl: `/boards/${String(board)}?glob=${ref}`,
      contentHash: ref,
      state: 'ready',
      ...patch,
    };
    await store.transaction(async (tx) => {
      await tx.replaceItem(item, [{ position: 0, header: `[${ref}]`, text }]);
      const pending = await tx.chunksToEmbed(1000);
      await tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: vectorOf(c.text) })));
    });
  };

  const call = async (email: string, name: string, args: Record<string, unknown>) => {
    const server = buildServer({ search } as unknown as McpDeps, email, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({ name, arguments: args });
    await client.close();
    const text = z.array(z.object({ text: z.string() })).parse(result.content)[0]?.text ?? 'null';
    return { isError: result.isError === true, text };
  };
  const titles = async (email: string, name: string, args: Record<string, unknown>) => {
    const { isError, text } = await call(email, name, args);
    if (isError) throw new Error(text);
    return hitsOf.parse(JSON.parse(text)).map((h) => h.citation.title);
  };
  const route = (query: string, email = DEV) => app.request(`/api/boards/${String(boardId)}/search?${query}`, { headers: { 'x-test-email': email } });

  beforeAll(async () => {
    const created = await createTestDatabase('search_tools');
    drop = created.drop;
    store = new PgStore(created.database.db);
    embedder = new FakeEmbedder();
    search = new SearchService({ store, clock: { now: () => new Date().toISOString() }, embedder });
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? DEV);
      await next();
    });
    mountSearch(app, { search });
    [boardId, otherBoardId] = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: STRANGER, name: 'Stranger', active: true });
      const insert = (name: string) =>
        tx.insertBoard({ name, repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      const mine = await insert('mine');
      const theirs = await insert('theirs');
      await tx.upsertMember({ boardId: mine.id, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId: theirs.id, email: STRANGER, role: 'dev' });
      return [mine.id, theirs.id];
    });
    await put(boardId, 'retries', 'Retry failed syncs with exponential backoff', { globIds: ['s1t1'], globGroup: 'sync' });
    await put(boardId, 'old-retries', 'Retry failed syncs with exponential backoff', { occurredAt: new Date(Date.now() - 400 * DAY).toISOString() });
    await put(boardId, 'invoices', 'Invoices are rendered nightly', { sourceType: 'kb_doc' });
    await put(boardId, 'change-a', 'Files: src/sync/retry.ts\nRetries now back off.', { sourceType: 'change_summary', authority: 'merged_code' });
    await put(otherBoardId, 'secret', 'Retry failed syncs with exponential backoff', { globIds: ['s2t1'], globGroup: 'sync' });
  });

  afterAll(async () => {
    await drop();
  });

  it('search_text returns cited, ranked chunks from the board only', async () => {
    const { text } = await call(DEV, 'search_text', { board: boardId, query: 'exponential backoff' });
    const hits = hitsOf.parse(JSON.parse(text));
    expect(hits.map((h) => h.citation.title)).toEqual(['retries', 'old-retries']);
    expect(hits[0]?.citation).toMatchObject({ source: 'glob_plan', link: `/boards/${String(boardId)}?glob=retries` });
  });

  it('search_text filters by glob, group, source type and date range', async () => {
    expect(await titles(DEV, 'search_text', { board: boardId, query: 'retry', glob: 's1t1' })).toEqual(['retries']);
    expect(await titles(DEV, 'search_text', { board: boardId, query: 'retry', group: 'sync' })).toEqual(['retries']);
    expect(await titles(DEV, 'search_text', { board: boardId, query: 'invoices', sourceTypes: ['kb_doc'] })).toEqual(['invoices']);
    const from = new Date(Date.now() - 30 * DAY).toISOString();
    expect(await titles(DEV, 'search_text', { board: boardId, query: 'backoff', from })).toEqual(['retries']);
    expect(await titles(DEV, 'search_text', { board: boardId, query: 'backoff', mode: 'all_time' })).toHaveLength(2);
  });

  it('search_semantic ranks by meaning and returns llm_unavailable while the embedder is down', async () => {
    expect((await titles(DEV, 'search_semantic', { board: boardId, query: 'exponential backoff retry' }))[0]).toMatch(/retries/);
    embedder.unavailable = new LlmUnavailable('AWS sign-in expired', 'Sign in again');
    try {
      const down = await call(DEV, 'search_semantic', { board: boardId, query: 'retry' });
      expect(down.isError).toBe(true);
      expect(errorOf.parse(JSON.parse(down.text)).code).toBe('llm_unavailable');
      expect((await titles(DEV, 'search_text', { board: boardId, query: 'retry' })).length).toBeGreaterThan(0);
    } finally {
      embedder.unavailable = null;
    }
  });

  it('search_changes finds merged changes by query or path and needs one of them', async () => {
    expect(await titles(DEV, 'search_changes', { board: boardId, path: 'src/sync/retry.ts' })).toEqual(['change-a']);
    expect(await titles(DEV, 'search_changes', { board: boardId, query: 'back off' })).toEqual(['change-a']);
    const neither = await call(DEV, 'search_changes', { board: boardId });
    expect(neither.isError).toBe(true);
    expect(errorOf.parse(JSON.parse(neither.text)).code).toBe('invalid_input');
  });

  it('refuses a non-member on each tool and never leaks the other board through a glob filter', async () => {
    for (const [name, args] of [
      ['search_text', { board: boardId, query: 'retry' }],
      ['search_semantic', { board: boardId, query: 'retry' }],
      ['search_changes', { board: boardId, query: 'retry' }],
    ] as const) {
      const result = await call(STRANGER, name, args);
      expect(result.isError, name).toBe(true);
      expect(errorOf.parse(JSON.parse(result.text)).code, name).toBe('forbidden');
    }
    expect(await titles(DEV, 'search_text', { board: boardId, query: 'retry', glob: 's2t1' })).toEqual([]);
    expect(await titles(DEV, 'search_text', { board: boardId, query: 'retry', group: 'sync' })).not.toContain('secret');
  });

  it('GET /api/boards/:b/search fuses results, honours history, and refuses non-members', async () => {
    const ok = await route('q=exponential%20backoff');
    expect(ok.status).toBe(200);
    const body = z.object({ value: z.object({ semantic: z.string(), hits: hitsOf }) }).parse(await ok.json());
    expect(body.value.semantic).toBe('ok');
    expect(body.value.hits.map((h) => h.citation.title)[0]).toBe('retries');
    expect(body.value.hits.map((h) => h.citation.title)).not.toContain('secret');

    embedder.unavailable = new LlmUnavailable('down', 'later');
    try {
      const fallback = z.object({ value: z.object({ semantic: z.string() }) }).parse(await (await route('q=backoff&history=1')).json());
      expect(fallback.value.semantic).toBe('unavailable');
    } finally {
      embedder.unavailable = null;
    }

    expect((await route('q=retry', STRANGER)).status).toBe(403);
    expect((await route('q=')).status).toBe(422);
    expect((await route('q=retry&from=nonsense')).status).toBe(422);
  });
});
