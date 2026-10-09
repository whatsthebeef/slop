import { describe, expect, it } from 'vitest';
import type { BoardView, Me } from '../src/lib/api';
import {
  allBoardsOrder,
  barRows,
  lastViewedBoard,
  lastViewedLabel,
  withSessions,
  writeSequence,
} from '../src/lib/board-bar';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const board = (
  id: number,
  position: number | null | undefined,
  lastViewedAt?: string | null,
): BoardView => ({
  id,
  name: `b${id}`,
  repo: null,
  baseBranch: 'main',
  timeZone: 'UTC',
  defaultRoutineOwner: null,
  environments: [],
  sensitivePaths: [],
  readinessTicks: {},
  deploy: null,
  agentSetVersion: 0,
  agentCatalogHash: null,
  runNoProgressHours: 2,
  runReadyHours: 8,
  runStartMinutes: 30,
  runRespondMinutes: 30,
  subMaxChangedLines: 2000,
  effectCheckGlobs: 10,
  agentKbApproval: 'docs',
  version: 1,
  role: 'dev',
  ...(position === undefined ? {} : { position }),
  ...(lastViewedAt === undefined ? {} : { lastViewedAt }),
});

const ids = (boards: readonly BoardView[]) => boards.map((b) => b.id);

describe('barRows', () => {
  it('returns the sessions in position order, whatever order the API lists them in', () => {
    const rows = barRows([board(1, 3), board(2, 1), board(3, null), board(4, 2)], 2);
    expect(rows.managed).toBe(true);
    expect(ids(rows.sessions)).toEqual([2, 4, 1]);
    expect(rows.loose).toBeUndefined();
  });

  it('shows the current board outside the bar as loose, and counts the others', () => {
    const rows = barRows([board(1, 1), board(2, null), board(3, null)], 2);
    expect(rows.loose?.id).toBe(2);
    expect(rows.others).toBe(1);
  });

  it('copes with an older API that sends no sessions', () => {
    const rows = barRows([board(1, undefined), board(2, undefined), board(3, undefined)], 2);
    expect(rows.managed).toBe(false);
    expect(rows.sessions).toEqual([]);
    expect(rows.loose?.id).toBe(2);
    expect(rows.others).toBe(2);
  });

  it('keeps managing an emptied bar, so boards can still be added (s15t42)', () => {
    const rows = barRows([board(1, null, ago(HOUR)), board(2, null)], 1);
    expect(rows.managed).toBe(true);
    expect(rows.sessions).toEqual([]);
    expect(rows.loose?.id).toBe(1);
    expect(rows.others).toBe(1);
  });

  it('has nothing to show without boards', () => {
    expect(barRows([], undefined)).toEqual({
      managed: false,
      sessions: [],
      loose: undefined,
      others: 0,
    });
  });
});

describe('allBoardsOrder', () => {
  it('lists sessions by position, then the rest by last viewed, never viewed last', () => {
    const order = allBoardsOrder([
      board(1, null, ago(DAY)),
      board(2, 2, ago(DAY)),
      board(3, null),
      board(4, 1),
      board(5, null, ago(HOUR)),
      board(6, null),
    ]);
    expect(ids(order)).toEqual([4, 2, 5, 1, 6, 3]);
  });
});

describe('lastViewedLabel', () => {
  it('names each bucket', () => {
    expect(lastViewedLabel(ago(DAY * 3), NOW, true)).toBe('viewing now');
    expect(lastViewedLabel(null, NOW, false)).toBe('never viewed');
    expect(lastViewedLabel(undefined, NOW, false)).toBe('never viewed');
    expect(lastViewedLabel(ago(0), NOW, false)).toBe('viewed just now');
    expect(lastViewedLabel(ago(MIN - 1), NOW, false)).toBe('viewed just now');
    expect(lastViewedLabel(ago(MIN), NOW, false)).toBe('viewed 1m ago');
    expect(lastViewedLabel(ago(HOUR - 1), NOW, false)).toBe('viewed 59m ago');
    expect(lastViewedLabel(ago(HOUR), NOW, false)).toBe('viewed 1h ago');
    expect(lastViewedLabel(ago(DAY - 1), NOW, false)).toBe('viewed 23h ago');
    expect(lastViewedLabel(ago(DAY), NOW, false)).toBe('viewed yesterday');
    expect(lastViewedLabel(ago(2 * DAY - 1), NOW, false)).toBe('viewed yesterday');
    expect(lastViewedLabel(ago(2 * DAY), NOW, false)).toBe('viewed 2 days ago');
    expect(lastViewedLabel(ago(10 * DAY), NOW, false)).toBe('viewed 10 days ago');
  });
});

describe('lastViewedBoard', () => {
  it('picks the bar board viewed last, so a board taken out of the bar is not reopened', () => {
    // Board 2 was viewed last but is no longer in the bar.
    expect(
      lastViewedBoard([board(1, 1, ago(DAY)), board(2, null, ago(HOUR)), board(3, 2, ago(2 * DAY))])
        ?.id,
    ).toBe(1);
    // In the bar but never viewed: the first in bar order.
    expect(lastViewedBoard([board(1, 2), board(2, null, ago(HOUR)), board(3, 1)])?.id).toBe(3);
  });

  it('falls back to the board viewed last when the bar is empty, else the first board', () => {
    expect(lastViewedBoard([board(1, null, ago(DAY)), board(2, null, ago(HOUR))])?.id).toBe(2);
    expect(lastViewedBoard([board(1, null), board(2, null)])?.id).toBe(1);
    expect(lastViewedBoard([board(1, undefined), board(2, undefined)])?.id).toBe(1);
    expect(lastViewedBoard([])).toBeUndefined();
  });
});

describe('writeSequence', () => {
  it('applies answers in send order and drops one older than an answer already applied', () => {
    const writes = writeSequence();
    const first = writes.next();
    const second = writes.next();
    expect(writes.accept(second)).toBe(true);
    expect(writes.accept(first)).toBe(false);
    const third = writes.next();
    expect(writes.accept(third)).toBe(true);
    expect(writes.accept(third)).toBe(false);
  });
});

describe('withSessions', () => {
  it('patches positions and view times, and takes boards missing from the answer out of the bar', () => {
    const me: Me = {
      email: 'dev@example.com',
      boards: [board(1, 1, ago(DAY)), board(2, 2, ago(HOUR)), board(3, null)],
    };
    const next = withSessions(me, [
      { boardId: 1, position: null, lastViewedAt: ago(DAY) },
      { boardId: 3, position: 1, lastViewedAt: ago(0) },
    ]);
    expect(next.email).toBe('dev@example.com');
    expect(next.boards.map((b) => [b.id, b.position, b.lastViewedAt])).toEqual([
      [1, null, ago(DAY)],
      [2, null, ago(HOUR)],
      [3, 1, ago(0)],
    ]);
  });
});

describe('opening a board not in the bar (s15t46)', () => {
  it('shows it as the dashed row right away and leaves the bar as it was', () => {
    const me: Me = {
      email: 'dev@example.com',
      boards: [board(1, 1, ago(DAY)), board(2, null, null)],
    };
    // The answer to POST /viewed: board 2 has a view time and no place.
    const next = withSessions(me, [
      { boardId: 1, position: 1, lastViewedAt: ago(DAY) },
      { boardId: 2, position: null, lastViewedAt: ago(0) },
    ]);
    const rows = barRows(next.boards, 2);
    expect(ids(rows.sessions)).toEqual([1]);
    expect(rows.loose?.id).toBe(2);
  });
});
