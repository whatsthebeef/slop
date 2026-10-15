import { ArtifactService, BoardService, CodeViewUnavailable, GlobService, IntakeService, LlmUnavailable, machine } from '@slop/core';
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
  script?: { path: string; onBase: boolean | null } | null;
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
  // The base branch's files as the fake code view sees them, how often it was read, and whether the code host is down.
  const onBase = new Set<string>();
  const baseReads: string[] = [];
  let hostDown = false;
  let downReads = 0;
  // The local clone lags a push until the board's code sync runs: reads miss `onBase` files while true.
  let stale = false;
  // Moves the service's clock forward (ms), to pass cache lifetimes.
  let skew = 0;

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
    const clock = { now: () => new Date(Date.now() + skew).toISOString() };
    const deps = { store, notifier, clock };
    const codeView = {
      read: (_board: number, ref: string | null, path: string) => {
        if (hostDown) {
          downReads += 1;
          return Promise.reject(new CodeViewUnavailable('host down'));
        }
        baseReads.push(`${String(ref)}:${path}`);
        return Promise.resolve(onBase.has(path) && !stale ? { path, content: '#!/bin/sh\n', startLine: 1, endLine: 1, totalLines: 1, truncated: false, binary: false } : null);
      },
    };
    globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) }, codeView });
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
    const server = buildServer({ artifacts, globs, intake: new IntakeService({ store, llm: { complete: () => Promise.reject(new LlmUnavailable('off', 'none')) } }), outbox, boards, deploys: { history: () => Promise.resolve({ ok: true as const, value: [] }) } } as unknown as McpDeps, DEV, 'http://localhost');
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

  it('REST create and update speak actor, mode, fix and workKind, with category and type as aliases', async () => {
    type Kind = Body & { actor: string; mode: string; fix: boolean; fixSource: string; workKind: string; workKindSource: string };
    const post = async (body: Record<string, unknown>) => rest('POST', `/api/boards/${boardId}/globs`, { group: null, plan: 'p', ...body });
    const human = await post({ title: 'Do it by hand', actor: 'human' });
    expect(human.body).toMatchObject({ actor: 'human', mode: 'action', category: 'action', type: null });
    const aliased = await post({ title: 'Old caller', category: 'bug', type: 'same' });
    expect(aliased.body).toMatchObject({ actor: 'machine', mode: 'same', fix: true, fixSource: 'person', workKind: 'maintenance' });
    const modern = await post({ title: 'New caller', actor: 'machine', mode: 'same', fix: false, workKind: 'rnd' });
    expect(modern.body).toMatchObject({ mode: 'same', fix: false, workKind: 'rnd', workKindSource: 'person', category: 'feature' });
    // No category given and no intake wired: a same, not a fix, maintenance, inferred.
    const bare = await post({ title: 'Plain' });
    expect(bare.body).toMatchObject({ actor: 'machine', mode: 'same', category: 'task', fix: false, fixSource: 'inferred', workKind: 'maintenance', workKindSource: 'inferred' });
    expect((await post({ title: 'Mixed', actor: 'machine', mode: 'action' })).status).toBe(422);
    expect((await post({ title: 'Mixed', actor: 'human', mode: 'same' })).status).toBe(422);
    // A person flips the fix flag; only an admin changes the work kind.
    const flipped = await rest('PATCH', `/api/globs/${bare.body.id}`, { version: bare.body.version, fix: true });
    expect(flipped.status).toBe(200);
    expect(flipped.body).toMatchObject({ fix: true, fixSource: 'person' });
    const refused = await rest('PATCH', `/api/globs/${bare.body.id}`, { version: (flipped.body as Kind).version, workKind: 'rnd' });
    expect(refused.status).toBe(403);
    const allowed = await rest('PATCH', `/api/globs/${bare.body.id}`, { version: (flipped.body as Kind).version, workKind: 'rnd' }, ADMIN);
    expect(allowed.body).toMatchObject({ workKind: 'rnd', workKindSource: 'person' });
    const mode = await rest('PATCH', `/api/globs/${modern.body.id}`, { version: modern.body.version, mode: 'same' });
    expect(mode.body).toMatchObject({ actor: 'machine', mode: 'same' });
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

  describe('an action waits for its script to be on the base branch', () => {
    const plan = (path: string): string => `## Why\n\nRoll it out.\n\n## Do this\n\nscript: ${path}\n\nbash ${path}\n`;
    const make = async (key: string, path: string, extra: Record<string, unknown> = {}) =>
      (await tool('create_glob', { board: boardId, idempotencyKey: key, category: 'action', title: `Run ${path}`, plan: plan(path), group: null, ...extra })).body;
    const done = (a: Body) => rest('POST', `/api/globs/${a.id}/actions/done`, { version: a.version });

    it('refuses Done while the script is absent on the base branch, even with no relation, and allows it after the push', async () => {
      const a = await make('script-1', 'scripts/rollout/s1-run.sh');
      const view = await rest('GET', `/api/globs/${a.id}`);
      expect(view.body.script).toEqual({ path: 'scripts/rollout/s1-run.sh', onBase: false });
      expect(view.body.allowedActions).toEqual(['dismiss_action', 'delete']);
      const listed = (await rest('GET', `/api/boards/${boardId}/globs`)).body as unknown as Body[];
      expect(listed.find((g) => g.id === a.id)).toMatchObject({ script: { onBase: false }, allowedActions: ['dismiss_action', 'delete'] });
      const refused = await done(view.body);
      expect(refused.status).toBe(409);
      expect(refused.body.message).toBe('script not on main yet: scripts/rollout/s1-run.sh');
      // The answer is cached until the base branch moves.
      const reads = baseReads.filter((r) => r.endsWith('s1-run.sh')).length;
      await rest('GET', `/api/globs/${a.id}`);
      expect(baseReads.filter((r) => r.endsWith('s1-run.sh')).length).toBe(reads);
      expect(baseReads.every((r) => r.startsWith('null:'))).toBe(true);
      onBase.add('scripts/rollout/s1-run.sh');
      await globs.baseMoved(boardId);
      const after = await rest('GET', `/api/globs/${a.id}`);
      expect(after.body.script).toEqual({ path: 'scripts/rollout/s1-run.sh', onBase: true });
      expect(after.body.allowedActions).toContain('complete_action');
      expect((await done(after.body)).body).toMatchObject({ status: 'signed_off' });
    });

    it('does not keep a stale "missing" after a push: the clone catches up and the answer is read again', async () => {
      const path = 'scripts/rollout/s6-run.sh';
      const a = await make('script-6', path);
      // The push arrives, but the clone has not fetched it yet: the re-check reads it as missing.
      onBase.add(path);
      stale = true;
      await globs.baseMoved(boardId);
      expect((await rest('GET', `/api/globs/${a.id}`)).body.script).toEqual({ path, onBase: false });
      // The code sync runs; a missing answer is trusted for seconds only, so the next read sees the script.
      stale = false;
      skew += 20_000;
      try {
        const after = await rest('GET', `/api/globs/${a.id}`);
        expect(after.body.script).toEqual({ path, onBase: true });
        expect(after.body.allowedActions).toContain('complete_action');
      } finally {
        skew -= 20_000;
      }
    });

    it('dismisses an action whose script is missing, and ignores a script path that leaves the repo', async () => {
      const a = await make('script-2', 'scripts/rollout/s2-run.sh');
      const dismissed = await tool('dismiss_action', { id: a.id, version: a.version, reason: 'not needed' });
      expect(dismissed.body).toMatchObject({ status: 'signed_off' });
      const escaping = await make('script-3', '../outside.sh');
      expect((await rest('GET', `/api/globs/${escaping.id}`)).body.script).toBeNull();
      expect(baseReads.some((r) => r.includes('outside.sh'))).toBe(false);
    });

    it('fails open when the code host is down, and says it could not check', async () => {
      hostDown = true;
      try {
        const a = await make('script-4', 'scripts/rollout/s4-run.sh');
        const view = await rest('GET', `/api/globs/${a.id}`);
        expect(view.body.script).toEqual({ path: 'scripts/rollout/s4-run.sh', onBase: null });
        expect(view.body.allowedActions).toContain('complete_action');
        // The unavailable answer is cached briefly: repeated reads don't hit the down host again.
        const reads = downReads;
        await rest('GET', `/api/globs/${a.id}`);
        await rest('GET', `/api/boards/${boardId}/globs`);
        expect(downReads).toBe(reads);
        expect((await done(view.body)).body).toMatchObject({ status: 'signed_off' });
      } finally {
        hostDown = false;
      }
    });

    it('holds Done for the glob that builds the script until it merges, even when the script is on the base branch', async () => {
      const builder = unwrap(await globs.create(ADMIN, { boardId, title: 'Builds it', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'p' }));
      onBase.add('scripts/rollout/s5-run.sh');
      const a = await make('script-5', 'scripts/rollout/s5-run.sh', { relations: [{ to: builder.id, gate: 'start', until: 'merged', reason: 'builds its script' }] });
      const view = await rest('GET', `/api/globs/${a.id}`);
      expect(view.body.allowedActions).toEqual(['dismiss_action', 'delete']);
      expect(view.body.holding).toMatchObject([{ to: builder.id, until: 'merged' }]);
      const refused = await done(view.body);
      expect(refused.status).toBe(409);
      expect(refused.body.message).toContain(`Waits for ${builder.id} to merge`);
      unwrap(await globs.applyEvent(builder.id, (g, c) => machine.merged(g, { sha: 'abc1234' }, c)));
      await globs.releaseDependents(builder.id, boardId);
      const after = await rest('GET', `/api/globs/${a.id}`);
      expect(after.body.allowedActions).toContain('complete_action');
      expect((await done(after.body)).body).toMatchObject({ status: 'signed_off' });
    });
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

  it('keeps a row with no category in the work listing (written before the field existed)', async () => {
    const base: Glob = unwrap(await globs.create(DEV, { boardId, title: 'old row', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'old' }));
    await store.transaction(async (tx) => {
      await tx.deleteGlob(base.id);
      await tx.insertGlob({ ...base, id: `s${boardId}t9000`, category: undefined as never, version: 1 }, null);
    });
    const ids = async (include: 'work' | 'actions' | 'human') => (await store.transaction((tx) => tx.listGlobs(boardId, { include }))).map((g) => g.id);
    expect(await ids('work')).toContain(`s${boardId}t9000`);
    expect(await ids('actions')).not.toContain(`s${boardId}t9000`);
    expect(await ids('human')).not.toContain(`s${boardId}t9000`);
  });

  it('pick-up and take-over are refused on an action over REST, and a needs-list entry for it waits until done', async () => {
    const a = (await rest('POST', `/api/boards/${boardId}/globs`, { title: 'Not picked', category: 'action', group: null })).body;
    expect((await rest('POST', `/api/globs/${a.id}/actions/pick-up`, { version: a.version })).status).toBe(409);
    expect((await rest('POST', `/api/globs/${a.id}/actions/take-over`, { version: a.version })).status).toBe(409);
    const sub = await rest('POST', `/api/boards/${boardId}/globs`, { title: 'Waits', type: 'sub', category: 'task', group: null, plan: 'p', needs: [a.id] }, ADMIN);
    const view = unwrap(await globs.get(DEV, sub.body.id));
    expect(view.holding.map((h) => [h.to, h.until])).toEqual([[a.id, 'done']]);
    expect((await rest('POST', `/api/globs/${a.id}/actions/done`, { version: a.version })).status).toBe(200);
    expect(unwrap(await globs.get(DEV, sub.body.id)).holding).toEqual([]);
  });

  it('an action shows on the board list with a type of null and one derived step while open', async () => {
    const list = await rest('GET', `/api/boards/${boardId}/globs`);
    const items = list.body as unknown as Body[];
    const open = items.filter((g) => g.category === 'action' && g.status === 'planning');
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((g) => g.type === null)).toBe(true);
  });
});
