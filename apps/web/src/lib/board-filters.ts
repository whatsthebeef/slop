import { decisionOf, isMine } from '@slop/core';
import type { Glob, Role } from '@slop/core';

/** The board's filter chips: Work and Decisions pick the kinds of glob shown, Mine narrows to the signed-in person's. */
export const BOARD_FILTERS = ['work', 'decisions', 'mine'] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

/** What each role sees first: developers and QA the work, POs the decisions, admins both. */
export const defaultFilters = (role: Role): readonly BoardFilter[] => {
  switch (role) {
    case 'po':
      return ['decisions'];
    case 'admin':
      return ['work', 'decisions'];
    case 'dev':
    case 'qa':
      return ['work'];
  }
};

/**
 * The globs a set of chips shows. A rejected or closed decision (archived) never shows. With neither Work nor Decisions
 * on, every kind shows, so a lone Mine chip, or no chip, hides nothing it should not.
 */
export const filterGlobs = <T extends Glob>(globs: readonly T[], filters: readonly BoardFilter[], email: string): T[] => {
  const work = filters.includes('work');
  const decisions = filters.includes('decisions');
  const everything = !work && !decisions;
  return globs.filter((glob) => {
    const attributes = decisionOf(glob);
    if (attributes?.archived === true) return false;
    if (filters.includes('mine') && !isMine(glob, email)) return false;
    return everything || (attributes === null ? work : decisions);
  });
};

/** Toggles one chip. */
export const toggleFilter = (filters: readonly BoardFilter[], chip: BoardFilter): BoardFilter[] =>
  filters.includes(chip) ? filters.filter((f) => f !== chip) : [...filters, chip];

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const keyOf = (boardId: number) => `slop.board-filters.${String(boardId)}`;

/** The browser's store, or null where it can't be used (blocked, or a private window). */
const browserStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The chips saved for the board, else the role's defaults. Anything unreadable falls back to the defaults. */
export const loadFilters = (boardId: number, role: Role, store: Store | null = browserStore()): readonly BoardFilter[] => {
  try {
    const raw = store?.getItem(keyOf(boardId)) ?? null;
    if (raw === null) return defaultFilters(role);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultFilters(role);
    return BOARD_FILTERS.filter((chip) => parsed.includes(chip));
  } catch {
    return defaultFilters(role);
  }
};

/** Remembers the chips for the board; a store that can't be written to changes nothing. */
export const saveFilters = (boardId: number, filters: readonly BoardFilter[], store: Store | null = browserStore()): void => {
  try {
    store?.setItem(keyOf(boardId), JSON.stringify(filters));
  } catch {
    // The chips just won't be remembered.
  }
};
