import { DEFAULT_STALL_MINUTES, agentSetVersionOfTitle, isAgentSetGlob, isInFlight, isStale, humanSteps as deriveHumanSteps, machineSteps as deriveMachineSteps, whoseMove } from '@slop/core';
import type { HumanStepViewer, MachineStep, MachineStepKind, Move } from '@slop/core';
import type { GlobView } from './api';

/**
 * Where a glob is, in one indicator: who has the ball and what they are doing. The card's chip and the glob view's "Now" row
 * read the same value. Derived from the move the server sends (or, for an older API or a single read without one, the same
 * pure functions run here), never stored.
 */
export interface Position {
  readonly holder: 'human' | 'machine' | 'waiting' | 'stalled';
  /** One short line: "implementing", "queued 3 min", "checks running on abc1234", "stalled: ...". */
  readonly text: string;
  /** The card's single line: a few words (the move's short label where it has one), never a file path or a sentence. */
  readonly label: string;
  readonly tip: string;
  /** Spins while the machine is running. */
  readonly spinning: boolean;
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
  resolve_conflict: 'fixing the conflict',
  answer_review: 'answering review',
  standby: 'standby',
  review_code: 'reviewing the code',
  size_check: 'checking the size',
  learning_pipeline: 'processing the learning',
  merge: 'merging',
  deploy: 'deploying',
  agent_set_commit: 'committing the agent set',
  rollout_check: 'checking rollout',
  checks: 'checks running',
  upload_wait: 'waiting for an upload',
};

const minutesSince = (at: string | null, now: string): number | null =>
  at === null ? null : Math.max(0, Math.floor((Date.parse(now) - Date.parse(at)) / 60_000));

const runDetail = (glob: GlobView): string[] => {
  const run = glob.currentRun ?? null;
  if (run === null || run.state === 'ended') return [];
  return [`Owned by ${run.routineOwner}, triggered by ${run.triggeredBy}`, ...(run.sessionUrl === null ? [] : [`Session: ${run.sessionUrl}`])];
};

const liveSession = (glob: GlobView): string | null => {
  const run = glob.currentRun ?? null;
  return run === null || run.state === 'ended' ? null : run.sessionUrl;
};

/** The move for a glob: the server's, else derived here from the glob alone. */
export const moveOf = (glob: GlobView, now: string, viewer?: HumanStepViewer): Move =>
  glob.move ??
  whoseMove(glob, deriveHumanSteps(glob, {}, []), glob.machineSteps ?? deriveMachineSteps(glob), new Map(), now, {
    ...(viewer === undefined ? {} : { viewer }),
  });

/** The machine steps for a glob: the server's, else derived here. */
export const stepsOf = (glob: GlobView): readonly MachineStep[] => glob.machineSteps ?? deriveMachineSteps(glob);

/** The step the machine is on: the first one holding the ball that is alive. */
const leadStep = (steps: readonly MachineStep[], now: string): MachineStep | undefined =>
  steps.find((s) => s.holdsBall && isInFlight(s) && !isStale(s, now, DEFAULT_STALL_MINUTES));

const machineText = (step: MachineStep, now: string): string => {
  // An armed merge is queued until the checks pass, but what the machine is doing is merging.
  if (step.kind === 'merge') return DOING.merge;
  if (step.state === 'queued') {
    const n = minutesSince(step.startedAt, now);
    return n === null || n < 1 ? 'queued' : `queued ${String(n)} min`;
  }
  return DOING[step.kind];
};

/**
 * The glob's position, or null when the indicator shows nothing: it is the viewer's turn (the Your turn chip says it), the
 * glob is idle in Planning, or it is signed off.
 */
export const positionOf = (glob: GlobView, now: string, viewer?: HumanStepViewer): Position | null => {
  const steps = stepsOf(glob);
  const move = moveOf(glob, now, viewer);
  const session = liveSession(glob);
  // Slop's own agent-set glob has no run, session or implementer: slop commits the set itself.
  if (isAgentSetGlob(glob) && session === null && (glob.status === 'in_progress' || glob.status === 'implementing')) {
    return {
      holder: 'machine',
      text: `committing agent set v${String(agentSetVersionOfTitle(glob.title))}`,
      label: `committing agent set v${String(agentSetVersionOfTitle(glob.title))}`,
      tip: 'Slop commits the agent set to this branch shortly after the board changes it, then marks the PR ready. Nobody works on it.',
      spinning: false,
      tone: 'text-muted-foreground',
      sessionUrl: null,
      onChecks: false,
      minutes: null,
    };
  }
  switch (move.holder) {
    case 'machine': {
      const lead = leadStep(steps, now);
      const text = lead === undefined ? move.reason : machineText(lead, now);
      const tip =
        lead?.state === 'queued'
          ? [`Machine run queued: ${session === null ? 'no session yet' : 'open the session'}`, ...runDetail(glob)]
          : ['The machine is working on it', ...runDetail(glob)];
      return {
        holder: 'machine',
        text,
        label: text,
        tip: tip.join('\n'),
        spinning: lead?.state === 'running',
        tone: 'text-muted-foreground',
        sessionUrl: session,
        onChecks: false,
        minutes: minutesSince(move.since, now),
      };
    }
    case 'waiting': {
      const armed = steps.some((s) => s.kind === 'merge' && s.id === 'machine:merge:armed');
      const checks = steps.some((s) => s.kind === 'checks' && isInFlight(s));
      return {
        holder: 'waiting',
        text: armed && checks ? `merging when checks pass${glob.pr?.headSha == null ? '' : ` · ${glob.pr.headSha.slice(0, 7)}`}` : move.reason,
        label: armed && checks ? `merging when checks pass${glob.pr?.headSha == null ? '' : ` · ${glob.pr.headSha.slice(0, 7)}`}` : move.reason,
        tip: armed && checks
          ? 'Slop merges the PR as soon as the checks on its head pass. If they fail or the PR conflicts, it stops and says why. Cancel merge stops it.'
          : `Waiting: ${move.reason}`,
        spinning: steps.some((s) => s.kind === 'checks' && s.state === 'running'),
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
        tone: 'text-required',
        sessionUrl: session,
        onChecks: false,
        minutes: move.minutes ?? minutesSince(move.since, now),
      };
    case 'human':
      // Without a server move or a viewer a due step could be anyone's, so say nothing; the Your turn chip covers the viewer.
      if (move.reason !== 'Picked up' && glob.move === undefined && viewer === undefined) return null;
      // Someone else's turn. A person's pick-up that nothing has touched keeps its old explanation.
      return {
        holder: 'human',
        text: move.reason === 'Picked up' ? 'picked up, no machine run' : move.reason,
        label: move.reason === 'Picked up' ? 'picked up, no machine run' : (move.label ?? move.reason),
        tip:
          move.reason === 'Picked up'
            ? `${move.who ?? 'Someone'} picked this up and no machine run is working on it. A local session isn't visible to slop. Start hands it to the machine.`
            : `${move.who ?? 'Someone'}'s turn: ${move.reason}`,
        spinning: false,
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
export const onStandby = (glob: GlobView): MachineStep | null => stepsOf(glob).find((s) => s.state === 'standby') ?? null;

/** A step's state in words, for the glob view's list. */
export const stepWords = (step: MachineStep, now: string): string => {
  const n = minutesSince(step.startedAt, now);
  const age = n === null ? '' : ` · ${String(n)} min`;
  if (step.state === 'standby') return `standby${age}`;
  if (step.state === 'failed') return `failed${step.detail === null ? '' : `: ${step.detail}`}`;
  return `${step.state}${age}`;
};

export const stepLabel = (step: MachineStep): string => DOING[step.kind];
