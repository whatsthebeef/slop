import type { List } from '@slop/core';

/** The board's names for its lists: column headings, and the glob view header's label beside the ID. */
export const LIST_TITLES: Record<List, string> = {
  planning: 'Planning',
  doing: 'Doing',
  reviewing: 'Reviewing',
  signed_off: 'Signed Off',
};
