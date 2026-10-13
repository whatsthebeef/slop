import type { Deploy } from './deploys.js';
import type { Board, Glob, Run } from './types.js';

/**
 * Machine steps: what slop is doing for a glob, as one list, the machine's counterpart of human steps. Derived on every
 * read from what slop already stores (runs, provisioning, head checks, deploys, the merge state) and the few facts the
 * caller reads for a batch of globs (pending effects, unseen uploads, pipeline state). Never stored.
 */

export const MACHINE_STEP_KINDS = [
  'provision',
  'investigate',
  'implement',
  'fix_checks',
  'resolve_conflict',
  'answer_review',
  'standby',
  'review_code',
  'size_check',
  'learning_pipeline',
  'merge',
  'deploy',
  'agent_set_commit',
  'checks',
  'upload_wait',
] as const;
export type MachineStepKind = (typeof MACHINE_STEP_KINDS)[number];

export const MACHINE_STEP_STATES = ['queued', 'running', 'standby', 'failed', 'done'] as const;
export type MachineStepState = (typeof MACHINE_STEP_STATES)[number];

export interface MachineStep {
  readonly id: string;
  readonly kind: MachineStepKind;
  readonly state: MachineStepState;
  /** When it was queued or began; null when slop doesn't know. */
  readonly startedAt: string | null;
  /** The last sign of life: a run's last slop call. Null for steps that report none. */
  readonly lastProgressAt: string | null;
  /** A session URL, a commit, an environment, a failure reason. */
  readonly detail: string | null;
  /** Whether the machine has the ball while it is queued or running. Standby never does. */
  readonly holdsBall: boolean;
}

/** Steps that only wait on something automated: the glob is Waiting while they run, never Machine. */
export const WAITING_STEP_KINDS: readonly MachineStepKind[] = ['checks', 'deploy', 'upload_wait'];

export const isWaitingStep = (step: Pick<MachineStep, 'kind'>): boolean => WAITING_STEP_KINDS.includes(step.kind);

/** A queued or running step: work in flight, not finished, failed or on standby. */
export const isInFlight = (step: Pick<MachineStep, 'state'>): boolean => step.state === 'queued' || step.state === 'running';

/** An outbox effect for the glob that hasn't finished, as the server reads it for the whole board in one query. */
export interface PendingEffect {
  /** The effect's kind (`review_change`, `squash_merge`, ...). */
  readonly kind: string;
  /** `failed`: it gave up retrying. */
  readonly state: 'queued' | 'running' | 'failed';
  readonly since: string;
  readonly error?: string | null;
}

/** What the glob alone can't say. Every field is optional: a caller that lacks one just gets fewer steps. */
export interface MachineFacts {
  /** The glob's deploys (any state; finished ones are ignored). */
  readonly deploys?: readonly Pick<Deploy, 'id' | 'environment' | 'sha' | 'state' | 'requestedAt' | 'runningSince' | 'url'>[];
  readonly effects?: readonly PendingEffect[];
  /** Files whose upload link was issued but whose file slop hasn't seen yet. */
  readonly pendingUploads?: readonly { readonly key: string; readonly fileName: string; readonly since: string }[];
  /** A decision glob's learning pipeline, while it processes. */
  readonly pipeline?: { readonly state: 'queued' | 'running' | 'failed'; readonly since: string } | null;
  /** Intake's size check hasn't answered yet. */
  readonly sizeCheck?: { readonly since: string } | null;
}

/** Effect kinds that are a machine step of their own; the rest (housekeeping, refreshes) don't show. */
const EFFECT_STEP: Readonly<Record<string, MachineStepKind>> = {
  provision: 'provision',
  open_pr: 'provision',
  review_change: 'review_code',
  kb_route: 'learning_pipeline',
  kb_draft: 'learning_pipeline',
  suggest_decision: 'learning_pipeline',
  squash_merge: 'merge',
  revert_merge: 'merge',
  evaluate_sub_gate: 'merge',
  commit_agent_set: 'agent_set_commit',
};

const short = (sha: string): string => sha.slice(0, 7);

const step = (
  kind: MachineStepKind,
  state: MachineStepState,
  rest: Partial<Omit<MachineStep, 'kind' | 'state'>> = {},
): MachineStep => ({
  id: rest.id ?? `machine:${kind}`,
  kind,
  state,
  startedAt: rest.startedAt ?? null,
  lastProgressAt: rest.lastProgressAt ?? null,
  detail: rest.detail ?? null,
  holdsBall: rest.holdsBall ?? (!WAITING_STEP_KINDS.includes(kind) && kind !== 'standby'),
});

/** What a run is doing, from the glob around it: the kinds of work a routine run does. */
const runKind = (glob: Glob, run: Run): MachineStepKind => {
  if (run.purpose === 'investigate') return 'investigate';
  if (run.purpose === 'resolve_conflict') return 'resolve_conflict';
  if (glob.status === 'reviewing') return 'answer_review';
  if (glob.headChecks?.state === 'failed' && glob.headChecks.inheritedFrom === undefined) return 'fix_checks';
  return 'implement';
};

const runStep = (glob: Glob, run: Run): MachineStep | null => {
  const detail = run.sessionUrl;
  switch (run.state) {
    case 'queued':
      return step(runKind(glob, run), 'queued', { id: `machine:run:${run.id}`, startedAt: run.queuedAt, lastProgressAt: run.lastProgressAt, detail });
    case 'active':
      return step(runKind(glob, run), 'running', {
        id: `machine:run:${run.id}`,
        startedAt: run.startedAt ?? run.queuedAt,
        lastProgressAt: run.lastProgressAt,
        detail,
      });
    case 'watching':
      return step('standby', 'standby', { id: `machine:run:${run.id}`, startedAt: run.startedAt, lastProgressAt: run.lastProgressAt, detail, holdsBall: false });
    case 'ended':
      return null;
  }
};

const failedKind = (glob: Glob): MachineStepKind => {
  switch (glob.failure?.kind) {
    case 'merge':
    case 'reverted':
      return 'merge';
    case 'provisioning':
      return 'provision';
    default:
      return glob.status === 'reviewing' ? 'answer_review' : 'implement';
  }
};

/** Everything the machine is doing, or has stopped doing, for the glob right now. Pure: the glob and the facts in, the steps out. */
export const machineSteps = (glob: Glob, facts: MachineFacts = {}): MachineStep[] => {
  const steps: MachineStep[] = [];
  const run = glob.runs[glob.runs.length - 1];
  const effectKinds = new Set<MachineStepKind>();

  if (glob.provisioning === 'pending') steps.push(step('provision', 'running', { startedAt: glob.doingSince ?? glob.updatedAt }));
  if (run !== undefined) {
    const s = runStep(glob, run);
    if (s !== null) steps.push(s);
  }
  // A failed glob: the step that stopped. A run that gave up also leaves `failure` on the glob, so one source covers both.
  if (glob.failure !== null && glob.status !== 'signed_off') {
    steps.push(
      step(failedKind(glob), 'failed', { id: 'machine:failed', startedAt: glob.failure.at, detail: glob.failure.reason, holdsBall: false }),
    );
  }

  // Checks run by the code host: Waiting, not Machine.
  if (glob.pr !== null && glob.headChecks?.state === 'pending') {
    steps.push(step('checks', 'running', { detail: short(glob.headChecks.sha), startedAt: glob.headChecks.at ?? null }));
  }
  // Merge pressed before the checks passed: slop merges the moment they do. Until then the checks hold the ball.
  if (glob.mergeMode === 'when_green') {
    const checksPassed = glob.headChecks?.state === 'passed';
    steps.push(step('merge', 'queued', { id: 'machine:merge:armed', detail: 'merge when checks pass', holdsBall: checksPassed }));
  } else if (glob.mergeMode === 'continue' || glob.status === 'merging') {
    steps.push(step('merge', 'running', { id: 'machine:merge:running' }));
  }

  for (const d of facts.deploys ?? []) {
    if (d.state !== 'waiting' && d.state !== 'running') continue;
    steps.push(
      step('deploy', d.state === 'running' ? 'running' : 'queued', {
        id: `machine:deploy:${d.id}`,
        startedAt: d.runningSince ?? d.requestedAt,
        detail: d.url ?? d.environment,
      }),
    );
  }
  for (const u of facts.pendingUploads ?? []) {
    steps.push(step('upload_wait', 'queued', { id: `machine:upload_wait:${u.key}`, startedAt: u.since, detail: u.fileName }));
  }
  if (facts.sizeCheck != null) steps.push(step('size_check', 'running', { startedAt: facts.sizeCheck.since }));
  if (facts.pipeline != null) {
    steps.push(
      step('learning_pipeline', facts.pipeline.state, { startedAt: facts.pipeline.since, holdsBall: facts.pipeline.state !== 'failed' }),
    );
    effectKinds.add('learning_pipeline');
  }

  for (const e of facts.effects ?? []) {
    const kind = EFFECT_STEP[e.kind];
    if (kind === undefined) continue;
    // The pipeline fact already says it, and a provision effect repeats `provisioning`.
    if (effectKinds.has(kind) || (kind === 'provision' && glob.provisioning === 'pending')) continue;
    const key = `machine:effect:${e.kind}`;
    if (steps.some((s) => s.id === key)) continue;
    steps.push(step(kind, e.state, { id: key, startedAt: e.since, detail: e.error ?? null, holdsBall: e.state !== 'failed' }));
  }

  if (glob.provisioning === 'failed' && !steps.some((s) => s.kind === 'provision' && s.state === 'failed')) {
    steps.push(step('provision', 'failed', { id: 'machine:provision:failed', holdsBall: false }));
  }
  return steps;
};

/** The minutes a step may go without a sign of life before the glob counts as stalled. */
export interface StallThresholds {
  /** A run that is working (implementing, fixing, investigating, answering review). */
  readonly implement: number;
  /** Anything queued. */
  readonly queued: number;
  /** Branch and PR creation. */
  readonly provision: number;
  /** Any other machine step. */
  readonly other: number;
  /** A glob a person picked up that has no run and hasn't been written to. */
  readonly pickedUp: number;
}

export const DEFAULT_STALL_MINUTES: StallThresholds = { implement: 45, queued: 20, provision: 10, other: 30, pickedUp: 30 };

/**
 * The board's thresholds: the defaults, held below the minutes after which slop fails the run itself, so a card shows
 * stalled before the run is failed.
 */
export const stallThresholds = (
  board: Pick<Board, 'runNoProgressHours' | 'runStartMinutes'> | null = null,
): StallThresholds => {
  if (board === null) return DEFAULT_STALL_MINUTES;
  const below = (limit: number, minutes: number) => Math.max(1, Math.min(minutes, Math.floor(limit * 0.75)));
  return {
    ...DEFAULT_STALL_MINUTES,
    implement: below(board.runNoProgressHours * 60, DEFAULT_STALL_MINUTES.implement),
    queued: below(board.runStartMinutes, DEFAULT_STALL_MINUTES.queued),
  };
};

const RUN_WORK_KINDS: readonly MachineStepKind[] = ['implement', 'fix_checks', 'resolve_conflict', 'answer_review', 'investigate'];

/** How many minutes this step may be quiet for, by its kind and state. */
export const thresholdFor = (s: Pick<MachineStep, 'kind' | 'state'>, t: StallThresholds): number => {
  if (s.state === 'queued') return t.queued;
  if (s.kind === 'provision') return t.provision;
  return RUN_WORK_KINDS.includes(s.kind) ? t.implement : t.other;
};

/** Minutes the step has been quiet: since its last sign of life, else since it began. Null when slop has no time for it. */
export const quietMinutes = (s: Pick<MachineStep, 'startedAt' | 'lastProgressAt' | 'state'>, now: string): number | null => {
  const from = s.state === 'queued' ? s.startedAt : (s.lastProgressAt ?? s.startedAt);
  if (from === null) return null;
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(from)) / 60_000));
};

/** Whether a step in flight has been quiet longer than its threshold. */
export const isStale = (s: MachineStep, now: string, t: StallThresholds): boolean => {
  if (!isInFlight(s)) return false;
  const quiet = quietMinutes(s, now);
  return quiet !== null && quiet >= thresholdFor(s, t);
};
