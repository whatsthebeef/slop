/**
 * Board sessions: a person's board bar, an ordered list of the boards they keep open (like tmux sessions), and when
 * they last opened each board. Personal state: never shown to other members.
 */
export interface BoardSession {
  readonly boardId: number;
  /** 1-based place in the bar; null when the board isn't in it. */
  readonly position: number | null;
  /** When the person last opened the board in the web app; null if never. */
  readonly lastViewedAt: string | null;
}

/** Board IDs in bar order, by position. Gaps (left when a membership goes) are tolerated; ties fall back to board ID. */
export const sessionOrder = (sessions: readonly BoardSession[]): number[] =>
  sessions
    .flatMap((s) => (s.position === null ? [] : [{ boardId: s.boardId, position: s.position }]))
    .sort((a, b) => a.position - b.position || a.boardId - b.boardId)
    .map((s) => s.boardId);

/** The order with `boardId` at the end; unchanged if it's already in the bar. */
export const appendSession = (order: readonly number[], boardId: number): number[] =>
  order.includes(boardId) ? [...order] : [...order, boardId];

/** The order without `boardId`; unchanged if it isn't there. Positions become 1..n when written. */
export const removeSession = (order: readonly number[], boardId: number): number[] =>
  order.filter((id) => id !== boardId);

/** True when the stored positions are exactly 1..n, so writing `order` would change nothing. */
export const isContiguous = (sessions: readonly BoardSession[]): boolean => {
  const positions = sessions
    .flatMap((s) => (s.position === null ? [] : [s.position]))
    .sort((a, b) => a - b);
  return positions.every((p, i) => p === i + 1);
};

/** The sessions as shown: positions renumbered 1..n in bar order, so a stored gap never shows. */
export const displaySessions = (sessions: readonly BoardSession[]): BoardSession[] => {
  const order = sessionOrder(sessions);
  return sessions.map((s) => {
    const index = order.indexOf(s.boardId);
    return { ...s, position: index === -1 ? null : index + 1 };
  });
};
