import type { Action } from '@slop/core';

/** How an action button looks: one filled primary, outlined secondaries, danger-styled destructive ones last. */
export type ActionTier = 'primary' | 'secondary' | 'destructive';

/** The actions that undo or remove work. */
const DESTRUCTIVE: readonly Action[] = ['start_again', 'delete'];

/** The next-step actions, most important first: the first one available is the glob's primary. */
const PRIMARY_ORDER: readonly Action[] = [
  'merge',
  'merge_continue',
  'retry_merge',
  'mark_ready',
  'resolve_conflict',
  'retry_autofix',
  'start',
  'make_super',
  'pick_up',
  'retrigger',
];

/** The tier of each available action: at most one primary, then secondary, then destructive. */
export const actionTiers = (available: readonly Action[]): Map<Action, ActionTier> => {
  const primary = PRIMARY_ORDER.find((a) => available.includes(a));
  return new Map(
    available.map((a) => [
      a,
      DESTRUCTIVE.includes(a) ? 'destructive' : a === primary ? 'primary' : 'secondary',
    ]),
  );
};

const RANK: Record<ActionTier, number> = { primary: 0, secondary: 1, destructive: 2 };

/** The actions in row order: primary first, then secondary, then destructive (stable within a tier). */
export const orderActions = (available: readonly Action[]): Action[] => {
  const tiers = actionTiers(available);
  return [...available].sort(
    (a, b) => RANK[tiers.get(a) ?? 'secondary'] - RANK[tiers.get(b) ?? 'secondary'],
  );
};
