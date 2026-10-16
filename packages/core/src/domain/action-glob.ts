import { isActionAttributes } from './attributes.js';
import type { ActionAttributes, ActionPreparation } from './attributes.js';
import type { Glob } from './types.js';

/** The attributes of an action glob, or null for any other glob. */
export const actionOf = (glob: Glob): ActionAttributes | null =>
  glob.category === 'action' && isActionAttributes(glob.attributes) ? glob.attributes : null;

/** The machine preparation of an action glob, or null for a plain action (and any other glob). */
export const preparationOf = (glob: Glob): ActionPreparation | null => actionOf(glob)?.preparation ?? null;

/** Whether an action's record is a branch the routine writes on (so it has a branch, a PR and slop merges it after Done). */
export const hasBranchRecord = (glob: Glob): boolean => preparationOf(glob)?.record === 'branch';

/**
 * The state of an action as the card and the glob view show it. Derived, never stored: from the status, the outcome, the
 * preparation and the PR.
 * - `open`: a plain action, a person does it from the plan.
 * - `waiting`: prepared, not started (held by a start relation, or Prepare not pressed yet).
 * - `preparing`: a preparation round is queued or running (the machine has the ball).
 * - `preparation_failed`: the round ended without a script; Retry is offered.
 * - `ready`: the person's turn: run it, then Done or Failed.
 * - `recording`: Done was pressed and the record is merging (a branch record only).
 * - `closed`: signed off, done or dismissed.
 */
export const ACTION_STATES = ['open', 'waiting', 'preparing', 'preparation_failed', 'ready', 'recording', 'closed'] as const;
export type ActionState = (typeof ACTION_STATES)[number];

/** The action's state, or null for a glob that is not an action. */
export const actionState = (glob: Glob): ActionState | null => {
  const action = actionOf(glob);
  if (action === null) return null;
  if (glob.status === 'signed_off') return 'closed';
  if (action.preparation === undefined) return 'open';
  if (action.outcome !== null) return action.outcome.kind === 'done' ? 'recording' : 'closed';
  switch (glob.status) {
    case 'planning':
      return 'waiting';
    case 'implementing':
      return 'preparing';
    case 'failed':
      return 'preparation_failed';
    case 'pr_open':
    case 'in_progress':
      return 'ready';
    default:
      return 'open';
  }
};

/** An action nobody has finished yet. */
export const isOpenAction = (glob: Glob): boolean => {
  const action = actionOf(glob);
  return action !== null && action.outcome === null;
};

/** plan.md for an action glob when the caller gives none: what a person needs to do the work and show it worked. */
export const ACTION_PLAN_TEMPLATE = `# <What a person needs to do>

## Why
<Why this is needed and what happens without it. One short paragraph.>

## Do this
<The steps. When a script does the work, give its path and the command to run it, in the rollout step format:
\`scripts/rollout/<glob-id>-<slug>.sh\` and \`bash scripts/rollout/<glob-id>-<slug>.sh\`.>

## Permissions
<What access the person needs (accounts, roles, tokens) and who can grant it.>

## Check it worked
<How the person sees that it is done, and what to note when marking it Done.>
`;
