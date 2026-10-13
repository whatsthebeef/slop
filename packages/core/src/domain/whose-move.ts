import { isForViewer } from './human-steps.js';
import type { HumanStep, HumanStepViewer, StepAction } from './human-steps.js';
import type { Action } from './machine.js';
import { DEFAULT_STALL_MINUTES, isInFlight, isStale, isWaitingStep, quietMinutes } from './machine-steps.js';
import type { MachineStep, StallThresholds } from './machine-steps.js';
import type { Glob } from './types.js';
import { waitingFor } from './waiting.js';
import type { DependencyState } from './waiting.js';

/**
 * Whose move it is on a glob: exactly one holder, reduced from the human steps, the machine steps and the glob's
 * dependencies. `you` and `human` are a person's turn (the viewer's, or someone else's), `machine` is slop at work,
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
  /** When the holder took the ball, where slop knows. */
  readonly since: string | null;
  /** `you` and `human`: whom the step is for (the viewer's email, or the step's role or email). */
  readonly who?: string;
  /** `waiting`: what it waits on (glob IDs, `checks`, `deploy:<env>`, ...). */
  readonly waitingOn?: readonly string[];
  /** `stalled`: why, and for how many minutes when it is time. */
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

/** Two states a person is the one to move in, whatever steps say: sign-off labels asked for, an escalation. */
const personReason = (glob: Glob): string | null => {
  if (glob.status === 'reviewing' && Object.values(glob.labels).some((l) => l === 'required' || l === 'added')) return 'Review needed';
  if (glob.escalation != null && glob.status !== 'signed_off' && glob.status !== 'failed') return `Needs a human: ${glob.escalation.reason}`;
  return null;
};

const holderOf = (who: string, glob: Pick<Glob, 'implementer' | 'planner'>): string =>
  who === 'implementer' ? (glob.implementer ?? glob.planner) : who;

const stalled = (cause: StallCause, reason: string, since: string | null, minutes?: number): Move => ({
  holder: 'stalled',
  reason,
  since,
  cause,
  ...(minutes === undefined ? {} : { minutes }),
});

const earliest = (steps: readonly MachineStep[]): string | null =>
  steps.map((s) => s.startedAt).filter((t): t is string => t !== null).sort()[0] ?? null;

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
  dependencies: ReadonlyMap<string, DependencyState>,
  now: string,
  options: MoveOptions = {},
): Move => {
  const thresholds = options.thresholds ?? DEFAULT_STALL_MINUTES;
  if (glob.status === 'signed_off') return { holder: 'done', reason: 'Signed off', since: glob.signedOffAt };

  // 1. A person's turn: a step that is due.
  const due = humanSteps.filter((s) => s.kind !== 'unstick' && s.state === 'due');
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

  // 3. Waiting: checks, a deploy, an unseen upload, an unmerged need, or a rollout the glob's steps wait on.
  const waits = machineSteps.filter((s) => isWaitingStep(s) && isInFlight(s));
  const awaited = glob.status === 'planning' ? waitingFor(glob, dependencies) : [];
  const rollouts = humanSteps.filter((s) => s.state === 'pending' && s.blocks.length > 0);
  if (waits.length > 0 || awaited.length > 0) {
    const on = [...awaited.map((a) => a.id), ...waits.map((s) => (s.kind === 'deploy' ? `deploy:${s.detail ?? ''}` : s.kind))];
    const reason =
      awaited.length > 0
        ? `waiting on ${awaited.map((a) => a.id).join(', ')}`
        : waits.map((s) => (s.kind === 'checks' ? `checks running on ${s.detail ?? 'the head'}` : s.kind === 'deploy' ? `deploying to ${s.detail ?? 'an environment'}` : `waiting for ${s.detail ?? 'the upload'}`)).join('; ');
    return { holder: 'waiting', reason, since: earliest(waits), waitingOn: on };
  }
  if (rollouts.length > 0 && quiet.length === 0 && !machineSteps.some((s) => s.state === 'failed')) {
    const first = rollouts[0];
    return { holder: 'waiting', reason: `waiting for ${first?.title ?? 'a step'}`, since: null, waitingOn: rollouts.map((s) => s.id) };
  }

  // 4. A person's turn by state: sign-off asked for, an escalation. Nothing failed.
  const person = personReason(glob);
  const failed = machineSteps.filter((s) => s.state === 'failed');
  if (person !== null && failed.length === 0 && quiet.length === 0) {
    return { holder: options.viewer !== undefined && (glob.implementer ?? glob.planner) === options.viewer.email ? 'you' : 'human', reason: person, since: null, who: glob.implementer ?? glob.planner };
  }

  // 5. Idle: a Planning glob nobody started.
  const live = machineSteps.some((s) => s.state !== 'done' && s.state !== 'standby');
  if (glob.status === 'planning' && glob.failure === null && !live) return { holder: 'idle', reason: 'Not started', since: null };

  // 6. Stalled: something failed, something went quiet, or nobody is on it.
  const gone = failed[0];
  if (gone !== undefined) return stalled('failed', gone.detail ?? 'the machine stopped', gone.startedAt);
  const slow = quiet[0];
  if (slow !== undefined) {
    const minutes = quietMinutes(slow, now) ?? 0;
    return stalled(slow.state === 'queued' ? 'queued' : 'quiet', quietReason(slow, minutes), slow.lastProgressAt ?? slow.startedAt, minutes);
  }
  if (glob.implementer !== null && (glob.status === 'implementing' || glob.status === 'in_progress')) {
    if (options.complete === false) return { holder: 'idle', reason: 'Not enough facts to say', since: null };
    const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(glob.updatedAt)) / 60_000));
    if (minutes < thresholds.pickedUp) return { holder: 'human', reason: 'Picked up', since: glob.updatedAt, who: glob.implementer };
    return stalled('nobody', `picked up ${String(minutes)} min ago, no session`, glob.updatedAt, minutes);
  }
  if (options.complete === false) return { holder: 'idle', reason: 'Not enough facts to say', since: null };
  return stalled('nobody', 'nobody is on this', glob.updatedAt);
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
