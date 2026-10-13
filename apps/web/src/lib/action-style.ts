import type { Action } from '@slop/core';

/** How an action button looks: one filled primary, outlined secondaries, danger-styled destructive ones last. */
export type ActionTier = 'primary' | 'secondary' | 'destructive';

/** The actions that undo or remove work. */
const DESTRUCTIVE: readonly Action[] = ['start_again', 'delete'];

/**
 * The tier of each available action: the main action (chosen by `mainAction`) is the one primary,
 * the destructive ones are danger-styled, everything else is secondary.
 */
export const actionTiers = (
  available: readonly Action[],
  main: Action | null,
): Map<Action, ActionTier> =>
  new Map(
    available.map((a) => [
      a,
      DESTRUCTIVE.includes(a) ? 'destructive' : a === main ? 'primary' : 'secondary',
    ]),
  );

const RANK: Record<ActionTier, number> = { primary: 0, secondary: 1, destructive: 2 };

/** The actions in row order: primary first, then secondary, then destructive (stable within a tier). */
export const orderActions = (
  available: readonly Action[],
  main: Action | null,
  /** A stalled glob's one alternative: the first of the secondaries. */
  alternative?: Action,
): Action[] => {
  const tiers = actionTiers(available, main);
  const rank = (a: Action): number =>
    RANK[tiers.get(a) ?? 'secondary'] - (a === alternative && tiers.get(a) === 'secondary' ? 0.5 : 0);
  return [...available].sort((a, b) => rank(a) - rank(b));
};
