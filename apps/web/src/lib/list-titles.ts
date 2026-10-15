import type { List } from '@slop/core';

/** The board's list names, as the columns and the glob view's top bar show them. */
export const LIST_TITLES: Record<List, string> = {
  planning: 'Planning',
  doing: 'Doing',
  reviewing: 'Reviewing',
  signed_off: 'Signed Off',
};
