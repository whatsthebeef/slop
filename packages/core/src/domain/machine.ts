/**
 * The glob state machine. Every function is pure: it takes the glob's current state and
 * returns the next state plus the domain events to log and the effects to queue, or a
 * domain error. The numbered rows refer to the transition table in the spec.
 */
import { err, forbidden, invalidCombination, invalidInput, ok, runActive } from './errors.js';
import type { Result } from './errors.js';
import type { DomainEvent, DomainEventType, Effect, JsonValue } from './events.js';
import { isValidCombination, listOf } from './matrix.js';
import type {
  Actor,
  Board,
  Category,
  Glob,
  LabelName,
  LabelState,
  Labels,
  Run,
  RunOutcome,
  SlopType,
  Status,
} from './types.js';

export interface Context {
  /** The person acting, or null for system and integration events. */
  readonly actor: Actor | null;
  readonly now: string;
  readonly newRunId: () => string;
  /** Whose routine runs for a trigger by this person (theirs, or the board's fallback). */
  readonly routineOwnerFor: (triggeredBy: string) => string;
}

export interface Transition {
  readonly glob: Glob;
  readonly changed: boolean;
  readonly events: readonly DomainEvent[];
  readonly effects: readonly Effect[];
}

export type Action =
  | 'start'
  | 'pick_up'
  | 'take_over'
  | 'retrigger'
  | 'start_again'
  | 'merge'
  | 'delete';

// ---------------------------------------------------------------------------
// Helpers

export const currentRun = (glob: Glob): Run | null => glob.runs.at(-1) ?? null;

/** A run that has called slop and not ended: pick-up is refused while one exists. */
export const hasBusyRun = (glob: Glob): boolean => {
  const run = currentRun(glob);
  return run !== null && (run.state === 'active' || run.state === 'watching');
};

/** Any run that has not ended, including one still queued. */
export const hasLiveRun = (glob: Glob): boolean => {
  const run = currentRun(glob);
  return run !== null && run.state !== 'ended';
};

const initialStatus = (type: SlopType): Status =>
  type === 'sub' ? 'implementing' : type === 'same' ? 'planning' : 'in_progress';

const requiredLabels = (type: SlopType): Labels =>
  type === 'sub' ? { QA: 'required' } : { FR: 'required', CR: 'required', QA: 'required' };

class Builder {
  private readonly events: DomainEvent[] = [];
  private readonly effects: Effect[] = [];
  private changed = false;

  constructor(
    private glob: Glob,
    private readonly ctx: Context,
  ) {}

  get current(): Glob {
    return this.glob;
  }

  set(patch: Partial<Glob>): this {
    this.glob = { ...this.glob, ...patch };
    this.changed = true;
    return this;
  }

  status(to: Status): this {
    const from = this.glob.status;
    if (from === to) return this;
    const entersDoing = listOf(from) !== 'doing' && listOf(to) === 'doing';
    const leavesDoing = listOf(to) !== 'doing';
    this.set({
      status: to,
      doingSince: entersDoing ? this.ctx.now : leavesDoing ? null : this.glob.doingSince,
    });
    this.event('StatusChanged', { from, to });
    return listOf(to) === 'doing' ? this.ensureProvisioned() : this;
  }

  /** A glob gets its branch and draft PR when it enters Doing; queued before any routine run. */
  ensureProvisioned(): this {
    if (this.glob.provisioning !== 'none') return this;
    this.set({ provisioning: 'pending' });
    return this.effect({ kind: 'provision', globId: this.glob.id, generation: this.glob.generation });
  }

  event(type: DomainEventType, data: { readonly [key: string]: JsonValue } = {}): this {
    this.events.push({
      type,
      globId: this.glob.id,
      actor: this.ctx.actor?.email ?? null,
      at: this.ctx.now,
      data,
    });
    return this;
  }

  effect(effect: Effect): this {
    this.effects.push(effect);
    return this;
  }

  /** Ends the current run if it has not ended. */
  endRun(outcome: RunOutcome, failureReason: string | null = null): this {
    const run = currentRun(this.glob);
    if (run === null || run.state === 'ended') return this;
    const ended: Run = { ...run, state: 'ended', outcome, endedAt: this.ctx.now, failureReason };
    this.set({ runs: [...this.glob.runs.slice(0, -1), ended] });
    return outcome === 'failed'
      ? this.event('RunFailed', { runId: run.id, reason: failureReason })
      : this.event('RunEnded', { runId: run.id, outcome });
  }

  updateRun(patch: Partial<Run>): this {
    const run = currentRun(this.glob);
    if (run === null) return this;
    return this.set({ runs: [...this.glob.runs.slice(0, -1), { ...run, ...patch }] });
  }

  /** Queues a new routine run for whoever triggered it. */
  queueRun(triggeredBy: string): this {
    const run: Run = {
      id: this.ctx.newRunId(),
      state: 'queued',
      outcome: null,
      generation: this.glob.generation,
      triggeredBy,
      routineOwner: this.ctx.routineOwnerFor(triggeredBy),
      queuedAt: this.ctx.now,
      startedAt: null,
      lastProgressAt: null,
      endedAt: null,
      failureReason: null,
      sessionId: null,
      sessionUrl: null,
    };
    this.set({ runs: [...this.glob.runs, run] });
    this.event('RunTriggered', {
      runId: run.id,
      triggeredBy,
      routineOwner: run.routineOwner,
    });
    return this.effect({
      kind: 'fire_routine',
      globId: this.glob.id,
      generation: this.glob.generation,
      runId: run.id,
      routineOwner: run.routineOwner,
    });
  }

  bumpGeneration(): this {
    return this.set({ generation: this.glob.generation + 1 });
  }

  done(): Result<Transition> {
    const glob = this.changed ? { ...this.glob, updatedAt: this.ctx.now } : this.glob;
    return ok({ glob, changed: this.changed, events: this.events, effects: this.effects });
  }
}

const unchanged = (glob: Glob): Result<Transition> =>
  ok({ glob, changed: false, events: [], effects: [] });

const invalidTransition = (glob: Glob, actor: Actor | null, message: string): Result<never> =>
  err({
    code: 'invalid_transition',
    message,
    status: glob.status,
    allowedActions: actor === null ? [] : allowedActions(glob, actor),
  });

const requireActor = (ctx: Context): Actor => {
  if (ctx.actor === null) throw new Error('This command needs an actor');
  return ctx.actor;
};

// ---------------------------------------------------------------------------
// Creation (rows 1–4)

export interface CreateInput {
  readonly id: string;
  readonly boardId: number;
  readonly title: string;
  readonly summary: string;
  readonly type: SlopType;
  readonly category: Category;
  readonly group: string | null;
  readonly environment: string | null;
  /** Same only: start a routine run immediately (explicit instruction or `runRoutine`). */
  readonly autoTrigger: boolean;
}

export const create = (input: CreateInput, board: Board, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (!isValidCombination(input.type, input.category)) {
    return invalidCombination(`A ${input.category} cannot be a ${input.type}`);
  }
  if ((actor.role === 'qa' || actor.role === 'po') && input.type === 'super') {
    return forbidden('QA and PO members cannot create supers');
  }
  if (input.title.trim() === '') return invalidInput('A glob needs a title');
  const envCheck = checkEnvironment(board, input.environment);
  if (!envCheck.ok) return envCheck;

  const autoStart = input.type === 'same' && input.autoTrigger;
  const status: Status = autoStart ? 'implementing' : initialStatus(input.type);
  const glob: Glob = {
    id: input.id,
    boardId: input.boardId,
    title: input.title.trim(),
    summary: input.summary,
    type: input.type,
    category: input.category,
    group: input.group,
    environment: input.environment,
    status,
    version: 0,
    generation: 1,
    creator: actor.email,
    planner: actor.email,
    implementer: input.type === 'super' ? actor.email : null,
    labels: {},
    pr: null,
    headChecks: null,
    runs: [],
    failure: null,
    provisioning: 'none',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    signedOffAt: null,
    doingSince: listOf(status) === 'doing' ? ctx.now : null,
  };
  const b = new Builder(glob, ctx).event('GlobCreated', {
    type: glob.type,
    category: glob.category,
    group: glob.group,
    environment: glob.environment,
    status,
  });
  // Subs, supers and auto-started sames start in Doing, so they provision now.
  if (listOf(status) === 'doing') b.ensureProvisioned();
  if (input.type === 'sub' || autoStart) b.queueRun(actor.email);
  return b.done();
};

export const checkEnvironment = (board: Board, environment: string | null): Result<null> => {
  if (environment === null) return ok(null);
  const env = board.environments.find((e) => e.name === environment);
  if (env === undefined) return invalidInput(`Board has no environment named ${environment}`);
  if (!env.allowBranchDeploy) {
    return invalidInput(`Environment ${environment} does not allow branch deploys`);
  }
  return ok(null);
};

// ---------------------------------------------------------------------------
// Commands from people

/** Row 5: start a same's routine run from planning. */
export const start = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status !== 'planning' || glob.type !== 'same') {
    return invalidTransition(glob, actor, 'Only a same in planning can be started');
  }
  return new Builder(glob, ctx).status('implementing').queueRun(actor.email).done();
};

/** Rows 6–10: pick up, optionally taking over a routine run. */
export const pickUp = (
  glob: Glob,
  ctx: Context,
  options: { readonly takeOver: boolean },
): Result<Transition> => {
  const actor = requireActor(ctx);
  if ((actor.role === 'qa' || actor.role === 'po') && glob.type === 'same') {
    return forbidden('QA and PO members cannot pick up sames');
  }

  // Row 8: the current implementer picking up again is a no-op.
  if (
    (glob.status === 'in_progress' || glob.status === 'pr_open') &&
    glob.implementer === actor.email &&
    !hasLiveRun(glob)
  ) {
    return unchanged(glob);
  }

  if (options.takeOver) {
    // Row 10.
    if (!hasLiveRun(glob) || glob.type === 'super') {
      return invalidTransition(glob, actor, 'There is no routine run to take over');
    }
    if (glob.status !== 'implementing' && glob.status !== 'pr_open') {
      return invalidTransition(glob, actor, 'Take over applies to implementing or pr_open globs');
    }
    const b = new Builder(glob, ctx)
      .endRun('superseded')
      .bumpGeneration()
      .set({ implementer: actor.email })
      .event('PickedUp', { takeOver: true });
    if (glob.status === 'implementing') b.status('in_progress');
    return b.done();
  }

  if (hasBusyRun(glob)) {
    return runActive('A routine run is active or watching; take over to supersede it');
  }

  const b = new Builder(glob, ctx);
  switch (glob.status) {
    case 'planning':
    case 'failed':
      // Row 6.
      b.endRun('superseded').set({ implementer: actor.email, failure: null }).status('in_progress');
      break;
    case 'pr_open':
    case 'in_progress':
      // Rows 7 and 9.
      b.endRun('superseded').set({ implementer: actor.email });
      break;
    default:
      return invalidTransition(glob, actor, `A glob in ${glob.status} cannot be picked up`);
  }
  return b.event('PickedUp', { takeOver: false }).done();
};

/** Row 20: re-trigger a failed sub or same on its existing branch. */
export const retrigger = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status !== 'failed' || glob.type === 'super') {
    return invalidTransition(glob, actor, 'Only a failed sub or same can be re-triggered');
  }
  if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
  return new Builder(glob, ctx)
    .bumpGeneration()
    .set({ implementer: null, failure: null })
    .effect({ kind: 'reopen_pr', globId: glob.id, generation: glob.generation + 1 })
    .status('implementing')
    .queueRun(actor.email)
    .done();
};

/** Row 23: return the glob to its starting status with a fresh branch and PR. */
export const startAgain = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status === 'reviewing' || glob.status === 'signed_off') {
    return invalidTransition(glob, actor, 'A merged glob cannot be started again');
  }
  const b = new Builder(glob, ctx).endRun('superseded').bumpGeneration();
  const generation = b.current.generation;
  b.set({
    implementer: glob.type === 'super' ? glob.creator : null,
    failure: null,
    pr: null,
    headChecks: null,
    provisioning: 'none',
  })
    .effect({ kind: 'close_pr', globId: glob.id, generation, prNumber: glob.pr?.number ?? null })
    .effect({ kind: 'delete_branch', globId: glob.id, generation })
    .status(initialStatus(glob.type));
  // A sub or super starts again in Doing with a fresh branch; a same waits for its next start.
  if (listOf(initialStatus(glob.type)) === 'doing') b.ensureProvisioned();
  if (glob.type === 'sub') b.queueRun(actor.email);
  return b.done();
};

/** Row 14: the Merge button on a same or super. */
export const requestMerge = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status !== 'pr_open' || glob.type === 'sub') {
    return invalidTransition(glob, actor, 'Only a same or super with a ready PR can be merged');
  }
  const head = glob.pr?.headSha ?? null;
  if (head === null || glob.headChecks?.sha !== head || glob.headChecks.state !== 'passed') {
    return invalidTransition(glob, actor, 'Required checks have not passed on the current head');
  }
  return new Builder(glob, ctx)
    .status('merging')
    .effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha: head })
    .done();
};

/** Row 24: delete the glob and everything it owns. */
export const remove = (glob: Glob, ctx: Context): Result<Transition> =>
  new Builder(glob, ctx)
    .endRun('superseded')
    .event('GlobDeleted', { status: glob.status })
    .effect({ kind: 'delete_glob_data', globId: glob.id, boardId: glob.boardId, prNumber: glob.pr?.number ?? null })
    .done();

/** Rows 21–22: FR, CR and QA switches. */
export const setLabel = (
  glob: Glob,
  name: LabelName,
  state: LabelState,
  ctx: Context,
): Result<Transition> => {
  const actor = requireActor(ctx);
  const from = glob.labels[name];
  if (from === undefined) {
    return invalidTransition(glob, actor, `${name} is not required on this glob`);
  }
  if (from === state) return unchanged(glob);
  const labels: Labels = { ...glob.labels, [name]: state };
  const b = new Builder(glob, ctx).set({ labels }).event('LabelChanged', { label: name, from, to: state });
  const allAdded = Object.values(labels).every((s) => s === 'added');
  if (glob.status === 'reviewing' && allAdded) {
    b.set({ signedOffAt: ctx.now }).status('signed_off');
  } else if (glob.status === 'signed_off' && !allAdded) {
    b.set({ signedOffAt: null }).status('reviewing');
  }
  return b.done();
};

export interface FieldChanges {
  readonly title?: string;
  readonly summary?: string;
  readonly type?: SlopType;
  readonly category?: Category;
  readonly group?: string | null;
  readonly environment?: string | null;
}

/** Changing fields is not a transition, except same → sub from planning (row 26). */
export const changeFields = (
  glob: Glob,
  changes: FieldChanges,
  board: Board,
  ctx: Context,
): Result<Transition> => {
  const actor = requireActor(ctx);
  const type = changes.type ?? glob.type;
  const category = changes.category ?? glob.category;
  if (!isValidCombination(type, category)) {
    return invalidCombination(`A ${category} cannot be a ${type}`);
  }
  if (changes.title?.trim() === '') return invalidInput('A glob needs a title');
  if (changes.environment !== undefined) {
    const envCheck = checkEnvironment(board, changes.environment);
    if (!envCheck.ok) return envCheck;
  }

  const typeCheck = checkTypeChange(glob, type, actor);
  if (!typeCheck.ok) return typeCheck;

  const patch: { -readonly [K in keyof FieldChanges]: FieldChanges[K] } = {};
  const diff: { [key: string]: JsonValue } = {};
  for (const key of ['title', 'summary', 'type', 'category', 'group', 'environment'] as const) {
    const value = key === 'title' ? changes.title?.trim() : changes[key];
    if (value !== undefined && value !== glob[key]) {
      Object.assign(patch, { [key]: value });
      diff[key] = { from: glob[key], to: value };
    }
  }
  if (Object.keys(diff).length === 0) return unchanged(glob);

  const b = new Builder(glob, ctx).set(patch).event('FieldsChanged', diff);
  if (('type' in diff || 'environment' in diff) && glob.pr !== null) {
    b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  }
  if (glob.type === 'same' && type === 'sub') {
    b.status('implementing').queueRun(actor.email);
  }
  return b.done();
};

const checkTypeChange = (glob: Glob, to: SlopType, actor: Actor): Result<null> => {
  const from = glob.type;
  if (from === to) return ok(null);
  if (from === 'sub' && to === 'same') {
    if (glob.status === 'merging' || glob.status === 'reviewing' || glob.status === 'signed_off') {
      return invalidTransition(glob, actor, 'A sub can only become a same before it merges');
    }
    return ok(null);
  }
  if ((from === 'same' && to === 'super') || (from === 'super' && to === 'same')) {
    if ((glob.status !== 'in_progress' && glob.status !== 'pr_open') || hasLiveRun(glob)) {
      return invalidTransition(
        glob,
        actor,
        'Sames and supers can only be swapped while a human is implementing and no run is live',
      );
    }
    if (to === 'super' && (actor.role === 'qa' || actor.role === 'po')) {
      return forbidden('QA and PO members cannot create supers');
    }
    return ok(null);
  }
  if (from === 'same' && to === 'sub') {
    if (glob.status !== 'planning') {
      return invalidTransition(glob, actor, 'A same can only become a sub while in planning');
    }
    return ok(null);
  }
  return invalidTransition(glob, actor, `A ${from} cannot become a ${to}`);
};

// ---------------------------------------------------------------------------
// Events from integrations and routines

/** Draft PRs are recorded without changing status. */
export const prOpened = (glob: Glob, pr: { number: number; headSha: string | null }, ctx: Context) =>
  new Builder(glob, ctx)
    .set({ pr: { number: pr.number, state: 'draft', headSha: pr.headSha }, provisioning: 'ok' })
    .event('PROpened', { number: pr.number })
    .done();

/** Provisioning finished: the branch exists, and the draft PR if the repo integration opened one. */
export const provisioned = (
  glob: Glob,
  result: { branch: string; pr: { number: number; headSha: string | null } | null },
  ctx: Context,
): Result<Transition> => {
  const b = new Builder(glob, ctx)
    .set({ provisioning: 'ok' })
    .event('BranchCreated', { ok: true, branch: result.branch });
  if (result.pr !== null) {
    b.set({ pr: { number: result.pr.number, state: 'draft', headSha: result.pr.headSha } }).event('PROpened', {
      number: result.pr.number,
    });
  }
  return b.done();
};

export const provisioningFailed =(glob: Glob, reason: string, ctx: Context) =>
  new Builder(glob, ctx).set({ provisioning: 'failed' }).event('BranchCreated', { ok: false, reason }).done();

/** A push to the glob branch: records the new head; results for older commits stop counting. */
export const commitPushed = (
  glob: Glob,
  push: { sha: string; runId: string | null },
  ctx: Context,
): Result<Transition> => {
  const b = new Builder(glob, ctx);
  if (glob.pr !== null) b.set({ pr: { ...glob.pr, headSha: push.sha } });
  const run = currentRun(glob);
  const superseded = push.runId !== null && (run === null || run.id !== push.runId || run.state === 'ended');
  if (!superseded && run !== null && run.state !== 'ended' && push.runId === run.id) {
    b.updateRun({ lastProgressAt: ctx.now, state: run.state === 'queued' ? 'active' : run.state });
  }
  if (glob.status === 'pr_open' || glob.status === 'merging') {
    b.set({ headChecks: null }).effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
  }
  return b.event('CommitPushed', { sha: push.sha, runId: push.runId, fromSupersededRun: superseded }).done();
};

/** The routine was fired: records its cloud session (if the fire response returned one). */
export const runFired = (
  glob: Glob,
  fired: { runId: string; sessionId: string | null; sessionUrl: string | null },
  ctx: Context,
): Result<Transition> => {
  const run = currentRun(glob);
  if (run === null || run.id !== fired.runId || run.state === 'ended') return unchanged(glob);
  return new Builder(glob, ctx)
    .updateRun({ sessionId: fired.sessionId ?? run.sessionId, sessionUrl: fired.sessionUrl ?? run.sessionUrl })
    .event('RunTriggered', { runId: run.id, fired: true, sessionUrl: fired.sessionUrl })
    .done();
};

/**
 * Run failure detection: a run with no progress (no slop call or push) for too long, or that
 * has not marked its PR ready in time, is failed like a `report_failure` (rows 17 and 25).
 */
export const runTimeoutReason = (glob: Glob, board: Pick<Board, 'runNoProgressHours' | 'runReadyHours'>, now: string): string | null => {
  const run = currentRun(glob);
  if (run === null || run.state === 'ended' || run.state === 'queued') return null;
  const hours = (from: string | null) => (from === null ? 0 : (Date.parse(now) - Date.parse(from)) / 3_600_000);
  const lastProgress = run.lastProgressAt ?? run.startedAt ?? run.queuedAt;
  if (hours(lastProgress) >= board.runNoProgressHours) {
    return `No progress for ${String(board.runNoProgressHours)} hours`;
  }
  if (run.state === 'active' && hours(run.startedAt ?? run.queuedAt) >= board.runReadyHours) {
    return `PR not marked ready within ${String(board.runReadyHours)} hours`;
  }
  return null;
};

/** A routine's slop call: marks the run active and records progress. Superseded runs are ignored. */
export const runProgress = (glob: Glob, runId: string, ctx: Context): Result<Transition> => {
  const run = currentRun(glob);
  if (run === null || run.id !== runId || run.state === 'ended') return unchanged(glob);
  return new Builder(glob, ctx)
    .updateRun({
      state: run.state === 'queued' ? 'active' : run.state,
      startedAt: run.startedAt ?? ctx.now,
      lastProgressAt: ctx.now,
    })
    .done();
};

/** Row 11: the glob's draft PR was marked ready for review. */
export const prReadyForReview = (
  glob: Glob,
  pr: { number: number; headSha: string },
  ctx: Context,
): Result<Transition> => {
  if (glob.status !== 'implementing' && glob.status !== 'in_progress') {
    return invalidTransition(glob, null, `PR ready ignored: glob is ${glob.status}`);
  }
  const b = new Builder(glob, ctx)
    .set({ pr: { number: pr.number, state: 'ready', headSha: pr.headSha } })
    .event('PRReadyForReview', { number: pr.number, sha: pr.headSha });
  const run = currentRun(glob);
  if (run !== null && (run.state === 'active' || run.state === 'queued')) {
    b.updateRun({ state: 'watching', lastProgressAt: ctx.now, startedAt: run.startedAt ?? ctx.now });
  }
  return b
    .status('pr_open')
    .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation })
    .done();
};

/** A check suite or run changed on the glob's branch: re-read the head's merge state. */
export const checksChanged = (glob: Glob, ctx: Context): Result<Transition> => {
  if (glob.pr === null || (glob.status !== 'pr_open' && glob.status !== 'merging')) return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation })
    .done();
};

/** Required checks finished on a commit; only the PR's current head counts. */
export const checksCompleted = (
  glob: Glob,
  checks: { sha: string; passed: boolean },
  ctx: Context,
): Result<Transition> => {
  if (glob.pr?.headSha !== checks.sha) return unchanged(glob);
  const b = new Builder(glob, ctx)
    .set({ headChecks: { sha: checks.sha, state: checks.passed ? 'passed' : 'failed' } })
    .event('BuildCompleted', { sha: checks.sha, passed: checks.passed });
  // Slop updated the branch while merging: the checks on the new head decide (rows 12, 14, 16).
  if (glob.status === 'merging') {
    if (!checks.passed) {
      return b
        .set({ failure: { reason: 'Checks failed after updating the branch', at: ctx.now } })
        .event('MergeFailed', { reason: 'checks failed after update' })
        .status('failed')
        .done();
    }
    b.effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha: checks.sha });
  }
  return b.done();
};

/**
 * `mark_ready`: the implementer is done and asks slop to mark the draft PR ready. The status
 * changes when GitHub confirms (row 11); a routine passes its run ID, which must be current.
 */
export const readyRequested = (glob: Glob, runId: string | null, ctx: Context): Result<Transition> => {
  if (glob.status !== 'implementing' && glob.status !== 'in_progress') {
    return invalidTransition(glob, ctx.actor, `A glob in ${glob.status} has no draft PR to mark ready`);
  }
  if (glob.pr === null) return invalidTransition(glob, ctx.actor, 'The glob has no PR yet');
  const run = currentRun(glob);
  if (runId !== null && (run === null || run.id !== runId || run.state === 'ended')) {
    return invalidTransition(glob, ctx.actor, `Run ${runId} is not the glob's current run`);
  }
  return new Builder(glob, ctx)
    .effect({ kind: 'mark_pr_ready', globId: glob.id, generation: glob.generation })
    .done();
};

/** The `sub-gate` check finished: on success, slop applies the board's policy before merging. */
export const subGateCheckCompleted = (
  glob: Glob,
  check: { sha: string; passed: boolean },
  ctx: Context,
): Result<Transition> => {
  if (glob.status !== 'pr_open' || glob.type !== 'sub' || glob.pr?.headSha !== check.sha) return unchanged(glob);
  // Failing checks are left to the routine's auto-fix; only policy flags convert a sub.
  if (!check.passed) return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({ kind: 'evaluate_sub_gate', globId: glob.id, generation: glob.generation, sha: check.sha })
    .done();
};

/** Rows 12–13: the sub gate's verdict on a commit. */
export const subGateCompleted = (
  glob: Glob,
  gate: { sha: string; passed: boolean; reason: string | null },
  ctx: Context,
): Result<Transition> => {
  if (glob.status !== 'pr_open' || glob.type !== 'sub' || glob.pr?.headSha !== gate.sha) {
    return unchanged(glob);
  }
  const b = new Builder(glob, ctx).event('SubReviewCompleted', {
    sha: gate.sha,
    passed: gate.passed,
    reason: gate.reason,
  });
  if (gate.passed) {
    return b
      .status('merging')
      .effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha: gate.sha })
      .done();
  }
  return b
    .set({ type: 'same' })
    .event('FieldsChanged', { type: { from: 'sub', to: 'same' } })
    .effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation })
    .done();
};

/** Row 15: the merge was observed (slop's own merge response or the merged event). */
export const merged = (glob: Glob, merge: { sha: string }, ctx: Context): Result<Transition> => {
  // GitHub is the source of truth for merges, so any status before merging moves to reviewing.
  if (glob.status === 'reviewing' || glob.status === 'signed_off') return unchanged(glob);
  return new Builder(glob, ctx)
    .endRun('completed')
    .set({
      labels: requiredLabels(glob.type),
      failure: null,
      pr: glob.pr === null ? null : { ...glob.pr, state: 'merged' },
    })
    .event('Merged', { sha: merge.sha })
    .status('reviewing')
    .done();
};

/** Row 16: slop's own merge failed (conflict, or checks failed after updating the branch). */
export const mergeFailed = (glob: Glob, reason: string, ctx: Context): Result<Transition> => {
  if (glob.status !== 'merging') return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ failure: { reason, at: ctx.now } })
    .event('MergeFailed', { reason })
    .status('failed')
    .done();
};

/** Rows 17, 18 and 25: `report_failure`, or a run timeout (always with its run ID). */
export const reportFailure = (
  glob: Glob,
  report: { reason: string; runId: string | null },
  ctx: Context,
): Result<Transition> => {
  if (report.runId === null) {
    // Row 18: an interactive session gave up.
    if (glob.status !== 'in_progress') {
      return invalidTransition(glob, ctx.actor, 'Only a glob in progress can be failed without a run');
    }
    return new Builder(glob, ctx)
      .set({ failure: { reason: report.reason, at: ctx.now } })
      .status('failed')
      .done();
  }

  const run = currentRun(glob);
  if (run === null || run.id !== report.runId || run.state === 'ended') {
    // Results from superseded runs are recorded but ignored.
    return new Builder(glob, ctx)
      .event('RunFailed', { runId: report.runId, reason: report.reason, ignored: true })
      .done();
  }
  if (glob.status === 'implementing') {
    // Row 17.
    return new Builder(glob, ctx)
      .endRun('failed', report.reason)
      .set({ failure: { reason: report.reason, at: ctx.now } })
      .status('failed')
      .done();
  }
  if (glob.status === 'pr_open' && run.state === 'watching') {
    // Row 25: auto-fix ended; the glob stays in pr_open and shows the failure.
    return new Builder(glob, ctx)
      .endRun('failed', report.reason)
      .set({ failure: { reason: report.reason, at: ctx.now } })
      .done();
  }
  return invalidTransition(glob, ctx.actor, `Run failure ignored: glob is ${glob.status}`);
};

/** Row 19: the PR was closed without merging. */
export const prClosed = (glob: Glob, ctx: Context): Result<Transition> => {
  const b = new Builder(glob, ctx);
  if (glob.pr !== null) b.set({ pr: { ...glob.pr, state: 'closed' } });
  b.event('PRClosed', {});
  if (glob.status !== 'pr_open') return b.done();
  return b
    .endRun('superseded')
    .set({ failure: { reason: 'PR closed without merging', at: ctx.now } })
    .status('failed')
    .done();
};

// ---------------------------------------------------------------------------
// What a person can do next (drives the glob view's buttons and error messages)

export const allowedActions = (glob: Glob, actor: Actor): Action[] => {
  const actions: Action[] = [];
  const restricted = actor.role === 'qa' || actor.role === 'po';
  if (glob.status === 'planning' && glob.type === 'same') actions.push('start');
  const canPickUp =
    !(restricted && glob.type === 'same') &&
    !hasBusyRun(glob) &&
    (glob.status === 'planning' ||
      glob.status === 'failed' ||
      ((glob.status === 'in_progress' || glob.status === 'pr_open') &&
        glob.implementer !== actor.email));
  if (canPickUp) actions.push('pick_up');
  if (
    !(restricted && glob.type === 'same') &&
    glob.type !== 'super' &&
    hasLiveRun(glob) &&
    (glob.status === 'implementing' || glob.status === 'pr_open')
  ) {
    actions.push('take_over');
  }
  if (glob.status === 'failed' && glob.type !== 'super' && !hasLiveRun(glob)) actions.push('retrigger');
  if (glob.status !== 'reviewing' && glob.status !== 'signed_off') actions.push('start_again');
  if (
    glob.status === 'pr_open' &&
    glob.type !== 'sub' &&
    glob.pr?.headSha != null &&
    glob.headChecks?.sha === glob.pr.headSha &&
    glob.headChecks.state === 'passed'
  ) {
    actions.push('merge');
  }
  actions.push('delete');
  return actions;
};
