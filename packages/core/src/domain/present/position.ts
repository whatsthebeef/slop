import { CHECKS_RUNNING_TEXT, whoseMove, PAIRING_REASON, PICKED_UP_REASON } from '../whose-move.js';
import {
  DEFAULT_STALL_MINUTES,
  isInFlight,
  isStale,
  machineSteps as deriveMachineSteps,
} from '../machine-steps.js';
import { agentSetVersionOfTitle, isAgentSetGlob } from '../agent-set.js';
import { humanSteps as deriveHumanSteps } from '../human-steps.js';
import type { HumanStepViewer } from '../human-steps.js';
import type { MachineStep, MachineStepKind } from '../machine-steps.js';
import type { Move } from '../whose-move.js';
import type { PresentableGlob } from './facts.js';
import {
  checksInFlightWhileMerging,
  checksRunningTip,
  mergeQueueStatus,
  mergingChecksText,
} from './check-wording.js';

/**
 * Where a glob is, in one indicator: who has the ball and what they are doing. The card's chip and the glob view's "Now" row
 * read the same value. Derived from the move the server sends (or, for an older API or a single read without one, the same
 * pure functions run here), never stored.
 */
export interface Position {
  readonly holder: 'human' | 'machine' | 'waiting' | 'stalled';
  /** One short line: "implementing", "starting", "queued 3 min", "checks running", "stalled: ...". */
  readonly text: string;
  /** The card's single line: a few words (the move's short label where it has one), never a file path or a sentence. */
  readonly label: string;
  readonly tip: string;
  /** Spins while the machine is running. */
  readonly spinning: boolean;
  /** True when the machine's step is waiting to start (queued or starting), not yet running. */
  readonly queued: boolean;
  readonly tone: string;
  /** The session or run the indicator is about, when it has one. */
  readonly sessionUrl: string | null;
  /** True when the position is the checks on the PR head (the click opens them). */
  readonly onChecks: boolean;
  /** How long it has been so, in whole minutes, where known. */
  readonly minutes: number | null;
}

/** What the machine is doing, by the kind of step that holds the ball. */
const DOING: Readonly<Record<MachineStepKind, string>> = {
  provision: 'creating the branch',
  investigate: 'investigating',
  implement: 'implementing',
  fix_checks: 'fixing CI',
  resolve_conflict: 'fixing conflict',
  answer_review: 'answering review',
  standby: 'standby',
  review_code: 'reviewing the code',
  size_check: 'checking the size',
  learning_pipeline: 'processing the learning',
  recommendation: 'investigating',
  merge: 'merging',
  deploy: 'deploying',
  agent_set_commit: 'committing the agent set',
  rollout_check: 'checking rollout',
  checks: CHECKS_RUNNING_TEXT,
  upload_wait: 'waiting for an upload',
  merge_held: 'merge waits for another glob',
};

const minutesSince = (at: string | null, now: string): number | null =>
  at === null ? null : Math.max(0, Math.floor((Date.parse(now) - Date.parse(at)) / 60_000));

const runDetail = (glob: PresentableGlob): string[] => {
  const run = glob.currentRun ?? null;
  if (run === null || run.state === 'ended') return [];
  return [
    `Owned by ${run.routineOwner}, triggered by ${run.triggeredBy}`,
    ...(run.sessionUrl === null ? [] : [`Session: ${run.sessionUrl}`]),
  ];
};

const liveSession = (glob: PresentableGlob): string | null => {
  const run = glob.currentRun ?? null;
  return run === null || run.state === 'ended' ? null : run.sessionUrl;
};

/** The move for a glob: the server's, else derived here from the glob alone. */
export const moveOf = (glob: PresentableGlob, now: string, viewer?: HumanStepViewer): Move =>
  glob.move ??
  whoseMove(
    glob,
    deriveHumanSteps(glob, {}, []),
    glob.machineSteps ?? deriveMachineSteps(glob),
    glob.holding ?? [],
    now,
    {
      ...(viewer === undefined ? {} : { viewer }),
    },
  );

/** The machine steps for a glob: the server's, else derived here. */
export const stepsOf = (glob: PresentableGlob): readonly MachineStep[] =>
  glob.machineSteps ?? deriveMachineSteps(glob);

/** The step the machine is on: the first one holding the ball that is alive. */
const leadStep = (steps: readonly MachineStep[], now: string): MachineStep | undefined =>
  steps.find((s) => s.holdsBall && isInFlight(s) && !isStale(s, now, DEFAULT_STALL_MINUTES));

const machineText = (
  glob: PresentableGlob,
  step: MachineStep,
  now: string,
  base?: string,
): string => {
  // An armed merge is queued until the checks pass, but what the machine is doing is merging (the shared wording while they run).
  if (step.kind === 'merge')
    return (
      mergeQueueStatus(glob) ??
      (checksInFlightWhileMerging(glob) ? mergingChecksText(glob, base) : DOING.merge)
    );
  if (step.state === 'queued') {
    const n = minutesSince(step.startedAt, now);
    return n === null || n < 1 ? 'starting' : `queued ${String(n)} min`;
  }
  return DOING[step.kind];
};

/** Past this many minutes without a touch, a person's glob says how long it has been quiet. */
const QUIET_AFTER_MINUTES = 24 * 60;

const quietWords = (minutes: number): string => {
  const days = Math.floor(minutes / (24 * 60));
  return `quiet ${String(days)} ${days === 1 ? 'day' : 'days'}`;
};

/**
 * A glob a person holds, picked up (no machine run) or a super in a pairing session: says "Picked up" or "pairing" with the human icon and no name (the card's avatar says who; the
 * tooltip and the activity log carry the name and when), never "nobody". A long silence only adds how long.
 */
const heldByPerson = (move: Move, now: string, viewer?: HumanStepViewer): Position => {
  const who = move.who ?? '';
  const mine = viewer !== undefined && who === viewer.email;
  const full = mine ? 'You' : who === '' ? 'Someone' : who;
  const minutes = move.minutes ?? minutesSince(move.since, now);
  const quiet = minutes !== null && minutes >= QUIET_AFTER_MINUTES ? quietWords(minutes) : null;
  const pairing = move.reason === PAIRING_REASON;
  const text = pairing ? 'pairing' : `Picked up${quiet === null ? '' : `, ${quiet}`}`;
  const ago =
    minutes === null
      ? ''
      : ` ${minutes < 60 ? `${String(minutes)} min` : minutes < QUIET_AFTER_MINUTES ? `${String(Math.round(minutes / 60))} h` : `${String(Math.round(minutes / 1440))} d`} ago`;
  return {
    holder: 'human',
    text,
    label: text,
    tip: pairing
      ? `${full} ${mine ? 'are' : 'is'} pairing on this super${ago === '' ? '' : `; last touched${ago}`}. The session is local, so slop can't see it.`
      : `${full} picked this up${ago}. A local session isn't visible to slop; Start hands it back to the machine.`,
    spinning: false,
    queued: false,
    tone: 'text-muted-foreground',
    sessionUrl: null,
    onChecks: false,
    minutes,
  };
};

/**
 * The glob's position, or null when the indicator shows nothing: it is the viewer's turn (the Your turn chip says it), the
 * glob is idle in Planning, or it is signed off.
 */
export const positionOf = (
  glob: PresentableGlob,
  now: string,
  viewer?: HumanStepViewer,
  base?: string,
): Position | null => {
  const steps = stepsOf(glob);
  const move = moveOf(glob, now, viewer);
  const session = liveSession(glob);
  // Slop's own agent-set glob has no run, session or implementer: slop commits the set itself. Once its checks run or it merges,
  // it reads like any other glob.
  if (
    isAgentSetGlob(glob) &&
    session === null &&
    !steps.some((s) => s.kind === 'checks' || s.kind === 'merge') &&
    move.holder !== 'waiting' &&
    (glob.status === 'in_progress' || glob.status === 'implementing')
  ) {
    return {
      holder: 'machine',
      text: `committing agent set v${String(agentSetVersionOfTitle(glob.title))}`,
      label: `committing agent set v${String(agentSetVersionOfTitle(glob.title))}`,
      tip: 'Slop commits the agent set to this branch shortly after the board changes it, then marks the PR ready. Nobody works on it.',
      spinning: false,
      queued: false,
      tone: 'text-muted-foreground',
      sessionUrl: null,
      onChecks: false,
      minutes: null,
    };
  }
  switch (move.holder) {
    case 'machine': {
      const lead = leadStep(steps, now);
      const text = lead === undefined ? move.reason : machineText(glob, lead, now, base);
      const tip =
        lead?.kind === 'recommendation'
          ? [
              'Slop is getting its recommendation, as it does when the learning is picked up and when the draft changes',
            ]
          : lead?.state === 'queued'
            ? [
                `Machine run queued: ${session === null ? 'no session yet' : 'open the session'}`,
                ...runDetail(glob),
              ]
            : ['The machine is working on it', ...runDetail(glob)];
      return {
        holder: 'machine',
        text,
        label: text,
        tip: tip.join('\n'),
        spinning: lead?.state === 'running',
        queued: lead?.state === 'queued' && lead.kind !== 'merge',
        tone: 'text-muted-foreground',
        sessionUrl: session,
        onChecks: false,
        minutes: minutesSince(move.since, now),
      };
    }
    case 'waiting': {
      const armed = steps.some((s) => s.kind === 'merge' && s.id === 'machine:merge:armed');
      const checks = steps.some((s) => s.kind === 'checks' && isInFlight(s));
      const sha = glob.pr?.headSha ?? null;
      const text = armed && checks ? mergingChecksText(glob, base) : move.reason;
      return {
        holder: 'waiting',
        text,
        label: text,
        tip:
          armed && checks
            ? `Slop merges the PR as soon as the checks on its head${sha === null ? '' : ` (${sha.slice(0, 7)})`} pass. If they fail or the PR conflicts, it stops and says why. Cancel merge stops it.`
            : checks
              ? `${move.reason === CHECKS_RUNNING_TEXT ? '' : `Waiting: ${move.reason}\n`}${checksRunningTip(glob)}`
              : `Waiting: ${move.reason}`,
        spinning: steps.some((s) => s.kind === 'checks' && s.state === 'running'),
        queued: false,
        tone: 'text-muted-foreground',
        sessionUrl: null,
        onChecks: checks,
        minutes: minutesSince(move.since, now),
      };
    }
    case 'stalled':
      return {
        holder: 'stalled',
        text: `stalled: ${move.reason}`,
        label: move.label ?? `stalled: ${move.reason}`,
        tip: `Stalled: ${move.reason}\nNobody is moving this glob. The first step in Your turn gets it going.${session === null ? '' : `\nSession: ${session}`}`,
        spinning: false,
        queued: false,
        tone: 'text-required',
        sessionUrl: session,
        onChecks: false,
        minutes: move.minutes ?? minutesSince(move.since, now),
      };
    case 'human':
      // Without a server move or a viewer a due step could be anyone's, so say nothing; the Your turn chip covers the viewer.
      if (move.reason === PICKED_UP_REASON || move.reason === PAIRING_REASON)
        return heldByPerson(move, now, viewer);
      if (glob.move === undefined && viewer === undefined) return null;
      // Someone else's turn.
      return {
        holder: 'human',
        text: move.reason,
        label: move.label ?? move.reason,
        tip: `${move.who ?? 'Someone'}'s turn: ${move.reason}`,
        spinning: false,
        queued: false,
        tone: 'text-muted-foreground',
        sessionUrl: null,
        onChecks: false,
        minutes: minutesSince(move.since, now),
      };
    default:
      return null;
  }
};

/** Whether the machine is on standby for the glob (fixes new CI failures and review comments until it merges). */
export const onStandby = (glob: PresentableGlob): MachineStep | null =>
  stepsOf(glob).find((s) => s.state === 'standby') ?? null;

/** A step's state in words, for the glob view's list. */
export const stepWords = (step: MachineStep, now: string): string => {
  const n = minutesSince(step.startedAt, now);
  const age = n === null ? '' : ` · ${String(n)} min`;
  if (step.state === 'standby') return `standby${age}`;
  if (step.state === 'failed') return `failed${step.detail === null ? '' : `: ${step.detail}`}`;
  return `${step.state}${age}`;
};

export const stepLabel = (step: MachineStep): string => DOING[step.kind];
