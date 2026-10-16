import { decisionOf } from '../decision-glob.js';
import {
  DEPLOY_STALLED_LABEL,
  feedbackText,
  labelsWaiting,
  openFeedback,
  signOffText,
} from '../whose-move.js';
import { isHumanCategory } from '../types.js';
import type { DecisionAttributes } from '../attributes.js';
import type { HumanStepViewer } from '../human-steps.js';
import type { PresentableGlob } from './facts.js';
import { OUTCOME_TEXT } from './outcome-text.js';
import { cardTargets } from './card-targets.js';
import { reviewOpen } from './human-steps.js';
import { sentence, tipLines } from './tip-text.js';
import type { GlobTarget } from './glob-sections.js';
import { onStandby, positionOf } from './position.js';
import {
  heldByQuestion,
  openQuestionsOf,
  questionChipTip,
  questionText,
} from './open-questions.js';
import type { Position } from './position.js';
import {
  actionLine,
  blockedParts,
  holdLine,
  isProblemLine,
  relationTips,
  statusLine,
  workstreamLine,
} from './status-line.js';
import type { StatusLine } from './status-line.js';

/**
 * What the card's status says, decided in one place and kept pure: the one status in the card's top right (also the glob view
 * header's text), whether anything blocks the glob, and the actions row. The card only renders these.
 */

/** What clicking the status does: open the glob view at a section. The status never runs an action and never opens a link. */
export type StatusClick = GlobTarget;

/** What the Your turn status opens: a stored work step (a rollout) the Human steps, a decision its block, a label its review, anything else the actions. */
const yourTurnClick = (status: StatusLine): StatusClick => {
  if (status.work === true) return cardTargets.humanSteps();
  // Mark deployed is on the Human steps section, beside the steps that wait for the deploy.
  if (status.action === 'mark_deployed') return cardTargets.humanSteps();
  switch (status.turn) {
    case 'decide':
      return cardTargets.decision();
    case 'sign_off':
    case 'review_label':
      return cardTargets.label();
    default:
      return cardTargets.actions();
  }
};

/** What clicking a problem on the status line opens: the rollout's steps, else the actions. */
const statusClick = (status: StatusLine): StatusClick =>
  status.kind === 'rollout' ? cardTargets.humanSteps() : cardTargets.actions();

/** Which icon leads the status: the machine (spinning while a step runs), a warning, a person, an hourglass, or "needs a <person>". */
export type StatusIcon =
  'machine' | 'machine-spinning' | 'alert' | 'human' | 'hourglass' | 'needs-human' | 'check';

export interface CornerStatus {
  /** What the status is about, for styling and tests: stalled, needs-human, ready, a problem's kind, decided (a learning's outcome), machine, human, waiting, standby. */
  readonly kind: string;
  readonly icon: StatusIcon;
  /** One short phrase; the card never wraps it. The icon carries what the words would repeat ("working", "stalled"). */
  readonly text: string;
  /** The accessible name of the status. */
  readonly label: string;
  /** The full detail: every lower-priority item, what a click does, the learned reasons and the chain it waits for. */
  readonly tip: string;
  readonly tone: string;
  /** What a click does; null where the status is plain text. */
  readonly click: StatusClick | null;
}

const STANDBY_TIP =
  "The machine is on standby, listening to GitHub: it fixes new CI failures or review comments until it's merged.";

const PROVISIONING_TIP =
  'slop could not create the branch and draft PR; it retries in the background';

const isEscalated = (glob: PresentableGlob): boolean =>
  glob.escalation != null && glob.status === 'planning';

/**
 * The specifics a position's label adds to its icon, without the word the icon already says: "stalled · merge conflict"
 * becomes "merge conflict", and a bare "standby" says what it is listening for.
 */
export const specifics = (label: string): string => {
  const rest = label.replace(/^stalled(\s*[·:]\s*|$)/i, '');
  return rest.toLowerCase() === 'standby' ? 'listening for CI and reviews' : rest;
};

/** The merge conflict the glob has, open or recorded on a failed merge. */
const conflictOf = (glob: PresentableGlob) => glob.conflict ?? glob.failure?.conflict ?? null;

/** What a problem says on the card, in a few words; the sentence, files and advice stay in the tooltip and the glob view. */
const shortProblem = (status: StatusLine, glob: PresentableGlob): string => {
  // A merge conflict is already worded short by the status line (`conflicts with main`, or the stall label).
  if (status.conflict === true) return status.text;
  switch (status.kind) {
    case 'provisioning':
      return 'branch not created';
    case 'base-red':
      return status.text;
    case 'checks':
      return 'checks failed';
    case 'failure':
      return glob.failure?.kind === 'needs_pairing'
        ? 'needs a person'
        : glob.failure?.kind === 'merge'
          ? 'merge failed'
          : 'routine run failed';
    case 'investigation-failed':
      return 'investigation failed';
    case 'stuck':
      return 'looks stuck';
    case 'behind':
      return `behind ${glob.behind?.base ?? 'the base'}`;
    default:
      return status.text;
  }
};

/** Why a Planning glob waits, from what slop learned of its needs, for the tooltip. */
const learnedReasons = (glob: PresentableGlob): string[] =>
  (glob.impliedAfter ?? [])
    .filter((i) => i.overridden !== true && i.kind === 'needs')
    .map((i) => `${i.id}: ${i.evidence ?? 'a run failed without it'}`);

/**
 * The status without elapsed times ("run failed · 18 min", "queued 3 min", "queued · 3 min"): they live in the tooltip and
 * the glob view. No status text carries a commit SHA; that is only ever in the tooltip.
 */
export const plainText = (text: string): string =>
  text
    .replace(/\s*·\s*\d+ min\b/g, '')
    .replace(/\s+\d+ min\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Whether the glob is merged and waits for a person's sign-off: a label is still to be approved. */
const awaitingSignOff = (glob: PresentableGlob): boolean =>
  glob.status === 'reviewing' &&
  reviewOpen(glob) &&
  Object.values(glob.labels).some((state) => state !== 'approved');

/** "Merged; QA and CR are waiting for a person to approve them." */
const signOffTip = (labels: PresentableGlob['labels']): string => {
  const waiting = labelsWaiting(labels);
  const names =
    waiting.length <= 1
      ? waiting.join('')
      : `${waiting.slice(0, -1).join(', ')} and ${waiting[waiting.length - 1]}`;
  return `Merged; ${names === '' ? 'the labels are' : `${names} ${waiting.length === 1 ? 'is' : 'are'}`} waiting for a person to approve ${waiting.length === 1 ? 'it' : 'them'}.`;
};

/** "Merged; QA has 2 open items: first; second" for a merged glob whose labels have feedback to fix. */
const feedbackTip = (glob: PresentableGlob): string =>
  `Merged; ${openFeedback(glob)
    .map(
      (f) =>
        `${f.label} has ${String(f.items.length)} open item${f.items.length === 1 ? '' : 's'}: ${f.items.map((item) => item.text).join('; ')}`,
    )
    .join('. ')}.`;

/**
 * True when the glob needs a person now: its status shows the human outline (Your turn, a due rollout step, awaiting
 * sign-off, an escalation in Planning) or it has an open question. A decision glob's turn is the status line's.
 */
export const needsPerson = (
  glob: PresentableGlob,
  now: string,
  viewer?: HumanStepViewer,
): boolean => {
  // An action waits for a person until it is done or dismissed; a prepared one while the machine prepares or records is the machine's.
  if (glob.category === 'action') {
    const line = actionLine(glob);
    return (
      glob.status === 'planning' ||
      line?.state === 'ready' ||
      line?.state === 'preparation_failed' ||
      (line?.state === 'recording' && line.icon === 'human')
    );
  }
  if (decisionOf(glob) !== null) return statusLine(glob, now, viewer)?.kind === 'ready';
  // An open question is a person's to answer even when a higher-priority status holds the corner.
  if (openQuestionsOf(glob).length > 0) return true;
  const icon = cornerStatus(glob, now, viewer)?.icon;
  return icon === 'human' || icon === 'needs-human';
};

/**
 * A decided learning's status: the outcome in the corner, with who decided and why (and a contradiction of a broader-scope
 * decision) in the tooltip. Scope and contradictions are shown in the glob view; the card carries no tags for them.
 */
const decidedStatus = (glob: PresentableGlob, decision: DecisionAttributes): CornerStatus => {
  const { outcome } = decision;
  if (outcome === null) throw new Error(`${glob.id} has no outcome`);
  const text = OUTCOME_TEXT[outcome.kind].toLowerCase();
  const conflicts = decision.conflictsWith ?? [];
  const tip = tipLines([
    `${OUTCOME_TEXT[outcome.kind]} by ${outcome.by}${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`,
    ...(conflicts.length === 0
      ? []
      : [
          `Contradicts ${conflicts.join(', ')}, which apply more broadly and win where they disagree`,
        ]),
    'Opens the decision',
  ]);
  const tone =
    outcome.kind === 'reject' || outcome.kind === 'closed'
      ? 'text-muted-foreground'
      : 'text-signal-strong';
  return {
    kind: 'decided',
    icon: 'check',
    text,
    label: text,
    tip,
    tone,
    click: cardTargets.decision(),
  };
};

/** An open question: the human icon with "question" ("questions" for more), the first question's text in the tooltip. */
const questionStatus = (
  glob: PresentableGlob,
  make: (
    kind: string,
    icon: StatusIcon,
    text: string,
    tone: string,
    click: StatusClick | null,
    lead: string[],
  ) => CornerStatus,
): CornerStatus =>
  make(
    'question',
    'human',
    questionText(openQuestionsOf(glob).length),
    'text-required',
    cardTargets.questions(),
    [questionChipTip(glob) ?? ''],
  );

/**
 * The card's one status (and the glob view header's text), or null when there is nothing to say. Highest priority wins the
 * words, the rest go in the tooltip: a stall, an escalation in Planning, your turn, a problem, the machine running, the
 * prerequisites it waits on, any other waiting, standby, and last the globs in Planning waiting on this one. A decision glob has one only once decided: its outcome.
 */
export const cornerStatus = (
  glob: PresentableGlob,
  now: string,
  viewer?: HumanStepViewer,
  waitingOnThis = 0,
  /** The board's base branch, for "merging from <base>". */
  base?: string,
): CornerStatus | null => {
  const decision = decisionOf(glob);
  if (decision !== null) return decision.outcome === null ? null : decidedStatus(glob, decision);
  // An open action's one status is what it waits for (the glob that builds its script); otherwise an action has none.
  if (glob.category === 'action') {
    const acting = actionLine(glob);
    if (acting !== null) {
      // The line is the action's own, or a real problem on its PR (failed checks, a conflict) that outranks it.
      const line = statusLine(glob, now, viewer, base);
      const text = line?.text ?? acting.text;
      const problem = line !== null && line.kind !== 'action';
      return {
        kind: problem ? line.kind : 'action',
        icon: problem ? (isProblemLine(line) ? 'alert' : 'machine') : acting.icon,
        text,
        label: text,
        tip: line?.tip ?? acting.tip,
        tone: line?.tone ?? acting.tone,
        click: cardTargets.actions(),
      };
    }
    const held = holdLine(glob);
    return held === null
      ? null
      : {
          kind: 'hold',
          icon: held.icon,
          text: held.text,
          label: held.text,
          tip: held.tip,
          tone: 'text-muted-foreground',
          click: cardTargets.related(),
        };
  }
  if (isHumanCategory(glob.category)) return null;
  // Signed off is the glob's whole state: nothing else shows, and the date lives in the tooltip.
  if (glob.status === 'signed_off') {
    const when = glob.signedOffAt == null ? '' : ` ${new Date(glob.signedOffAt).toLocaleString()}`;
    const tip = `Signed off${when}`;
    return {
      kind: 'signed-off',
      icon: 'check',
      text: 'signed off',
      label: 'signed off',
      tip,
      tone: 'text-muted-foreground',
      click: null,
    };
  }
  const status = statusLine(glob, now, viewer, base);
  const position = positionOf(glob, now, viewer, base);
  const held = holdLine(glob);
  const workstreams = workstreamLine(glob);
  const standby = onStandby(glob);
  const escalation = glob.escalation;
  const escalated = isEscalated(glob);
  const waitingTip =
    waitingOnThis > 0 ? `${String(waitingOnThis)} in Planning wait for this glob to merge.` : null;

  const make = (
    kind: string,
    icon: StatusIcon,
    text: string,
    tone: string,
    click: StatusClick | null,
    lead: string[],
  ): CornerStatus => {
    const rest = [
      ...(status === null ? [] : [status.tip]),
      ...(position === null ? [] : [position.tip]),
      ...(kind !== 'needs-human' && escalated && escalation != null
        ? [`Needs a person: ${escalation.reason}`]
        : []),
      ...(held === null || kind === 'hold' ? [] : [held.tip]),
      ...relationTips(glob),
      ...(standby === null || kind === 'standby' ? [] : [STANDBY_TIP]),
      ...(waitingTip === null || kind === 'waiting-on-this' ? [] : [waitingTip]),
    ];
    const hint =
      click === null || kind === 'needs-human' || kind === 'question'
        ? []
        : [
            kind === 'hold' || kind === 'waiting-on-this'
              ? "Opens this glob's related globs."
              : 'Opens the glob.',
          ];
    const shown = plainText(text);
    // What the text dropped (a time, a commit) stays in the tooltip.
    const detail = shown === text ? [] : [text];
    const tip = tipLines([
      ...new Set([...lead, ...detail, ...rest, ...hint].filter((t) => t !== '')),
    ]);
    return {
      kind,
      icon,
      text: shown,
      label: kind === 'needs-human' ? 'Needs a person' : shown,
      tip,
      tone,
      click,
    };
  };

  if (position?.holder === 'stalled') {
    const cause = specifics(position.label) || specifics(position.text) || 'nobody on it';
    // A cause that already carries its age ("no progress 12 min") is not given it twice.
    const minutes =
      position.minutes !== null && position.minutes > 0 && !/\d+ min/.test(cause)
        ? ` · ${String(position.minutes)} min`
        : '';
    // The stall's next step is a person's (the viewer's turn): the human outline with that action, not the warning.
    if (status !== null && status.kind === 'ready' && status.action !== 'mark_deployed') {
      return make('ready', 'human', status.text, status.tone, yourTurnClick(status), [
        position.tip,
        `Stalled: ${cause}${minutes}`,
        status.tip,
      ]);
    }
    // A failed provisioning stalls the glob; it says what failed, with the click that retries it (the actions section).
    if (glob.provisioning === 'failed') {
      return make('stalled', 'alert', 'provisioning failed', 'text-red', cardTargets.actions(), [
        PROVISIONING_TIP,
        position.tip,
      ]);
    }
    // A deploy that never came: the steps waiting on it, with Mark deployed, are in the Human steps section.
    const stalledClick =
      position.label === DEPLOY_STALLED_LABEL ? cardTargets.humanSteps() : cardTargets.actions();
    return make('stalled', 'alert', `${cause}${minutes}`, position.tone, stalledClick, [
      position.tip,
    ]);
  }
  if (escalated && escalation != null) {
    return make(
      'needs-human',
      'needs-human',
      'needs a',
      'text-required',
      cardTargets.escalation(),
      [`Needs a person: ${sentence(escalation.reason)} Opens the reason`],
    );
  }
  if (glob.provisioning === 'failed') {
    return make('provisioning', 'alert', 'provisioning failed', 'text-red', cardTargets.actions(), [
      PROVISIONING_TIP,
    ]);
  }
  // A start question holds the glob in Planning: that is the reason it waits, ahead of any relation hold. Built from the glob's
  // questions (the single glob read has no `move`, and `holding` lists relations only).
  if (heldByQuestion(glob)) return questionStatus(glob, make);
  if (status !== null && status.kind === 'ready') {
    return make('ready', 'human', status.text, status.tone, yourTurnClick(status), [status.tip]);
  }
  if (
    status !== null &&
    position?.holder === 'machine' &&
    (status.conflict === true ||
      status.kind === 'checks' ||
      status.kind === 'stuck' ||
      status.kind === 'behind')
  ) {
    // Someone is on the problem: say what the machine is doing ("fixing the conflict"), with the problem in the tooltip.
    const icon = position.spinning ? 'machine-spinning' : 'machine';
    return make('machine', icon, position.label, position.tone, cardTargets.actions(), [
      position.tip,
      status.tip,
    ]);
  }
  // "Behind <base>" is not shown on the card (the glob view has it); the status falls through to what else there is.
  if (status !== null && status.kind !== 'behind') {
    const icon =
      status.kind === 'base-red' || status.kind === 'start-queued'
        ? 'hourglass'
        : status.kind === 'rollout'
          ? 'human'
          : status.kind === 'merging'
            ? 'machine'
            : 'alert';
    return make(status.kind, icon, shortProblem(status, glob), status.tone, statusClick(status), [
      status.tip,
    ]);
  }
  // Open feedback on a label is the developer's turn (a run fixing it shows as the machine), and outranks sign-off.
  if (
    glob.status === 'reviewing' &&
    reviewOpen(glob) &&
    openFeedback(glob).length > 0 &&
    (position === null || position.holder === 'machine')
  ) {
    const target = cardTargets.label();
    if (position?.holder === 'machine') {
      return make(
        'machine',
        position.spinning ? 'machine-spinning' : 'machine',
        feedbackText('fixing feedback'),
        position.tone,
        target,
        [feedbackTip(glob)],
      );
    }
    return make('feedback', 'human', feedbackText(), 'text-signal-strong', target, [
      feedbackTip(glob),
    ]);
  }
  if (awaitingSignOff(glob) && position === null) {
    return make('sign-off', 'human', signOffText(), 'text-signal-strong', cardTargets.label(), [
      signOffTip(glob.labels),
    ]);
  }
  // A fanned-out glob's workstreams say more than the machine's general position.
  if (workstreams !== null) {
    return make(
      'workstreams',
      workstreams.icon,
      workstreams.text,
      workstreams.tone,
      cardTargets.actions(),
      [workstreams.tip],
    );
  }
  if (position?.holder === 'machine') {
    const icon = position.spinning ? 'machine-spinning' : 'machine';
    const isStandby = position.label.toLowerCase() === 'standby';
    return make(
      isStandby ? 'standby' : 'machine',
      icon,
      position.label,
      position.tone,
      cardTargets.actions(),
      [position.tip],
    );
  }
  // Any other open question (a merge question lets the run finish, the merge waits for the answer; a notice holds nothing).
  if (openQuestionsOf(glob).length > 0) return questionStatus(glob, make);
  if (held !== null) {
    return make('hold', held.icon, held.text, 'text-muted-foreground', cardTargets.related(), [
      held.tip,
      ...learnedReasons(glob),
    ]);
  }
  if (position !== null) {
    const waiting = position.holder === 'waiting';
    return make(
      waiting ? 'waiting' : 'human',
      waiting ? 'hourglass' : 'human',
      position.label,
      position.tone,
      cardTargets.actions(),
      [position.tip],
    );
  }
  if (standby !== null)
    return make('standby', 'machine', 'standby', 'text-muted-foreground', null, [STANDBY_TIP]);
  if (waitingTip !== null) {
    return make(
      'waiting-on-this',
      'hourglass',
      `${String(waitingOnThis)} waiting on this`,
      'text-muted-foreground',
      cardTargets.related(),
      [waitingTip],
    );
  }
  return null;
};

/**
 * Whether something blocks the glob, so the card offers no action and the status line says what is wrong: unmerged needs, a
 * conflict, failed checks, a stall, or an escalation or step waiting on a decision. A glob that is merely behind or
 * clashes with another, or whose checks are still running is not blocked.
 */
export const hasBlocker = (
  glob: PresentableGlob,
  now: string,
  viewer?: HumanStepViewer,
): boolean => {
  const status = statusLine(glob, now, viewer);
  const position: Position | null = positionOf(glob, now, viewer);
  if (blockedParts(glob) !== null) return true;
  if (glob.status === 'planning' && position?.holder === 'waiting') return true;
  if (conflictOf(glob) != null) return true;
  if (position?.holder === 'stalled') return true;
  if (isEscalated(glob) || heldByQuestion(glob) || status?.turn === 'decide') return true;
  return status !== null && ['provisioning', 'base-red', 'checks', 'stuck'].includes(status.kind);
};

/** How many globs wait for this one at the start gate (its open `holdsBack` relations), for the glob view's "N waiting on this"; 0 when the view has none. */
export const waitingOnOwn = (glob: Pick<PresentableGlob, 'relations'>): number =>
  new Set((glob.relations?.holdsBack ?? []).filter((h) => h.gate === 'start').map((h) => h.from))
    .size;

/** How many globs in Planning wait for each glob to merge (their unmet start relations), for the card's "N waiting on this". */
export const waitingOnCounts = (
  globs: readonly Pick<PresentableGlob, 'id' | 'status' | 'holding'>[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const g of globs) {
    if (g.status !== 'planning') continue;
    for (const to of new Set((g.holding ?? []).filter((h) => h.gate === 'start').map((h) => h.to)))
      counts.set(to, (counts.get(to) ?? 0) + 1);
  }
  return counts;
};
