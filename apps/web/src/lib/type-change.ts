import { canChooseType, fixOf, isValidCombination, machine, SLOP_TYPES, WORK_KINDS, workKindOf } from '@slop/core';
import type { EditFailure, Role, SlopType, WorkKind } from '@slop/core';
import type { GlobChanges, GlobView } from './api';

/** Shown beside the type choices a non-admin can't make. */
export const CHOOSE_TYPE_TOOLTIP = 'Only board admins can choose sub or super';

/** Who acts for each type, for the icons beside it. */
const ACTORS: Record<SlopType, { readonly machine: boolean; readonly human: boolean }> = {
  sub: { machine: true, human: false },
  same: { machine: true, human: true },
  super: { machine: false, human: true },
};

const DESCRIPTIONS: Record<SlopType, string> = {
  sub: 'The machine does it all and merges it itself',
  same: 'The machine builds it; a human starts and merges it',
  super: 'A human pairs with the machine',
};

/** The endpoint a type change goes through: the glob update, or the action that also clears what the type implied. */
export type TypeVia = 'update' | 'deescalate' | 'make_super';

export interface TypeOption {
  readonly to: SlopType;
  readonly description: string;
  readonly machine: boolean;
  readonly human: boolean;
  readonly current: boolean;
  /** How the change is made; null when it is the current type or can't be made now. */
  readonly via: TypeVia | null;
  /** What follows from choosing it, said before it is confirmed. */
  readonly consequence: string | null;
  /** Why it can't be chosen now (null when it can, or when it is the current type). */
  readonly reason: string | null;
}

const consequenceFor = (to: SlopType, via: TypeVia, glob: Pick<GlobView, 'after'>): string => {
  if (to === 'sub') {
    const after = glob.after ?? [];
    const starts =
      after.length > 0 ? `Waits for ${after.join(', ')} to merge, then the machine starts it` : 'The machine starts it now';
    return `${starts} and merges it itself when ready.${via === 'deescalate' ? ' Also clears "needs a human".' : ''}`;
  }
  return to === 'same' ? 'A person merges it.' : 'You and the PO work on it together; no machine run.';
};

/** Why a type can't be chosen now, in the words the server's refusal would use. */
const blockerFor = (glob: GlobView, role: Role, to: SlopType): string => {
  if (!isValidCombination(to, glob.category, fixOf(glob))) return `A fix cannot be a ${to}`;
  if (!canChooseType(role, to)) return CHOOSE_TYPE_TOOLTIP;
  if (to === 'super' && (role === 'qa' || role === 'po')) return 'QA and PO members cannot create supers';
  const from = glob.type;
  if (from === 'sub' && to === 'same') return 'A sub can only become a same before it merges';
  if (from === 'same' && to === 'sub') {
    return glob.escalation == null
      ? 'A same can only become a sub while in planning'
      : 'An escalation can only be undone before the glob merges';
  }
  if (from === 'sub' || to === 'sub') {
    return 'A sub and a super can only be swapped while in planning with no run and nobody implementing';
  }
  return machine.sameSuperSwapBlocker(glob) ?? 'The type can no longer change';
};

/**
 * The three types as the popover lists them. A change the server would refuse is listed with the reason, never offered.
 * Before work starts it goes through the glob update; afterwards through the action that does the same and clears what the
 * old type implied (deescalate, make_super).
 */
export const typeOptions = (glob: GlobView, role: Role): TypeOption[] => {
  // Human work (decision, action) has no type to choose.
  if (glob.type === null) return [];
  const allowed = machine.allowedTypeChanges(glob, role).map((c) => c.to).filter((to) => canChooseType(role, to));
  const actions = glob.allowedActions ?? [];
  return SLOP_TYPES.map((to): TypeOption => {
    const base = { to, description: DESCRIPTIONS[to], ...ACTORS[to], current: to === glob.type };
    if (base.current) return { ...base, via: null, consequence: null, reason: null };
    const viaAction: TypeVia | null =
      glob.status === 'planning' || !canChooseType(role, to)
        ? null
        : to === 'sub' && glob.escalation != null && actions.includes('deescalate')
          ? 'deescalate'
          : to === 'super' && actions.includes('make_super')
            ? 'make_super'
            : null;
    const via: TypeVia | null = viaAction ?? (allowed.includes(to) ? 'update' : null);
    return via === null
      ? { ...base, via, consequence: null, reason: blockerFor(glob, role, to) }
      : { ...base, via, consequence: consequenceFor(to, via, glob), reason: null };
  });
};

/** True when the glob's fix flag may be turned on: a fix is never a super, and human work is never a fix. */
export const canBeFix = (glob: Pick<GlobView, 'category' | 'type'>): boolean => glob.type !== null && isValidCombination(glob.type, glob.category, true);

/** The work kinds a glob can be given: none for human work. */
export const workKindOptions = (glob: Pick<GlobView, 'type'>): readonly WorkKind[] => (glob.type === null ? [] : WORK_KINDS);

export type KindSave<T> =
  | { readonly saved: true; readonly undo: T }
  | { readonly saved: false; readonly failure: EditFailure };

/** Saves a fix flag change at once (a person's choice, which inference never overwrites). The caller keeps showing the old value when it is refused. */
export const saveFix = async (
  update: (changes: GlobChanges) => Promise<EditFailure | null>,
  from: boolean,
  to: boolean,
): Promise<KindSave<boolean>> => {
  const failure = await update({ fix: to });
  return failure === null ? { saved: true, undo: from } : { saved: false, failure };
};

/** Saves a work kind change at once (board admins only; the server refuses anyone else). */
export const saveWorkKind = async (
  update: (changes: GlobChanges) => Promise<EditFailure | null>,
  from: WorkKind,
  to: WorkKind,
): Promise<KindSave<WorkKind>> => {
  const failure = await update({ workKind: to });
  return failure === null ? { saved: true, undo: from } : { saved: false, failure };
};

/** The work kind a glob reads as (stored, else from its old category). */
export const currentWorkKind = (glob: Pick<GlobView, 'category' | 'workKind'>): WorkKind => workKindOf(glob);
