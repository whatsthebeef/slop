import { decisionOf } from './decision-glob.js';
import type { HumanStepViewer } from './human-steps.js';
import type { Action } from './machine.js';
import { pendingInForce, pendingTimedOut } from './pending-action.js';
import { activityOf } from './present/activity.js';
import type { ActivityEntry } from './present/activity.js';
import { actionPresentation, fixesBuild } from './present/action-presentation.js';
import type { ActionIcon } from './present/action-presentation.js';
import { blockingItem } from './present/blocking-item.js';
import type { BlockingItem } from './present/blocking-item.js';
import { cardTargets } from './present/card-targets.js';
import { cornerStatus, hasBlocker } from './present/corner-status.js';
import type { CornerStatus } from './present/corner-status.js';
import type { PresentableGlob } from './present/facts.js';
import {
  dueWorkSteps,
  isDismissedStep,
  mainStep,
  personSteps,
  reviewOpen,
} from './present/human-steps.js';
import {
  failedRepeatedly,
  promotedAction,
  viewActions,
  viewMainAction,
} from './present/main-action.js';
import { openQuestionsOf } from './present/open-questions.js';
import { positionOf, stepsOf } from './present/position.js';
import { isInvestigateRun, statusCandidates } from './present/status-line.js';
import type { StatusLine } from './present/status-line.js';
import type { PendingAction, Role } from './types.js';

/**
 * What every screen says about a glob, decided in one place and kept pure: the status (top right of the card and of the glob view),
 * the one primary action (glob view) and the one the card may offer, the notice that says why the last click or the glob's state needs
 * attention, the blocks that ask a person for something, and the activity wording. The board card, the glob view, the sticky bar
 * and the activity log only render this; none of them works out a status, a button or a problem of its own.
 */

/** The actions the board card may ever offer, and only as its single primary button. Everything else is the glob view's. */
export const CARD_ACTION_KINDS = ['pick_up', 'start', 'merge', 'resolve_conflict'] as const;
export type CardActionKind = (typeof CARD_ACTION_KINDS)[number];

/** What the card's primary button is: the allowed kind it stands for, the action it sends and its words. */
export interface CardPrimary {
  readonly kind: CardActionKind;
  /** What the request sends: `take_over` is a Pick up while a run is live. */
  readonly action: Action;
  readonly label: string;
  /** What it does, for the tooltip. */
  readonly tip: string;
  readonly icon: ActionIcon | null;
  /** A first click only arms the button; a second one within a few seconds sends it. */
  readonly confirm: boolean;
}

/** The kinds of notice, most urgent first within each group: how the last click ended, then what is wrong with the glob. */
export type NoticeKind =
  | 'outcome'
  | 'conflict'
  | 'build-failed'
  | 'checks'
  | 'failure'
  | 'investigation-failed'
  | 'stuck'
  | 'provisioning'
  | 'clash';

/** The one non-dismissable line beside the primary action: why the last click did not work, or the most important thing wrong. */
export interface Notice {
  readonly kind: NoticeKind;
  readonly text: string;
  /** The files behind a conflict or a clash; empty for any other notice. */
  readonly files: readonly string[];
  /** The whole sentence where `text` is cut short. */
  readonly detail: string | null;
  /** The failing check run, when the notice is about failed checks. */
  readonly url: string | null;
  /** The label of the glob's attachment the notice links to (a failed build's log), or null. */
  readonly attachment: string | null;
}

/** A block that asks a person for something: Answer a question, Decide a decision or a review, Do a step. Nothing else is a block. */
export interface PresentedBlock {
  readonly kind: 'answer' | 'decide' | 'do';
  readonly id: string;
}

export interface PresentationFacts {
  readonly glob: PresentableGlob;
  /** An ISO time. */
  readonly now: string;
  readonly viewer?: HumanStepViewer;
  /** The board's base branch, for "merging from <base>". */
  readonly base?: string;
  /** How many globs in Planning wait for this one to merge. */
  readonly waitingOnThis?: number;
  /** The code host repo, for the activity's links. */
  readonly repo?: string | null;
  /** A click this client has sent that the glob does not show yet, in the same shape as the stored one. */
  readonly pending?: PendingAction | null;
  /** False for a learning whose outcome is already in (its decision block has nothing left to decide). */
  readonly learningOpen?: boolean;
}

export interface Presentation {
  /** The status for the top right, in-progress after a click included; null when there is nothing to say. Never an action or a link. */
  readonly status: CornerStatus | null;
  /** The glob view's primary action; null while a click is pending, a block holds the glob, or nothing leads. */
  readonly primary: Action | null;
  /** The card's primary button: `primary` when it is one of Pick up, Start, Merge or Fix conflict, else null. */
  readonly cardPrimary: CardPrimary | null;
  /** The failure or problem to say beside the primary action; null while a click is pending or nothing is wrong. */
  readonly notice: Notice | null;
  /** Answer, Decide and Do blocks, never conflicts, failed checks, failures or stalls. */
  readonly blocks: readonly PresentedBlock[];
  /** The block that holds the glob's progress for this viewer (its buttons are the way forward), or null. */
  readonly blocking: BlockingItem | null;
  /** The click in force (stored or this client's), or null. */
  readonly pending: PendingAction | null;
  readonly activity: readonly ActivityEntry[];
}

/** What a glob says while a click's effect is still to show: the machine at work, in the words of what was asked. */
const IN_PROGRESS: Readonly<Partial<Record<Action, string>>> = {
  start: 'starting',
  start_anyway: 'starting',
  investigate: 'investigating',
  pick_up: 'picking up',
  take_over: 'picking up',
  retrigger: 'retrying',
  retry_autofix: 'fixing CI',
  resolve_conflict: 'fixing conflict',
  start_again: 'discarding',
  merge: 'merging',
  merge_anyway: 'merging',
  merge_continue: 'merging',
  retry_merge: 'merging',
  retry_checks: 'retrying checks',
  mark_ready: 'marking ready',
  prepare_action: 'preparing',
};

/** The in-progress words for a click; a Retry of a failed build is fixing the build, not CI. */
export const inProgressText = (action: Action, glob?: PresentableGlob): string =>
  action === 'retry_autofix' && glob !== undefined && fixesBuild(glob)
    ? 'fixing the build'
    : (IN_PROGRESS[action] ?? 'working');

/** The status of a glob with a click in force: the spinning machine and what it was asked to do, nothing to click and nothing to run. */
const pendingStatus = (glob: PresentableGlob, pending: PendingAction): CornerStatus => {
  const text = inProgressText(pending.kind, glob);
  const label = actionPresentation(pending.kind, glob).label;
  return {
    kind: 'pending',
    icon: 'machine-spinning',
    text,
    label: text,
    tip: `${label} was clicked; slop is ${text}. The result shows here when it arrives.`,
    tone: 'text-muted-foreground',
    click: cardTargets.actions(),
  };
};

/** Past this many characters a notice's sentence is cut and the whole of it goes in `detail`. */
const NOTICE_MAX = 240;

const cut = (text: string): { text: string; detail: string | null } => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= NOTICE_MAX
    ? { text: one, detail: null }
    : { text: `${one.slice(0, NOTICE_MAX - 1).trimEnd()}…`, detail: text.trim() };
};

/** Whether a machine run is working on the glob right now (alive, not stalled), so the status already says what is being done about the problem. */
const machineOnIt = (
  glob: PresentableGlob,
  now: string,
  viewer: HumanStepViewer | undefined,
  base: string | undefined,
): boolean => {
  const run = glob.currentRun;
  return (
    run != null &&
    run.state !== 'ended' &&
    !isInvestigateRun(run) &&
    positionOf(glob, now, viewer, base)?.holder === 'machine'
  );
};

/** The conflict said once: what it is, since when, the files (listed apart) and that the checks follow the fix. */
const conflictNotice = (glob: PresentableGlob): Notice | null => {
  const open = glob.conflict ?? null;
  const conflict = glob.failure?.conflict ?? open;
  if (conflict == null) return null;
  const files = conflict.files.length;
  const what =
    files === 0 ? 'some of the same files' : `${String(files)} ${files === 1 ? 'file' : 'files'}`;
  const since = open?.since == null ? '' : `Since ${open.since} merged, `;
  const both = since === '' ? `Both sides changed ${what}.` : `${since}both sides changed ${what}.`;
  return {
    kind: 'conflict',
    text: `Conflicts with ${conflict.base}. ${both} Checks will re-run once it is fixed.`,
    files: conflict.files,
    detail: null,
    url: null,
    attachment: null,
  };
};

/** The order problems are said in: a conflict, failed checks, a failed run, a stall, a branch that was not created. */
const NOTICE_ORDER = [
  'build-failed',
  'checks',
  'failure',
  'investigation-failed',
  'stuck',
  'provisioning',
] as const satisfies readonly StatusLine['kind'][];

/**
 * What the notice says: how the last click ended; otherwise the most important problem, each said once. The conflict comes first and
 * says what the failed checks would; failed checks show only when no conflict explains them; "looks stuck" is only ever the
 * sole problem's sentence. None while a click is pending, and no problem while a machine run is already on it.
 */
const noticeOf = (
  glob: PresentableGlob,
  now: string,
  viewer: HumanStepViewer | undefined,
  base: string | undefined,
  pending: PendingAction | null,
): Notice | null => {
  if (pending !== null) return null;
  const outcome = glob.lastOutcome;
  if (outcome != null) {
    const label = actionPresentation(outcome.kind, glob).label;
    const said =
      outcome.result === 'timed_out'
        ? `${label} had no effect after a minute.`
        : `${label} failed: ${outcome.reason}`;
    return { kind: 'outcome', ...cut(said), files: [], url: null, attachment: null };
  }
  // A click that was neither refused nor settled by the time it timed out: say so (it is written down by the next change).
  const stale = glob.pendingAction;
  if (stale != null && pendingTimedOut(glob, stale, now)) {
    const label = actionPresentation(stale.kind, glob).label;
    return {
      kind: 'outcome',
      text: `${label} had no effect after a minute.`,
      detail: null,
      files: [],
      url: null,
      attachment: null,
    };
  }
  if (machineOnIt(glob, now, viewer, base)) return null;
  const conflict = conflictNotice(glob);
  if (conflict !== null) return conflict;
  const { lines } = statusCandidates(glob, now, base);
  for (const kind of NOTICE_ORDER) {
    const line = lines.find((l) => l.kind === kind);
    if (line === undefined) continue;
    // A failed build links its log attachment in the glob view (when one was written), which keeps CodeBuild's link.
    const build = kind === 'build-failed' ? (glob.buildFailed ?? null) : null;
    return {
      kind,
      ...cut(line.full),
      files: [],
      url: build?.label == null ? line.url : null,
      attachment: build?.label ?? null,
    };
  }
  const clash = glob.clash ?? null;
  if (clash !== null) {
    return {
      kind: 'clash',
      text: `${clash.with} also changes some of the same files; whichever merges second will conflict.`,
      files: clash.paths,
      detail: null,
      url: null,
      attachment: null,
    };
  }
  return null;
};

/** Answer, Decide and Do: the open questions, an undecided decision or a label review waiting, and the due work steps. */
const blocksOf = (glob: PresentableGlob): PresentedBlock[] => {
  const blocks: PresentedBlock[] = openQuestionsOf(glob).map((q) => ({ kind: 'answer', id: q.id }));
  const decision = decisionOf(glob);
  if (decision !== null && decision.outcome === null) blocks.push({ kind: 'decide', id: glob.id });
  if (decision === null && reviewOpen(glob) && glob.status === 'reviewing') {
    for (const [name, state] of Object.entries(glob.labels))
      if (state !== 'approved') blocks.push({ kind: 'decide', id: `label:${name}` });
  }
  const due = dueWorkSteps(personSteps(glob.humanSteps ?? []).filter((s) => !isDismissedStep(s)));
  for (const step of due) blocks.push({ kind: 'do', id: step.id });
  return blocks;
};

/** The card's kinds of action, by what a glob's action is: Pick up covers take_over. */
const cardKindOf = (action: Action): CardActionKind | null => {
  switch (action) {
    case 'pick_up':
    case 'take_over':
      return 'pick_up';
    case 'start':
      return 'start';
    case 'merge':
      return 'merge';
    case 'resolve_conflict':
      return 'resolve_conflict';
    default:
      return null;
  }
};

/**
 * The card's one button: the glob view's primary action, when it is Pick up, Start, Merge or Fix conflict. Pick up and Start are
 * the start of work, so only in Planning (never a take-over of a failed automatic fix); Merge and Fix conflict run in place
 * after a confirming click. While anything blocks the glob only Fix conflict (the answer to a conflict) is left.
 */
const cardPrimaryOf = (
  glob: PresentableGlob,
  primary: Action | null,
  now: string,
  viewer: HumanStepViewer | undefined,
): CardPrimary | null => {
  if (primary === null || glob.provisioning === 'pending') return null;
  const kind = cardKindOf(primary);
  if (kind === null || !(glob.allowedActions ?? []).includes(primary)) return null;
  const planning = glob.list === 'planning';
  if ((kind === 'pick_up' || kind === 'start') && !planning) return null;
  if ((kind === 'merge' || kind === 'resolve_conflict') && planning) return null;
  if (kind !== 'resolve_conflict' && hasBlocker(glob, now, viewer)) return null;
  // Never Pick up for a failed automatic fix: the machine failed again, which is a stall for the glob view to say.
  if (kind === 'pick_up' && failedRepeatedly(glob)) return null;
  const shown = actionPresentation(primary, glob, false, viewer?.email);
  const inPlace = kind === 'merge' || kind === 'resolve_conflict';
  return {
    kind,
    action: primary,
    // Merge reads Merge whether it merges now or arms "merge when checks pass"; the tooltip says which.
    label: kind === 'merge' ? 'Merge' : shown.label,
    tip: `${shown.label} ${glob.id}: ${shown.tip}`,
    icon: shown.icon,
    confirm: inPlace,
  };
};

/** The glob view's primary action before a pending click or a holding block takes it away. */
const leadAction = (glob: PresentableGlob, viewer: HumanStepViewer | undefined): Action | null => {
  const natural = viewMainAction(glob, viewer);
  if (natural !== null) return natural;
  // A due step for the viewer is the next thing to do; otherwise a menu item is promoted so the split button never shows a lone arrow.
  if (mainStep(glob, viewer) !== null) return null;
  const available = viewActions(glob, viewer?.email).filter((a) => a !== 'decide');
  return promotedAction(available, glob);
};

export const presentGlob = (facts: PresentationFacts): Presentation => {
  const { glob, now, viewer } = facts;
  const stored = pendingInForce(glob, now);
  const local =
    facts.pending != null && pendingInForce({ pendingAction: facts.pending }, now) !== null
      ? facts.pending
      : null;
  const pending = stored ?? local;
  const role: Role = viewer?.role ?? 'dev';
  const blocking = blockingItem(glob, role, viewer, facts.learningOpen ?? true);
  const lead = pending !== null ? null : leadAction(glob, viewer);
  // A decision's outcomes live in its block, so Decide is never the row's button; while a block holds the glob its buttons are the way forward.
  // A block that holds a gate with an override (a question holding the merge) leaves that override as the primary: Merge anyway.
  const overridable: Action | null =
    blocking?.kind === 'question' &&
    pending === null &&
    glob.status !== 'planning' &&
    (glob.allowedActions ?? []).includes('merge_anyway')
      ? 'merge_anyway'
      : null;
  const primary =
    overridable !== null
      ? overridable
      : lead === null || blocking !== null || (decisionOf(glob) !== null && lead === 'decide')
        ? null
        : lead;
  const status =
    pending !== null
      ? pendingStatus(glob, pending)
      : cornerStatus(glob, now, viewer, facts.waitingOnThis ?? 0, facts.base);
  const human = decisionOf(glob) !== null || glob.category === 'action';
  return {
    status,
    primary,
    cardPrimary: cardPrimaryOf(glob, lead, now, viewer),
    notice: noticeOf(glob, now, viewer, facts.base, pending),
    blocks: blocksOf(glob),
    blocking,
    pending,
    activity: activityOf(glob, facts.repo ?? null, human ? [] : stepsOf(glob), viewer?.email, now),
  };
};
