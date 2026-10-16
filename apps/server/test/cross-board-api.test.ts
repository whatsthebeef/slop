import { BoardService, GlobService, machine } from '@slop/core';
import type { Glob, Result } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const BOTH = 'both@example.com';
const ONLY_X = 'x@example.com';
const ONLY_Y = 'y@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface External {
  boardId: number;
  boardName: string | null;
  hidden: boolean;
}
interface HoldingRow {
  relationId: string;
  to: string;
  toTitle: string | null;
  state: string;
  reason: string | null;
  external?: External;
}
interface HeldRow {
  from: string;
  fromTitle?: string | null;
  external?: External;
}
interface View {
  id: string;
  version: number;
  holding?: HoldingRow[];
  waitingFor?: { id: string; why: string }[];
  waitedOnBy?: string[];
  relations?: { holding: HoldingRow[]; holdsBack: HeldRow[]; waitedOnByOtherBoards?: number };
  holdsBack?: HeldRow[];
  code?: string;
  message?: string;
}

describe('cross-board relations over REST (Postgres)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let app: Hono<Env>;
  let boardX: number;
  let boardY: number;
  let holder: Glob;
  let target: Glob;

  const rest = async (method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: View }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer dev:${as}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : {}) as View };
  };
  const make = async (boardId: number, title: string, patch: Record<string, unknown> = {}): Promise<Glob> =>
    unwrap(await globs.create(ADMIN, { boardId, title, type: 'same', category: 'task', group: 'grp', environment: null, autoTrigger: false, idempotencyKey: null, plan: title, ...patch }));
  const list = async (boardId: number, as: string): Promise<View[]> => (await rest('GET', `/api/boards/${String(boardId)}/globs`, as)).body as unknown as View[];

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('cross_board_api'));
    store = new PgStore(database.db);
    const notifier = new HintHub();
    const clock = { now: () => new Date().toISOString() };
    const deps = { store, notifier, clock };
    globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const boards = new BoardService(deps);
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, BOTH, ONLY_X, ONLY_Y]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardX = unwrap(await boards.create(ADMIN, { name: 'Machine X', repo: null, timeZone: 'UTC', environments: [] })).id;
    boardY = unwrap(await boards.create(ADMIN, { name: 'Machine Y', repo: null, timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardX, BOTH, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardY, BOTH, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardX, ONLY_X, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardY, ONLY_Y, 'dev'));
    const outbox = new OutboxRunner(database.db, { globs }, {}, () => undefined);
    app = createApp({ auth: new Auth(database.db, loadConfig({})), links: new SignedLinks('test'), boards, globs, hub: notifier, outbox, onBoardCreated: () => Promise.resolve() });
    // The holder on board X waits for a glob on board Y ("waits for another machine").
    target = await make(boardY, 'Turn on push mode on the other machine');
    holder = await make(boardX, 'Roll out here', { type: 'sub', after: [target.id], afterReason: 'needs the other machine first' });
  });

  afterAll(async () => {
    await drop();
  });

  it('a member of both boards sees the other board by name on both sides', async () => {
    const held = await rest('GET', `/api/globs/${holder.id}`, BOTH);
    expect(held.status).toBe(200);
    expect(held.body.relations?.holding).toMatchObject([{ to: target.id, toTitle: target.title, reason: 'needs the other machine first', external: { boardId: boardY, boardName: 'Machine Y', hidden: false } }]);
    expect(held.body.waitingFor?.[0]?.id).toBe(target.id);
    const other = await rest('GET', `/api/globs/${target.id}`, BOTH);
    expect(other.body.relations?.holdsBack).toMatchObject([{ from: holder.id, external: { boardId: boardX, boardName: 'Machine X', hidden: false } }]);
    // The target's board list carries who waits for it.
    const listed = (await list(boardY, BOTH)).find((v) => v.id === target.id);
    expect(listed?.holdsBack).toMatchObject([{ from: holder.id }]);
  });

  it('a viewer who is not on the other board sees "another board": no id, no title, on the glob view and the board list', async () => {
    const view = await rest('GET', `/api/globs/${holder.id}`, ONLY_X);
    expect(view.status).toBe(200);
    expect(view.body.relations?.holding).toMatchObject([{ to: 'another board', toTitle: null, external: { hidden: true, boardName: null } }]);
    expect(view.body.waitingFor?.[0]?.id).toBe('another board');
    expect(view.body.waitingFor?.[0]?.why).toBe('Waits for a glob on another board');
    expect(JSON.stringify(view.body)).not.toContain(target.id);
    expect(JSON.stringify(view.body)).not.toContain(target.title);
    const row = (await list(boardX, ONLY_X)).find((v) => v.id === holder.id);
    expect(row?.holding).toMatchObject([{ to: 'another board', toTitle: null }]);
    expect(JSON.stringify(row)).not.toContain(target.id);
    // The other direction: a viewer on Y only sees that some glob on another board waits for the target.
    const targetView = await rest('GET', `/api/globs/${target.id}`, ONLY_Y);
    expect(targetView.body.waitedOnBy ?? []).not.toContain(holder.id);
    expect(targetView.body.relations?.waitedOnByOtherBoards).toBe(1);
    expect(JSON.stringify(targetView.body)).not.toContain(holder.id);
    const yRow = (await list(boardY, ONLY_Y)).find((v) => v.id === target.id);
    expect(JSON.stringify(yRow?.holdsBack ?? [])).not.toContain(holder.id);
  });

  it('a person who cannot see the target gets the same answer as for a glob that does not exist', async () => {
    const mine = await make(boardX, 'Mine on X');
    const refused = await rest('POST', `/api/globs/${mine.id}/relations`, ONLY_X, { version: mine.version, to: target.id });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toBe(`No glob ${target.id}`);
    const missing = await rest('POST', `/api/globs/${mine.id}/relations`, ONLY_X, { version: mine.version, to: 's999t999' });
    expect(missing.status).toBe(refused.status);
    expect(missing.body.message).toBe('No glob s999t999');
    // A member of both may add it (a people relation needs no reason).
    const added = await rest('POST', `/api/globs/${mine.id}/relations`, BOTH, { version: mine.version, to: target.id, gate: 'sign_off', until: 'rolled_out' });
    expect(added.status).toBe(200);
    expect(added.body.relations?.holding).toMatchObject([{ to: target.id, external: { boardName: 'Machine Y' } }]);
  });

  it('a cycle across the two boards is refused', async () => {
    const back = await rest('POST', `/api/globs/${target.id}/relations`, BOTH, { version: (await globs.peek(target.id))?.version, to: holder.id, gate: 'start' });
    expect(back.status).toBe(422);
    expect(back.body.message).toContain('cycle');
  });

  it("a merge on the target's board releases the holder on the other board", async () => {
    unwrap(await globs.applyEvent(target.id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
    await globs.releaseDependents(target.id, boardY);
    const after = await rest('GET', `/api/globs/${holder.id}`, BOTH);
    expect(after.body.waitingFor ?? []).toEqual([]);
    expect(after.body.relations?.holding).toEqual([]);
  });
});
