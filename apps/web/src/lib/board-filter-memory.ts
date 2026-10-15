import { BOARD_FILTERS, LEGACY_KEYS } from './board-filters';

/** The part of `Storage` the memory uses, so tests can pass a fake. */
export interface FilterStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyFor = (boardId: number): string => `slop.board-filters.${String(boardId)}`;

/** The browser's storage, or undefined when it is unavailable (private mode, blocked site data). */
export const browserStore = (): FilterStore | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** Only the filters' parameters of a query, in their URL form. */
export const filterParams = (params: URLSearchParams): URLSearchParams => {
  const only = new URLSearchParams();
  for (const key of [...BOARD_FILTERS.map((f) => f.key), ...LEGACY_KEYS]) {
    const value = params.get(key);
    if (value !== null) only.set(key, value);
  }
  return only;
};

/** True when the query carries any filter parameter (so it wins over the remembered ones). */
export const hasFilterParams = (params: URLSearchParams): boolean => filterParams(params).size > 0;

/** The board's remembered filters, or null when none are stored or storage fails. */
export const loadFilterMemory = (
  store: FilterStore | undefined,
  boardId: number,
): URLSearchParams | null => {
  try {
    const raw = store?.getItem(keyFor(boardId)) ?? null;
    if (raw === null) return null;
    const saved = filterParams(new URLSearchParams(raw));
    return saved.size > 0 ? saved : null;
  } catch {
    return null;
  }
};

/** Remembers the filters in this query for the board; a query without any clears the memory. */
export const saveFilterMemory = (
  store: FilterStore | undefined,
  boardId: number,
  params: URLSearchParams,
): void => {
  const only = filterParams(params);
  if (only.size === 0) {
    clearFilterMemory(store, boardId);
    return;
  }
  try {
    store?.setItem(keyFor(boardId), only.toString());
  } catch {
    // Storage full or blocked: the filters just aren't remembered.
  }
};

export const clearFilterMemory = (store: FilterStore | undefined, boardId: number): void => {
  try {
    store?.removeItem(keyFor(boardId));
  } catch {
    // Nothing to clear if storage is blocked.
  }
};
