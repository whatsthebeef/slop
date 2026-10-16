import { isHumanCategory } from '../types.js';
import type { Action } from '../machine.js';
import type { HumanStepViewer } from '../human-steps.js';
import { actionPresentation, isReviewRetry, presentedActions } from './action-presentation.js';
import type { PresentableGlob } from './facts.js';
import { mainStep } from './human-steps.js';

type Subject = Pick<PresentableGlob, 'type' | 'status' | 'implementer' | 'pr'> &
  Partial<Pick<PresentableGlob, 'runs' | 'artifacts'>>;

/** The machine has failed this many runs in a row (a retry included, whatever the cause): another retry is unlikely to help, so a person steps in. */
export const REPEATED_FAILURES = 2;

/**
 * Whether the glob's latest runs failed back to back since the last one that didn't: a Retry was used and failed again.
 * Superseded runs are skipped; a run that ended another way, or one still in progress, ends the streak.
 */
export const failedRepeatedly = (glob: Pick<Subject, 'runs'>): boolean => {
  const runs = glob.runs ?? [];
  // A run in progress is the machine working: nothing is failing right now.
  if (runs.at(-1)?.state !== 'ended') return false;
  let streak = 0;
  for (const run of [...runs].reverse()) {
    if (run.outcome === 'superseded') continue;
    if (run.outcome !== 'failed') break;
    streak += 1;
  }
  return streak >= REPEATED_FAILURES;
};

/** The ways a person takes the glob over from the machine. */
const TAKE_OVERS: readonly Action[] = ['take_over', 'pick_up'];

/** Recoveries first, most specific to least: a conflict hides the checks, failed checks hide a failed merge. */
const FIXES: readonly Action[] = ['resolve_conflict', 'retry_autofix', 'retry_merge', 'retrigger'];

/** Otherwise the state's next step: land it, hand it in, start it, work through a decision, or do an action. */
const NEXT_STEPS: readonly Action[] = [
  'merge_continue',
  'merge',
  'mark_ready',
  'start',
  'prepare_action',
  'pick_up',
  'decide',
  'sign_off',
  'complete_action',
];

/** Never the main button: they jump ahead, throw work away or remove the glob. */
const NEVER_MAIN: readonly Action[] = [
  'start_anyway',
  'merge_anyway',
  'sign_off_anyway',
  'start_again',
  'delete',
];

/** Led with only when nothing else is left, so a glob held for a merge or sign-off still has its ▾ and the way to force it through. */
const LAST_RESORT: readonly Action[] = ['merge_anyway', 'sign_off_anyway'];

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
  // Unless it has moved on since: a person fixed it, so landing it (Merge, or Mark ready) is allowed and leads instead.
  const movedOn =
    available.includes('merge') ||
    available.includes('mark_ready') ||
    (glob.type !== 'super' && available.includes('merge_continue'));
  if (!stepFirst && !movedOn && failedRepeatedly(glob)) {
    const person = TAKE_OVERS.find((action) => available.includes(action));
    if (person !== undefined) return person;
  }
  // A same (or super) is the person's to own: while the machine implements it, stepping in leads and Review code waits in the menu.
  if (
    !stepFirst &&
    glob.type !== 'sub' &&
    glob.status === 'implementing' &&
    available.includes('take_over')
  )
    return 'take_over';
  const candidate = (action: Action): boolean => {
    if (!available.includes(action) || NEVER_MAIN.includes(action)) return false;
    return actionPresentation(action, glob, decision, viewer).placement === 'main';
  };
  return (stepFirst ? FIXES : [...FIXES, ...NEXT_STEPS]).find(candidate) ?? null;
};

/** The actions the glob view lists (main button and More menu) for this viewer: the allowed ones it presents, never Delete or one with no placement. */
export const viewActions = (glob: PresentableGlob, email?: string): Action[] =>
  presentedActions(glob.allowedActions ?? []).filter(
    (a) => a !== 'delete' && actionPresentation(a, glob, false, email).placement !== 'none',
  );

/** The action a stalled glob's step names to lead with, if any. */
export const leadingAction = (glob: Pick<PresentableGlob, 'humanSteps'>): Action | undefined => {
  const stall = glob.humanSteps?.find((s) => s.kind === 'unstick');
  return stall?.action === undefined || stall.action === 'open_session' ? undefined : stall.action;
};

/**
 * The natural main action of the glob view for this viewer (null when none leads). The glob view's primary button and the
 * board card's primary button both read it, so they never disagree.
 */
export const viewMainAction = (glob: PresentableGlob, viewer?: HumanStepViewer): Action | null =>
  mainAction(
    viewActions(glob, viewer?.email),
    glob,
    isHumanCategory(glob.category),
    mainStep(glob, viewer) !== null,
    viewer?.email,
    leadingAction(glob),
  );

/** Promoted in this order when nothing is the natural main: undo what the person just started, retry a missing review, then step in. */
const PROMOTION: readonly Action[] = ['cancel_merge', 'review_now', 'take_over', 'pick_up'];

/**
 * The menu item to lead with when `mainAction` finds no natural main, so the split button never shows a lone ▾:
 * Cancel merge, Retry review, Pick up, else the first remaining item; none while the glob is merging. Never a destructive action (those stay in the
 * Reset area), and a person's own Review code only as the last resort (only the retry of a missing review leads). Null when
 * nothing is left, and the row then shows no actions.
 */
export const promotedAction = (available: readonly Action[], glob: Subject): Action | null => {
  // Merging is waiting for the checks: nothing is the thing to do, so no retry or review button reads as the next step.
  if (glob.status === 'merging') return null;
  const rest = available.filter((a) => !NEVER_MAIN.includes(a));
  const leading = rest.filter((a) => a !== 'review_now' || isReviewRetry(glob));
  // Only when nothing else is left does a person's own Review code lead, so the row isn't empty.
  return (
    PROMOTION.find((a) => leading.includes(a)) ??
    leading[0] ??
    rest[0] ??
    LAST_RESORT.find((a) => available.includes(a)) ??
    null
  );
};

/**
 * Whether the main button shows as an outline: a sub the machine is implementing and making progress on, where Pick up is
 * there to step in but a stopped healthy run is not what anyone wants. Stalled, it turns black.
 */
export const mainVariant = (
  main: Action | null,
  glob: Subject,
  stalled: boolean,
): 'default' | 'outline' =>
  !stalled &&
  glob.type === 'sub' &&
  (main === 'take_over' || main === 'pick_up') &&
  (glob.status === 'implementing' || glob.status === 'pr_open') &&
  glob.pr?.state !== 'merged'
    ? 'outline'
    : 'default';
