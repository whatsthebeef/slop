import { ArtifactService, BoardService, GlobService, GroupService } from '@slop/core';
import type { Glob, Result } from '@slop/core';
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
const OUTSIDER = 'outsider@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface GroupBody {
  name: string;
  progress: { merged: number; total: number };
  globs: { id: string; title: string; status: string }[];
  relations: { from: string; to: string; holding: boolean; crosses: boolean }[];
  decisions: { id: string; holdsBack: string[] }[];
  code?: string;
}

describe('groups over REST and MCP (Postgres)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let globs: GlobService;
  let client: Client;
  let app: Hono<Env>;
  let boardId: number;

  const make = async (title: string, patch: Record<string, unknown> = {}): Promise<Glob> =>
    unwrap(await globs.create(ADMIN, { boardId, title, type: 'same', category: 'task', group: 'board-chat', environment: null, autoTrigger: false, idempotencyKey: null, plan: title, ...patch }));
  // The caller names the body's shape: the response is JSON the test reads, not validated here.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  const rest = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, as = DEV): Promise<{ status: number; body: T }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${as}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : {}) as T };
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('group_routes'));
    const store = new PgStore(database.db);
    const notifier = new HintHub();
    const clock = { now: () => new Date().toISOString() };
    const deps = { store, notifier, clock };
    globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const artifacts = new ArtifactService(deps);
    const boards = new BoardService(deps);
    const groups = new GroupService({ store, globs, boards, clock });
    await store.transaction(async (tx) => {
      for (const email of [DEV, ADMIN, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    const outbox = new OutboxRunner(database.db, { globs }, {}, () => undefined);
    app = createApp({ auth: new Auth(database.db, loadConfig({})), links: new SignedLinks('test'), boards, globs, groups, hub: notifier, outbox, onBoardCreated: () => Promise.resolve() });
    const server = buildServer({ artifacts, globs, groups, outbox, boards, deploys: { history: () => Promise.resolve({ ok: true as const, value: [] }) } } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await drop();
  });

  it('lists the groups and serves one group\'s view, to members only', async () => {
    const first = await make('First');
    const second = await make('Second', { type: 'sub', after: [first.id] });
    await make('Elsewhere', { group: 'other' });

    const list = await rest<{ name: string; progress: unknown; open: number }[]>('GET', `/api/boards/${boardId}/groups`);
    expect(list.status).toBe(200);
    expect(list.body.map((g) => [g.name, g.progress, g.open]).sort()).toEqual([
      ['board-chat', { merged: 0, total: 2 }, 2],
      ['other', { merged: 0, total: 1 }, 1],
    ]);

    const view = await rest<GroupBody>('GET', `/api/boards/${boardId}/groups/Board%20Chat`);
    expect(view.status).toBe(200);
    const body = view.body;
    expect(body.name).toBe('board-chat');
    expect(body.globs.map((g) => g.id)).toEqual([first.id, second.id]);
    expect(body.relations).toMatchObject([{ from: second.id, to: first.id, holding: true, crosses: false }]);

    expect((await rest('GET', `/api/boards/${boardId}/groups`, undefined, OUTSIDER)).status).toBe(403);
    expect((await rest('GET', `/api/boards/${boardId}/groups/none`)).status).toBe(404);
  });

  it('does not take the backfill route for a group named backfill', async () => {
    const res = await rest('POST', `/api/boards/${boardId}/groups/backfill`, { apply: false });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('The group backfill is not available');
  });

  it('renames and merges through POST, and reports a name clash as 422', async () => {
    await make('Solo', { group: 'solo' });
    expect((await rest('POST', `/api/boards/${boardId}/groups/solo/rename`, { to: 'x' }, OUTSIDER)).status).toBe(403);
    expect((await rest('POST', `/api/boards/${boardId}/groups/solo/merge`, { into: 'other' }, OUTSIDER)).status).toBe(403);
    const clash = await rest('POST', `/api/boards/${boardId}/groups/solo/rename`, { to: 'other' });
    expect(clash.status).toBe(422);
    const renamed = await rest('POST', `/api/boards/${boardId}/groups/solo/rename`, { to: 'lonely' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ name: 'lonely', moved: 1, failed: [] });
    const merged = await rest('POST', `/api/boards/${boardId}/groups/lonely/merge`, { into: 'other' });
    expect(merged.body).toEqual({ name: 'other', moved: 1, failed: [] });
    expect((await rest('GET', `/api/boards/${boardId}/groups/lonely`)).status).toBe(404);
    expect((await rest<GroupBody>('GET', `/api/boards/${boardId}/groups/other`)).body.globs).toHaveLength(2);
  });

  it('get_group returns the same view to an agent', async () => {
    const reply = await client.callTool({ name: 'get_group', arguments: { board: boardId, name: 'board-chat' } });
    const body = JSON.parse((reply.content as { text: string }[])[0]?.text ?? '{}') as GroupBody;
    expect(reply.isError).not.toBe(true);
    expect(body.name).toBe('board-chat');
    expect(body.progress.total).toBe(2);
    const missing = await client.callTool({ name: 'get_group', arguments: { board: boardId, name: 'nope' } });
    expect(missing.isError).toBe(true);
  });
});
