import { CATEGORIES, isValidCombination, machine } from '@slop/core';
import type { Category, EditFailure, Role, SlopType } from '@slop/core';
import type { GlobChanges, GlobView } from './api';

export interface TypeAction {
  readonly to: SlopType;
  readonly label: string;
  /** What follows from pressing it. */
  readonly tip: string;
}

const LABELS: Record<SlopType, string> = { sub: 'Make it a sub', same: 'Make it a same', super: 'Pair on it' };

const tipFor = (to: SlopType, glob: Pick<GlobView, 'after'>): string => {
  if (to === 'sub') {
    const after = glob.after ?? [];
    return `${after.length > 0 ? `Waits for ${after.join(', ')} to merge, then starts` : 'Starts'} a routine run${after.length > 0 ? '' : ' now'} and merges itself when ready.`;
  }
  return to === 'same' ? 'A person merges it.' : 'You and the PO work on it together; no routine run.';
};

/** The type changes the server allows from here, as buttons; none are offered that it would refuse. */
export const typeActions = (glob: GlobView, role: Role): TypeAction[] =>
  machine.allowedTypeChanges(glob, role).map(({ to }) => ({ to, label: LABELS[to], tip: tipFor(to, glob) }));

/** Why the type can't change now, for the tooltip on the type label (null when a change is offered). */
export const typeChangeBlocker = (glob: GlobView, role: Role): string | null => {
  if (typeActions(glob, role).length > 0) return null;
  if (glob.type === 'sub') return 'A sub can only become a same before it merges';
  if (glob.type === 'same' && glob.status !== 'planning' && machine.sameSuperSwapBlocker(glob) === null && (role === 'qa' || role === 'po')) {
    return 'QA and PO members cannot create supers';
  }
  return machine.sameSuperSwapBlocker(glob) ?? 'The type can no longer change';
};

/** What pressing Make it a sub says first. */
export const subConfirmation = (action: TypeAction): string => `Make it a sub? ${action.tip}`;

/** The change a type action sends. */
export const typeActionChanges = (action: TypeAction): GlobChanges => ({ type: action.to });

/** The categories the glob's type allows. */
export const categoryOptions = (type: SlopType): Category[] => CATEGORIES.filter((c) => isValidCombination(type, c));

export type CategorySave =
  | { readonly saved: true; readonly undo: Category }
  | { readonly saved: false; readonly failure: EditFailure };

/** Saves a category change at once. The caller keeps showing the old value when it is refused. */
export const saveCategory = async (
  update: (changes: GlobChanges) => Promise<EditFailure | null>,
  from: Category,
  to: Category,
): Promise<CategorySave> => {
  const failure = await update({ category: to });
  return failure === null ? { saved: true, undo: from } : { saved: false, failure };
};
