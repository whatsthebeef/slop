import { isForViewer } from './human-steps.js';
import type { HumanStep, HumanStepViewer } from './human-steps.js';
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

/** A state a person is the one to move in, whatever steps say: sign-off labels asked for. */
const personReason = (glob: Glob): string | null =>
  glob.status === 'reviewing' && Object.values(glob.labels).some((l) => l === 'required' || l === 'added') ? 'Review needed' : null;

/** An escalation is a person's turn only when nothing else holds the ball: it never outranks a machine step (see `whoseMove`). */
const escalationReason = (glob: Glob): string | null =>
  glob.escalation != null && glob.status !== 'signed_off' && glob.status !== 'failed' ? `Needs a human: ${glob.escalation.reason}` : null;

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

  // 4. A person's turn by state: sign-off asked for. Nothing failed.
  const person = personReason(glob);
  const failed = machineSteps.filter((s) => s.state === 'failed');
  if (person !== null && failed.length === 0 && quiet.length === 0) {
    return { holder: options.viewer !== undefined && (glob.implementer ?? glob.planner) === options.viewer.email ? 'you' : 'human', reason: person, since: null, who: glob.implementer ?? glob.planner };
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
    if (checks?.state === 'failed' && checks.inheritedFrom === undefined) {
      // A watching run is about to answer failed checks; otherwise it is a person's.
      if (standby !== undefined) return { holder: 'machine', reason: 'fix checks', since: checks.at ?? null };
      return mover('Fix checks');
    }
  }

  // 4c. A person's turn by escalation: only after the machine had its say above (a run working, a watcher answering failed checks).
  const escalation = escalationReason(glob);
  if (escalation !== null && failed.length === 0 && quiet.length === 0) {
    return {
      holder: options.viewer !== undefined && (glob.implementer ?? glob.planner) === options.viewer.email ? 'you' : 'human',
      reason: escalation,
      since: null,
      who: glob.implementer ?? glob.planner,
    };
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

const UNSTICK_TITLES: Readonly<Record<StallCause, (m: Move) => string>> = {
  failed: () => 'Machine stopped: retry or pick up',
  queued: (m) => `Queued for ${String(m.minutes ?? 0)} min: open the session`,
  quiet: (m) => `No progress for ${String(m.minutes ?? 0)} min: open the session`,
  nobody: () => 'Nobody is on this: start, hand to machine or pick up',
};

/**
 * The human step a stalled glob adds: for the implementer, or the planner while nobody implements. Derived from the move, so
 * it is gone the moment the cause is.
 */
export const unstickStep = (move: Move): HumanStep | null => {
  if (move.holder !== 'stalled' || move.cause === undefined) return null;
  return {
    id: 'machine:unstick',
    kind: 'unstick',
    title: UNSTICK_TITLES[move.cause](move),
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
  };
};

/** The glob's human steps with the stall hand-off added when it is stalled (any earlier `unstick` step is replaced). */
export const withUnstick = (steps: readonly HumanStep[], move: Move): HumanStep[] => {
  const rest = steps.filter((s) => s.kind !== 'unstick');
  const unstick = unstickStep(move);
  return unstick === null ? rest : [unstick, ...rest];
};

/** Whether the move is a stall: the card's warning, the tab count and the notification. */
export const isStalled = (move: Move): boolean => move.holder === 'stalled';
