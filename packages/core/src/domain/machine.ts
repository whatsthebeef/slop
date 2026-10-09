/**
 * The glob state machine. Every function is pure: it takes the glob's current state and
 * returns the next state plus the domain events to log and the effects to queue, or a
 * domain error. The numbered rows refer to the transition table in the spec.
 */
import { err, forbidden, invalidCombination, invalidInput, ok, runActive } from './errors.js';
import type { Result } from './errors.js';
import type { DomainEvent, DomainEventType, Effect, JsonValue } from './events.js';
import type { ArtifactSummary } from './knowledge.js';
import type { SubGateCause } from './sub-limit.js';
import { failureSummary, inheritedFailure } from './checks.js';
import { isValidCombination, listOf } from './matrix.js';
import { SLOP_TYPES } from './types.js';
import { mergeImplied } from './exclusive-paths.js';
import { dependencyIds, refusalText, waitingFor, waitSummary } from './waiting.js';
import type { DependencyState } from './waiting.js';
import type {
  Actor,
  Board,
  Category,
  BaseChecks,
  BehindBase,
  CheckFailure,
  ChecklistItem,
  Glob,
  HeadChecks,
  ImpliedAfter,
  LabelName,
  LabelState,
  Labels,
  MergeConflict,
  OpenConflict,
  Role,
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
  /** A glob held for another glob to merge starts now, before it has. */
  | 'start_anyway'
  | 'pick_up'
  | 'take_over'
  | 'retrigger'
  /** A PR whose auto-fix ended without fixing it: a new routine run on the same branch, keeping the PR. */
  | 'retry_autofix'
  /** A merge conflict with no human implementer: ask the Claude GitHub App, in a PR comment, to resolve it on the same branch. */
  | 'resolve_conflict'
  | 'start_again'
  | 'merge'
  /** Supers: squash-merge what's done and keep going on the same glob and branch. */
  | 'merge_continue'
  /** Supers, from the board: ask slop to mark the draft PR ready (as the `mark_ready` tool does). */
  | 'mark_ready'
  | 'delete';

/**
 * What the actions depend on beyond the glob itself: read from its artifacts, which live outside
 * the glob document.
 */
export interface ActionFacts {
  /** The commit SHA of the glob's latest postplan, or null without one (or without a SHA). */
  readonly postplanSha?: string | null;
  /** The state of every glob this one waits for (a missing entry reads as deleted); absent when not loaded. */
  readonly dependencies?: ReadonlyMap<string, DependencyState>;
}

const NO_DEPENDENCIES: ReadonlyMap<string, DependencyState> = new Map();

/** The latest postplan's commit SHA among a glob's artifact summaries. */
export const postplanShaOf = (artifacts: readonly Pick<ArtifactSummary, 'kind' | 'label' | 'commitSha'>[]): string | null =>
  artifacts.find((a) => a.kind === 'postplan' && a.label === '')?.commitSha ?? null;

/** Short SHAs are at least this long (git's default abbreviation). */
const MIN_SHA_LENGTH = 7;

/** Whether two SHAs name the same commit: equal, or one a prefix of the other (a short SHA). */
export const sameCommit = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (a == null || b == null) return false;
  const [x, y] = [a.trim().toLowerCase(), b.trim().toLowerCase()];
  if (Math.min(x.length, y.length) < MIN_SHA_LENGTH) return false;
  return x.startsWith(y) || y.startsWith(x);
};

/** A super's latest postplan was written at its PR's current head. */
export const postplanAtHead = (glob: Glob, facts: ActionFacts): boolean =>
  glob.type === 'super' && sameCommit(facts.postplanSha, glob.pr?.headSha);

export const POSTPLAN_NOT_AT_HEAD = 'Update the postplan at the head first (/finalise)';

/**
 * The squash commit's title: `<id>: <title>`. A piece landed with Merge and continue says which
 * part it is, so the base branch doesn't read as if the whole super had landed.
 */
export const squashTitle = (glob: Glob): string =>
  glob.mergeMode === 'continue'
    ? `${glob.id}: ${glob.title} (part ${glob.prs.length + 1})`
    : `${glob.id}: ${glob.title}`;

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

  /** `detail` adds to the StatusChanged event (e.g. a failure report's reason and agent-set version). */
  status(to: Status, detail: { readonly [key: string]: JsonValue } = {}): this {
    const from = this.glob.status;
    if (from === to) return this;
    const entersDoing = listOf(from) !== 'doing' && listOf(to) === 'doing';
    const leavesDoing = listOf(to) !== 'doing';
    this.set({
      status: to,
      doingSince: entersDoing ? this.ctx.now : leavesDoing ? null : this.glob.doingSince,
    });
    this.event('StatusChanged', { ...detail, from, to });
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

  /**
   * Ends the current run if it has not ended. `detail` adds to its RunFailed event (e.g. the agent-set version) or
   * RunEnded event (a superseded run's `cause`, which mined signals count).
   */
  endRun(outcome: RunOutcome, failureReason: string | null = null, detail: { readonly [key: string]: JsonValue } = {}): this {
    const run = currentRun(this.glob);
    if (run === null || run.state === 'ended') return this;
    const ended: Run = { ...run, state: 'ended', outcome, endedAt: this.ctx.now, failureReason };
    this.set({ runs: [...this.glob.runs.slice(0, -1), ended] });
    return outcome === 'failed'
      ? this.event('RunFailed', { ...detail, runId: run.id, reason: failureReason })
      : this.event('RunEnded', { ...detail, runId: run.id, outcome });
  }

  updateRun(patch: Partial<Run>): this {
    const run = currentRun(this.glob);
    if (run === null) return this;
    return this.set({ runs: [...this.glob.runs.slice(0, -1), { ...run, ...patch }] });
  }

  /** Queues a new routine run for whoever triggered it. */
  queueRun(triggeredBy: string, retry?: { readonly failureSummary: string | null }): this {
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
      ...(retry === undefined ? {} : { autoRetry: true as const }),
    };
    this.set({ runs: [...this.glob.runs, run] });
    this.event('RunTriggered', {
      runId: run.id,
      triggeredBy,
      routineOwner: run.routineOwner,
      ...(retry === undefined ? {} : { automatic: true }),
    });
    return this.effect({
      kind: 'fire_routine',
      globId: this.glob.id,
      generation: this.glob.generation,
      runId: run.id,
      routineOwner: run.routineOwner,
      ...(retry?.failureSummary == null ? {} : { failureSummary: retry.failureSummary }),
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
  /** Same only: start a routine run immediately (explicit instruction or `autoTrigger`). */
  readonly autoTrigger: boolean;
  /** Globs to start after, already checked and without merged ones (see `checkAfter`). */
  readonly after?: readonly string[];
  /** Merge-policy holds found for this glob before it was created. */
  readonly impliedAfter?: readonly ImpliedAfter[];
}

export const create = (
  input: CreateInput,
  board: Board,
  ctx: Context,
  dependencies: ReadonlyMap<string, DependencyState> = NO_DEPENDENCIES,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (!isValidCombination(input.type, input.category)) {
    return invalidCombination(`A ${input.category} cannot be a ${input.type}`);
  }
  if ((actor.role === 'qa' || actor.role === 'po') && input.type === 'super') {
    return forbidden('QA and PO members cannot create supers');
  }
  if (input.title.trim() === '') return invalidInput('A glob needs a title');
  // A sub created without an environment gets the board's default for subs, if it has one.
  const environment =
    input.environment ?? (input.type === 'sub' ? (board.environments.find((e) => e.subDefault === true)?.name ?? null) : null);
  const envCheck = checkEnvironment(board, environment);
  if (!envCheck.ok) return envCheck;

  const after = input.after ?? [];
  const impliedAfter = input.impliedAfter ?? [];
  const awaited = waitingFor({ after, impliedAfter }, dependencies);
  const wantsStart = input.type === 'sub' || (input.type === 'same' && input.autoTrigger);
  // A sub (or auto-started same) with something unmerged to wait for sits in Planning, with no branch, until released.
  const held = wantsStart && awaited.length > 0;
  const autoStart = input.type === 'same' && input.autoTrigger && !held;
  const status: Status = held ? 'planning' : autoStart ? 'implementing' : initialStatus(input.type);
  const glob: Glob = {
    id: input.id,
    boardId: input.boardId,
    title: input.title.trim(),
    summary: input.summary,
    type: input.type,
    category: input.category,
    group: input.group,
    environment,
    status,
    version: 0,
    generation: 1,
    creator: actor.email,
    planner: actor.email,
    implementer: input.type === 'super' ? actor.email : null,
    labels: {},
    checklists: {},
    pr: null,
    prs: [],
    mergeMode: null,
    headChecks: null,
    runs: [],
    failure: null,
    provisioning: 'none',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    signedOffAt: null,
    doingSince: listOf(status) === 'doing' ? ctx.now : null,
    ...(after.length > 0 && { after }),
    ...(impliedAfter.length > 0 && { impliedAfter }),
    ...(held && { waiting: { since: ctx.now } }),
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
  if (held) b.event('Waiting', { for: awaited.map((a) => a.id), note: waitSummary(awaited) });
  else if (input.type === 'sub' || autoStart) b.queueRun(actor.email);
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

/**
 * Row 5: start a same's routine run from planning. Refused while it waits for another glob to merge (row 33a): Start
 * anyway is the person's override.
 */
export const start = (
  glob: Glob,
  ctx: Context,
  dependencies: ReadonlyMap<string, DependencyState> = NO_DEPENDENCIES,
  /** Holds the board's merge policy found for this start (another open glob may change the same exclusive paths). */
  newHolds: readonly ImpliedAfter[] = [],
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status !== 'planning' || glob.type !== 'same') {
    return invalidTransition(glob, actor, 'Only a same in planning can be started');
  }
  const awaited = waitingFor(glob, dependencies);
  if (awaited.length > 0) return invalidTransition(glob, actor, refusalText(awaited));
  // A merge-policy hold keeps the request: the same waits in Planning and starts when the other glob merges.
  const holding = waitingFor({ impliedAfter: newHolds }, dependencies);
  if (holding.length > 0) {
    return new Builder(glob, ctx)
      .set({ impliedAfter: mergeImplied(glob.impliedAfter, newHolds), waiting: { since: ctx.now } })
      .event('Waiting', { for: holding.map((a) => a.id), note: waitSummary(holding) })
      .done();
  }
  return new Builder(glob, ctx).set({ waiting: null }).status('implementing').queueRun(actor.email).done();
};

/** Row 34: Start anyway. A sub or same in planning that waits for unmerged globs starts now; the hold is recorded as overridden. */
export const startAnyway = (
  glob: Glob,
  ctx: Context,
  dependencies: ReadonlyMap<string, DependencyState> = NO_DEPENDENCIES,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status !== 'planning' || glob.type === 'super') {
    return invalidTransition(glob, actor, 'Only a sub or same in planning can be started anyway');
  }
  const awaited = waitingFor(glob, dependencies);
  if (awaited.length === 0 && glob.waiting == null) {
    return invalidTransition(glob, actor, 'Nothing holds this glob; use Start');
  }
  return new Builder(glob, ctx)
    .set({
      waiting: null,
      ...(glob.impliedAfter === undefined ? {} : { impliedAfter: glob.impliedAfter.map((i) => ({ ...i, overridden: true as const })) }),
    })
    .event('HoldOverridden', { for: awaited.map((a) => a.id) })
    .status('implementing')
    .queueRun(actor.email)
    .done();
};

/**
 * Row 33: a glob this one waited for merged. When everything it waits for has merged, it starts as a fresh sub (or
 * auto-started same) would: branch cut from the current base, run queued for whoever created it. Anything else, or a
 * second call, changes nothing, so the outbox can deliver it any number of times.
 */
export const released = (
  glob: Glob,
  ctx: Context,
  dependencies: ReadonlyMap<string, DependencyState> = NO_DEPENDENCIES,
  /** Holds found when checking again just before starting: another glob may have taken the exclusive paths meanwhile. */
  newHolds: readonly ImpliedAfter[] = [],
): Result<Transition> => {
  if (glob.waiting == null || glob.status !== 'planning' || glob.type === 'super') return unchanged(glob);
  if (waitingFor(glob, dependencies).length > 0) return unchanged(glob);
  const holding = waitingFor({ impliedAfter: newHolds }, dependencies);
  if (holding.length > 0) {
    return new Builder(glob, ctx)
      .set({ impliedAfter: mergeImplied(glob.impliedAfter, newHolds) })
      .event('Waiting', { for: holding.map((a) => a.id), note: waitSummary(holding) })
      .done();
  }
  return new Builder(glob, ctx)
    .set({ waiting: null })
    .event('Released', { after: dependencyIds(glob) })
    .status('implementing')
    .queueRun(glob.creator)
    .done();
};

/** Supers and sames are picked up by developers; QA and PO members only pick up subs. */
const restrictedFrom = (actor: Actor, glob: Glob): boolean =>
  (actor.role === 'qa' || actor.role === 'po') && glob.type !== 'sub';

export interface PickUpOptions {
  readonly takeOver: boolean;
  /** Chosen at pick-up: must exist on the board and allow branch deploys. */
  readonly environment?: string | null;
  /** The state of the globs the glob waits for: picking up a held glob works, and notes what hadn't merged. */
  readonly dependencies?: ReadonlyMap<string, DependencyState>;
}

/** Rows 6–10: pick up, optionally taking over a routine run, optionally choosing the environment. */
export const pickUp = (glob: Glob, ctx: Context, board: Board, options: PickUpOptions): Result<Transition> => {
  const actor = requireActor(ctx);
  if (restrictedFrom(actor, glob)) {
    return forbidden(`QA and PO members cannot pick up ${glob.type}s`);
  }
  const environment = options.environment;
  if (environment !== undefined) {
    const envCheck = checkEnvironment(board, environment);
    if (!envCheck.ok) return envCheck;
  }
  const environmentChanged = environment !== undefined && environment !== glob.environment;

  // Row 8: the current implementer picking up again is a no-op, unless it changes the environment.
  if (
    (glob.status === 'in_progress' || glob.status === 'pr_open') &&
    glob.implementer === actor.email &&
    !hasLiveRun(glob)
  ) {
    if (!environmentChanged) return unchanged(glob);
    return setEnvironment(new Builder(glob, ctx), environment).done();
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
      .endRun('superseded', null, { cause: 'take_over' })
      .bumpGeneration()
      .set({ implementer: actor.email })
      .event('PickedUp', { takeOver: true });
    if (glob.status === 'implementing') b.status('in_progress');
    if (environmentChanged) setEnvironment(b, environment);
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
      b.endRun('superseded', null, { cause: 'pick_up' })
        .set({ implementer: actor.email, failure: null, ...(glob.waiting == null ? {} : { waiting: null }) })
        .status('in_progress');
      break;
    case 'pr_open':
    case 'in_progress':
      // Rows 7 and 9.
      b.endRun('superseded', null, { cause: 'pick_up' }).set({ implementer: actor.email });
      break;
    default:
      return invalidTransition(glob, actor, `A glob in ${glob.status} cannot be picked up`);
  }
  // A person may go ahead on a glob that still waits; the event records what hadn't merged.
  const unmerged = glob.status === 'planning' ? waitingFor(glob, options.dependencies ?? NO_DEPENDENCIES) : [];
  b.event('PickedUp', { takeOver: false, ...(unmerged.length > 0 && { waitingFor: unmerged.map((a) => a.id) }) });
  if (environmentChanged) setEnvironment(b, environment);
  return b.done();
};

/** Records an environment chosen at pick-up as a field change, and relabels the PR (`env:<name>`). */
const setEnvironment = (b: Builder, environment: string | null): Builder => {
  const glob = b.current;
  b.set({ environment }).event('FieldsChanged', { environment: { from: glob.environment, to: environment } });
  if (glob.pr !== null) b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  return b;
};

/** Whether the glob's PR was left by an ended auto-fix run: ready for review, a failure on the card, nobody working on it. */
const canRetryAutofix = (glob: Glob): boolean => {
  const run = currentRun(glob);
  return (
    glob.status === 'pr_open' &&
    glob.type !== 'super' &&
    glob.implementer === null &&
    glob.pr !== null &&
    glob.failure !== null &&
    glob.failure.kind === undefined &&
    run?.state === 'ended' &&
    run.outcome === 'failed'
  );
};

/** Row 25a: Retry auto-fix. A new routine run watches the same PR on the same branch; the failure clears. */
export const retryAutofix = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
  if (!canRetryAutofix(glob)) return invalidTransition(glob, actor, 'Only a ready PR whose auto-fix ended can retry it');
  return new Builder(glob, ctx).set({ failure: null }).queueRun(actor.email).done();
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

/** The failure reason for a merge conflict, naming the files when known. */
export const conflictReason = (conflict: MergeConflict): string => {
  const shown = conflict.files.slice(0, 5).join(', ');
  const more = conflict.files.length > 5 ? ` and ${String(conflict.files.length - 5)} more` : '';
  return `Merge conflict with ${conflict.base}${conflict.files.length === 0 ? '' : ` in ${shown}${more}`}`;
};

/** Whether the glob has an open PR that a base-branch conflict is worth flagging on. */
const hasOpenPr = (glob: Glob): boolean =>
  glob.pr !== null &&
  (glob.pr.state === 'draft' || glob.pr.state === 'ready') &&
  (glob.status === 'pr_open' || glob.status === 'in_progress');

/** A conflict slop could ask the Claude GitHub App to fix: nobody implements the glob, no routine run is live, and it hasn't asked yet. */
const canRequestConflictFix = (glob: Glob): boolean =>
  glob.type !== 'super' &&
  glob.implementer === null &&
  !hasLiveRun(glob) &&
  ((hasOpenPr(glob) && glob.conflict != null && glob.conflict.requestedAt === undefined) ||
    (glob.status === 'failed' && glob.failure?.conflict !== undefined && glob.pr?.state === 'ready'));

/**
 * A base-branch merge happened: recheck this glob's open PR for a conflict with it. The recheck runs through the
 * outbox because GitHub computes mergeability in the background.
 */
export const baseMerged = (glob: Glob, merge: { since: string }, ctx: Context): Result<Transition> => {
  if (glob.id === merge.since || !hasOpenPr(glob)) return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({ kind: 'check_conflict', globId: glob.id, generation: glob.generation, since: merge.since })
    .done();
};

/** The open PR conflicts with the base branch: flag it on the card. The first conflict found is kept. */
export const conflictFound = (
  glob: Glob,
  found: { base: string; files: readonly string[]; since: string | null },
  ctx: Context,
): Result<Transition> => {
  if (!hasOpenPr(glob) || glob.conflict?.base === found.base) return unchanged(glob);
  const conflict: OpenConflict = { ...found, at: ctx.now };
  return new Builder(glob, ctx)
    .set({ conflict })
    .event('ConflictFlagged', { base: found.base, files: [...found.files], since: found.since })
    .done();
};

/** Whether the glob is in Doing with an open PR: the globs whose distance from the base branch is worth showing. */
const isDoingWithPr = (glob: Glob): boolean => glob.status === 'in_progress' && hasOpenPr(glob);

/** The base branch or the glob's branch received a push: read again how far the branch is behind the base. */
export const behindCheckRequested = (glob: Glob, ctx: Context): Result<Transition> => {
  if (!isDoingWithPr(glob)) return unchanged(glob);
  return new Builder(glob, ctx).effect({ kind: 'check_behind', globId: glob.id, generation: glob.generation }).done();
};

/** What the code host says about how far the branch is behind the base: recorded when it changed, cleared when up to date. */
export const behindChecked = (
  glob: Glob,
  found: { base: string; behindBy: number; files: readonly string[] },
  ctx: Context,
): Result<Transition> => {
  if (!hasOpenPr(glob)) return unchanged(glob);
  const before = glob.behind ?? null;
  if (found.behindBy <= 0) {
    if (before === null) return unchanged(glob);
    return new Builder(glob, ctx).set({ behind: null }).event('BehindChanged', { base: found.base, behindBy: 0 }).done();
  }
  if (before?.base === found.base && before.behindBy === found.behindBy && before.files.join('\n') === found.files.join('\n')) {
    return unchanged(glob);
  }
  const behind: BehindBase = { base: found.base, behindBy: found.behindBy, files: [...found.files], at: ctx.now };
  return new Builder(glob, ctx)
    .set({ behind })
    .event('BehindChanged', { base: found.base, behindBy: found.behindBy, files: [...found.files] })
    .done();
};

/** The open PR no longer conflicts with the base branch. */
export const conflictCleared = (glob: Glob, ctx: Context): Result<Transition> => {
  if (glob.conflict == null) return unchanged(glob);
  return new Builder(glob, ctx).set({ conflict: null }).event('ConflictCleared', { base: glob.conflict.base }).done();
};

/**
 * Resolve conflict (rows 16 and 20a): a conflicting PR nobody is implementing gets one PR comment asking the Claude
 * GitHub App to merge the base branch in and push; no routine run starts. A glob failed by a merge conflict goes back
 * to review with the conflict flagged. A human implementer resolves locally (`sstor --glob <id> --resolve`).
 */
export const resolveConflict = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.implementer !== null) {
    return invalidTransition(glob, actor, 'A glob with a human implementer resolves its conflict locally');
  }
  if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
  if (glob.conflict?.requestedAt !== undefined) return unchanged(glob);
  if (!canRequestConflictFix(glob)) {
    return invalidTransition(glob, actor, 'Only a glob whose PR conflicts with the base branch can resolve it');
  }
  const request = { kind: 'request_conflict_fix', globId: glob.id, generation: glob.generation } as const;
  const b = new Builder(glob, ctx);
  const failed = glob.status === 'failed' ? glob.failure?.conflict : undefined;
  if (failed !== undefined) {
    // The failed merge left a ready PR: return it to review while the conflict is fixed.
    b.set({ failure: null, headChecks: null, conflict: { ...failed, since: null, at: ctx.now, requestedAt: ctx.now } })
      .status('pr_open')
      .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
  } else if (glob.conflict != null) {
    b.set({ conflict: { ...glob.conflict, requestedAt: ctx.now } });
  }
  return b.event('ConflictFixRequested', { base: (failed ?? glob.conflict)?.base ?? null }).effect(request).done();
};

/** Row 23: return the glob to its starting status with a fresh branch and PR. */
export const startAgain = (
  glob: Glob,
  ctx: Context,
  dependencies: ReadonlyMap<string, DependencyState> = NO_DEPENDENCIES,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status === 'reviewing' || glob.status === 'signed_off') {
    return invalidTransition(glob, actor, 'A merged glob cannot be started again');
  }
  const b = new Builder(glob, ctx).endRun('superseded', null, { cause: 'start_again' }).bumpGeneration();
  const generation = b.current.generation;
  b.set({
    implementer: glob.type === 'super' ? glob.creator : null,
    failure: null,
    pr: null,
    mergeMode: null,
    headChecks: null,
    provisioning: 'none',
    ...(glob.waiting == null ? {} : { waiting: null }),
  })
    .effect({ kind: 'close_pr', globId: glob.id, generation, prNumber: glob.pr?.number ?? null })
    .effect({ kind: 'delete_branch', globId: glob.id, generation });
  // A sub that waits for an unmerged glob goes back to Planning, held, instead of starting again.
  const awaited = glob.type === 'sub' ? waitingFor(glob, dependencies) : [];
  if (awaited.length > 0) {
    b.set({ waiting: { since: ctx.now } }).status('planning').event('Waiting', { for: awaited.map((a) => a.id), note: waitSummary(awaited) });
    return b.done();
  }
  b.status(initialStatus(glob.type));
  // A sub or super starts again in Doing with a fresh branch; a same waits for its next start.
  if (listOf(initialStatus(glob.type)) === 'doing') b.ensureProvisioned();
  if (glob.type === 'sub') b.queueRun(actor.email);
  return b.done();
};

export interface MergeOptions {
  /** Row 31: Merge and continue (supers): the glob returns to in_progress once merged. */
  readonly continue: boolean;
  readonly facts?: ActionFacts;
}

/** Rows 14 and 31: the Merge (or Merge and continue) button on a same or super. */
export const requestMerge = (
  glob: Glob,
  ctx: Context,
  options: MergeOptions = { continue: false },
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status !== 'pr_open' || glob.type === 'sub') {
    return invalidTransition(glob, actor, 'Only a same or super with a ready PR can be merged');
  }
  const head = glob.pr?.headSha ?? null;
  if (head === null || glob.headChecks?.sha !== head || glob.headChecks.state !== 'passed') {
    return invalidTransition(glob, actor, 'Required checks have not passed on the current head');
  }
  if (options.continue) {
    if (glob.type !== 'super') return invalidTransition(glob, actor, 'Only a super can merge and continue');
    if (!postplanAtHead(glob, options.facts ?? {})) return invalidTransition(glob, actor, POSTPLAN_NOT_AT_HEAD);
  }
  return new Builder(glob, ctx)
    .set({ mergeMode: options.continue ? 'continue' : null })
    .status('merging', options.continue ? { mode: 'continue' } : {})
    .effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha: head })
    .done();
};

/** Row 24: delete the glob and everything it owns. */
export const remove = (glob: Glob, ctx: Context): Result<Transition> =>
  new Builder(glob, ctx)
    .endRun('superseded', null, { cause: 'deleted' })
    .event('GlobDeleted', { status: glob.status })
    .effect({ kind: 'delete_glob_data', globId: glob.id, boardId: glob.boardId, prNumber: glob.pr?.number ?? null })
    .done();

/** What a reviewer or developer does to one sign-off label (rows 21, 22 and 27–30). */
export type LabelCommand =
  /** Reviewer: ask for changes on a required label. */
  | { readonly kind: 'submit_items'; readonly items: readonly string[] }
  /** Reviewer: satisfied, with or without items. */
  | { readonly kind: 'approve' }
  /** Developer: tick or untick an item while the label has items added. */
  | { readonly kind: 'tick'; readonly itemId: string; readonly done: boolean }
  /** Developer: send the label back to its reviewer, even with items unticked. */
  | { readonly kind: 'resubmit' }
  /** Re-open an approved label's review. */
  | { readonly kind: 'reopen' };

export const MAX_CHECKLIST_ITEMS = 100;
export const MAX_CHECKLIST_ITEM_LENGTH = 2000;

const openItems = (items: readonly ChecklistItem[]): number => items.filter((i) => !i.done).length;

/**
 * Rows 21, 22 and 27–30: sign-off labels and their review checklists. Who may act is not
 * restricted yet (anyone on the board); the event log records who did what.
 */
export const reviewLabel = (
  glob: Glob,
  name: LabelName,
  command: LabelCommand,
  ctx: Context,
): Result<Transition> => {
  const actor = requireActor(ctx);
  const from = glob.labels[name];
  if (from === undefined) {
    return invalidTransition(glob, actor, `${name} is not required on this glob`);
  }
  const items = glob.checklists[name] ?? [];
  const setState = (to: LabelState, detail: { readonly [key: string]: JsonValue } = {}): Builder => {
    const labels: Labels = { ...glob.labels, [name]: to };
    const b = new Builder(glob, ctx).set({ labels }).event('LabelChanged', { ...detail, label: name, from, to });
    const allApproved = Object.values(labels).every((s) => s === 'approved');
    if (glob.status === 'reviewing' && allApproved) {
      b.set({ signedOffAt: ctx.now }).status('signed_off');
    } else if (glob.status === 'signed_off' && !allApproved) {
      b.set({ signedOffAt: null }).status('reviewing');
    }
    return b;
  };

  switch (command.kind) {
    case 'submit_items': {
      // Row 27.
      if (from !== 'required') {
        return invalidTransition(glob, actor, `Items can only be added while ${name} waits for its reviewer`);
      }
      const texts = command.items.map((t) => t.trim()).filter((t) => t !== '');
      if (texts.length === 0) return invalidInput('Add at least one item');
      if (texts.some((t) => t.length > MAX_CHECKLIST_ITEM_LENGTH)) {
        return invalidInput(`Items are limited to ${MAX_CHECKLIST_ITEM_LENGTH} characters`);
      }
      if (items.length + texts.length > MAX_CHECKLIST_ITEMS) {
        return invalidInput(`A label holds at most ${MAX_CHECKLIST_ITEMS} items`);
      }
      // Items are never removed, so a running number is unique within the label.
      const added: ChecklistItem[] = texts.map((text, i) => ({
        id: String(items.length + i + 1),
        text,
        done: false,
        addedBy: actor.email,
        addedAt: ctx.now,
        doneBy: null,
        doneAt: null,
      }));
      return setState('added', { items: texts })
        .set({ checklists: { ...glob.checklists, [name]: [...items, ...added] } })
        .done();
    }
    case 'approve':
      // Row 28 (and row 21 when it is the last label).
      if (from === 'approved') return unchanged(glob);
      return setState('approved', { open: openItems(items) }).done();
    case 'tick': {
      // Row 29.
      if (from !== 'added') {
        return invalidTransition(
          glob,
          actor,
          glob.status === 'signed_off'
            ? "A signed-off glob's checklists are read-only"
            : `Items can only be ticked while ${name} has items added`,
        );
      }
      const item = items.find((i) => i.id === command.itemId);
      if (item === undefined) return invalidInput(`No item ${command.itemId} on ${name}`);
      if (item.done === command.done) return unchanged(glob);
      const ticked: ChecklistItem = {
        ...item,
        done: command.done,
        doneBy: command.done ? actor.email : null,
        doneAt: command.done ? ctx.now : null,
      };
      return new Builder(glob, ctx)
        .set({ checklists: { ...glob.checklists, [name]: items.map((i) => (i.id === item.id ? ticked : i)) } })
        .event('LabelItemTicked', { label: name, item: item.id, done: command.done })
        .done();
    }
    case 'resubmit':
      // Row 30.
      if (from !== 'added') {
        return invalidTransition(glob, actor, 'Only a label with items added can be resubmitted');
      }
      return setState('required', { open: openItems(items) }).done();
    case 'reopen':
      // Row 22 when the glob was signed off.
      if (from !== 'approved') return invalidTransition(glob, actor, 'Only an approved label can be re-opened');
      return setState('required').done();
  }
};

export interface FieldChanges {
  readonly title?: string;
  readonly summary?: string;
  readonly type?: SlopType;
  readonly category?: Category;
  readonly group?: string | null;
  readonly environment?: string | null;
  /** Globs to start after, already checked (`checkAfter`): editable while the glob has no branch. */
  readonly after?: readonly string[];
  /** Merge-policy holds found for a same becoming a sub (set by the service, not by clients). */
  readonly impliedAfter?: readonly ImpliedAfter[];
}

/** Changing fields is not a transition, except same → sub from planning (row 26). */
export const changeFields = (
  glob: Glob,
  changes: FieldChanges,
  board: Board,
  ctx: Context,
  dependencies: ReadonlyMap<string, DependencyState> = NO_DEPENDENCIES,
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

  const afterChanged = changes.after !== undefined && changes.after.join('\n') !== (glob.after ?? []).join('\n');
  if (afterChanged && (glob.status !== 'planning' || glob.provisioning !== 'none')) {
    return invalidTransition(glob, actor, 'Start after can only be changed before the glob has started');
  }

  const patch: { -readonly [K in keyof FieldChanges]: FieldChanges[K] } = {};
  const diff: { [key: string]: JsonValue } = {};
  for (const key of ['title', 'summary', 'type', 'category', 'group', 'environment'] as const) {
    const value = key === 'title' ? changes.title?.trim() : changes[key];
    if (value !== undefined && value !== glob[key]) {
      Object.assign(patch, { [key]: value });
      diff[key] = { from: glob[key], to: value };
    }
  }
  if (afterChanged) {
    Object.assign(patch, { after: changes.after });
    diff['after'] = { from: [...(glob.after ?? [])], to: [...changes.after] };
  }
  if (Object.keys(diff).length === 0) return unchanged(glob);

  const b = new Builder(glob, ctx).set(patch).event('FieldsChanged', diff);
  if (('type' in diff || 'environment' in diff) && glob.pr !== null) {
    b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  }
  // A same becoming a sub starts, unless something it starts after hasn't merged; a held glob whose waiting list was
  // edited down to nothing starts too. A held sub turned into a same is no longer asked to start by itself.
  const becomesSub = glob.type === 'same' && type === 'sub';
  const wasHeld = glob.waiting != null && glob.status === 'planning' && glob.type !== 'super';
  if (wasHeld && glob.type === 'sub' && type === 'same') b.set({ waiting: null });
  else if (becomesSub || wasHeld) {
    const impliedAfter = becomesSub ? mergeImplied(glob.impliedAfter, changes.impliedAfter ?? []) : glob.impliedAfter;
    const awaited = waitingFor({ after: changes.after ?? glob.after, impliedAfter }, dependencies);
    if (awaited.length > 0) {
      if (!wasHeld) {
        b.set({ waiting: { since: ctx.now }, ...(impliedAfter === undefined ? {} : { impliedAfter }) }).event('Waiting', { for: awaited.map((a) => a.id), note: waitSummary(awaited) });
      }
    } else if (wasHeld) {
      b.set({ waiting: null }).event('Released', { after: [] }).status('implementing').queueRun(glob.creator);
    } else {
      b.status('implementing').queueRun(actor.email);
    }
  }
  return b.done();
};

/** Why a same can't become a super (or back) right now, or null when it can; the glob view shows it beforehand. */
export const sameSuperSwapBlocker = (glob: Glob): string | null =>
  !['planning', 'in_progress', 'pr_open'].includes(glob.status) || hasLiveRun(glob)
    ? 'Sames and supers can only be swapped in planning or while a human is implementing, with no run live'
    : null;

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
    const blocker = sameSuperSwapBlocker(glob);
    if (blocker !== null) return invalidTransition(glob, actor, blocker);
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

/** A type change the glob view may offer: a feature can only become a sub as a task (`category`). */
export interface TypeChangeOption {
  readonly to: SlopType;
  readonly category?: Category;
}

/** The type changes `changeFields` would accept now, so the glob view never offers one the server refuses. */
export const allowedTypeChanges = (glob: Glob, role: Role): TypeChangeOption[] =>
  SLOP_TYPES.flatMap((to): TypeChangeOption[] => {
    if (to === glob.type || !checkTypeChange(glob, to, { email: '', role }).ok) return [];
    if (isValidCombination(to, glob.category)) return [{ to }];
    return glob.category === 'feature' && isValidCombination(to, 'task') ? [{ to, category: 'task' }] : [];
  });

// ---------------------------------------------------------------------------
// Events from integrations and routines

/**
 * Draft PRs are recorded without changing status. Recording the glob's current PR again is a no-op
 * (slop's own open response and the `opened` event both report it).
 */
export const prOpened = (glob: Glob, pr: { number: number; headSha: string | null }, ctx: Context): Result<Transition> => {
  if (glob.pr?.number === pr.number && glob.provisioning === 'ok') return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ pr: { number: pr.number, state: 'draft', headSha: pr.headSha }, provisioning: 'ok' })
    .event('PROpened', { number: pr.number })
    .done();
};

/** Provisioning finished: the branch exists, and the draft PR if the repo integration opened one. */
export const provisioned = (
  glob: Glob,
  result: { branch: string; pr: { number: number; headSha: string | null } | null },
  ctx: Context,
): Result<Transition> => {
  const b = new Builder(glob, ctx)
    .set({ provisioning: 'ok', ...(glob.failure?.kind === 'provisioning' ? { failure: null } : {}) })
    .event('BranchCreated', { ok: true, branch: result.branch });
  if (result.pr !== null) {
    b.set({ pr: { number: result.pr.number, state: 'draft', headSha: result.pr.headSha } }).event('PROpened', {
      number: result.pr.number,
    });
  }
  return b.done();
};

/**
 * Provisioning failed. A retryable failure only records the attempt; one that won't be retried (`final`: a 404 or 403
 * from the code host, or the last attempt) puts the reason on the glob and ends its queued run with it, so the card
 * and glob view say why and nothing keeps waiting for a branch that will not come.
 */
export const provisioningFailed = (glob: Glob, reason: string, ctx: Context, final = false): Result<Transition> => {
  const b = new Builder(glob, ctx).set({ provisioning: 'failed' }).event('BranchCreated', { ok: false, reason });
  if (!final) return b.done();
  if (currentRun(glob)?.state === 'queued') b.endRun('failed', reason);
  b.set({ failure: { reason, at: ctx.now, kind: 'provisioning' } });
  if (glob.status === 'implementing') b.status('failed');
  return b.done();
};

/** A push to the glob branch: records the new head; results for older commits stop counting. */
export const commitPushed = (
  glob: Glob,
  push: { sha: string; runId: string | null; message?: string | null; agentSetVersion?: number | null },
  ctx: Context,
): Result<Transition> => {
  const b = new Builder(glob, ctx);
  if (glob.pr !== null) b.set({ pr: { ...glob.pr, headSha: push.sha } });
  // Row 16a: a push after slop's own merge failed (usually the base merged in, conflict resolved) puts a same or super
  // back in review with its implementer; no run is queued and Merge is offered again once the new head's checks pass.
  const recovers =
    glob.status === 'failed' &&
    glob.failure?.kind === 'merge' &&
    glob.type !== 'sub' &&
    glob.pr?.state === 'ready' &&
    push.message?.trim() !== `${glob.id}: start`;
  if (recovers) {
    b.set({ failure: null, headChecks: null, mergeMode: null, ...(glob.conflict == null ? {} : { conflict: null }) })
      .event('MergeFailureRecovered', { sha: push.sha, reason: glob.failure.reason })
      .status('pr_open')
      .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
  }
  const run = currentRun(glob);
  const superseded = push.runId !== null && (run === null || run.id !== push.runId || run.state === 'ended');
  if (!superseded && run !== null && run.state !== 'ended' && push.runId === run.id) {
    b.updateRun({ lastProgressAt: ctx.now, state: run.state === 'queued' ? 'active' : run.state });
  }
  if (!recovers && (glob.status === 'pr_open' || glob.status === 'merging')) {
    b.set({ headChecks: null }).effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
  }
  // A push may have fixed a flagged conflict (or not): look again.
  if (glob.conflict != null && glob.pr !== null) {
    b.effect({ kind: 'check_conflict', globId: glob.id, generation: glob.generation, since: null });
  }
  // Doing: look again at how far the branch is behind the base (the card warns before a conflict exists).
  if (glob.status === 'in_progress' && glob.pr !== null) {
    b.effect({ kind: 'check_behind', globId: glob.id, generation: glob.generation });
  }
  // After Merge and continue the glob has no PR until the next push opens one, once there's new
  // work on the branch (main is merged back into it first, so the PR shows only the new work).
  if (glob.status === 'in_progress' && glob.pr === null && glob.provisioning === 'ok') {
    b.effect({ kind: 'open_pr', globId: glob.id, generation: glob.generation });
  }
  // Each push deploys exactly that commit to the glob's environment; not a superseded run's push,
  // nor the empty `<id>: start` commit slop creates the branch with.
  const isStart = push.message?.trim() === `${glob.id}: start`;
  if (glob.environment !== null && !superseded && !isStart && listOf(glob.status) === 'doing') {
    b.effect({ kind: 'request_deploy', globId: glob.id, generation: glob.generation, sha: push.sha });
  }
  // Doing with a PR: look again at whether the branch changes exclusive paths another open glob changes too (a warning).
  if (glob.status === 'in_progress' && glob.pr !== null && !superseded && !isStart) {
    b.effect({ kind: 'check_exclusive_paths', globId: glob.id, generation: glob.generation });
  }
  // The commit's `Slop-Agent-Set` trailer, when it has one: which agent set produced the glob's work.
  return b
    .event('CommitPushed', {
      sha: push.sha,
      runId: push.runId,
      fromSupersededRun: superseded,
      ...(push.agentSetVersion != null && { agentSetVersion: push.agentSetVersion }),
    })
    .done();
};

/**
 * Row 35: another open glob started or stopped changing the same exclusive paths as this one. Only a warning on the
 * glob (the card shows it); it never blocks anything. The first clash found is kept until it ends or changes.
 */
export const clashChanged = (
  glob: Glob,
  clash: { with: string; paths: readonly string[] } | null,
  ctx: Context,
): Result<Transition> => {
  const before = glob.clash ?? null;
  if (clash === null) {
    if (before === null) return unchanged(glob);
    return new Builder(glob, ctx).set({ clash: null }).event('ClashChanged', { with: null }).done();
  }
  if (before?.with === clash.with && before.paths.join('\n') === clash.paths.join('\n')) return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ clash: { with: clash.with, paths: [...clash.paths] } })
    .event('ClashChanged', { with: clash.with, paths: [...clash.paths] })
    .done();
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

const minutesSince = (from: string, now: string): number => (Date.parse(now) - Date.parse(from)) / 60_000;

/** `2026-10-07 02:01 UTC`: a time in a failure reason. */
const queuedAtText = (at: string): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The reason `runTimeoutReason` gives a watching run that ignored failed checks. */
const GAVE_UP = /^Auto-fix didn't respond/;

/** The failing check and its first lines, as the retried run's fire text carries them; null when the log wasn't read. */
const failureSummaryOf = (glob: Glob): string | null => {
  const failure = glob.headChecks?.state === 'failed' ? glob.headChecks.failure : undefined;
  if (failure === undefined) return null;
  const where = failure.step === null ? failure.name : `${failure.name} (${failure.step})`;
  return [where, ...failure.lines.slice(0, 5)].join('\n');
};

/** The head's failed checks that are the glob's own to fix (not inherited from the base): what a watching run is asked to respond to. */
const ownFailedHead = (glob: Glob): HeadChecks | null => {
  const checks = glob.headChecks;
  return glob.pr?.headSha != null && checks?.sha === glob.pr.headSha && checks.state === 'failed' && checks.inheritedFrom === undefined
    ? checks
    : null;
};

/**
 * Run failure detection: a run with no progress (no slop call or push) for too long, or that
 * has not marked its PR ready in time, is failed like a `report_failure` (rows 17 and 25).
 * A watching run is idle by design, so it has no no-progress limit; it is failed only for not
 * responding (no slop call or push) within `runRespondMinutes` of the head's checks failing.
 */
export const runTimeoutReason = (
  glob: Glob,
  board: Pick<Board, 'runNoProgressHours' | 'runReadyHours' | 'runStartMinutes' | 'runRespondMinutes'>,
  now: string,
): string | null => {
  const run = currentRun(glob);
  if (run === null || run.state === 'ended') return null;
  // Queued runs have made no slop call yet: one that never starts (no session, a session that never called slop).
  if (run.state === 'queued') {
    return minutesSince(run.queuedAt, now) >= board.runStartMinutes
      ? `Routine run never started (queued at ${queuedAtText(run.queuedAt)})`
      : null;
  }
  const hours = (from: string | null) => (from === null ? 0 : (Date.parse(now) - Date.parse(from)) / 3_600_000);
  const lastProgress = run.lastProgressAt ?? run.startedAt ?? run.queuedAt;
  if (run.state === 'watching') {
    const failed = ownFailedHead(glob);
    if (failed?.at === undefined) return null;
    // The clock starts when the checks failed, or when the run last did something, whichever is later.
    const since = lastProgress > failed.at ? lastProgress : failed.at;
    if (minutesSince(since, now) < board.runRespondMinutes) return null;
    const names = failed.failure?.name;
    return `Auto-fix didn't respond to failed checks${names === undefined ? '' : ` (${names})`} on ${failed.sha.slice(0, MIN_SHA_LENGTH)}`;
  }
  if (hours(lastProgress) >= board.runNoProgressHours) {
    return `No progress for ${String(board.runNoProgressHours)} hours`;
  }
  if (hours(run.startedAt ?? run.queuedAt) >= board.runReadyHours) {
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
      // A run retried on a ready PR watches it; there is no PR to mark ready.
      state: run.state === 'queued' ? (glob.status === 'pr_open' ? 'watching' : 'active') : run.state,
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
  b.status('pr_open').effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
  // CodeRabbit reviews on its own unless the repo turned that off; the executor decides whether to ask (R3).
  b.effect({ kind: 'request_code_review', globId: glob.id, generation: glob.generation });
  // A sub doesn't wait for the PR's checks: the board's policy decides at once, and the checks run on the base after it merges.
  if (glob.type === 'sub') b.effect({ kind: 'evaluate_sub_gate', globId: glob.id, generation: glob.generation, sha: pr.headSha });
  return b.done();
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
  checks: {
    sha: string;
    passed: boolean;
    conflict?: MergeConflict;
    /** Why they failed, read from the failing run's log; null/absent when it couldn't be read. */
    failure?: CheckFailure | null;
    /** The base branch's result when the checks failed: the failure is inherited if the base fails the same way. */
    base?: BaseChecks | null;
    baseBranch?: string;
  },
  ctx: Context,
): Result<Transition> => {
  if (glob.pr?.headSha !== checks.sha) return unchanged(glob);
  const failure = checks.passed ? undefined : (checks.failure ?? undefined);
  const inherited = inheritedFailure(failure, checks.base, checks.baseBranch ?? 'the base branch');
  const b = new Builder(glob, ctx)
    .set({
      headChecks: {
        sha: checks.sha,
        state: checks.passed ? 'passed' : 'failed',
        // A re-read of the same failure keeps its first time.
        ...(!checks.passed && { at: glob.headChecks?.sha === checks.sha && glob.headChecks.state === 'failed' ? (glob.headChecks.at ?? ctx.now) : ctx.now }),
        ...(failure !== undefined && { failure }),
        ...(inherited !== null && { inheritedFrom: inherited }),
      },
    })
    .event('BuildCompleted', {
      sha: checks.sha,
      passed: checks.passed,
      ...(failure !== undefined && { failure: failureSummary(failure) }),
      ...(inherited !== null && { inheritedFrom: inherited.base }),
    });
  // Slop updated the branch while merging: the checks on the new head decide (rows 12, 14, 16).
  if (glob.status === 'merging') {
    if (checks.conflict !== undefined) {
      const reason = conflictReason(checks.conflict);
      return b
        .set({ failure: { reason, at: ctx.now, kind: 'merge', conflict: checks.conflict }, mergeMode: null })
        .event('MergeFailed', { reason, conflict: true })
        .status('failed')
        .done();
    }
    if (!checks.passed) {
      return b
        .set({
          failure: {
            reason: `Checks failed after updating the branch${failure === undefined ? '' : `: ${failureSummary(failure)}`}`,
            at: ctx.now,
            kind: 'merge',
          },
          mergeMode: null,
        })
        .event('MergeFailed', { reason: 'checks failed after update' })
        .status('failed')
        .done();
    }
    b.effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha: checks.sha });
  }
  return b.done();
};

/** Whether the glob's head failed checks that a base-branch result can explain (or stop explaining). */
const hasFailedHead = (glob: Glob): boolean =>
  glob.pr?.headSha != null &&
  glob.headChecks?.sha === glob.pr.headSha &&
  glob.headChecks.state === 'failed' &&
  (glob.status === 'pr_open' || glob.status === 'in_progress');

/**
 * The base branch's check result changed: a failed head that fails the same way as a red base is marked inherited, and
 * the mark goes when the base no longer fails like it (a fixed base, or a different failure).
 */
export const baseChecksChanged = (
  glob: Glob,
  base: { checks: BaseChecks; branch: string },
  ctx: Context,
): Result<Transition> => {
  const checks = glob.headChecks;
  if (!hasFailedHead(glob) || checks === null) return unchanged(glob);
  const inherited = inheritedFailure(checks.failure, base.checks, base.branch);
  if (JSON.stringify(inherited) === JSON.stringify(checks.inheritedFrom ?? null)) return unchanged(glob);
  const kept: HeadChecks = {
    sha: checks.sha,
    state: checks.state,
    ...(checks.at !== undefined && { at: checks.at }),
    ...(checks.failure !== undefined && { failure: checks.failure }),
    ...(inherited !== null && { inheritedFrom: inherited }),
  };
  return new Builder(glob, ctx)
    .set({ headChecks: kept })
    .event('BaseChecksChanged', { base: base.branch, inherited: inherited !== null })
    .done();
};

/**
 * The base branch went green again: a glob whose failed checks were inherited from it is brought up to date with it, so
 * its checks run again on the fixed base. The update's push resets the head checks (row 21).
 */
export const baseTurnedGreen = (glob: Glob, ctx: Context): Result<Transition> => {
  if (!hasFailedHead(glob) || glob.headChecks?.inheritedFrom === undefined || glob.pr?.headSha == null) return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({ kind: 'update_branch', globId: glob.id, generation: glob.generation, sha: glob.pr.headSha })
    .done();
};

/** Where `mark_ready` came from: the board offers it to supers only, once the postplan is at the head. */
export type ReadySource = { readonly from: 'tool' } | { readonly from: 'board'; readonly facts: ActionFacts };

/**
 * `mark_ready`: the implementer is done and asks slop to mark the draft PR ready. The status
 * changes when GitHub confirms (row 11); a routine passes its run ID, which must be current.
 */
export const readyRequested = (
  glob: Glob,
  runId: string | null,
  ctx: Context,
  source: ReadySource = { from: 'tool' },
): Result<Transition> => {
  if (glob.status !== 'implementing' && glob.status !== 'in_progress') {
    return invalidTransition(glob, ctx.actor, `A glob in ${glob.status} has no draft PR to mark ready`);
  }
  if (glob.pr === null) return invalidTransition(glob, ctx.actor, 'The glob has no PR yet');
  if (source.from === 'board') {
    if (glob.type !== 'super') return invalidTransition(glob, ctx.actor, 'Only a super is marked ready from the board');
    if (restrictedFrom(requireActor(ctx), glob)) return forbidden('QA and PO members cannot mark a super ready');
    if (!postplanAtHead(glob, source.facts)) return invalidTransition(glob, ctx.actor, POSTPLAN_NOT_AT_HEAD);
  }
  const run = currentRun(glob);
  if (runId !== null && (run === null || run.id !== runId || run.state === 'ended')) {
    return invalidTransition(glob, ctx.actor, `Run ${runId} is not the glob's current run`);
  }
  // Already ready (a conflict fixed, a second call): GitHub raises no event, so go straight to pr_open.
  if (glob.pr.state === 'ready') return prReadyForReview(glob, { number: glob.pr.number, headSha: glob.pr.headSha ?? '' }, ctx);
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
  gate: {
    sha: string;
    passed: boolean;
    reason: string | null;
    /** Recorded for the learned sub limit: why it converted, the lines it changes and the limit applied. */
    cause?: SubGateCause | null;
    changedLines?: number;
    /** Generated lines left out of `changedLines` (the board's `sizeIgnoredPaths`). */
    ignoredLines?: number;
    limit?: number;
  },
  ctx: Context,
): Result<Transition> => {
  if (glob.status !== 'pr_open' || glob.type !== 'sub' || glob.pr?.headSha !== gate.sha) {
    return unchanged(glob);
  }
  const b = new Builder(glob, ctx).event('SubReviewCompleted', {
    sha: gate.sha,
    passed: gate.passed,
    reason: gate.reason,
    ...(gate.cause !== undefined && { cause: gate.cause }),
    ...(gate.changedLines !== undefined && { changedLines: gate.changedLines }),
    ...(gate.ignoredLines !== undefined && gate.ignoredLines > 0 && { ignoredLines: gate.ignoredLines }),
    ...(gate.limit !== undefined && { limit: gate.limit }),
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

/**
 * Rows 15 and 31: the merge was observed (slop's own merge response or the merged event, whichever
 * comes first; the second is a no-op). `number` is the merged PR's, when the caller knows it.
 */
export const merged = (glob: Glob, merge: { sha: string; number?: number }, ctx: Context): Result<Transition> => {
  // GitHub is the source of truth for merges, so any status before merging moves to reviewing.
  if (glob.status === 'reviewing' || glob.status === 'signed_off') return unchanged(glob);
  // A PR already landed with Merge and continue: its second observation.
  if (merge.number !== undefined && glob.prs.some((p) => p.number === merge.number)) return unchanged(glob);
  if (glob.type === 'super' && glob.mergeMode === 'continue') {
    // Row 31: the glob keeps going on its branch; the next push opens a fresh draft PR.
    const number = merge.number ?? glob.pr?.number;
    const prs = number === undefined ? glob.prs : [...glob.prs, { number, mergeSha: merge.sha, mergedAt: ctx.now }];
    return new Builder(glob, ctx)
      .set({ prs, pr: null, headChecks: null, mergeMode: null, failure: null, ...(glob.conflict == null ? {} : { conflict: null }) })
      .event('Merged', { sha: merge.sha, ...(number === undefined ? {} : { number }), mode: 'continue' })
      .status('in_progress')
      .effect({ kind: 'flag_conflicts', globId: glob.id, generation: glob.generation })
      .done();
  }
  return new Builder(glob, ctx)
    .endRun('completed')
    .set({
      labels: requiredLabels(glob.type),
      checklists: {},
      failure: null,
      mergeMode: null,
      pr: glob.pr === null ? null : { ...glob.pr, state: 'merged' },
      ...(glob.conflict == null ? {} : { conflict: null }),
    })
    .event('Merged', { sha: merge.sha })
    .status('reviewing')
    .effect({ kind: 'flag_conflicts', globId: glob.id, generation: glob.generation })
    // Only the final merge releases the globs waiting for this one (a Merge and continue leaves it open).
    .effect({ kind: 'release_waiting', globId: glob.id, generation: glob.generation })
    .done();
};

/** Row 16: slop's own merge failed (conflict, or checks failed after updating the branch). */
export const mergeFailed = (
  glob: Glob,
  reason: string,
  ctx: Context,
  conflict?: MergeConflict,
): Result<Transition> => {
  if (glob.status !== 'merging') return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ failure: { reason, at: ctx.now, kind: 'merge', ...(conflict === undefined ? {} : { conflict }) }, mergeMode: null })
    .event('MergeFailed', { reason })
    .status('failed')
    .done();
};

/**
 * Row 16b: the checks on the base branch failed at the commit a sub merged. Slop reverts that commit and fails the sub,
 * naming the failing check. Sames and supers are left to a person (the red base shows on the board).
 */
export const mergeTurnedBaseRed = (
  glob: Glob,
  red: { sha: string; failure: CheckFailure | null; base: string },
  ctx: Context,
): Result<Transition> => {
  if (glob.type !== 'sub' || glob.status !== 'reviewing' || glob.pr?.state !== 'merged') return unchanged(glob);
  const check = red.failure === null ? 'the checks' : red.failure.name;
  const link = red.failure?.url == null ? '' : ` (${red.failure.url})`;
  return new Builder(glob, ctx)
    .set({ failure: { reason: `Reverted from ${red.base}: ${check} failed on its merge commit${link}`, at: ctx.now, kind: 'reverted' } })
    .event('MergeReverted', { sha: red.sha, ...(red.failure === null ? {} : { check: red.failure.name }) })
    .status('failed')
    .effect({ kind: 'revert_merge', globId: glob.id, generation: glob.generation, sha: red.sha })
    .done();
};

/** The automatic revert could not be made (the base moved on since); a person reverts the commit. */
export const revertFailed = (glob: Glob, reason: string, ctx: Context): Result<Transition> => {
  if (glob.status !== 'failed' || glob.failure?.kind !== 'reverted') return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ failure: { ...glob.failure, reason: `${glob.failure.reason}. ${reason}` } })
    .event('MergeRevertFailed', { reason })
    .done();
};

/** Rows 17, 18 and 25: `report_failure`, or a run timeout (always with its run ID). */
export const reportFailure = (
  glob: Glob,
  report: { reason: string; runId: string | null; agentSetVersion?: number | null },
  ctx: Context,
): Result<Transition> => {
  // Every failure report records the agent-set version it ran with (spec: provenance).
  const agentSetVersion = report.agentSetVersion ?? null;
  const failure = { reason: report.reason, at: ctx.now, ...(agentSetVersion === null ? {} : { agentSetVersion }) };
  if (report.runId === null) {
    // Row 18: an interactive session gave up.
    if (glob.status !== 'in_progress') {
      return invalidTransition(glob, ctx.actor, 'Only a glob in progress can be failed without a run');
    }
    return new Builder(glob, ctx)
      .set({ failure })
      .status('failed', { reason: report.reason, agentSetVersion })
      .done();
  }

  const run = currentRun(glob);
  if (run === null || run.id !== report.runId || run.state === 'ended') {
    // Results from superseded runs are recorded but ignored.
    return new Builder(glob, ctx)
      .event('RunFailed', { runId: report.runId, reason: report.reason, ignored: true, agentSetVersion })
      .done();
  }
  if (glob.status === 'implementing') {
    // Row 17.
    return new Builder(glob, ctx)
      .endRun('failed', report.reason, { agentSetVersion })
      .set({ failure })
      .status('failed')
      .done();
  }
  if (glob.status === 'pr_open' && run.state === 'watching') {
    // Row 25: auto-fix ended; the glob stays in pr_open and shows the failure.
    const b = new Builder(glob, ctx).endRun('failed', report.reason, { agentSetVersion });
    // A watcher that gave up is retried once by slop itself, on the same PR and branch; only if that run also ends
    // without fixing it does the glob show the failure and the Retry auto-fix button.
    const retried = glob.runs.some((r) => r.autoRetry === true);
    if (GAVE_UP.test(report.reason) && !retried && glob.type !== 'super' && glob.implementer === null && glob.pr !== null) {
      return b.queueRun(run.triggeredBy, { failureSummary: failureSummaryOf(glob) }).done();
    }
    return b.set({ failure }).done();
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
    .endRun('superseded', null, { cause: 'pr_closed' })
    .set({ failure: { reason: 'PR closed without merging', at: ctx.now } })
    .status('failed')
    .done();
};

// ---------------------------------------------------------------------------
// What a person can do next (drives the glob view's buttons and error messages)

export const allowedActions = (glob: Glob, actor: Actor, facts: ActionFacts = {}): Action[] => {
  const actions: Action[] = [];
  const restricted = restrictedFrom(actor, glob);
  // Held: waiting for another glob to merge. Without the dependencies loaded, the glob's own mark says it.
  const held =
    glob.status === 'planning' &&
    glob.type !== 'super' &&
    (facts.dependencies === undefined ? glob.waiting != null : waitingFor(glob, facts.dependencies).length > 0);
  if (glob.status === 'planning' && glob.type === 'same' && !held) actions.push('start');
  if (held && !restricted) actions.push('start_anyway');
  const canPickUp =
    !restricted &&
    !hasBusyRun(glob) &&
    (glob.status === 'planning' ||
      glob.status === 'failed' ||
      ((glob.status === 'in_progress' || glob.status === 'pr_open') &&
        glob.implementer !== actor.email));
  if (canPickUp) actions.push('pick_up');
  if (
    !restricted &&
    glob.type !== 'super' &&
    hasLiveRun(glob) &&
    (glob.status === 'implementing' || glob.status === 'pr_open')
  ) {
    actions.push('take_over');
  }
  // A merge failure on a glob a person implements is theirs to fix and push: a routine run is the wrong answer.
  const personMergeFailure = glob.failure?.kind === 'merge' && glob.implementer !== null;
  if (glob.status === 'failed' && glob.type !== 'super' && !hasLiveRun(glob) && !personMergeFailure) {
    actions.push('retrigger');
  }
  if (!restricted && !hasLiveRun(glob) && canRetryAutofix(glob)) actions.push('retry_autofix');
  if (canRequestConflictFix(glob)) actions.push('resolve_conflict');
  if (glob.status !== 'reviewing' && glob.status !== 'signed_off') actions.push('start_again');
  if (
    glob.status === 'pr_open' &&
    glob.type !== 'sub' &&
    glob.pr?.headSha != null &&
    glob.headChecks?.sha === glob.pr.headSha &&
    glob.headChecks.state === 'passed'
  ) {
    actions.push('merge');
    if (postplanAtHead(glob, facts)) actions.push('merge_continue');
  }
  if (
    !restricted &&
    glob.status === 'in_progress' &&
    glob.pr?.state === 'draft' &&
    postplanAtHead(glob, facts)
  ) {
    actions.push('mark_ready');
  }
  actions.push('delete');
  return actions;
};
