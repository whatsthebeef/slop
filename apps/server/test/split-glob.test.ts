import { ArtifactService, BoardService, GlobService } from '@slop/core';
import type { Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const ADMIN = 'admin@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface SplitBody {
  parts: { id: string; part?: number; version: number; title: string; after?: string[]; waiting?: boolean }[];
}

describe('split a glob (MCP and REST, on Postgres)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let client: Client;
  let app: Hono<Env>;
  let boardId: number;

  const make = async (title: string) =>
    unwrap(
      await globs.create(DEV, {
        boardId,
        title,
        summary: 'Everything',
        type: 'same',
        category: 'task',
        group: 'grp',
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan: 'Everything in one',
      }),
    );
  const planOf = async (id: string) => (await store.transaction((tx) => tx.listArtifacts(id, 'plan')))[0]?.content ?? '';

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('split_glob'));
    store = new PgStore(database.db);
    const notifier = new HintHub();
    const clock = { now: () => new Date().toISOString() };
    const deps = { store, notifier, clock };
    globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    artifacts = new ArtifactService(deps);
    const boards = new BoardService(deps);
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    const outbox = new OutboxRunner(database.db, { globs }, {}, () => undefined);
    app = createApp({
      auth: new Auth(database.db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub: notifier,
      outbox,
      onBoardCreated: () => Promise.resolve(),
    });
    const server = buildServer({ artifacts, globs, outbox } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await drop();
  });

  const parts = (extra: object = {}) => [
    { title: 'First', summary: 'one', plan: 'First, then {part:1}' },
    { title: 'Second', summary: 'two', plan: 'Second, needs {part:0}', after: [0], ...extra },
  ];

  it('split_glob returns the parts and is idempotent with a key', async () => {
    const glob = await make('Big');
    const args = { id: glob.id, version: glob.version, idempotencyKey: 'mcp-1', parts: parts() };
    const call = async () => {
      const reply = await client.callTool({ name: 'split_glob', arguments: args });
      const text = (reply.content as { type: string; text: string }[])[0]?.text ?? '';
      expect(reply.isError).toBeFalsy();
      return JSON.parse(text) as SplitBody;
    };
    const first = await call();
    expect(first.parts.map((p) => p.part)).toEqual([0, 1]);
    expect(first.parts[0]?.id).toBe(glob.id);
    const second = first.parts[1];
    expect(second?.after).toEqual([glob.id]);
    expect(await planOf(glob.id)).toContain(`First, then ${second?.id ?? ''}`);
    expect(await planOf(second?.id ?? '')).toContain(`Second, needs ${glob.id}`);
    const again = await call();
    expect(again.parts.map((p) => p.id)).toEqual(first.parts.map((p) => p.id));
    expect(await store.transaction((tx) => tx.listGlobs(boardId, { group: 'grp' }))).toHaveLength(2);
  });

  it('refuses a stale version over MCP', async () => {
    const glob = await make('Stale');
    const reply = await client.callTool({
      name: 'split_glob',
      arguments: { id: glob.id, version: glob.version + 3, idempotencyKey: 'mcp-stale', parts: parts() },
    });
    expect(reply.isError).toBe(true);
  });

  it('POST /api/globs/:id/split splits, and refuses a glob that started', async () => {
    const glob = await make('Rest');
    const request = (id: string, body: unknown) =>
      app.request(`/api/globs/${id}/split`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer dev:${DEV}` },
        body: JSON.stringify(body),
      });
    const res = await request(glob.id, { version: glob.version, idempotencyKey: 'rest-1', parts: parts() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SplitBody;
    expect(body.parts).toHaveLength(2);
    expect(body.parts[1]?.after).toEqual([glob.id]);

    const started = await make('Started');
    const picked = unwrap(await globs.pickUp(DEV, started.id, started.version, false));
    const refused = await request(started.id, { version: picked.version, parts: parts() });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await store.transaction((tx) => tx.listGlobs(boardId, { group: 'grp' }))).toHaveLength(6);
  });

  it('holds a sub part until the part it starts after has merged', async () => {
    const glob = await make('Subs');
    const reply = await client.callTool({
      name: 'split_glob',
      arguments: { id: glob.id, version: glob.version, idempotencyKey: 'mcp-sub', parts: parts({ type: 'sub' }) },
    });
    const body = JSON.parse((reply.content as { text: string }[])[0]?.text ?? '') as SplitBody;
    expect(body.parts[1]?.waiting).toBe(true);
    const sub = await globs.peek(body.parts[1]?.id ?? '');
    expect(sub?.status).toBe('planning');
    expect(sub?.runs).toHaveLength(0);
  });
});
