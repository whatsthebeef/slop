import type { BoardSession } from '@slop/core';
import type { BoardView, Me } from '@/lib/api';

export interface BarRows {
  /** False against an older API that doesn't send sessions: the bar can't add or remove then. */
  readonly managed: boolean;
  /** Your sessions, in bar order. */
  readonly sessions: readonly BoardView[];
  /** The current board when it isn't a session (opened from a link, or just removed): shown with an add button. */
  readonly loose: BoardView | undefined;
  /** Behind More boards: the boards not in the bar, but the current one; most recently viewed first, never viewed last. */
  readonly more: readonly BoardView[];
}

const viewedAt = (b: BoardView): number => {
  const at = b.lastViewedAt ?? null;
  return at === null ? Number.NEGATIVE_INFINITY : Date.parse(at);
};

/** Splits your boards into the bar's rows. */
export const barRows = (boards: readonly BoardView[], current: number | undefined): BarRows => {
  const managed = boards.some((b) => b.position !== undefined);
  const sessions = boards
    .filter((b) => (b.position ?? null) !== null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id - b.id);
  const rest = boards.filter((b) => (b.position ?? null) === null);
  const loose = rest.find((b) => b.id === current);
  const more = rest
    .filter((b) => b.id !== current)
    .sort((a, b) => viewedAt(b) - viewedAt(a) || b.id - a.id);
  return { managed, sessions, loose, more };
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "viewing now", "viewed 12m ago", "viewed yesterday", …: elapsed time only, so it doesn't depend on the time zone. */
export const lastViewedLabel = (
  at: string | null | undefined,
  now: number,
  viewing: boolean,
): string => {
  if (viewing) return 'viewing now';
  if (at === null || at === undefined) return 'never viewed';
  const elapsed = now - Date.parse(at);
  if (Number.isNaN(elapsed)) return 'never viewed';
  if (elapsed < MINUTE) return 'viewed just now';
  if (elapsed < HOUR) return `viewed ${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `viewed ${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 2 * DAY) return 'viewed yesterday';
  return `viewed ${Math.floor(elapsed / DAY)} days ago`;
};

/**
 * Where `/` goes: of the boards in your bar, the one you viewed last (so a board you took out of the bar isn't put
 * back); with an empty bar, the board you viewed last; else your first board.
 */
export const lastViewedBoard = (boards: readonly BoardView[]): BoardView | undefined => {
  const newest = (list: readonly BoardView[]) =>
    list.reduce<BoardView | undefined>(
      (best, b) => (best === undefined || viewedAt(b) > viewedAt(best) ? b : best),
      undefined,
    );
  const { sessions } = barRows(boards, undefined);
  if (sessions.length > 0) return newest(sessions);
  const viewed = boards.filter((b) => (b.lastViewedAt ?? null) !== null);
  return newest(viewed) ?? boards[0];
};

/**
 * Orders the bar's session writes: each takes a number when it is sent, and its answer is applied only if no later
 * write's answer has been, so two writes answering out of order can't leave the older bar in the cache.
 */
export const writeSequence = () => {
  let sent = 0;
  let applied = 0;
  return {
    next: (): number => ++sent,
    /** True if the answer to write `n` is the newest so far (and records it as applied). */
    accept: (n: number): boolean => {
      if (n <= applied) return false;
      applied = n;
      return true;
    },
  };
};

/** The /api/me cache with a session write's answer applied; a board missing from it isn't in the bar. */
export const withSessions = (me: Me, sessions: readonly BoardSession[]): Me => {
  const byId = new Map(sessions.map((s) => [s.boardId, s]));
  return {
    ...me,
    boards: me.boards.map((b) => {
      const session = byId.get(b.id);
      return {
        ...b,
        position: session?.position ?? null,
        lastViewedAt: session === undefined ? (b.lastViewedAt ?? null) : session.lastViewedAt,
      };
    }),
  };
};
