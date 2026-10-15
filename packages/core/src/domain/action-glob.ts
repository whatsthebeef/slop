import { isActionAttributes } from './attributes.js';
import type { ActionAttributes } from './attributes.js';
import type { Glob } from './types.js';

/** The attributes of an action glob, or null for any other glob. */
export const actionOf = (glob: Glob): ActionAttributes | null =>
  glob.category === 'action' && isActionAttributes(glob.attributes) ? glob.attributes : null;

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
