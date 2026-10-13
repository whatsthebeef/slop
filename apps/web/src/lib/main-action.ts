import type { Action } from '@slop/core';
import { actionPresentation } from './action-presentation';
import type { GlobView } from './api';

type Subject = Pick<GlobView, 'type' | 'status' | 'implementer' | 'pr'>;

/** Recoveries first, most specific to least: a conflict hides the checks, failed checks hide a failed merge. */
const FIXES: readonly Action[] = ['resolve_conflict', 'retry_autofix', 'retry_merge', 'retrigger'];

/** Otherwise the state's next step: land it, hand it in, start it, or work through a decision. */
const NEXT_STEPS: readonly Action[] = [
  'merge',
  'mark_ready',
  'start',
  'pick_up',
  'decide',
  'sign_off',
];

/** Never the main button: they jump ahead, throw work away or remove the glob. */
const NEVER_MAIN: readonly Action[] = ['start_anyway', 'start_again', 'delete'];

/**
 * The one expected next step among the allowed actions, or null when nothing qualifies (the glob view then
 * shows only More). Pick up leads only where the presentation says so: a super in Planning, or a decision.
 * With `stepFirst` (a blocking human step is due for the viewer) only a recovery still leads: the step is the main button.
 */
export const mainAction = (
  available: readonly Action[],
  glob: Subject,
  decision = false,
  stepFirst = false,
): Action | null => {
  const candidate = (action: Action): boolean => {
    if (!available.includes(action) || NEVER_MAIN.includes(action)) return false;
    return actionPresentation(action, glob, decision).placement === 'main';
  };
  return (stepFirst ? FIXES : [...FIXES, ...NEXT_STEPS]).find(candidate) ?? null;
};
