import type { Category, List, SlopType, Status } from './types.js';

const ALLOWED: Record<Category, readonly SlopType[]> = {
  feature: ['sub', 'same', 'super'],
  task: ['sub', 'same', 'super'],
  bug: ['sub', 'same'],
  /** Decisions never run, branch or merge: always a same, and the type can't change. */
  decision: ['same'],
};

/** The type/category matrix: bugs are never supers. */
export const isValidCombination = (type: SlopType, category: Category): boolean =>
  ALLOWED[category].includes(type);

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
