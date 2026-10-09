import {
  ArtifactService,
  FakeEmbedder,
  GlobService,
  InboxPipeline,
  InboxService,
  LlmBusy,
  SearchIndexer,
  vectorOf,
} from '@slop/core';
import type { Llm } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountInbox } from '../src/http/inbox.js';
import { KbPipelineJob } from '../src/jobs/kb-pipeline.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const STRANGER = 'stranger@example.com';
const NOTES =
  'Standup.\n\nWe agreed the sync jobs will be pushed over a websocket connection instead of polling the server.';

/** Answers every summary call with a summary suggesting the glob the test names (or a busy Bedrock while `busy`). */
class ScriptedLlm implements Llm {
  calls = 0;
  busy = false;
  suggest = 's1t1';
  complete(): Promise<string> {
    this.calls++;
    if (this.busy) return Promise.reject(new LlmBusy());
    return Promise.resolve(
      JSON.stringify({
        title: 'Sync standup',
        kind: 'meeting',
        summary: 'Sync jobs move to a websocket.',
        suggestions: [{ globId: this.suggest, reason: 'Same topic.' }],
      }),
    );
  }
}

const itemsOf = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      status: z.string(),
      summary: z.string().nullable(),
      suggestions: z.array(z.object({ globId: z.string(), title: z.string(), reason: z.string() })),
    }),
  ),
});
const idOf = z.object({ id: z.number(), created: z.boolean() });

/** The board inbox on real Postgres, on a board of its own: routes, the MCP tool, the pipeline, and attaching into a glob's context. */
describe('inbox', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let inbox: InboxService;
  let pipeline: InboxPipeline;
  let artifacts: ArtifactService;
  let llm: ScriptedLlm;
  let embedder: FakeEmbedder;
  let app: Hono<Env>;
  let boardId: number;
  let otherBoardId: number;
  let first: string;
  let second: string;
  let foreign: string;

  const clock = { now: () => new Date().toISOString() };
  const notifier = { publish: () => undefined };
  const req = (path: string, email = DEV, body?: unknown) =>
    app.request(`/api/boards/${String(boardId)}/inbox${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-test-email': email, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const post = (path: string, body: unknown = {}, email = DEV) => req(path, email, body);
  const paste = async (body: Record<string, unknown>, email = DEV) => {
    const res = await post('', body, email);
    return { status: res.status, json: idOf.parse(await res.json()) };
  };
  const call = async (email: string, name: string, args: Record<string, unknown>) => {
    const server = buildServer({ inbox } as unknown as McpDeps, email, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({ name, arguments: args });
    await client.close();
    const text = z.array(z.object({ text: z.string() })).parse(result.content)[0]?.text ?? 'null';
    return { isError: result.isError === true, text };
  };
  const drain = async () => {
    for (let i = 0; i < 10; i++) if ((await pipeline.processNext()) === null) return;
  };
  const rowsOf = (table: typeof schema.inboxItems | typeof schema.inboxLinks) =>
    database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .then((r) => r[0]?.n ?? 0);

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('inbox'));
    store = new PgStore(database.db);
    llm = new ScriptedLlm();
    embedder = new FakeEmbedder();
    inbox = new InboxService({ store, clock, notifier });
    pipeline = new InboxPipeline({ store, clock, notifier, llm, embedder });
    artifacts = new ArtifactService({ store, clock, notifier });
    app = new Hono<Env>();
    app.use('/api/*', async (c, next) => {
      c.set('email', c.req.header('x-test-email') ?? DEV);
      await next();
    });
    mountInbox(app, { inbox });
    const globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    [boardId, otherBoardId] = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: STRANGER, name: 'Stranger', active: true });
      const insert = (name: string) =>
        tx.insertBoard({
          name,
          repo: null,
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [],
          sensitivePaths: [],
        });
      const mine = await insert('mine');
      const theirs = await insert('theirs');
      await tx.upsertMember({ boardId: mine.id, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId: theirs.id, email: STRANGER, role: 'dev' });
      return [mine.id, theirs.id];
    });
    const make = async (board: number, email: string, title: string) => {
      const made = await globs.create(email, {
        boardId: board,
        title,
        summary: title,
        type: 'same',
        category: 'task',
        group: 'sync',
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      });
      if (!made.ok) throw new Error(made.error.message);
      return made.value.id;
    };
    first = await make(boardId, DEV, 'Push sync jobs over a websocket');
    second = await make(boardId, DEV, 'Billing export');
    foreign = await make(otherBoardId, STRANGER, 'Elsewhere');
    // The glob's own search item, embedded, so the semantic arm has something to find.
    await new SearchIndexer({
      store,
      clock,
      embedder,
      changes: { mergedDiff: () => Promise.resolve(null) },
      llm,
    }).syncBoard(boardId);
    await store.transaction(async (tx) => {
      const pending = await tx.chunksToEmbed(1000);
      await tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: vectorOf(c.text) })));
    });
  });

  afterAll(async () => {
    await drop();
  });

  it('pastes through the route into a stored, searchable item; the same text again is the same item', async () => {
    const added = await paste({
      text: NOTES,
      title: 'Sync standup',
      sourceLabel: 'Standup',
      occurredAt: '2026-10-03',
    });
    expect(added.status).toBe(201);
    expect(added.json.created).toBe(true);
    const [row] = await database.db
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.id, added.json.id));
    expect(row).toMatchObject({
      boardId,
      title: 'Sync standup',
      source: 'paste',
      sourceLabel: 'Standup',
      sourceType: 'meeting',
      status: 'new',
      state: 'pending',
      version: 2,
    });
    expect(row?.occurredAt.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    const [item] = await database.db
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, row?.itemId ?? -1));
    expect(item).toMatchObject({
      sourceType: 'meeting',
      authority: 'discussion',
      externalRef: `inbox:${String(added.json.id)}`,
    });
    const found = await store.transaction((tx) =>
      tx.keywordCandidates(
        { boardId, query: 'websocket', mode: 'all_time', sourceTypes: ['meeting'] },
        10,
      ),
    );
    expect(found.length).toBeGreaterThan(0);
    const again = await paste({ text: `${NOTES}  ` });
    expect(again).toEqual({ status: 201, json: { id: added.json.id, created: false } });
    expect(await rowsOf(schema.inboxItems)).toBe(1);
  });

  it('summarises with suggestions on the board, waiting without spending attempts while Bedrock is busy', async () => {
    llm.busy = true;
    await drain();
    let list = itemsOf.parse(await (await req('')).json());
    expect(list.items[0]?.summary).toBeNull();
    const [waiting] = await database.db.select().from(schema.inboxItems);
    expect(waiting).toMatchObject({ state: 'pending', attempts: 0 });
    expect(waiting?.lastError).toContain('Bedrock busy');
    // Waiting is not retried until its time.
    const calls = llm.calls;
    await drain();
    expect(llm.calls).toBe(calls);
    await database.db.update(schema.inboxItems).set({ processAfter: null });
    llm.busy = false;
    await drain();
    list = itemsOf.parse(await (await req('')).json());
    expect(list.items[0]).toMatchObject({
      summary: 'Sync jobs move to a websocket.',
      suggestions: [
        { globId: first, title: 'Push sync jobs over a websocket', reason: 'Same topic.' },
      ],
    });
    // Done is done.
    const done = llm.calls;
    await drain();
    expect(llm.calls).toBe(done);
  });

  it('finds suggested globs by meaning when the paste has no title', async () => {
    const added = await paste({
      text: 'Push sync jobs over a websocket, as agreed in the review.',
    });
    llm.suggest = first;
    await drain();
    const [row] = await database.db
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.id, added.json.id));
    expect(row?.suggestions).toEqual([{ globId: first, reason: 'Same topic.' }]);
    expect(row?.title).toBe('Sync standup');
  });

  it('attaches to a glob: attachment, context and status; keeps and discards the others', async () => {
    const list = itemsOf.parse(await (await req('')).json());
    const standup = list.items.find(
      (i) => i.summary !== null && i.title === 'Sync standup' && i.status === 'new',
    );
    if (standup === undefined) throw new Error('no item');
    const attached = await post(`/${String(standup.id)}/attach`, { globIds: [first, second] });
    expect(attached.status).toBe(200);
    for (const g of [first, second]) {
      const [a] = await store.transaction((tx) => tx.listArtifacts(g, 'attachment'));
      expect(a).toMatchObject({
        label: 'From the inbox: Sync standup',
        link: `/boards/${String(boardId)}/inbox?item=${String(standup.id)}`,
        content: '',
      });
    }
    const context = await artifacts.context(DEV, first);
    if (!context.ok) throw new Error(context.error.message);
    expect(context.value.inbox).toHaveLength(1);
    expect(context.value.inbox[0]).toMatchObject({
      id: standup.id,
      summary: 'Sync jobs move to a websocket.',
      truncated: false,
    });
    expect(context.value.inbox[0]?.text).toContain('websocket');
    const [item] = await database.db
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.externalRef, `inbox:${String(standup.id)}`));
    expect(item?.globIds.sort()).toEqual([first, second].sort());
    // Re-attaching changes nothing; an attached item can't be discarded.
    await post(`/${String(standup.id)}/attach`, { globIds: [first] });
    expect(await rowsOf(schema.inboxLinks)).toBe(2);
    expect((await post(`/${String(standup.id)}/discard`)).status).toBe(422);

    const other = list.items.find((i) => i.id !== standup.id);
    if (other === undefined) throw new Error('no other item');
    expect((await post(`/${String(other.id)}/keep`)).status).toBe(200);
    expect((await post(`/${String(other.id)}/discard`)).status).toBe(200);
    expect(itemsOf.parse(await (await req('')).json()).items.map((i) => i.id)).toEqual([
      standup.id,
    ]);
    expect(
      itemsOf.parse(await (await req('?status=discarded')).json()).items.map((i) => i.id),
    ).toEqual([other.id]);
    const gone = await database.db
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.externalRef, `inbox:${String(other.id)}`));
    expect(gone).toHaveLength(0);

    // Deleting a glob drops its link; the item stays attached to the other, then becomes kept.
    await store.transaction((tx) => tx.deleteGlob(first));
    expect(await rowsOf(schema.inboxLinks)).toBe(1);
    await store.transaction((tx) => tx.deleteGlob(second));
    const [after] = await database.db
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.id, standup.id));
    expect(after?.status).toBe('kept');
    expect(await rowsOf(schema.inboxLinks)).toBe(0);
  });

  it('refuses non-members, other boards, and bad bodies', async () => {
    expect((await req('', STRANGER)).status).toBe(403);
    expect((await post('', { text: NOTES }, STRANGER)).status).toBe(403);
    expect((await post('', { text: '' })).status).toBe(422);
    expect((await post('', { text: 'x', occurredAt: 'soon' })).status).toBe(422);
    expect((await req('?status=bogus')).status).toBe(422);
    const added = await paste({ text: 'A note for the attach checks' });
    expect((await post(`/${String(added.json.id)}/attach`, { globIds: [foreign] })).status).toBe(
      404,
    );
    expect((await post(`/${String(added.json.id)}/attach`, { globIds: [] })).status).toBe(422);
    expect(
      (await post(`/${String(added.json.id)}/attach`, { globIds: [foreign] }, STRANGER)).status,
    ).toBe(403);
    expect((await req('/999999')).status).toBe(404);
    expect((await req('/abc')).status).toBe(422);
  });

  it('add_to_inbox puts text on its own board only', async () => {
    const added = await call(DEV, 'add_to_inbox', {
      board: boardId,
      text: 'Notes from the MCP tool',
      title: 'Tool notes',
      occurredAt: '2026-09-30',
      sourceLabel: 'Claude app',
    });
    expect(added.isError).toBe(false);
    const result = z
      .object({ id: z.number(), duplicate: z.boolean() })
      .parse(JSON.parse(added.text));
    expect(result.duplicate).toBe(false);
    const [row] = await database.db
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.id, result.id));
    expect(row).toMatchObject({
      boardId,
      title: 'Tool notes',
      sourceLabel: 'Claude app',
      createdBy: DEV,
    });
    const repeat = await call(DEV, 'add_to_inbox', {
      board: boardId,
      text: 'Notes from the MCP tool',
    });
    expect(JSON.parse(repeat.text)).toEqual({ id: result.id, duplicate: true });
    const stranger = await call(STRANGER, 'add_to_inbox', { board: boardId, text: 'Sneaky' });
    expect(stranger.isError).toBe(true);
    expect(stranger.text).toContain('forbidden');
    const bad = await call(DEV, 'add_to_inbox', {
      board: boardId,
      text: 'Dated badly',
      occurredAt: 'tomorrowish',
    });
    expect(bad.isError).toBe(true);
    expect((await store.transaction((tx) => tx.listInboxItems(otherBoardId))).length).toBe(0);
  });

  it('is drained by the job like the other pipelines', async () => {
    const added = await paste({ text: 'Drained by the job', title: 'Job note' });
    const job = new KbPipelineJob(
      pipeline,
      () => undefined,
      { isDown: () => false },
      Date.now,
      'inbox',
    );
    await job.drain();
    const [row] = await database.db
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.id, added.json.id));
    expect(row?.state).toBe('done');
  });

  it('imports through the route: archived, searchable, deduped by source key, updated on change', async () => {
    const item = (text: string, extra: Record<string, unknown> = {}) => ({
      source: 'jira',
      sourceKey: 'APP-1',
      title: 'APP-1: Sync store',
      text,
      sourceType: 'thread',
      occurredAt: '2025-03-01T10:00:00.000Z',
      ...extra,
    });
    const outcomes = async (items: unknown[], email = DEV) => {
      const res = await post('/import', { items }, email);
      return { status: res.status, json: (await res.json()) as unknown };
    };
    const first = await outcomes([item('APP-1: we chose Postgres over DynamoDB')]);
    expect(first).toEqual({
      status: 200,
      json: { outcomes: [{ sourceKey: 'APP-1', result: 'added' }] },
    });
    const [row] = await database.db
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.sourceKey, 'APP-1'));
    expect(row).toMatchObject({ boardId, source: 'jira', status: 'archived', state: 'done' });
    const found = await store.transaction((tx) =>
      tx.keywordCandidates({ boardId, query: 'DynamoDB', mode: 'all_time', sourceTypes: ['thread'] }, 10),
    );
    expect(found.map((f) => f.itemId)).toContain(row?.itemId);
    // Archived items are out of the default list and in the archived one.
    const live = itemsOf.parse(await (await req('')).json());
    expect(live.items.some((i) => i.id === row?.id)).toBe(false);
    const archived = itemsOf.parse(await (await req('?status=archived')).json());
    expect(archived.items.some((i) => i.id === row?.id)).toBe(true);

    expect((await outcomes([item('APP-1: we chose Postgres over DynamoDB')])).json).toEqual({
      outcomes: [{ sourceKey: 'APP-1', result: 'skipped' }],
    });
    expect((await outcomes([item('APP-1: we moved to long polling')])).json).toEqual({
      outcomes: [{ sourceKey: 'APP-1', result: 'updated' }],
    });
    const [changed] = await database.db
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.sourceKey, 'APP-1'));
    expect(changed?.id).toBe(row?.id);
    expect(changed?.text).toContain('long polling');
    expect((await outcomes([item('x')], STRANGER)).status).toBe(403);
    expect((await outcomes([])).status).toBe(422);
    expect((await outcomes([item('x', { source: 'slack' })])).status).toBe(422);
  });
});
