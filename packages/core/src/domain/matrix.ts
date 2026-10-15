import type { Category, List, SlopType, Status, WorkKind } from './types.js';
import { defaultFix } from './types.js';

/**
 * Code work takes any type; human work (decision, action) takes none. A glob with the fix flag is never a super (fixing
 * something broken needs no pairing). `fix` defaults to the category's (bug), for callers that only know the category.
 */
export const isValidCombination = (type: SlopType | null, category: Category, fix: boolean = defaultFix(category)): boolean => {
  if (category === 'decision' || category === 'action') return type === null;
  return type !== null && !(fix && type === 'super');
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

/**
 * Whether time on a glob counts as R&D: its work kind, else (a record or event from before work kinds) its category, where
 * features are R&D and tasks and bugs are maintenance. A bare category is still accepted.
 */
export const isRnd = (g: Category | { readonly category: Category; readonly workKind?: WorkKind | undefined }): boolean =>
  typeof g === 'string' ? g === 'feature' : (g.workKind ?? (g.category === 'feature' ? 'rnd' : 'maintenance')) === 'rnd';
