import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import {
  appendSession,
  displaySessions,
  isContiguous,
  removeSession,
  sessionOrder,
} from '../src/domain/board-sessions.js';
import type { BoardSession } from '../src/domain/board-sessions.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const DEV = 'dev@example.com';
const OTHER = 'other@example.com';
const OUTSIDER = 'outsider@example.com';
const T1 = '2026-10-09T10:00:00.000Z';
const T2 = '2026-10-09T11:00:00.000Z';

const session = (
  boardId: number,
  position: number | null,
  lastViewedAt: string | null = null,
): BoardSession => ({ boardId, position, lastViewedAt });

describe('board session order', () => {
  it('orders by position, tolerating gaps and ties', () => {
    expect(sessionOrder([session(3, 5), session(1, null), session(2, 2), session(4, 2)])).toEqual([
      2, 4, 3,
    ]);
  });

  it('appends to the end, once', () => {
    expect(appendSession([2, 1], 3)).toEqual([2, 1, 3]);
    expect(appendSession([2, 1, 3], 1)).toEqual([2, 1, 3]);
  });

  it('removes keeping the order, idempotently', () => {
    expect(removeSession([2, 1, 3], 1)).toEqual([2, 3]);
    expect(removeSession([2, 3], 1)).toEqual([2, 3]);
  });

  it('knows a contiguous bar and renumbers gaps for display', () => {
    expect(isContiguous([session(1, 1), session(2, 2), session(3, null)])).toBe(true);
    expect(isContiguous([session(1, 1), session(2, 3)])).toBe(false);
    expect(displaySessions([session(1, 1), session(2, 3), session(3, null, T1)])).toEqual([
      session(1, 1),
      session(2, 2),
      session(3, null, T1),
    ]);
  });
});

describe('BoardService sessions', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let boards: BoardService;
  let ids: number[];

  const create = async (name: string): Promise<number> =>
    unwrap(
      await boards.create(DEV, {
        name,
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
  const positions = async (email = DEV): Promise<Record<number, number | null>> =>
    Object.fromEntries((await boards.memberships(email)).map((m) => [m.board.id, m.position]));

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    boards = new BoardService({ store, notifier });
    await store.transaction(async (tx) => {
      for (const email of [DEV, OTHER, OUTSIDER])
        await tx.upsertUser({ email, name: email, active: true });
    });
    ids = [await create('a'), await create('b'), await create('c')];
    notifier.hints.length = 0;
  });

  it('records the time on open and leaves the bar as it was', async () => {
    const [a, b, c] = ids as [number, number, number];
    unwrap(await boards.addSession(DEV, b));
    const sessions = unwrap(await boards.openBoard(DEV, a, T1));
    expect(sessions).toEqual(expect.arrayContaining([session(b, 1, null), session(a, null, T1)]));
    unwrap(await boards.openBoard(DEV, b, T2));
    unwrap(await boards.openBoard(DEV, c, T2));
    expect(await positions()).toEqual({ [a]: null, [b]: 1, [c]: null });
    const memberships = await boards.memberships(DEV);
    expect(memberships.map((m) => [m.board.id, m.position, m.lastViewedAt])).toEqual([
      [a, null, T1],
      [b, 1, T2],
      [c, null, T2],
    ]);
  });

  it('keeps the place of a board opened again and moves its time', async () => {
    const [a, b] = ids as [number, number];
    unwrap(await boards.addSession(DEV, a));
    unwrap(await boards.addSession(DEV, b));
    unwrap(await boards.openBoard(DEV, a, T1));
    const sessions = unwrap(await boards.openBoard(DEV, a, T2));
    expect(sessions.find((s) => s.boardId === a)).toEqual(session(a, 1, T2));
    expect(sessions.find((s) => s.boardId === b)).toEqual(session(b, 2, null));
  });

  it('refuses non-members, inactive users and bad board IDs, storing nothing', async () => {
    const [a] = ids as [number];
    expect(await boards.openBoard(OUTSIDER, a, T1)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await boards.addSession(OUTSIDER, a)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await boards.removeSession(OUTSIDER, a)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(store.state.boardSessions.size).toBe(0);
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: false }));
    expect(await boards.openBoard(DEV, a, T1)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: true }));
    expect(await boards.openBoard(DEV, Number.NaN, T1)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await boards.addSession(DEV, 1.5)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(store.state.boardSessions.size).toBe(0);
  });

  it('removes a board and renumbers the rest, idempotently, keeping its view time', async () => {
    const [a, b, c] = ids as [number, number, number];
    for (const id of ids) {
      unwrap(await boards.addSession(DEV, id));
      unwrap(await boards.openBoard(DEV, id, T1));
    }
    const sessions = unwrap(await boards.removeSession(DEV, b));
    expect(sessions).toEqual(
      expect.arrayContaining([session(a, 1, T1), session(b, null, T1), session(c, 2, T1)]),
    );
    expect(unwrap(await boards.removeSession(DEV, b))).toEqual(sessions);
    expect(await positions()).toEqual({ [a]: 1, [b]: null, [c]: 2 });
  });

  it('removes the last board without renumbering the others (s15t42)', async () => {
    const [a, b, c] = ids as [number, number, number];
    for (const id of ids) {
      unwrap(await boards.addSession(DEV, id));
      unwrap(await boards.openBoard(DEV, id, T1));
    }
    unwrap(await boards.removeSession(DEV, c));
    expect(await positions()).toEqual({ [a]: 1, [b]: 2, [c]: null });
  });

  it('empties the bar by removing the only board, and the next add starts again at 1 (s15t42)', async () => {
    const [a, b, c] = ids as [number, number, number];
    unwrap(await boards.addSession(DEV, a));
    unwrap(await boards.openBoard(DEV, a, T1));
    expect(unwrap(await boards.removeSession(DEV, a))).toEqual([session(a, null, T1)]);
    expect(await positions()).toEqual({ [a]: null, [b]: null, [c]: null });
    unwrap(await boards.openBoard(DEV, b, T2));
    expect(await positions()).toEqual({ [a]: null, [b]: null, [c]: null });
    unwrap(await boards.addSession(DEV, b));
    expect(await positions()).toMatchObject({ [a]: null, [b]: 1 });
  });

  it('adds a board already in the bar without moving it (s15t42)', async () => {
    const [a, b, c] = ids as [number, number, number];
    for (const id of ids) {
      unwrap(await boards.addSession(DEV, id));
      unwrap(await boards.openBoard(DEV, id, T1));
    }
    unwrap(await boards.addSession(DEV, a));
    expect(await positions()).toEqual({ [a]: 1, [b]: 2, [c]: 3 });
  });

  it('adds a board to the end, idempotently', async () => {
    const [a, b, c] = ids as [number, number, number];
    for (const id of ids) {
      unwrap(await boards.addSession(DEV, id));
      unwrap(await boards.openBoard(DEV, id, T1));
    }
    unwrap(await boards.removeSession(DEV, b));
    unwrap(await boards.addSession(DEV, b));
    expect(await positions()).toEqual({ [a]: 1, [b]: 3, [c]: 2 });
    unwrap(await boards.addSession(DEV, b));
    expect(await positions()).toEqual({ [a]: 1, [b]: 3, [c]: 2 });
  });

  it('adds a board never opened, with no view time', async () => {
    const [a] = ids as [number];
    expect(unwrap(await boards.addSession(DEV, a))).toEqual([session(a, 1, null)]);
    expect((await boards.memberships(DEV)).find((m) => m.board.id === a)).toMatchObject({
      position: 1,
      lastViewedAt: null,
    });
  });

  it('keeps sessions per person', async () => {
    const [a, b] = ids as [number, number];
    unwrap(await boards.setMember(DEV, a, OTHER, 'dev'));
    unwrap(await boards.setMember(DEV, b, OTHER, 'dev'));
    unwrap(await boards.addSession(DEV, a));
    unwrap(await boards.openBoard(DEV, a, T1));
    unwrap(await boards.addSession(OTHER, b));
    unwrap(await boards.openBoard(OTHER, b, T2));
    expect(await positions(OTHER)).toEqual({ [a]: null, [b]: 1 });
    expect(
      (await boards.memberships(OTHER)).find((m) => m.board.id === a)?.lastViewedAt,
    ).toBeNull();
    expect(await positions(DEV)).toMatchObject({ [a]: 1, [b]: null });
  });

  it('drops the session with the membership and shows the rest without a gap', async () => {
    const [a, b, c] = ids as [number, number, number];
    for (const id of [a, b, c]) unwrap(await boards.setMember(DEV, id, OTHER, 'dev'));
    for (const id of [a, b, c]) {
      unwrap(await boards.addSession(OTHER, id));
      unwrap(await boards.openBoard(OTHER, id, T1));
    }
    unwrap(await boards.removeMember(DEV, a, OTHER));
    expect(await positions(OTHER)).toEqual({ [b]: 1, [c]: 2 });
    // The next write closes the stored gap.
    unwrap(await boards.removeSession(OTHER, b));
    expect(await positions(OTHER)).toEqual({ [b]: null, [c]: 1 });
    expect(store.state.boardSessions.get(`${c}:${OTHER}`)?.position).toBe(1);
  });

  it('publishes no board hint', async () => {
    const [a] = ids as [number];
    unwrap(await boards.openBoard(DEV, a, T1));
    unwrap(await boards.removeSession(DEV, a));
    unwrap(await boards.addSession(DEV, a));
    expect(notifier.hints).toEqual([]);
  });
});
