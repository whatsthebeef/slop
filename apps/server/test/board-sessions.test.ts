import { BoardService, GlobService } from '@slop/core';
import type { BoardSession, Result } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Auth, SESSION_COOKIE } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import * as schema from '../src/db/schema.js';
import { createTestDatabase } from './support/database.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const DEV = 'dev@example.com';
const OTHER = 'other@example.com';
const T1 = '2026-10-09T10:00:00.000Z';
const T2 = '2026-10-09T11:00:00.000Z';

const bar = (sessions: readonly BoardSession[]): number[] =>
  sessions
    .filter((s) => s.position !== null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((s) => s.boardId);

describe('board sessions in Postgres', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let store: PgStore;
  let boards: BoardService;
  let ids: number[];

  beforeAll(async () => {
    db = await createTestDatabase('board_sessions');
    store = new PgStore(db.database.db);
    boards = new BoardService({ store, notifier: { publish: () => undefined } });
    await store.transaction(async (tx) => {
      for (const email of [DEV, OTHER]) await tx.upsertUser({ email, name: email, active: true });
    });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.database.db.delete(schema.boardSessions);
    ids = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        unwrap(
          await boards.create(DEV, {
            name: `b${i}`,
            repo: null,
            baseBranch: 'main',
            timeZone: 'UTC',
            environments: [],
          }),
        ).id,
      );
    }
  });

  const sessions = (email = DEV): Promise<BoardSession[]> =>
    store.transaction((tx) => tx.listBoardSessions(email));

  it('renumbers without tripping the unique index (removing the first, reversing)', async () => {
    const [a, b, c] = ids as [number, number, number];
    await store.transaction((tx) => tx.setBoardSessionOrder(DEV, [a, b, c]));
    await store.transaction((tx) => tx.setBoardSessionOrder(DEV, [b, c]));
    expect(bar(await sessions())).toEqual([b, c]);
    expect((await sessions()).find((s) => s.boardId === a)?.position).toBeNull();
    await store.transaction((tx) => tx.setBoardSessionOrder(DEV, [c, b, a]));
    expect((await sessions()).filter((s) => ids.slice(0, 3).includes(s.boardId))).toEqual([
      { boardId: a, position: 3, lastViewedAt: null },
      { boardId: b, position: 2, lastViewedAt: null },
      { boardId: c, position: 1, lastViewedAt: null },
    ]);
    await store.transaction((tx) => tx.setBoardSessionOrder(DEV, []));
    expect(bar(await sessions())).toEqual([]);
  });

  it('touches the view time without moving the position, creating the row when missing', async () => {
    const [a, b] = ids as [number, number];
    await store.transaction((tx) => tx.touchBoardSession(DEV, a, T1));
    expect(await sessions()).toEqual([{ boardId: a, position: null, lastViewedAt: T1 }]);
    await store.transaction((tx) => tx.setBoardSessionOrder(DEV, [b, a]));
    await store.transaction((tx) => tx.touchBoardSession(DEV, a, T2));
    expect(await sessions()).toEqual([
      { boardId: a, position: 2, lastViewedAt: T2 },
      { boardId: b, position: 1, lastViewedAt: null },
    ]);
  });

  it('lists only that person, ignores non-members and cascades with the membership', async () => {
    const [a, b] = ids as [number, number];
    unwrap(await boards.setMember(DEV, a, OTHER, 'dev'));
    await store.transaction((tx) => tx.touchBoardSession(OTHER, a, T1));
    await store.transaction((tx) => tx.touchBoardSession(OTHER, b, T1));
    await store.transaction((tx) => tx.touchBoardSession(DEV, b, T2));
    expect(await sessions(OTHER)).toEqual([{ boardId: a, position: null, lastViewedAt: T1 }]);
    unwrap(await boards.removeMember(DEV, a, OTHER));
    expect(await sessions(OTHER)).toEqual([]);
  });

  it('rejects an order with a board the person is not a member of', async () => {
    const [a] = ids as [number];
    await expect(store.transaction((tx) => tx.setBoardSessionOrder(OTHER, [a]))).rejects.toThrow();
  });

  it('serialises concurrent adds: unique, contiguous positions and a repeated board once', async () => {
    const opened = [...ids.slice(0, 5), ids[2] ?? 0];
    const results = await Promise.all(opened.map((id) => boards.addSession(DEV, id)));
    results.forEach(unwrap);
    const order = bar(await sessions());
    expect(order).toHaveLength(5);
    expect(new Set(order)).toEqual(new Set(ids.slice(0, 5)));
    expect(
      (await sessions())
        .map((s) => s.position)
        .filter((p) => p !== null)
        .sort(),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it('records opens without changing the bar', async () => {
    const [a, b, c] = ids as [number, number, number];
    unwrap(await boards.addSession(DEV, b));
    await Promise.all([a, b, c, a].map((id) => boards.openBoard(DEV, id, T1)));
    expect(bar(await sessions())).toEqual([b]);
    expect((await sessions()).map((s) => [s.boardId, s.lastViewedAt]).sort()).toEqual(
      [a, b, c].map((id) => [id, T1]).sort(),
    );
  });

  it('removes and adds over Postgres through the service', async () => {
    const [a, b, c] = ids as [number, number, number];
    for (const id of [a, b, c]) {
      unwrap(await boards.addSession(DEV, id));
      unwrap(await boards.openBoard(DEV, id, T1));
    }
    expect(bar(unwrap(await boards.removeSession(DEV, a)))).toEqual([b, c]);
    expect(bar(unwrap(await boards.addSession(DEV, a)))).toEqual([b, c, a]);
    const memberships = await boards.memberships(DEV);
    expect(memberships.find((m) => m.board.id === a)).toMatchObject({
      position: 3,
      lastViewedAt: T1,
    });
  });
});

describe('board session routes', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: Hono<Env>;
  let cookie: string;
  let boardId: number;

  beforeAll(async () => {
    db = await createTestDatabase('board_session_routes');
    const store = new PgStore(db.database.db);
    const hub = new HintHub();
    const boards = new BoardService({ store, notifier: hub });
    const globs = new GlobService({
      store,
      notifier: hub,
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const auth = new Auth(db.database.db, loadConfig({}));
    app = createApp({
      auth,
      links: new SignedLinks('test'),
      boards,
      globs,
      hub,
      outbox: new OutboxRunner(db.database.db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
    cookie = `${SESSION_COOKIE}=${await auth.createSession({ email: DEV, name: DEV })}`;
    await store.transaction((tx) => tx.upsertUser({ email: OTHER, name: OTHER, active: true }));
    boardId = unwrap(
      await boards.create(OTHER, {
        name: 'theirs',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    unwrap(await boards.setMember(OTHER, boardId, DEV, 'dev'));
    unwrap(
      await boards.create(OTHER, {
        name: 'not mine',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    );
  });

  afterAll(async () => {
    await db.drop();
  });

  const call = (method: string, path: string) => app.request(path, { method, headers: { cookie } });

  it('records an open without adding it, then adds, removes, and /api/me shows the session', async () => {
    const viewed = await call('POST', `/api/boards/${boardId}/viewed`);
    expect(viewed.status).toBe(200);
    const { sessions } = (await viewed.json()) as { sessions: BoardSession[] };
    expect(sessions).toEqual([
      { boardId, position: null, lastViewedAt: expect.any(String) as string },
    ]);
    const me = (await (await call('GET', '/api/me')).json()) as {
      boards: { id: number; position: number | null; lastViewedAt: string | null }[];
    };
    expect(me.boards).toEqual([
      expect.objectContaining({
        id: boardId,
        position: null,
        lastViewedAt: sessions[0]?.lastViewedAt,
      }),
    ]);
    expect(await (await call('PUT', `/api/boards/${boardId}/session`)).json()).toMatchObject({
      sessions: [{ boardId, position: 1 }],
    });
    expect(await (await call('DELETE', `/api/boards/${boardId}/session`)).json()).toMatchObject({
      sessions: [{ boardId, position: null }],
    });
    expect(await (await call('PUT', `/api/boards/${boardId}/session`)).json()).toMatchObject({
      sessions: [{ boardId, position: 1 }],
    });
  });

  it('refuses a board you are not on (403) and a bad ID (422)', async () => {
    for (const [method, path] of [
      ['POST', 'viewed'],
      ['PUT', 'session'],
      ['DELETE', 'session'],
    ] as const) {
      expect((await call(method, `/api/boards/${boardId + 1}/${path}`)).status).toBe(403);
      expect((await call(method, `/api/boards/x/${path}`)).status).toBe(422);
    }
  });
});
