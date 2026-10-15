import { isForViewer } from './human-steps.js';
import type { HumanStep, HumanStepViewer, StepAction } from './human-steps.js';
import type { Action } from './machine.js';
import { DEFAULT_STALL_MINUTES, isInFlight, isStale, isWaitingStep, quietMinutes } from './machine-steps.js';
import type { MachineStep, StallThresholds } from './machine-steps.js';
import { LABEL_NAMES } from './types.js';
import type { ChecklistItem, Glob, LabelName, Labels } from './types.js';
import type { Holding } from './relations.js';

/**
 * Whose move it is on a glob: exactly one holder, reduced from the human steps, the machine steps and the glob's
 * relations. `you` and `human` are a person's turn (the viewer's, or someone else's), `machine` is slop at work,
 * `waiting` is blocked on something automated or another glob, `stalled` is nobody moving a glob that isn't finished.
 * `idle` (a Planning glob nobody started) and `done` (signed off) show nothing.
 */
export const HOLDERS = ['you', 'human', 'machine', 'waiting', 'stalled', 'idle', 'done'] as const;
export type Holder = (typeof HOLDERS)[number];

/** Why a glob is stalled, which picks the wording of the step that hands it to a person. */
export const STALL_CAUSES = ['failed', 'queued', 'quiet', 'nobody'] as const;
export type StallCause = (typeof STALL_CAUSES)[number];

export interface Move {
  readonly holder: Holder;
  /** One line a card can show after the holder: the step's title, what it waits on, or why it stalled. */
  readonly reason: string;
  /**
   * A few words (about four) for a card's single line, derived from the cause, never cut from `reason`: "stalled · merge conflict".
   * Set for a stall and for an escalation; absent otherwise, where `reason` is already short. `reason` keeps the full text for tooltips.
   */
  readonly label?: string;
  /** When the holder took the ball, where slop knows. */
  readonly since: string | null;
  /** `you` and `human`: whom the step is for (the viewer's email, or the step's role or email). */
  readonly who?: string;
  /** `waiting`: what it waits on (glob IDs, `checks`, `deploy:<env>`, ...). */
  readonly waitingOn?: readonly string[];
  /** `stalled`: why, and for how many minutes when it is time. `human` (picked up, pairing): minutes since the glob was last touched. */
  readonly cause?: StallCause;
  readonly minutes?: number;
}

export interface MoveOptions {
  /** Who is looking: without one every due step is `human`, never `you`. */
  readonly viewer?: HumanStepViewer;
  readonly thresholds?: StallThresholds;
  /**
   * Whether `machineSteps` holds every fact (effects, deploys, uploads). When `false`, a glob nobody seems to be on is `idle`
   * ("not enough facts"), not stalled: its activity may be in the facts that are missing. Failed steps and quiet runs still stall.
   */
  readonly complete?: boolean;
}

/** The labels a merged glob still waits on a person to approve, in FR, CR, QA order. */
export const labelsWaiting = (labels: Labels): LabelName[] => LABEL_NAMES.filter((name) => labels[name] === 'required' || labels[name] === 'added');

/** The one wording for a merged glob whose labels wait for sign-off: just "sign off"; the labels themselves show which are waiting. */
export const signOffText = (): string => 'sign off';

/** The unticked, sent items on labels in state `added`: the feedback the developer has to deal with, in FR, CR, QA order. */
export const openFeedback = (glob: Pick<Glob, 'labels' | 'checklists'>): { readonly label: LabelName; readonly items: readonly ChecklistItem[] }[] =>
  LABEL_NAMES.flatMap((label) => {
    const items = glob.labels[label] === 'added' ? (glob.checklists[label] ?? []).filter((item) => !item.done && item.draft !== true) : [];
    return items.length === 0 ? [] : [{ label, items }];
  });

/** The one wording for feedback waiting on the developer: just "fix feedback" (or the given verb); the tooltip lists the items. */
export const feedbackText = (verb = 'fix feedback'): string => verb;

/**
 * A state a person is the one to move in, whatever steps say: open feedback on a label is the developer's turn and outranks
 * sign-off, which is the reviewer's turn.
 */
const personReason = (glob: Glob): string | null => {
  if (glob.status !== 'reviewing') return null;
  if (openFeedback(glob).length > 0) return feedbackText();
  return labelsWaiting(glob.labels).length > 0 ? signOffText() : null;
};

/** An escalation is a person's turn only when nothing else holds the ball: it never outranks a machine step (see `whoseMove`). */
const escalationReason = (glob: Glob): string | null =>
  glob.escalation != null && glob.status !== 'signed_off' && glob.status !== 'failed' ? `Needs a human: ${glob.escalation.reason}` : null;

/**
 * The holdings that apply to the glob where it stands (the server sends every unmet relation, whatever the gate): a start relation
 * holds a glob in Planning, a merge relation a PR that is open and neither conflicting nor failing, a sign-off relation a merged
 * glob whose labels are all approved (until then the reviewer's turn comes first).
 */
export const appliedHolding = (glob: Glob, holding: readonly Holding[]): Holding[] =>
  holding.filter((h) => {
    switch (h.gate) {
      case 'start':
        return glob.status === 'planning';
      case 'merge':
        return glob.status === 'pr_open' && glob.conflict == null && !(glob.headChecks?.state === 'failed' && glob.headChecks.sha === glob.pr?.headSha);
      case 'sign_off':
        return glob.status === 'reviewing' && personReason(glob) === null;
    }
  });

const named = (h: Holding): string => (h.toIsDecision ? `decision ${h.to}` : h.toIsAction === true ? `action ${h.to}` : h.to);

/**
 * What a glob's holdings say, one phrase per gate: "waiting on s15f82, decision s15k190" for a start gate, "merge waits on s15f82"
 * and "sign-off waits on s15f82".
 */
export const holdingReason = (holding: readonly Holding[]): string => {
  const start = holding.filter((h) => h.gate === 'start');
  const merge = holding.filter((h) => h.gate === 'merge');
  const signOff = holding.filter((h) => h.gate === 'sign_off');
  return [
    ...(start.length === 0 ? [] : [`waiting on ${start.map(named).join(', ')}`]),
    ...(merge.length === 0 ? [] : [`merge waits on ${merge.map(named).join(', ')}`]),
    ...(signOff.length === 0 ? [] : [`sign-off waits on ${signOff.map(named).join(', ')}`]),
  ].join('; ');
};

/**
 * The one wording for checks in flight. Slop merges by itself when the checks pass ("merging when checks pass"), or is
 * catching up with the base first ("merging from main"); every other glob with checks running reads "checks running".
 * Whose-move uses only `CHECKS_RUNNING_TEXT`; the web composes the two merging variants (`apps/web/src/lib/check-wording.ts`).
 */
export const CHECKS_RUNNING_TEXT = 'checks running';
export const MERGING_WHEN_CHECKS_PASS_TEXT = 'merging when checks pass';
export const mergingFromBaseText = (base: string): string => `merging from ${base}`;

/**
 * The one wording for a PR in the code host's merge queue: "in merge queue · N ahead" (N is the PRs ahead of it), plain
 * "in merge queue" when the position is unknown, and "merging" once its group is being merged.
 */
export const MERGE_QUEUE_TEXT = 'in merge queue';
export const MERGE_QUEUE_TIP = 'GitHub tests it with the PRs ahead of it and merges it in order.';
export const mergeQueueText = (position: number | null, state: 'queued' | 'merging'): string =>
  state === 'merging' ? 'merging' : position === null ? MERGE_QUEUE_TEXT : `${MERGE_QUEUE_TEXT} · ${String(Math.max(0, position - 1))} ahead`;

/** The `human` move's reasons when a person holds a glob: picked up (no machine run), or pairing on a super. */
export const PICKED_UP_REASON = 'Picked up';
export const PAIRING_REASON = 'Pairing';

const holderOf = (who: string, glob: Pick<Glob, 'implementer' | 'planner'>): string =>
  who === 'implementer' ? (glob.implementer ?? glob.planner) : who;

const stalled = (cause: StallCause, reason: string, label: string, since: string | null, minutes?: number): Move => ({
  holder: 'stalled',
  reason,
  label,
  since,
  cause,
  ...(minutes === undefined ? {} : { minutes }),
});

const earliest = (steps: readonly MachineStep[]): string | null =>
  steps.map((s) => s.startedAt).filter((t): t is string => t !== null).sort()[0] ?? null;

/** The short stall label for a merge conflict: the card's one wording, also the status line's text for a failed merge. */
export const MERGE_CONFLICT_STALL_LABEL = 'stalled · merge conflict';

/** Why a failed step stopped, in a few words, from the glob's recorded conflict, checks or run, not from the step's text. */
const failedLabel = (glob: Glob, step: MachineStep): string => {
  if (glob.failure?.conflict !== undefined || glob.conflict != null) return MERGE_CONFLICT_STALL_LABEL;
  if (glob.failure?.kind === 'needs_pairing') return 'stalled · needs your decision';
  if (step.kind === 'fix_checks' || (glob.headChecks?.state === 'failed' && glob.headChecks.inheritedFrom === undefined)) return 'stalled · checks failed';
  return 'stalled · run failed';
};

/** What a quiet step says about itself, in a few words. */
const quietReason = (s: MachineStep, minutes: number): string => {
  if (s.state === 'queued') return `queued for ${String(minutes)} min`;
  return `${s.kind.replace(/_/g, ' ')}: no progress for ${String(minutes)} min`;
};

/**
 * Priority: a due human step, then a machine step holding the ball, then waiting, then a person's turn by state alone,
 * then stalled. A machine step quiet past its threshold doesn't hold the ball: it is what stalled the glob.
 *
 * `humanSteps` should be the glob's steps without any `unstick` step (that one is derived from this result, see
 * `withUnstick`); one passed in is ignored.
 */
export const whoseMove = (
  glob: Glob,
  humanSteps: readonly HumanStep[],
  machineSteps: readonly MachineStep[],
  /** The glob's unmet relations, every gate (the server computes them: see `holdingOf`); each holds only where the glob stands. */
  holding: readonly Holding[],
  now: string,
  options: MoveOptions = {},
): Move => {
  const thresholds = options.thresholds ?? DEFAULT_STALL_MINUTES;
  if (glob.status === 'signed_off') return { holder: 'done', reason: 'Signed off', since: glob.signedOffAt };

  // 1. A person's turn: a step that is due.
  const held = appliedHolding(glob, holding);
  // A merge that waits for a relation is not the person's to press yet: the Merge step isn't due while the gate holds.
  const mergeWaits = held.some((h) => h.gate === 'merge');
  // While slop gets its recommendation for a picked-up decision, the status says so rather than "Decide"; Decide is still usable.
  const recommending = machineSteps.some((s) => s.kind === 'recommendation' && s.holdsBall && isInFlight(s) && !isStale(s, now, thresholds));
  const due = humanSteps.filter(
    (s) => s.kind !== 'unstick' && s.state === 'due' && !(mergeWaits && s.kind === 'merge') && !(recommending && s.kind === 'decide'),
  );
  if (due.length > 0) {
    const mine = options.viewer === undefined ? [] : due.filter((s) => isForViewer(s, glob, options.viewer as HumanStepViewer));
    if (mine.length > 0 && options.viewer !== undefined) return { holder: 'you', reason: mine[0]?.title ?? '', since: null, who: options.viewer.email };
    const first = due[0];
    if (first !== undefined) return { holder: 'human', reason: first.title, since: null, who: holderOf(first.who, glob) };
  }

  // 2. The machine: a step holding the ball that is still alive. A failed step holds nothing.
  const flying = machineSteps.filter((s) => s.holdsBall && isInFlight(s));
  const alive = flying.filter((s) => !isStale(s, now, thresholds));
  const quiet = flying.filter((s) => isStale(s, now, thresholds));
  const lead = alive[0];
  if (lead !== undefined) {
    return { holder: 'machine', reason: lead.kind.replace(/_/g, ' '), since: lead.state === 'queued' ? lead.startedAt : (lead.lastProgressAt ?? lead.startedAt) };
  }

  // 3. Waiting: an unmet relation (another glob, a decision), checks, a deploy, an unseen upload, a merge held for
  // a relation, or a rollout the glob's steps wait on.
  const waits = machineSteps.filter((s) => isWaitingStep(s) && isInFlight(s));
  const rollouts = humanSteps.filter((s) => s.state === 'pending' && s.blocks.length > 0);
  if (waits.length > 0 || held.length > 0) {
    const waitsOn = (s: MachineStep): string => (s.kind === 'deploy' ? `deploy:${s.detail ?? ''}` : s.kind);
    // A held merge is already said by its relations; without them (a caller that has none) its own step names them.
    const stepWaits = waits.filter((s) => !(s.kind === 'merge_held' && held.length > 0));
    const on = [...new Set([...held.map((h) => h.to), ...stepWaits.map(waitsOn)])];
    const reason =
      held.length > 0
        ? holdingReason(held)
        : stepWaits
            .map((s) =>
              s.kind === 'checks'
                ? CHECKS_RUNNING_TEXT
                : s.kind === 'deploy'
                  ? `deploying to ${s.detail ?? 'an environment'}`
                  : s.kind === 'merge_held'
                    ? `merge waits on ${s.detail ?? 'another glob'}`
                    : `waiting for ${s.detail ?? 'the upload'}`,
            )
            .join('; ');
    return { holder: 'waiting', reason, since: earliest(waits), waitingOn: on };
  }
  // A rollout is only waited for once there is something to roll out: a Planning glob's predicted placeholder is not a wait,
  // or the card would hide Start on a glob that is free to start.
  if (glob.status !== 'planning' && rollouts.length > 0 && quiet.length === 0 && !machineSteps.some((s) => s.state === 'failed')) {
    const first = rollouts[0];
    return { holder: 'waiting', reason: `waiting for ${first?.title ?? 'a step'}`, since: null, waitingOn: rollouts.map((s) => s.id) };
  }

  // 4. A person's turn by state: sign-off asked for. Nothing failed.
  const person = personReason(glob);
  const failed = machineSteps.filter((s) => s.state === 'failed');
  if (person !== null && failed.length === 0 && quiet.length === 0) {
    return { holder: options.viewer !== undefined && (glob.implementer ?? glob.planner) === options.viewer.email ? 'you' : 'human', reason: person, since: null, who: glob.implementer ?? glob.planner };
  }

  // 4a. A person's turn by escalation. It never outranks a machine step (step 2) or a watcher answering failed checks (4b below);
  // it does outrank the open-PR next steps (conflict, failed checks nobody answers, 'merges by itself').
  const escalation = escalationReason(glob);
  const watcherAnswers =
    glob.pr !== null &&
    glob.status === 'pr_open' &&
    glob.headChecks?.state === 'failed' &&
    glob.headChecks.inheritedFrom === undefined &&
    machineSteps.some((s) => s.state === 'standby');
  if (escalation !== null && failed.length === 0 && quiet.length === 0 && !watcherAnswers) {
    return {
      holder: options.viewer !== undefined && (glob.implementer ?? glob.planner) === options.viewer.email ? 'you' : 'human',
      reason: escalation,
      label: 'Needs a human',
      since: null,
      who: glob.implementer ?? glob.planner,
    };
  }

  // 4b. An open PR with a conflict or failing checks and nothing working on it has a next step: never "nobody".
  if (failed.length === 0 && quiet.length === 0 && glob.pr !== null && glob.status === 'pr_open') {
    const mover = (reason: string): Move => ({
      holder: options.viewer !== undefined && (glob.implementer ?? glob.planner) === options.viewer.email ? 'you' : 'human',
      reason,
      since: null,
      who: glob.implementer ?? glob.planner,
    });
    const standby = machineSteps.find((s) => s.state === 'standby');
    if (glob.conflict != null) return mover(glob.implementer !== null ? 'Fix conflict: pick up' : 'Fix conflict');
    const checks = glob.headChecks;
    // A sub with passing checks merges by itself: slop is about to do it.
    if (glob.type === 'sub' && glob.conflict == null && checks?.state === 'passed' && checks.sha === glob.pr.headSha) {
      return { holder: 'waiting', reason: 'merges by itself', since: checks.at ?? null, waitingOn: ['merge'] };
    }
    // Failing the same way as the base: waiting for the base to be fixed, not stalled and not this glob's failure.
    if (checks?.state === 'failed' && checks.inheritedFrom !== undefined) {
      return { holder: 'waiting', reason: `${checks.inheritedFrom.base} is red`, since: checks.at ?? null, waitingOn: ['base'] };
    }
    if (checks?.state === 'failed' && checks.inheritedFrom === undefined) {
      // A watching run is about to answer failed checks; otherwise it is a person's.
      if (standby !== undefined) return { holder: 'machine', reason: 'fix checks', since: checks.at ?? null };
      return mover('Fix checks');
    }
  }

  // 5. Idle: a Planning glob nobody started.
  const live = machineSteps.some((s) => s.state !== 'done' && s.state !== 'standby');
  if (glob.status === 'planning' && glob.failure === null && !live) return { holder: 'idle', reason: 'Not started', since: null };

  // 6. Stalled: something failed, something went quiet, or nobody is on it.
  const gone = failed[0];
  if (gone !== undefined) return stalled('failed', gone.detail ?? 'the machine stopped', failedLabel(glob, gone), gone.startedAt);
  const slow = quiet[0];
  if (slow !== undefined) {
    const minutes = quietMinutes(slow, now) ?? 0;
    const queued = slow.state === 'queued';
    return stalled(
      queued ? 'queued' : 'quiet',
      quietReason(slow, minutes),
      queued ? `stalled · queued ${String(minutes)} min` : `stalled · no progress ${String(minutes)} min`,
      slow.lastProgressAt ?? slow.startedAt,
      minutes,
    );
  }
  if (glob.implementer !== null && (glob.status === 'implementing' || glob.status === 'in_progress')) {
    // A person holds it: a local session is invisible to slop, so it is never "nobody", however long it has been quiet, and missing facts can't change that (live machine steps won above).
    const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(glob.updatedAt)) / 60_000));
    return {
      holder: 'human',
      reason: glob.type === 'super' ? PAIRING_REASON : PICKED_UP_REASON,
      since: glob.updatedAt,
      who: glob.implementer,
      minutes,
    };
  }
  if (options.complete === false) return { holder: 'idle', reason: 'Not enough facts to say', since: null };
  return stalled('nobody', 'nobody is on this', 'stalled · nobody on it', glob.updatedAt);
};

/** The short label a stall step's action carries as its title: one or two words, the cause goes in `detail`. */
const ACTION_TITLES: Readonly<Partial<Record<StepAction, string>>> = {
  retrigger: 'Retry',
  pick_up: 'Pick up',
  start: 'Start',
  start_anyway: 'Start',
  open_session: 'Open session',
};

/** What the unstick step needs beyond the move: the actions the viewer may take, and whether a run's session can be opened. */
export interface UnstickOptions {
  /** The glob's `allowedActions`; without it every action counts as allowed. */
  readonly allowed?: readonly Action[];
  /** Whether the run has a session to open (default true). */
  readonly session?: boolean;
}

/**
 * The one action a stalled glob's step names, and the one alternative the glob view offers, by cause and state. Only
 * allowed actions are used: if the choice isn't allowed the alternative takes its place, and with neither there is no step.
 */
export const unstickAction = (
  move: Move,
  glob: Pick<Glob, 'implementer'>,
  options: UnstickOptions = {},
): { readonly action: StepAction; readonly alternative?: Action } | null => {
  if (move.cause === undefined) return null;
  const allowed = options.allowed;
  const ok = (a: StepAction): boolean => (a === 'open_session' ? options.session !== false : allowed === undefined || allowed.includes(a));
  const pair = ((): [StepAction, Action | undefined] => {
    switch (move.cause) {
      case 'failed':
        return glob.implementer === null ? ['retrigger', 'pick_up'] : ['pick_up', undefined];
      case 'queued':
      case 'quiet':
        return ['open_session', 'pick_up'];
      case 'nobody':
        return glob.implementer === null ? ['start', 'pick_up'] : ['pick_up', 'start_anyway'];
    }
  })();
  const [first, second] = pair;
  const alternative = second !== undefined && ok(second) ? second : undefined;
  if (ok(first)) return { action: first, ...(alternative === undefined ? {} : { alternative }) };
  return alternative === undefined ? null : { action: alternative };
};

/**
 * The human step a stalled glob adds: for the implementer, or the planner while nobody implements. Its title is its
 * action's label and the cause is its detail. Derived from the move, so it is gone the moment the cause is.
 */
export const unstickStep = (move: Move, glob: Pick<Glob, 'implementer'> = { implementer: null }, options: UnstickOptions = {}): HumanStep | null => {
  if (move.holder !== 'stalled' || move.cause === undefined) return null;
  const chosen = unstickAction(move, glob, options);
  if (chosen === null) return null;
  return {
    id: 'machine:unstick',
    kind: 'unstick',
    title: ACTION_TITLES[chosen.action] ?? 'Open',
    detail: move.reason,
    who: 'implementer',
    due: 'now',
    state: 'due',
    blocks: [],
    check: null,
    script: null,
    why: null,
    permissions: null,
    commands: [],
    verify: null,
    source: 'machine',
    doneBy: null,
    doneAt: null,
    action: chosen.action,
    ...(chosen.alternative === undefined ? {} : { alternative: chosen.alternative }),
  };
};

/** The glob's human steps with the stall hand-off added when it is stalled (any earlier `unstick` step is replaced). */
export const withUnstick = (
  steps: readonly HumanStep[],
  move: Move,
  glob: Pick<Glob, 'implementer'> = { implementer: null },
  options: UnstickOptions = {},
): HumanStep[] => {
  const rest = steps.filter((s) => s.kind !== 'unstick');
  const unstick = unstickStep(move, glob, options);
  return unstick === null ? rest : [unstick, ...rest];
};

/** Whether the move is a stall: the card's warning, the tab count and the notification. */
export const isStalled = (move: Move): boolean => move.holder === 'stalled';
