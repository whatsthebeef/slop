import type { Category } from './types.js';

/** ID letters. `h` (hotfix) is reserved and `k` is used by KB items. */
export type IdLetter = 'f' | 't' | 'b' | 'h' | 'k';

export const letterOf = (category: Category): IdLetter =>
  category === 'feature' ? 'f' : category === 'task' ? 't' : 'b';

export const formatId = (boardId: number, letter: IdLetter, n: number): string =>
  `s${boardId}${letter}${n}`;

const ID_PATTERN = /^s([1-9]\d*)([ftbhk])([1-9]\d*)$/;

export interface ParsedId {
  readonly boardId: number;
  readonly letter: IdLetter;
  readonly n: number;
}

const isIdLetter = (value: string): value is IdLetter => 'ftbhk'.includes(value);

export const parseId = (id: string): ParsedId | null => {
  const match = ID_PATTERN.exec(id);
  if (!match) return null;
  const [, board, letter, n] = match;
  if (board === undefined || letter === undefined || n === undefined || !isIdLetter(letter)) {
    return null;
  }
  return { boardId: Number(board), letter, n: Number(n) };
};
