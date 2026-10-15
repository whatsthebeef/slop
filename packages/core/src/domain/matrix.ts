import type { Category, List, SlopType, Status, WorkCategory } from './types.js';

const ALLOWED: Record<WorkCategory, readonly SlopType[]> = {
  feature: ['sub', 'same', 'super'],
  task: ['sub', 'same', 'super'],
  bug: ['sub', 'same'],
};

/** Code work takes one of its allowed types; human work (decision, action) takes none. Bugs are never supers. */
export const isValidCombination = (type: SlopType | null, category: Category): boolean => {
  if (category === 'decision' || category === 'action') return type === null;
  return type !== null && ALLOWED[category].includes(type);
};

export const LIST_OF_STATUS: Record<Status, List> = {
  planning: 'planning',
  implementing: 'doing',
  in_progress: 'doing',
  failed: 'doing',
  pr_open: 'doing',
  merging: 'doing',
  reviewing: 'reviewing',
  signed_off: 'signed_off',
};

export const listOf = (status: Status): List => LIST_OF_STATUS[status];

/** Features are RnD; tasks and bugs are maintenance. */
export const isRnd = (category: Category): boolean => category === 'feature';
