import type { Category } from './types.js';

/**
 * ID letters. `h` (hotfix) is reserved; `k` is used by KB items and the decision globs, which share one sequence per
 * board (a decision glob that fronts a KB item has the item's own ID).
 */
export type IdLetter = 'f' | 't' | 'b' | 'h' | 'k';

/** Every ID letter, for patterns. */
export const ID_LETTERS = 'ftbhk';

export const letterOf = (category: Category): IdLetter =>
  category === 'feature' ? 'f' : category === 'task' ? 't' : category === 'decision' ? 'k' : 'b';

export const formatId = (boardId: number, letter: IdLetter, n: number): string =>
  `s${boardId}${letter}${n}`;

/** A glob ID as a regex source, with no anchors or groups: the one pattern every glob-ID match in the repo builds on. */
export const GLOB_ID_SOURCE = `s[1-9]\\d*[${ID_LETTERS}][1-9]\\d*`;

/** A whole string that is a glob ID. */
export const GLOB_ID_PATTERN = new RegExp(`^${GLOB_ID_SOURCE}$`);

/** Glob IDs inside free text (a fresh regex each call, since a global regex keeps state between uses). */
export const globIdInText = (flags = 'g'): RegExp => new RegExp(`\\b${GLOB_ID_SOURCE}\\b`, flags);

const ID_PATTERN = new RegExp(`^s([1-9]\\d*)([${ID_LETTERS}])([1-9]\\d*)$`);

export interface ParsedId {
  readonly boardId: number;
  readonly letter: IdLetter;
  readonly n: number;
}

const isIdLetter = (value: string): value is IdLetter => value.length === 1 && ID_LETTERS.includes(value);

export const parseId = (id: string): ParsedId | null => {
  const match = ID_PATTERN.exec(id);
  if (!match) return null;
  const [, board, letter, n] = match;
  if (board === undefined || letter === undefined || n === undefined || !isIdLetter(letter)) {
    return null;
  }
  return { boardId: Number(board), letter, n: Number(n) };
};
