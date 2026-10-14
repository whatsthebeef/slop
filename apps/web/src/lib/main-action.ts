import type { Action } from '@slop/core';
import { actionPresentation } from './action-presentation';
import type { GlobView } from './api';

type Subject = Pick<GlobView, 'type' | 'status' | 'implementer' | 'pr'> & Partial<Pick<GlobView, 'runs'>>;

/** The machine failed this many runs in a row for the same cause: another retry is unlikely to help, so a person steps in. */
export const REPEATED_FAILURES = 2;

/**
 * Whether the glob's latest runs all failed for the same cause since the last one that didn't. The cause is the kind of run
 * (an implementing run, a conflict fix, an investigation): a conflict fix that fails again is the same failure.
 */
export const failedRepeatedly = (glob: Pick<Subject, 'runs'>): boolean => {
  const runs = glob.runs ?? [];
  // A run in progress is the machine working: nothing is failing right now.
  if (runs.at(-1)?.state !== 'ended') return false;
  const ended = runs.filter((run) => run.state === 'ended');
  const last = ended.at(-1);
  if (last === undefined || last.outcome !== 'failed') return false;
  let streak = 0;
  for (const run of [...ended].reverse()) {
    if (run.outcome === 'superseded') continue;
    if (run.outcome !== 'failed' || run.purpose !== last.purpose) break;
    streak += 1;
  }
  return streak >= REPEATED_FAILURES;
};

/** The ways a person takes the glob over from the machine. */
const TAKE_OVERS: readonly Action[] = ['take_over', 'pick_up'];

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
 * shows no actions row at all). Pick up leads only where the presentation says so: a super in Planning, or a decision.
 * With `stepFirst` (a blocking human step is due for the viewer) only a recovery still leads: the step is the main button.
 */
export const mainAction = (
  available: readonly Action[],
  glob: Subject,
  decision = false,
  stepFirst = false,
  viewer?: string,
  /** The action a stalled glob's step names: it leads whatever the usual order says. */
  preferred?: Action,
): Action | null => {
  if (preferred !== undefined && available.includes(preferred)) return preferred;
  // The machine has failed again after a retry: a person takes over, and Retry moves into the menu.
  if (failedRepeatedly(glob)) {
    const person = TAKE_OVERS.find((action) => available.includes(action));
    if (person !== undefined) return person;
  }
  const candidate = (action: Action): boolean => {
    if (!available.includes(action) || NEVER_MAIN.includes(action)) return false;
    return actionPresentation(action, glob, decision, viewer).placement === 'main';
  };
  return (stepFirst ? FIXES : [...FIXES, ...NEXT_STEPS]).find(candidate) ?? null;
};
