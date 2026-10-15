import { ArtifactService, BoardService, GlobService } from '@slop/core';
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

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface Body {
  id: string;
  version: number;
  status: string;
  type: string | null;
  category: string;
  branch?: string;
  provisioning?: string;
  assignee?: string | null;
  attributes?: { assignee: string | null; outcome: { kind: string; by: string; note?: string; reason?: string } | null };
  allowedActions?: string[];
  holding?: { to: string; until: string; toIsAction?: boolean }[];
  humanSteps?: { kind: string; title: string; who: string }[];
  code?: string;
  message?: string;
}

/** Action globs over REST and MCP, and the human listing, against Postgres. */
describe('action globs over REST and MCP (Postgres)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let client: Client;
  let app: Hono<Env>;
  let boardId: number;

  const rest = async (method: string, path: string, body?: unknown, as = DEV): Promise<{ status: number; body: Body }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${as}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : {}) as Body };
  };
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ error: boolean; body: Body }> => {
    const reply = await client.callTool({ name, arguments: args });
    const text = (reply.content as { type: string; text: string }[])[0]?.text ?? '{}';
    return { error: reply.isError === true, body: (text.startsWith('{') ? JSON.parse(text) : { message: text }) as Body };
  };
  const listed = async (args: Record<string, unknown>): Promise<{ id: string; type: string | null; category: string }[]> => {
    const reply = await client.callTool({ name: 'list_globs', arguments: { board: boardId, ...args } });
    return JSON.parse((reply.content as { type: string; text: string }[])[0]?.text ?? '[]') as { id: string; type: string | null; category: string }[];
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('human_work_api'));
    store = new PgStore(database.db);
    const notifier = new HintHub();
    const clock = { now: () => new Date().toISOString() };
    const deps = { store, notifier, clock };
    globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const artifacts = new ArtifactService(deps);
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
    const server = buildServer({ artifacts, globs, outbox, boards, deploys: { history: () => Promise.resolve({ ok: true as const, value: [] }) } } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await drop();
  });

  it('create_glob makes an action: no type, intake or branch; the plan template; idempotent', async () => {
    const made = await tool('create_glob', { board: boardId, idempotencyKey: 'act-1', category: 'action', title: 'Protect main', assignee: ADMIN });
    expect(made.error).toBe(false);
    expect(made.body).toMatchObject({ category: 'action', type: null, status: 'planning', assignee: ADMIN });
    expect(made.body.id).toMatch(/^s\d+a1$/);
    expect(made.body.branch).toBeUndefined();
    const stored = unwrap(await globs.get(DEV, made.body.id));
    expect(stored.glob).toMatchObject({ type: null, provisioning: 'none', runs: [], pr: null });
    const plan = (await store.transaction((tx) => tx.artifactVersions(made.body.id, 'plan', ''))).at(-1)?.content ?? '';
    for (const heading of ['## Why', '## Do this', '## Permissions', '## Check it worked']) expect(plan).toContain(heading);
    const again = await tool('create_glob', { board: boardId, idempotencyKey: 'act-1', category: 'action', title: 'Protect main' });
    expect(again.body.id).toBe(made.body.id);
    // The code counters are separate.
    const task = await tool('create_glob', { board: boardId, idempotencyKey: 'task-1', title: 'Code', type: 'same', plan: 'p', group: null });
    expect(task.body.id).toMatch(/t1$/);
  });

  it('create_glob refuses a type, files and a title-less action', async () => {
    expect((await tool('create_glob', { board: boardId, idempotencyKey: 'a2', category: 'action', title: 'x', type: 'same' })).body.code).toBe('invalid_input');
    expect((await tool('create_glob', { board: boardId, idempotencyKey: 'a3', category: 'action' })).body.code).toBe('invalid_input');
    expect((await tool('create_glob', { board: boardId, idempotencyKey: 'a4', category: 'action', title: 'x', files: [{ fileName: 'a.png' }] })).error).toBe(true);
  });

  it('creates an action over REST with a null type; a typed create is refused', async () => {
    const made = await rest('POST', `/api/boards/${boardId}/globs`, { title: 'Rotate token', category: 'action', assignee: DEV, group: null });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ category: 'action', type: null, attributes: { assignee: DEV, outcome: null }, allowedActions: ['complete_action', 'dismiss_action', 'delete'] });
    expect(made.body.humanSteps?.map((s) => [s.kind, s.title, s.who])).toEqual([['action', 'Do: Rotate token', DEV]]);
    const refused = await rest('POST', `/api/boards/${boardId}/globs`, { title: 'Rotate', category: 'action', type: 'same', group: null });
    expect(refused.status).toBe(422);
  });

  it('REST done and dismiss: note and reason, repeats, and version checks', async () => {
    const a = (await rest('POST', `/api/boards/${boardId}/globs`, { title: 'Do A', category: 'action', group: null })).body;
    const done = await rest('POST', `/api/globs/${a.id}/actions/done`, { version: a.version, note: 'checked' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'signed_off', attributes: { outcome: { kind: 'done', by: DEV, note: 'checked' } }, allowedActions: ['delete'] });
    const stale = await rest('POST', `/api/globs/${a.id}/actions/done`, { version: a.version });
    expect(stale.status).toBe(409);
    const b = (await rest('POST', `/api/boards/${boardId}/globs`, { title: 'Do B', category: 'action', group: null })).body;
    expect((await rest('POST', `/api/globs/${b.id}/actions/dismiss`, { version: b.version })).status).toBe(422);
    const dismissed = await rest('POST', `/api/globs/${b.id}/actions/dismiss`, { version: b.version, reason: 'not needed' }, ADMIN);
    expect(dismissed.body).toMatchObject({ status: 'signed_off', attributes: { outcome: { kind: 'dismissed', by: ADMIN, reason: 'not needed' } } });
  });

  it('work steps are refused on an action', async () => {
    const a = (await rest('POST', `/api/boards/${boardId}/globs`, { title: 'No start', category: 'action', group: null })).body;
    expect((await rest('POST', `/api/globs/${a.id}/actions/start`, { version: a.version })).status).toBe(409);
    expect((await rest('POST', `/api/globs/${a.id}/actions/merge`, { version: a.version })).status).toBe(409);
  });

  it('complete_action and dismiss_action over MCP release a sub that waits for the action', async () => {
    const act = await tool('create_glob', { board: boardId, idempotencyKey: 'act-wait', category: 'action', title: 'Wait for me', group: null });
    const held = await globs.create(ADMIN, { boardId, title: 'Needs it', type: 'sub', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'p', relations: [{ to: act.body.id, gate: 'start' }] });
    const waiting = unwrap(held);
    expect(waiting.waiting).toBeDefined();
    const view = unwrap(await globs.get(DEV, waiting.id));
    expect(view.holding.map((h) => [h.to, h.until, h.toIsAction])).toEqual([[act.body.id, 'done', true]]);
    const done = await tool('complete_action', { id: act.body.id, version: act.body.version, note: 'did it' });
    expect(done.body).toMatchObject({ status: 'signed_off', attributes: { outcome: { kind: 'done', note: 'did it' } } });
    const after = unwrap(await globs.get(DEV, waiting.id));
    expect(after.holding).toEqual([]);
    const other = await tool('create_glob', { board: boardId, idempotencyKey: 'act-dis', category: 'action', title: 'Drop me', group: null });
    expect((await tool('dismiss_action', { id: other.body.id, version: other.body.version, reason: '' })).error).toBe(true);
    const dismissed = await tool('dismiss_action', { id: other.body.id, version: other.body.version, reason: 'no longer needed' });
    expect(dismissed.body).toMatchObject({ status: 'signed_off', attributes: { outcome: { kind: 'dismissed', reason: 'no longer needed' } } });
  });

  it('list_globs: code work by default, a category filter for human work, type null for it', async () => {
    const decisionId = `s${boardId}k77`;
    const base: Glob = unwrap(await globs.create(DEV, { boardId, title: 'seed', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'seed' }));
    await store.transaction(async (tx) => {
      await tx.deleteGlob(base.id);
      await tx.insertGlob(
        { ...base, id: decisionId, category: 'decision', type: null, status: 'planning', provisioning: 'none', pr: null, version: 1, attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: null } },
        null,
      );
    });
    const work = await listed({});
    expect(work.length).toBeGreaterThan(0);
    expect(work.every((g) => g.category !== 'action' && g.category !== 'decision' && g.type !== null)).toBe(true);
    const actions = await listed({ category: 'action' });
    expect(actions.length).toBeGreaterThan(2);
    expect(actions.every((g) => g.category === 'action' && g.type === null)).toBe(true);
    const decisions = await listed({ category: 'decision' });
    expect(decisions.map((g) => [g.id, g.type])).toEqual([[decisionId, null]]);
    expect((await listed({ category: 'task' })).every((g) => g.category === 'task')).toBe(true);
  });

  it('the store lists work, actions, decisions and human globs apart', async () => {
    const by = async (include: 'work' | 'actions' | 'decisions' | 'human' | 'all') => (await store.transaction((tx) => tx.listGlobs(boardId, { include }))).map((g) => g.category);
    const [work, actions, decisions, human, all] = [await by('work'), await by('actions'), await by('decisions'), await by('human'), await by('all')];
    expect(work.some((c) => c === 'action' || c === 'decision')).toBe(false);
    expect(new Set(actions)).toEqual(new Set(['action']));
    expect(new Set(decisions)).toEqual(new Set(['decision']));
    expect(human.length).toBe(actions.length + decisions.length);
    expect(all.length).toBe(work.length + human.length);
  });

  it('an action shows on the board list with a type of null and one derived step while open', async () => {
    const list = await rest('GET', `/api/boards/${boardId}/globs`);
    const items = list.body as unknown as Body[];
    const open = items.filter((g) => g.category === 'action' && g.status === 'planning');
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((g) => g.type === null)).toBe(true);
  });
});
