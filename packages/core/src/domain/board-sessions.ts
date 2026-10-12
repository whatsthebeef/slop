/**
 * Board sessions: a person's board bar, the boards they keep open, each with its own number (like tmux windows), and when
 * they last opened each board. Personal state: never shown to other members.
 */
export interface BoardSession {
  readonly boardId: number;
  /** The session's stable number in the bar, kept until it is removed (gaps stay); null when the board isn't in it. */
  readonly position: number | null;
  /** When the person last opened the board in the web app; null if never. */
  readonly lastViewedAt: string | null;
}

/** The lowest positive number not in `positions` (nulls ignored): 1 if free, else the first gap, else one past the highest. */
export const nextFreePosition = (positions: readonly (number | null)[]): number => {
  const taken = new Set(positions);
  let n = 1;
  while (taken.has(n)) n += 1;
  return n;
};
