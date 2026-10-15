/**
 * The glob state machine. Every function is pure: it takes the glob's current state and
 * returns the next state plus the domain events to log and the effects to queue, or a
 * domain error. The numbered rows refer to the transition table in the spec.
 */
import { canChooseType } from '../app/access.js';
import { err, forbidden, invalidCombination, invalidInput, ok, runActive } from './errors.js';
import type { Result } from './errors.js';
import type { DomainEvent, DomainEventType, Effect, JsonValue } from './events.js';
import type { ConflictKind, ConflictResolvedBy } from './conflict-record.js';
import type { ArtifactSummary, IndependentReviewMeta } from './knowledge.js';
import type { SubGateCause } from './sub-limit.js';
import { failureSummary, inheritedFailure } from './checks.js';
import { isValidCombination, listOf } from './matrix.js';
import {
  isActionAttributes,
  isDecisionAttributes,
  sameScope,
  validateActionEdit,
  validateAttributes,
  validateScopeEdit,
} from './attributes.js';
import type {
  ActionAttributes,
  ActionOutcome,
  DecisionAttributes,
  DecisionClosedAs,
  DecisionOutcome,
  DecisionOutcomeKind,
  DecisionScope,
  GlobAttributes,
} from './attributes.js';
import { isAgentSetGlob } from './agent-set.js';
import { CLOSING_EDGE_KINDS, isHumanCategory, SLOP_TYPES } from './types.js';
import { criterionOf } from './escalation-learning.js';
import { isReplaceableInferred, mergeImplied, mergeInferred } from './exclusive-paths.js';
import {
  awaitedOf,
  holdWords,
  NO_RELATIONS,
  overrideEdits,
  refusalText,
  startIds,
  unmet,
  waitSummary,
} from './relations.js';
import type { RelationEdit, RelationFacts, Unmet } from './relations.js';
import { rolloutPending } from './human-steps.js';
import type { BlockProgress } from './human-steps.js';
import type {
  Actor,
  Board,
  Category,
  BaseChecks,
  BehindBase,
  CheckFailure,
  ChecklistItem,
  Failure,
  Glob,
  GlobLink,
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
  RunPurpose,
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
  /** Changes to the glob's relations (rows beside it) that go with this transition; the service writes them in the same transaction. */
  readonly relationEdits?: readonly RelationEdit[];
}

export type Action =
  | 'start'
  /** A glob in Planning: a routine run does the orchestrator's Phases 1–2 only and pushes the investigation; no branch, no commits. */
  | 'investigate'
  /** A glob with a PR in Doing or Reviewing: queue an independent review of it as it is now. */
  | 'review_now'
  /** A glob held for another glob to merge starts now, before it has. */
  | 'start_anyway'
  | 'pick_up'
  | 'take_over'
  | 'retrigger'
  /** A PR whose auto-fix ended without fixing it: a new routine run on the same branch, keeping the PR. */
  | 'retry_autofix'
  /** A merge conflict with no human implementer: a routine run merges the base branch into the glob's branch and pushes. */
  | 'resolve_conflict'
  | 'start_again'
  | 'merge'
  /** A failed merge that GitHub never decided (no conflict, checks passed at the head): ask slop to merge again. */
  | 'retry_merge'
  | 'deescalate'
  /** A failed sub or same whose routine said a person must decide something: becomes a super with the person implementing. */
  | 'make_super'
  /** Supers: squash-merge what's done and keep going on the same glob and branch. */
  | 'merge_continue'
  /** Disarm "merge when checks pass". */
  | 'cancel_merge'
  /** Supers, from the board: ask slop to mark the draft PR ready (as the `mark_ready` tool does). */
  | 'mark_ready'
  /** Decision globs: choose an outcome (accept, retarget, needs work, reject). */
  | 'decide'
  /** Decision globs: sign off an accepted decision. */
  | 'sign_off'
  /** Decision globs: take an accepted decision back to Doing to choose again. */
  | 'reopen'
  /** Action globs: a person did it; marks the action done. */
  | 'complete_action'
  /** Action globs: not needed after all; ends the action with a reason. */
  | 'dismiss_action'
  | 'delete';

/**
 * What the actions depend on beyond the glob itself: read from its artifacts, which live outside
 * the glob document.
 */
export interface ActionFacts {
  /** The commit SHA of the glob's latest implementation record, or null without one (or without a SHA). */
  readonly recordSha?: string | null;
  /** The glob's relations and the state of every glob they point at (a missing entry reads as deleted); absent when not loaded. */
  readonly relations?: RelationFacts;
  /** The work steps holding back sign-off, where loaded (sign-off is refused while any is open). */
  readonly rollout?: BlockProgress;
  /** The glob's stored independent reviews, where loaded (Retry review is offered only once they are known). */
  readonly reviews?: readonly IndependentReviewMeta[];
}

/** The latest implementation record's commit SHA among a glob's artifact summaries (a legacy postplan counts until migrated). */
export const recordShaOf = (
  artifacts: readonly Pick<ArtifactSummary, 'kind' | 'label' | 'commitSha'>[],
): string | null =>
  (
    artifacts.find((a) => a.kind === 'implementation_plan' && a.label === '') ??
    artifacts.find((a) => a.kind === 'postplan' && a.label === '')
  )?.commitSha ?? null;

/** The independent reviews among a glob's artifact summaries. */
export const reviewsOf = (artifacts: readonly Pick<ArtifactSummary, 'review'>[]): IndependentReviewMeta[] =>
  artifacts.flatMap((a) => (a.review === undefined ? [] : [a.review]));

/** Short SHAs are at least this long (git's default abbreviation). */
const MIN_SHA_LENGTH = 7;

/** Whether two SHAs name the same commit: equal, or one a prefix of the other (a short SHA). */
export const sameCommit = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (a == null || b == null) return false;
  const [x, y] = [a.trim().toLowerCase(), b.trim().toLowerCase()];
  if (Math.min(x.length, y.length) < MIN_SHA_LENGTH) return false;
  return x.startsWith(y) || y.startsWith(x);
};

/** A super's latest implementation record was written at its PR's current head. */
export const recordAtHead = (glob: Glob, facts: ActionFacts): boolean =>
  glob.type === 'super' && sameCommit(facts.recordSha, glob.pr?.headSha);

export const RECORD_NOT_AT_HEAD = 'Update the implementation record at the head first (/finalise)';

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

/**
 * A run that has called slop and not ended: pick-up is refused while one exists. An investigate-only run doesn't count:
 * picking the glob up supersedes it.
 */
export const hasBusyRun = (glob: Glob): boolean => {
  const run = currentRun(glob);
  return (
    run !== null &&
    run.purpose !== 'investigate' &&
    (run.state === 'active' || run.state === 'watching')
  );
};

/**
 * A run that is doing work: queued or active. A `watching` run only waits for check events, so it doesn't stand in the way
 * of actions the Claude GitHub App performs (like Fix conflict).
 */
export const hasWorkingRun = (glob: Glob): boolean => {
  const run = currentRun(glob);
  return run !== null && (run.state === 'queued' || run.state === 'active');
};

/**
 * A conflict-fixing run that has not ended. Its first call to slop on a PR that is ready moves it to `watching`, which
 * is not "working", so without this check a second Fix conflict supersedes it seconds after it starts.
 */
export const hasConflictFixRun = (glob: Glob): boolean => {
  const run = currentRun(glob);
  return run !== null && run.purpose === 'resolve_conflict' && run.state !== 'ended';
};

/** The investigate-only run that has not ended (queued or active), if it is the glob's current run. */
export const liveInvestigation = (glob: Glob): Run | null => {
  const run = currentRun(glob);
  return run !== null && run.purpose === 'investigate' && run.state !== 'ended' ? run : null;
};

/** The running investigation, as the context bundle and the pick-up reply tell it: its run, since when, its session. */
export const investigationRunning = (
  glob: Glob,
): { readonly runId: string; readonly since: string; readonly sessionUrl: string | null } | null => {
  const run = liveInvestigation(glob);
  return run === null ? null : { runId: run.id, since: run.startedAt ?? run.queuedAt, sessionUrl: run.sessionUrl };
};

/** Start was pressed while the glob was being investigated: it starts when that run ends. */
export const startQueued = (glob: Glob): boolean => glob.waiting?.investigation !== undefined;

/** Any run that has not ended, including one still queued. */
export const hasLiveRun = (glob: Glob): boolean => {
  const run = currentRun(glob);
  return run !== null && run.state !== 'ended';
};

const initialStatus = (type: SlopType | null): Status =>
  type === null ? 'planning' : type === 'sub' ? 'implementing' : type === 'same' ? 'planning' : 'in_progress';

const requiredLabels = (type: SlopType | null): Labels =>
  type === null ? {} : type === 'sub' ? { QA: 'required' } : { FR: 'required', CR: 'required', QA: 'required' };

class Builder {
  private readonly events: DomainEvent[] = [];
  private readonly effects: Effect[] = [];
  private changed = false;
  private edits: readonly RelationEdit[] = [];

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
      ...(listOf(from) !== listOf(to) && { listSince: this.ctx.now }),
    });
    this.event('StatusChanged', { ...detail, from, to });
    return listOf(to) === 'doing' ? this.ensureProvisioned() : this;
  }

  /** A glob gets its branch and draft PR when it enters Doing; queued before any routine run. */
  ensureProvisioned(): this {
    // Human work (a decision, an action) never gets a branch or a PR.
    if (isHumanCategory(this.glob.category) || this.glob.provisioning !== 'none') return this;
    this.set({ provisioning: 'pending' });
    return this.effect({
      kind: 'provision',
      globId: this.glob.id,
      generation: this.glob.generation,
    });
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
  endRun(
    outcome: RunOutcome,
    failureReason: string | null = null,
    detail: { readonly [key: string]: JsonValue } = {},
  ): this {
    const run = currentRun(this.glob);
    if (run === null || run.state === 'ended') return this;
    const ended: Run = { ...run, state: 'ended', outcome, endedAt: this.ctx.now, failureReason };
    this.set({ runs: [...this.glob.runs.slice(0, -1), ended] });
    const purpose: { readonly [key: string]: JsonValue } =
      run.purpose === undefined ? {} : { purpose: run.purpose };
    return outcome === 'failed'
      ? this.event('RunFailed', { ...detail, ...purpose, runId: run.id, reason: failureReason })
      : this.event('RunEnded', { ...detail, ...purpose, runId: run.id, outcome });
  }

  /**
   * A Start pressed during an investigation takes effect when that run ends (stored, or failed, which includes a timeout):
   * the glob starts as Start would have, and its run reuses the investigation if one was stored. Call it right after the
   * investigate run's `endRun`.
   */
  startAfterInvestigation(ended: Run, relations: RelationFacts = NO_RELATIONS): this {
    const queued = this.glob.waiting?.investigation;
    if (queued === undefined || queued.runId !== ended.id || this.glob.status !== 'planning') return this;
    // A start relation added since Start was pressed still holds: the glob goes back to waiting (the merge of what it waits for
    // releases it), never straight into a run.
    const awaited = awaitedOf(relations);
    if (awaited.length > 0)
      return this.set({ waiting: { since: this.glob.waiting?.since ?? this.ctx.now } }).event('Waiting', {
        for: awaited.map((a) => a.id),
        note: waitSummary(awaited),
      });
    return this.set({ waiting: null })
      .event('Released', { investigation: ended.id })
      .status('implementing')
      .queueRun(queued.by, undefined, true);
  }

  /**
   * The glob just failed: a queued, active or watching run it leaves behind could never be ended (report_failure and
   * Pick up refuse it), so end it as superseded. A conflict-fix run queued for the very conflict that failed the glob is
   * kept (`report_failure` from it is accepted on a failed glob).
   */
  endRunsOnFailure(reason: string, failure: Failure): this {
    const run = currentRun(this.glob);
    if (run === null || run.state === 'ended') return this;
    if (run.purpose === 'resolve_conflict' && failure.conflict !== undefined && run.state !== 'watching') return this;
    return run.state === 'watching'
      ? this.endRun('failed', reason)
      : this.endRun('superseded', `failed: ${reason}`, { cause: 'glob_failed' });
  }

  updateRun(patch: Partial<Run>): this {
    const run = currentRun(this.glob);
    if (run === null) return this;
    return this.set({ runs: [...this.glob.runs.slice(0, -1), { ...run, ...patch }] });
  }

  /** Queues a new routine run for whoever triggered it. */
  queueRun(
    triggeredBy: string,
    retry?: { readonly failureSummary: string | null },
    checkPrerequisites = false,
    purpose?: RunPurpose,
  ): this {
    // Starting the glob supersedes an investigation still in flight: its result would only duplicate Phase 2.
    const live = currentRun(this.glob);
    if (purpose === undefined && live?.purpose === 'investigate')
      this.endRun('superseded', null, { cause: 'started' });
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
      ...(purpose === undefined ? {} : { purpose }),
    };
    this.set({ runs: [...this.glob.runs, run] });
    this.event('RunTriggered', {
      runId: run.id,
      triggeredBy,
      routineOwner: run.routineOwner,
      ...(retry === undefined ? {} : { automatic: true }),
      ...(purpose === undefined ? {} : { purpose }),
    });
    return this.effect({
      kind: 'fire_routine',
      globId: this.glob.id,
      generation: this.glob.generation,
      runId: run.id,
      routineOwner: run.routineOwner,
      ...(retry?.failureSummary == null ? {} : { failureSummary: retry.failureSummary }),
      ...(checkPrerequisites ? { checkPrerequisites: true as const } : {}),
      ...(purpose === undefined ? {} : { purpose }),
    });
  }

  bumpGeneration(): this {
    return this.set({ generation: this.glob.generation + 1 });
  }

  /** Relation rows to change with this transition (Start now overrides the inferred and learned start relations). */
  relationEdits(edits: readonly RelationEdit[]): this {
    this.edits = edits;
    return this;
  }

  done(): Result<Transition> {
    const glob = this.changed ? { ...this.glob, updatedAt: this.ctx.now } : this.glob;
    return ok({
      glob,
      changed: this.changed,
      events: this.events,
      effects: this.effects,
      ...(this.edits.length === 0 ? {} : { relationEdits: this.edits }),
    });
  }
}

const unchanged = (glob: Glob): Result<Transition> =>
  ok({ glob, changed: false, events: [], effects: [] });

/**
 * The glob's relations changed (rows beside it, written by the service with their own events): the glob itself is as it was, but
 * its version and `updatedAt` move, so live updates and stale-form checks see the change.
 */
export const relationsChanged = (glob: Glob, ctx: Context): Result<Transition> => new Builder(glob, ctx).set({}).done();

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
  /** Null for human work (decision, action). */
  readonly type: SlopType | null;
  readonly category: Category;
  /** Decisions and actions: the full attributes (scope, source, channel); validated by `create`. Work globs: none. */
  readonly attributes?: GlobAttributes;
  readonly group: string | null;
  readonly environment: string | null;
  /** Same only: start a routine run immediately (explicit instruction or `autoTrigger`). */
  readonly autoTrigger: boolean;
  /** Predicted overlaps found for this glob before it was created (merge-policy holds; they never hold a start). */
  readonly impliedAfter?: readonly ImpliedAfter[];
  /** Super only: `false` parks it in Planning (no branch, run or implementer) until a person picks it up to pair. */
  readonly start?: boolean;
}

export const create = (
  input: CreateInput,
  board: Board,
  ctx: Context,
  /** The relations the new glob starts with (made by the service, already checked) and the state of what they point at. */
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (!isValidCombination(input.type, input.category)) {
    return invalidCombination(`A ${input.category} cannot be a ${input.type}`);
  }
  if ((actor.role === 'qa' || actor.role === 'po') && input.type === 'super') {
    return forbidden('QA and PO members cannot create supers');
  }
  if (input.title.trim() === '') return invalidInput('A glob needs a title');
  if (input.category === 'decision') return createDecision(input, ctx, actor);
  if (input.category === 'action') return createAction(input, ctx, actor);
  const type = input.type;
  if (type === null) return invalidCombination(`A ${input.category} needs a type`);
  // A sub created without an environment gets the board's default for subs, if it has one.
  const environment =
    input.environment ??
    (type === 'sub'
      ? (board.environments.find((e) => e.subDefault === true)?.name ?? null)
      : null);
  const envCheck = checkEnvironment(board, environment);
  if (!envCheck.ok) return envCheck;

  const impliedAfter = input.impliedAfter ?? [];
  const awaited = awaitedOf(relations);
  const wantsStart = type === 'sub' || (type === 'same' && input.autoTrigger);
  // A sub (or auto-started same) with something unmerged to wait for sits in Planning, with no branch, until released.
  const held = wantsStart && awaited.length > 0;
  const autoStart = type === 'same' && input.autoTrigger && !held;
  // A parked super waits in Planning for a person to pick it up; nobody's active glob until then.
  const parked = type === 'super' && input.start === false;
  const status: Status =
    held || parked ? 'planning' : autoStart ? 'implementing' : initialStatus(type);
  const glob: Glob = {
    id: input.id,
    boardId: input.boardId,
    title: input.title.trim(),
    type,
    category: input.category,
    group: input.group,
    environment,
    status,
    version: 0,
    generation: 1,
    creator: actor.email,
    planner: actor.email,
    implementer: type === 'super' && !parked ? actor.email : null,
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
    listSince: ctx.now,
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
  if (held)
    b.event('Waiting', {
      for: awaited.map((a) => a.id),
      note: waitSummary(awaited),
    });
  else if (type === 'sub' || autoStart) b.queueRun(actor.email);
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
  relations: RelationFacts = NO_RELATIONS,
  /** Overlaps the board's merge policy predicted for this start (another open glob may change the same exclusive paths). */
  newHolds: readonly ImpliedAfter[] = [],
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status !== 'planning' || glob.type !== 'same') {
    return invalidTransition(glob, actor, 'Only a same in planning can be started');
  }
  if (restrictedFrom(actor, glob)) return forbidden(`QA and PO members cannot start ${glob.type}s`);
  // A second Start while the first waits for the investigation changes nothing.
  if (startQueued(glob)) return unchanged(glob);
  const awaited = awaitedOf(relations);
  if (awaited.length > 0) return invalidTransition(glob, actor, refusalText(awaited));
  // Overlaps the policy predicted never hold the start; they stay on the glob as internal data for conflicts and learning.
  const overlaps =
    newHolds.length === 0 ? {} : { impliedAfter: mergeImplied(glob.impliedAfter, newHolds) };
  const investigating = liveInvestigation(glob);
  if (investigating !== null) return queueStart(new Builder(glob, ctx), ctx, investigating, actor, overlaps).done();
  return new Builder(glob, ctx)
    .set({ waiting: null, ...overlaps })
    .status('implementing')
    .queueRun(actor.email, undefined, true)
    .done();
};

/** Start during an investigation (row 5): the glob stays in Planning, waiting for that run; no second investigation starts. */
const queueStart = (
  b: Builder,
  ctx: Context,
  investigating: Run,
  actor: Actor,
  extra: Partial<Glob> = {},
): Builder =>
  b
    .set({
      ...extra,
      waiting: { since: b.current.waiting?.since ?? ctx.now, investigation: { runId: investigating.id, by: actor.email } },
    })
    .event('StartQueued', { runId: investigating.id });

/** Whether an investigate-only run can be started on the glob now: in Planning, not a super, nothing live. */
export const canInvestigate = (glob: Glob): boolean =>
  glob.status === 'planning' && glob.type !== 'super' && !hasLiveRun(glob);

/**
 * Row 5a: Investigate. A glob in Planning gets a routine run that does the orchestrator's Phases 1–2 only and pushes the
 * investigation. The glob stays in Planning with no branch or PR (nothing is committed), and starting it later reuses the
 * investigation when its plan hash and relevant files are unchanged. A person's choice, or slop's own when intake flagged the
 * glob big (`automatic`: the triggering person is the glob's creator).
 */
export const investigate = (glob: Glob, ctx: Context, automatic = false): Result<Transition> => {
  const actor = automatic ? null : requireActor(ctx);
  if (glob.status !== 'planning' || glob.type === 'super') {
    return invalidTransition(glob, actor, 'Only a sub or same in planning can be investigated');
  }
  if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
  if (actor !== null && restrictedFrom(actor, glob))
    return forbidden(`QA and PO members cannot investigate ${glob.type}s`);
  const triggeredBy = actor?.email ?? glob.creator;
  return new Builder(glob, ctx).queueRun(triggeredBy, undefined, false, 'investigate').done();
};

/** Whether a glob can be independently reviewed on demand: it has a PR (open or merged) and is in Doing or Reviewing. */
export const canReviewNow = (glob: Glob): boolean =>
  glob.pr !== null &&
  glob.pr.state !== 'closed' &&
  (listOf(glob.status) === 'doing' || glob.status === 'reviewing');

/**
 * Whether Review code is on offer, and as what: `retry` when slop's automatic review for the glob's stage is missing at the
 * current head (a ready same's before-merge review, any merged glob's after-merge one) and `review` for a person's own
 * same or super with an open PR. Never while a machine run is live. Without the reviews loaded the retry case is unknown
 * and not offered.
 */
export type ReviewOffer = 'retry' | 'review';

export const reviewOffer = (
  glob: Glob,
  reviews?: readonly IndependentReviewMeta[],
): ReviewOffer | null => {
  const pr = glob.pr;
  if (pr === null || !canReviewNow(glob) || hasLiveRun(glob)) return null;
  const automatic = pr.state === 'merged' || (pr.state === 'ready' && glob.type !== 'sub');
  if (automatic && reviews !== undefined) {
    const missing = !reviews.some((r) =>
      pr.state === 'merged' ? r.stage === 'post_merge' : r.stage === 'pre_merge' && sameCommit(r.headSha, pr.headSha),
    );
    if (missing) return 'retry';
  }
  return glob.type !== 'sub' && glob.implementer !== null && pr.state !== 'merged' ? 'review' : null;
};

/**
 * Review now: queues a fresh independent review (never deduplicated against earlier ones) of the change as it is: an open
 * PR as it would land on the latest base branch, a merged one as the squash commit. The glob itself doesn't change.
 */
export const reviewNow = (glob: Glob, ctx: Context, facts: ActionFacts = {}): Result<Transition> => {
  const actor = requireActor(ctx);
  const pr = glob.pr;
  if (pr === null || !canReviewNow(glob))
    return invalidTransition(
      glob,
      actor,
      'Only a glob with a pull request in Doing or Reviewing can be reviewed now',
    );
  if (!isAgentSetGlob(glob) && reviewOffer(glob, facts.reviews) === null)
    return invalidTransition(
      glob,
      actor,
      'Review code is only for a missing automatic review or a person implementing a same or super; the machine reviews the rest itself',
    );
  const stage = pr.state === 'merged' ? 'post_merge' : 'pre_merge';
  return new Builder(glob, ctx)
    .event('ReviewRequested', { stage })
    .effect({
      kind: 'review_change',
      globId: glob.id,
      generation: glob.generation,
      stage,
      sha: pr.headSha ?? '',
      requestId: ctx.newRunId(),
    })
    .done();
};

/**
 * A routine's investigation was stored (and its block validated): ends an investigate-only run. A run that implements the
 * glob keeps going; so does a superseded one, which `runId` no longer matches.
 */
export const investigationPushed = (
  glob: Glob,
  runId: string,
  ctx: Context,
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  const run = currentRun(glob);
  if (run === null || run.id !== runId || run.state === 'ended' || run.purpose !== 'investigate')
    return unchanged(glob);
  return new Builder(glob, ctx).endRun('completed').startAfterInvestigation(run, relations).done();
};

/**
 * Row 34: Start now. A sub or same in planning that is held (it waits for unmerged globs) starts now; the hold is
 * recorded as overridden. Also Start (row 34a): a glob a person picked up that has
 * no routine run goes to a routine, the person no longer implementing it.
 */
export const startAnyway = (
  glob: Glob,
  ctx: Context,
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (restrictedFrom(actor, glob)) return forbidden(`QA and PO members cannot start ${glob.type}s`);
  if (glob.type !== 'super' && glob.status === 'in_progress' && glob.implementer !== null) {
    if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
    return new Builder(glob, ctx)
      .bumpGeneration()
      .set({ implementer: null, failure: null })
      .status('implementing')
      .event('HandedToMachine', { from: glob.implementer })
      .queueRun(actor.email)
      .done();
  }
  if (glob.status !== 'planning' || glob.type === 'super') {
    return invalidTransition(
      glob,
      actor,
      'Only a sub or same in planning, or one picked up with no routine run, can be started anyway',
    );
  }
  if (startQueued(glob)) return unchanged(glob);
  const awaited = awaitedOf(relations);
  if (awaited.length === 0 && glob.waiting == null) {
    return invalidTransition(glob, actor, 'Nothing holds this glob; use Start');
  }
  // The inferred and learned start relations are marked overridden (a person's and a split's keep holding on paper, but the
  // glob starts); the predicted overlaps on the glob are kept as they are, so a recheck doesn't replace them.
  const overridden = {
    ...(glob.impliedAfter === undefined
      ? {}
      : { impliedAfter: glob.impliedAfter.map((i) => ({ ...i, overridden: true as const })) }),
  };
  const b = new Builder(glob, ctx)
    .relationEdits(overrideEdits(relations.relations, ctx.now))
    .event('HoldOverridden', { for: awaited.map((a) => a.id) });
  // An investigation is still running: the start waits for it, with the hold already overridden.
  const investigating = liveInvestigation(glob);
  if (investigating !== null) return queueStart(b, ctx, investigating, actor, overridden).done();
  return b.set({ waiting: null, ...overridden }).status('implementing').queueRun(actor.email).done();
};

/**
 * Row 33: a glob this one waited for merged. When everything it waits for has merged, it starts as a fresh sub (or
 * auto-started same) would: branch cut from the current base, run queued for whoever created it. Anything else, or a
 * second call, changes nothing, so the outbox can deliver it any number of times.
 */
export const released = (
  glob: Glob,
  ctx: Context,
  relations: RelationFacts = NO_RELATIONS,
  /** Overlaps found when checking again just before starting: another glob may have taken the exclusive paths meanwhile. */
  newHolds: readonly ImpliedAfter[] = [],
): Result<Transition> => {
  if (glob.waiting == null || glob.status !== 'planning' || glob.type === 'super')
    return unchanged(glob);
  // A Start waiting for an investigation is released when that run ends, not by what the glob starts after.
  if (startQueued(glob)) return unchanged(glob);
  if (awaitedOf(relations).length > 0) return unchanged(glob);
  return new Builder(glob, ctx)
    .set({
      waiting: null,
      ...(newHolds.length === 0 ? {} : { impliedAfter: mergeImplied(glob.impliedAfter, newHolds) }),
    })
    .event('Released', { after: startIds(relations.relations) })
    .status('implementing')
    .queueRun(glob.creator)
    .done();
};

/** Sames and supers are started, retried and picked up by developers and admins; QA and PO members only do that for subs. */
const restrictedFrom = (actor: Actor, glob: Glob): boolean =>
  (actor.role === 'qa' || actor.role === 'po') && glob.type !== 'sub';

export interface PickUpOptions {
  readonly takeOver: boolean;
  /** Chosen at pick-up: must exist on the board and allow branch deploys. */
  readonly environment?: string | null;
  /** The glob's relations: picking up a held glob works, and notes what hadn't merged. */
  readonly relations?: RelationFacts;
}

/** Rows 6–10: pick up, optionally taking over a routine run, optionally choosing the environment. */
export const pickUp = (
  glob: Glob,
  ctx: Context,
  board: Board,
  options: PickUpOptions,
): Result<Transition> => {
  if (glob.category === 'decision') return pickUpDecision(glob, ctx);
  const actor = requireActor(ctx);
  // An action has no branch, run or implementer: it is only ever done or dismissed.
  if (glob.category === 'action') return invalidTransition(glob, actor, 'An action is not picked up: mark it done or dismiss it');
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
    (!hasLiveRun(glob) || liveInvestigation(glob) !== null)
  ) {
    if (!environmentChanged) return unchanged(glob);
    return setEnvironment(new Builder(glob, ctx), environment).done();
  }

  // A queued or standby run holds nothing unpushed, so picking up supersedes it without a flag; an active one needs takeOver.
  const run = currentRun(glob);
  const idleRun =
    run !== null &&
    run.state !== 'active' &&
    run.state !== 'ended' &&
    glob.type !== 'super' &&
    (glob.status === 'implementing' || glob.status === 'pr_open' || glob.status === 'failed');
  if (options.takeOver || idleRun) {
    // Row 10.
    if (!hasLiveRun(glob) || glob.type === 'super') {
      return invalidTransition(glob, actor, 'There is no routine run to pick up from');
    }
    if (glob.status !== 'implementing' && glob.status !== 'pr_open' && glob.status !== 'failed') {
      return invalidTransition(glob, actor, 'Pick up applies to implementing, pr_open or failed globs');
    }
    const b = new Builder(glob, ctx)
      .endRun('superseded', null, { cause: 'take_over' })
      .bumpGeneration()
      .set({ implementer: actor.email })
      .event('PickedUp', { takeOver: true });
    // A failed glob is the person's to fix now, as when a failed glob is picked up (row 6).
    if (glob.status === 'failed') b.set({ failure: null });
    if (glob.status === 'implementing' || glob.status === 'failed') b.status('in_progress');
    if (environmentChanged) setEnvironment(b, environment);
    return b.done();
  }

  if (hasBusyRun(glob)) {
    return runActive('The machine is mid-run; unpushed work will be lost. Take over to supersede it');
  }

  const b = new Builder(glob, ctx);
  switch (glob.status) {
    case 'planning':
    case 'failed':
      // Row 6. A live investigation keeps going: its result shapes the work, and the local session waits for it.
      if (liveInvestigation(glob) === null) b.endRun('superseded', null, { cause: 'pick_up' });
      b.set({
        implementer: actor.email,
        failure: null,
        ...(glob.waiting == null ? {} : { waiting: null }),
      }).status('in_progress');
      break;
    case 'pr_open':
    case 'in_progress':
      // Rows 7 and 9.
      if (liveInvestigation(glob) === null) b.endRun('superseded', null, { cause: 'pick_up' });
      b.set({ implementer: actor.email });
      break;
    default:
      return invalidTransition(glob, actor, `A glob in ${glob.status} cannot be picked up`);
  }
  // A person may go ahead on a glob that still waits; the event records what hadn't merged.
  const unmerged =
    glob.status === 'planning' ? awaitedOf(options.relations ?? NO_RELATIONS) : [];
  b.event('PickedUp', {
    takeOver: false,
    ...(unmerged.length > 0 && { waitingFor: unmerged.map((a) => a.id) }),
  });
  if (environmentChanged) setEnvironment(b, environment);
  return b.done();
};

/** Records an environment chosen at pick-up as a field change, and relabels the PR (`env:<name>`). */
const setEnvironment = (b: Builder, environment: string | null): Builder => {
  const glob = b.current;
  b.set({ environment }).event('FieldsChanged', {
    environment: { from: glob.environment, to: environment },
  });
  if (glob.pr !== null)
    b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  return b;
};

/** Whether the glob's PR was left by an ended auto-fix run: ready for review, a failure on the card, nobody working on it. */
const canRetryAutofix = (glob: Glob): boolean => {
  const run = currentRun(glob);
  if (
    glob.status !== 'pr_open' ||
    glob.type === 'super' ||
    glob.implementer !== null ||
    glob.pr === null
  )
    return false;
  // Failed checks of this glob's own change with nothing watching them: always fixable, whatever ended the earlier run.
  if (
    glob.pr.state === 'ready' &&
    glob.conflict == null &&
    headChecksFailed(glob) &&
    glob.headChecks?.inheritedFrom === undefined
  )
    return true;
  return (
    glob.failure !== null &&
    glob.failure.kind === undefined &&
    run?.state === 'ended' &&
    run.outcome === 'failed' &&
    run.purpose !== 'resolve_conflict'
  );
};

/** Row 25a: Retry auto-fix. A new routine run watches the same PR on the same branch; the failure clears. */
export const retryAutofix = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
  if (!canRetryAutofix(glob))
    return invalidTransition(glob, actor, 'Only a ready PR whose auto-fix ended can retry it');
  return new Builder(glob, ctx).set({ failure: null }).queueRun(actor.email).done();
};

/** Row 20: retry a failed sub or same on its existing branch. */
export const retrigger = (
  glob: Glob,
  ctx: Context,
  relations: RelationFacts = NO_RELATIONS,
  anyway = false,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status !== 'failed' || glob.type === 'super') {
    return invalidTransition(glob, actor, 'Only a failed sub or same can be retried');
  }
  if (restrictedFrom(actor, glob)) return forbidden(`QA and PO members cannot retry ${glob.type}s`);
  if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
  const awaited = awaitedOf(relations);
  if (awaited.length > 0 && !anyway) return invalidTransition(glob, actor, refusalText(awaited));
  return new Builder(glob, ctx)
    .bumpGeneration()
    .set({ implementer: null, failure: null })
    .effect({ kind: 'reopen_pr', globId: glob.id, generation: glob.generation + 1 })
    .status('implementing')
    .queueRun(actor.email, undefined, !anyway)
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

/**
 * A conflict a routine run could fix: nobody implements the glob and no run is queued or working on it. A watching run
 * doesn't count as working: Resolve conflict ends it and starts the fix. Allowed again after a failed attempt.
 */
const canRequestConflictFix = (glob: Glob): boolean =>
  glob.type !== 'super' &&
  glob.implementer === null &&
  !hasWorkingRun(glob) &&
  !hasConflictFixRun(glob) &&
  ((hasOpenPr(glob) && glob.conflict != null) ||
    (glob.status === 'failed' &&
      glob.failure?.conflict !== undefined &&
      glob.pr?.state === 'ready'));

/**
 * A base-branch merge happened: recheck this glob's open PR for a conflict with it. The recheck runs through the
 * outbox because GitHub computes mergeability in the background.
 */
export const baseMerged = (
  glob: Glob,
  merge: { since: string },
  ctx: Context,
): Result<Transition> => {
  if (glob.id === merge.since || !hasOpenPr(glob)) return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({
      kind: 'check_conflict',
      globId: glob.id,
      generation: glob.generation,
      since: merge.since,
    })
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
  const b = new Builder(glob, ctx)
    .set({ conflict })
    .event('ConflictFlagged', { base: found.base, files: [...found.files], since: found.since });
  // A conflicted PR runs no checks: an armed merge would wait for ever.
  if (isMergeArmed(glob)) b.set({ mergeMode: null }).event('MergeDisarmed', { reason: 'conflict' });
  return b.done();
};

/** Whether the glob is in Doing with an open PR: the globs whose distance from the base branch is worth showing. */
const isDoingWithPr = (glob: Glob): boolean => glob.status === 'in_progress' && hasOpenPr(glob);

/** The base branch or the glob's branch received a push: read again how far the branch is behind the base. */
export const behindCheckRequested = (glob: Glob, ctx: Context): Result<Transition> => {
  if (!isDoingWithPr(glob)) return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({ kind: 'check_behind', globId: glob.id, generation: glob.generation })
    .done();
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
    return new Builder(glob, ctx)
      .set({ behind: null })
      .event('BehindChanged', { base: found.base, behindBy: 0 })
      .done();
  }
  if (
    before?.base === found.base &&
    before.behindBy === found.behindBy &&
    before.files.join('\n') === found.files.join('\n')
  ) {
    return unchanged(glob);
  }
  const behind: BehindBase = {
    base: found.base,
    behindBy: found.behindBy,
    files: [...found.files],
    at: ctx.now,
  };
  return new Builder(glob, ctx)
    .set({ behind })
    .event('BehindChanged', { base: found.base, behindBy: found.behindBy, files: [...found.files] })
    .done();
};

/**
 * A same or sub in Doing whose PR is already ready for review (picked up to fix a conflict or failed checks): once its
 * pushed head has no conflict, nothing else brings it back to pr_open, so the machine does.
 */
const backToReview = (glob: Glob): boolean =>
  glob.status === 'in_progress' &&
  glob.type !== 'super' &&
  glob.pr?.state === 'ready' &&
  !hasLiveRun(glob);

/** Returns a Doing glob with a ready PR to pr_open: its head's checks are read and a same is reviewed again. */
const returnToReview = (b: Builder, sha: string): Builder => {
  const glob = b.current;
  b.set({ headChecks: null })
    .event('ReturnedToReview', { sha })
    .status('pr_open')
    .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
  if (glob.type !== 'sub')
    b.effect({
      kind: 'review_change',
      globId: glob.id,
      generation: glob.generation,
      stage: 'pre_merge',
      sha,
    });
  return b;
};

/**
 * The open PR no longer conflicts with the base branch. The event records what was resolved (files, the causing glob)
 * and how: `by` is the conflict-fix run when the glob's latest run is a resolve_conflict run that is still live or
 * completed, else a person; `kind` is what the code host could tell about the resolution (`unknown` when it could not).
 */
export const conflictCleared = (
  glob: Glob,
  ctx: Context,
  kind: ConflictKind = 'unknown',
): Result<Transition> => {
  if (glob.conflict == null) return unchanged(glob);
  const run = currentRun(glob);
  const by: ConflictResolvedBy =
    run?.purpose === 'resolve_conflict' && (run.state !== 'ended' || run.outcome === 'completed') ? 'run' : 'human';
  const b = new Builder(glob, ctx).set({ conflict: null }).event('ConflictCleared', {
    base: glob.conflict.base,
    files: [...glob.conflict.files],
    since: glob.conflict.since,
    by,
    kind,
  });
  // The fix is pushed and nothing is left for the run: it now watches the PR's checks like any run on a ready PR.
  if (run?.purpose === 'resolve_conflict' && run.state === 'active' && glob.status === 'pr_open')
    b.updateRun({ state: 'watching', lastProgressAt: ctx.now });
  if (backToReview(glob) && glob.pr?.headSha != null) returnToReview(b, glob.pr.headSha);
  return b.done();
};

/**
 * Resolve conflict (rows 16 and 20a): a conflicting PR nobody is implementing gets a routine run that merges the base
 * branch in, resolves the conflicts and pushes (the Claude GitHub App's workflow can't run git). A run on standby is
 * ended and replaced; a failed attempt can be tried again. A glob failed by a merge conflict goes back to review with
 * the conflict flagged. A human implementer resolves locally (`sstor --glob <id>`).
 */
export const resolveConflict = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (restrictedFrom(actor, glob)) {
    return forbidden(`QA and PO members cannot resolve conflicts on ${glob.type}s`);
  }
  if (glob.implementer !== null) {
    return invalidTransition(
      glob,
      actor,
      'A glob with a human implementer resolves its conflict locally',
    );
  }
  if (hasWorkingRun(glob) || hasConflictFixRun(glob)) {
    return runActive('Already fixing the conflict: the run merges the latest base branch');
  }
  if (!canRequestConflictFix(glob)) {
    return invalidTransition(
      glob,
      actor,
      'Only a glob whose PR conflicts with the base branch can resolve it',
    );
  }
  const b = new Builder(glob, ctx);
  const failed = glob.status === 'failed' ? glob.failure?.conflict : undefined;
  if (failed !== undefined) {
    // The failed merge left a ready PR: return it to review while the conflict is fixed.
    b.set({ failure: null, headChecks: null, conflict: { ...failed, since: null, at: ctx.now } })
      .status('pr_open')
      .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
  } else {
    b.set({ failure: null });
  }
  return b
    .event('ConflictFixRequested', { base: (failed ?? glob.conflict)?.base ?? null })
    .endRun('superseded', null, { cause: 'resolve_conflict' })
    .queueRun(actor.email, undefined, false, 'resolve_conflict')
    .done();
};

/** Row 23: return the glob to its starting status with a fresh branch and PR. */
export const startAgain = (
  glob: Glob,
  ctx: Context,
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status === 'reviewing' || glob.status === 'signed_off') {
    return invalidTransition(glob, actor, 'A merged glob cannot be started again');
  }
  if (restrictedFrom(actor, glob)) {
    return forbidden(`QA and PO members cannot start ${glob.type}s again`);
  }
  const b = new Builder(glob, ctx)
    .endRun('superseded', null, { cause: 'start_again' })
    .bumpGeneration();
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
  const awaited = glob.type === 'sub' ? awaitedOf(relations) : [];
  if (awaited.length > 0) {
    b.set({ waiting: { since: ctx.now } })
      .status('planning')
      .event('Waiting', { for: awaited.map((a) => a.id), note: waitSummary(awaited) });
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

/** "Merge when checks pass" is armed: the human step is done and slop merges once the head's checks pass. */
export const isMergeArmed = (glob: Glob): boolean => glob.status === 'pr_open' && glob.mergeMode === 'when_green';

const headChecksPassed = (glob: Glob): boolean =>
  glob.pr?.headSha != null && glob.headChecks?.sha === glob.pr.headSha && glob.headChecks.state === 'passed';

const headChecksFailed = (glob: Glob): boolean =>
  glob.pr?.headSha != null && glob.headChecks?.sha === glob.pr.headSha && glob.headChecks.state === 'failed';

/** The unmet `merge` relations of a glob, where its relations were loaded (none otherwise). */
const mergeGate = (relations: RelationFacts | undefined): Unmet[] => (relations === undefined ? [] : unmet(relations, 'merge'));

/** "Can't merge until s15f82 is merged": what the unmet relations of a gate say, for a refusal. */
const gateText = (held: readonly Unmet[]): string => {
  const text = held.map((u) => holdWords(u.relation)).join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};

/** Why Merge can't be pressed on a ready same or super right now (not armed, no conflict, checks not failed), or null. */
const mergeBlocker = (glob: Glob, relations?: RelationFacts): string | null => {
  if (glob.status !== 'pr_open' || glob.type === 'sub')
    return 'Only a same or super with a ready PR can be merged';
  if (glob.mergeMode === 'when_green') return 'Merge is already waiting for the checks to pass';
  const held = mergeGate(relations);
  if (held.length > 0) return gateText(held);
  // Passing checks say nothing about mergeability once the base has moved: GitHub would refuse and fail the glob.
  if (glob.conflict != null)
    return `Conflicts with the base branch since ${glob.conflict.since ?? 'the last push'}: merge the base into the branch and push before merging`;
  if (glob.pr?.headSha == null) return 'The PR has no head yet';
  if (headChecksFailed(glob)) return 'Required checks failed on the current head';
  return null;
};

/**
 * Rows 14 and 31: the Merge (or Merge and continue) button on a same or super. With the head's checks passed it merges
 * now; with them pending or not reported yet it arms "merge when checks pass" instead (a hand-off to slop), updating a
 * branch that is behind its base so the checks run on what will merge. Merge and continue waits for passed checks.
 */
export const requestMerge = (
  glob: Glob,
  ctx: Context,
  options: MergeOptions = { continue: false },
): Result<Transition> => {
  const actor = requireActor(ctx);
  const blocked = mergeBlocker(glob, options.facts?.relations);
  if (blocked !== null) return invalidTransition(glob, actor, blocked);
  const head = glob.pr?.headSha ?? '';
  const passed = headChecksPassed(glob);
  if (options.continue) {
    if (glob.type !== 'super')
      return invalidTransition(glob, actor, 'Only a super can merge and continue');
    if (!passed) return invalidTransition(glob, actor, 'Required checks have not passed on the current head');
    if (!recordAtHead(glob, options.facts ?? {}))
      return invalidTransition(glob, actor, RECORD_NOT_AT_HEAD);
  }
  if (!passed) {
    const b = new Builder(glob, ctx)
      .set({ mergeMode: 'when_green' })
      .event('MergeArmed', { sha: head });
    // A branch behind its base is updated by the merge itself (squash_merge), once the checks pass.
    // Nothing reported for this head yet (a lost webhook): read it now, so a settled result isn't waited for in vain.
    if (glob.headChecks?.sha !== head)
      b.effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
    return b.done();
  }
  return new Builder(glob, ctx)
    .set({ mergeMode: options.continue ? 'continue' : null })
    .status('merging', options.continue ? { mode: 'continue' } : {})
    .effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha: head })
    .done();
};

/** Cancel merge: disarms "merge when checks pass". */
export const cancelMerge = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (!isMergeArmed(glob)) return invalidTransition(glob, actor, 'Merge is not waiting for checks');
  return new Builder(glob, ctx)
    .set({ mergeMode: null, ...(glob.mergeHold == null ? {} : { mergeHold: null }) })
    .event('MergeDisarmed', { reason: 'cancelled' })
    .done();
};

/** A failed merge slop can try again without a new run or push: no conflict, the PR is ready and its head passed. */
const canRetryMerge = (glob: Glob): boolean =>
  glob.status === 'failed' &&
  glob.failure?.kind === 'merge' &&
  glob.failure.conflict === undefined &&
  glob.pr?.state === 'ready' &&
  glob.pr.headSha != null &&
  glob.headChecks?.sha === glob.pr.headSha &&
  glob.headChecks.state === 'passed';

/** Retry merge: a glob whose merge failed (e.g. GitHub hadn't decided mergeability) goes back to merging. */
export const retryMerge = (glob: Glob, ctx: Context, relations?: RelationFacts): Result<Transition> => {
  const actor = requireActor(ctx);
  if (!canRetryMerge(glob))
    return invalidTransition(
      glob,
      actor,
      'Only a failed merge on a ready PR with passing checks can be retried',
    );
  const held = mergeGate(relations);
  if (held.length > 0) return invalidTransition(glob, actor, gateText(held));
  return new Builder(glob, ctx)
    .set({ failure: null, mergeMode: null })
    .status('merging', { retry: true })
    .effect({
      kind: 'squash_merge',
      globId: glob.id,
      generation: glob.generation,
      sha: glob.pr?.headSha ?? '',
    })
    .done();
};

/** Row 24: delete the glob and everything it owns. */
export const remove = (glob: Glob, ctx: Context): Result<Transition> => {
  // A decision may govern work, so only an admin or PO deletes one (a person; the system never does).
  if (glob.category === 'decision' && ctx.actor !== null && !mayDecide(ctx.actor)) {
    return forbidden('Only an admin or PO can delete a decision');
  }
  return removeGlob(glob, ctx);
};

const removeGlob = (glob: Glob, ctx: Context): Result<Transition> =>
  new Builder(glob, ctx)
    .endRun('superseded', null, { cause: 'deleted' })
    .event('GlobDeleted', { status: glob.status })
    .effect({
      kind: 'delete_glob_data',
      globId: glob.id,
      boardId: glob.boardId,
      prNumber: glob.pr?.number ?? null,
    })
    .done();

/** What a reviewer or developer does to one sign-off label (rows 21, 22 and 27–30). */
export type LabelCommand =
  /** Reviewer: ask for changes on a required label. */
  | { readonly kind: 'submit_items'; readonly items: readonly string[] }
  /** Reviewer: keep an item as an unsent draft (a new one, or the text of the draft `itemId`) while the label is required. */
  | { readonly kind: 'save_draft_item'; readonly text: string; readonly itemId?: string }
  /** Reviewer: drop one unsent draft. */
  | { readonly kind: 'remove_draft_item'; readonly itemId: string }
  /** Reviewer: send the drafts as items (label required → added). */
  | { readonly kind: 'send_items' }
  /** Reviewer: satisfied, with or without items. Unsent drafts are discarded. */
  | { readonly kind: 'approve' }
  /** Developer: tick or untick an item while the label has items added. */
  | { readonly kind: 'tick'; readonly itemId: string; readonly done: boolean }
  /** Developer: send the label back to its reviewer, even with items unticked. */
  | { readonly kind: 'resubmit' }
  /** Re-open an approved label's review. */
  | { readonly kind: 'reopen' };

export const MAX_CHECKLIST_ITEMS = 100;
export const MAX_CHECKLIST_ITEM_LENGTH = 2000;

const isDraft = (item: ChecklistItem): boolean => item.draft === true;
/** Unticked sent items: drafts are not part of the review yet. */
const openItems = (items: readonly ChecklistItem[]): number => items.filter((i) => !i.done && !isDraft(i)).length;
/** Drafts can be removed, so the next id follows the highest one rather than the count. */
const nextItemId = (items: readonly ChecklistItem[]): number =>
  items.reduce((max, i) => Math.max(max, Number(i.id) || 0), 0) + 1;
/** The drafts as sent items. */
const sent = (items: readonly ChecklistItem[]): ChecklistItem[] =>
  items.map((i) => {
    const { draft, ...rest } = i;
    return draft === true ? rest : i;
  });

/**
 * Rows 21, 22 and 27–30: sign-off labels and their review checklists. Who may act is not
 * restricted yet (anyone on the board); the event log records who did what.
 */
export const reviewLabel = (
  glob: Glob,
  name: LabelName,
  command: LabelCommand,
  ctx: Context,
  /** Work steps holding back sign-off: a merged glob's labels can't be approved until they are done (QA checks the change as rolled out). */
  rollout: BlockProgress | null = null,
  /** The glob's relations: labels stay approvable while a `sign_off` relation is unmet, but the glob doesn't move to Signed off. */
  relations?: RelationFacts,
): Result<Transition> => {
  const actor = requireActor(ctx);
  const from = glob.labels[name];
  if (from === undefined) {
    return invalidTransition(glob, actor, `${name} is not required on this glob`);
  }
  const items = glob.checklists[name] ?? [];
  const setState = (
    to: LabelState,
    detail: { readonly [key: string]: JsonValue } = {},
  ): Builder => {
    const labels: Labels = { ...glob.labels, [name]: to };
    const b = new Builder(glob, ctx)
      .set({ labels })
      .event('LabelChanged', { ...detail, label: name, from, to });
    const allApproved = Object.values(labels).every((s) => s === 'approved');
    const signOffHeld = relations === undefined ? [] : unmet(relations, 'sign_off');
    if (glob.status === 'reviewing' && allApproved && (rollout === null || rollout.open === 0)) {
      if (signOffHeld.length > 0) b.event('SignOffHeld', { for: signOffHeld.map((u) => u.relation.to) });
      else releaseWaiting(b.set({ signedOffAt: ctx.now }).status('signed_off'), glob);
    } else if (glob.status === 'signed_off' && !allApproved) {
      b.set({ signedOffAt: null }).status('reviewing');
    }
    return b;
  };

  switch (command.kind) {
    case 'submit_items': {
      // Row 27.
      if (from !== 'required') {
        return invalidTransition(
          glob,
          actor,
          `Items can only be added while ${name} waits for its reviewer`,
        );
      }
      const texts = command.items.map((t) => t.trim()).filter((t) => t !== '');
      const drafts = items.filter(isDraft);
      if (texts.length === 0 && drafts.length === 0) return invalidInput('Add at least one item');
      if (texts.some((t) => t.length > MAX_CHECKLIST_ITEM_LENGTH)) {
        return invalidInput(`Items are limited to ${MAX_CHECKLIST_ITEM_LENGTH} characters`);
      }
      if (items.length + texts.length > MAX_CHECKLIST_ITEMS) {
        return invalidInput(`A label holds at most ${MAX_CHECKLIST_ITEMS} items`);
      }
      const first = nextItemId(items);
      const added: ChecklistItem[] = texts.map((text, i) => ({
        id: String(first + i),
        text,
        done: false,
        addedBy: actor.email,
        addedAt: ctx.now,
        doneBy: null,
        doneAt: null,
      }));
      return setState('added', { items: [...drafts.map((d) => d.text), ...texts] })
        .set({ checklists: { ...glob.checklists, [name]: [...sent(items), ...added] } })
        .done();
    }
    case 'save_draft_item': {
      // Drafts change no label state and raise no event: the version bump alone refreshes open boards.
      if (from !== 'required') {
        return invalidTransition(glob, actor, `Draft items can only be saved while ${name} waits for its reviewer`);
      }
      const text = command.text.trim();
      if (text === '') return invalidInput('Add some text to the item');
      if (text.length > MAX_CHECKLIST_ITEM_LENGTH) {
        return invalidInput(`Items are limited to ${MAX_CHECKLIST_ITEM_LENGTH} characters`);
      }
      if (command.itemId !== undefined) {
        const draft = items.find((i) => i.id === command.itemId && isDraft(i));
        if (draft === undefined) return invalidInput(`No draft item ${command.itemId} on ${name}`);
        if (draft.text === text) return unchanged(glob);
        return new Builder(glob, ctx)
          .set({ checklists: { ...glob.checklists, [name]: items.map((i) => (i === draft ? { ...draft, text } : i)) } })
          .done();
      }
      if (items.length >= MAX_CHECKLIST_ITEMS) {
        return invalidInput(`A label holds at most ${MAX_CHECKLIST_ITEMS} items`);
      }
      const created: ChecklistItem = {
        id: String(nextItemId(items)),
        text,
        done: false,
        addedBy: actor.email,
        addedAt: ctx.now,
        doneBy: null,
        doneAt: null,
        draft: true,
      };
      return new Builder(glob, ctx)
        .set({ checklists: { ...glob.checklists, [name]: [...items, created] } })
        .done();
    }
    case 'remove_draft_item': {
      if (from !== 'required') {
        return invalidTransition(glob, actor, `Draft items can only be removed while ${name} waits for its reviewer`);
      }
      if (!items.some((i) => i.id === command.itemId && isDraft(i))) {
        return invalidInput(`No draft item ${command.itemId} on ${name}`);
      }
      return new Builder(glob, ctx)
        .set({ checklists: { ...glob.checklists, [name]: items.filter((i) => i.id !== command.itemId) } })
        .done();
    }
    case 'send_items': {
      if (from !== 'required') {
        return invalidTransition(glob, actor, `Items can only be sent while ${name} waits for its reviewer`);
      }
      const drafts = items.filter(isDraft);
      if (drafts.length === 0) return invalidInput('Add at least one item');
      return setState('added', { items: drafts.map((d) => d.text) })
        .set({ checklists: { ...glob.checklists, [name]: sent(items) } })
        .done();
    }
    case 'approve':
      // Row 28 (and row 21 when it is the last label).
      if (from === 'approved') return unchanged(glob);
      if (glob.status === 'reviewing' && rollout !== null && rollout.open > 0) return invalidTransition(glob, actor, rolloutPending(rollout));
      {
        const b = setState('approved', { open: openItems(items) });
        // Unsent drafts never became part of the review.
        if (items.some(isDraft)) {
          b.set({ checklists: { ...glob.checklists, [name]: items.filter((i) => !isDraft(i)) } });
        }
        return b.done();
      }
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
        .set({
          checklists: {
            ...glob.checklists,
            [name]: items.map((i) => (i.id === item.id ? ticked : i)),
          },
        })
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
      if (from !== 'approved')
        return invalidTransition(glob, actor, 'Only an approved label can be re-opened');
      return setState('required').done();
  }
};

export interface FieldChanges {
  readonly title?: string;
  readonly type?: SlopType;
  readonly category?: Category;
  readonly group?: string | null;
  readonly environment?: string | null;
  /**
   * The globs this one starts after, from and to, when a person changed them: set by the service, which writes the relations
   * (already checked) and passes their facts. Editable while the glob has no branch.
   */
  readonly after?: { readonly from: readonly string[]; readonly to: readonly string[] };
  /** Overlaps predicted for a same becoming a sub (set by the service, not by clients). */
  readonly impliedAfter?: readonly ImpliedAfter[];
  /** A decision's scope (the only attribute a client edits); checked by `changeFields`. */
  readonly attributes?: unknown;
}

/** Changing fields is not a transition, except same → sub from planning (row 26). */
export const changeFields = (
  glob: Glob,
  changes: FieldChanges,
  board: Board,
  ctx: Context,
  /** The glob's relations as they will be once the change is written (the service has checked and planned them). */
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (
    changes.category !== undefined &&
    changes.category !== glob.category &&
    (isHumanCategory(changes.category) || isHumanCategory(glob.category))
  ) {
    return invalidCombination('A glob cannot move into or out of human work, nor between a decision and an action');
  }
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

  const typeCheck = type === null ? ok(null) : checkTypeChange(glob, type, actor);
  if (!typeCheck.ok) return typeCheck;
  const scope =
    changes.attributes === undefined || glob.category === 'action'
      ? ok(null)
      : scopeEdit(glob, changes.attributes, actor);
  if (!scope.ok) return scope;
  const assignee =
    changes.attributes === undefined || glob.category !== 'action'
      ? ok(undefined)
      : assigneeEdit(glob, changes.attributes);
  if (!assignee.ok) return assignee;

  // A set, not a list: stores return the start relations in different orders, so an echoed `after` must not read as an edit.
  const asSet = (ids: readonly string[]): string => [...new Set(ids)].sort().join('\n');
  const afterChanged = changes.after !== undefined && asSet(changes.after.to) !== asSet(changes.after.from);
  if (afterChanged && (glob.status !== 'planning' || glob.provisioning !== 'none')) {
    return invalidTransition(
      glob,
      actor,
      'What a glob waits for can only be changed before the glob has started',
    );
  }

  const patch: { -readonly [K in keyof Omit<FieldChanges, 'attributes' | 'after'>]: FieldChanges[K] } = {};
  const diff: { [key: string]: JsonValue } = {};
  for (const key of ['title', 'type', 'category', 'group', 'environment'] as const) {
    const value = key === 'title' ? changes.title?.trim() : changes[key];
    if (value !== undefined && value !== glob[key]) {
      Object.assign(patch, { [key]: value });
      diff[key] = { from: glob[key], to: value };
    }
  }
  if (changes.after !== undefined && afterChanged) {
    diff['after'] = { from: [...changes.after.from], to: [...changes.after.to] };
  }
  let attributes: Partial<Glob> = {};
  if (scope.value !== null) {
    attributes = { attributes: { ...decisionAttributesOf(glob), scope: scope.value } };
    diff['attributes'] = {
      scope: { from: scopeJson(decisionAttributesOf(glob).scope), to: scopeJson(scope.value) },
    };
  }
  if (assignee.value !== undefined) {
    attributes = { attributes: { ...actionAttributesOf(glob), assignee: assignee.value } };
    diff['attributes'] = { assignee: { from: actionAttributesOf(glob).assignee, to: assignee.value } };
  }
  if (Object.keys(diff).length === 0) return unchanged(glob);

  const b = new Builder(glob, ctx).set({ ...patch, ...attributes }).event('FieldsChanged', diff);
  if (('type' in diff || 'environment' in diff) && glob.pr !== null) {
    b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  }
  // A same becoming a sub starts, unless something it starts after hasn't merged; a held glob whose waiting list was
  // edited down to nothing starts too. A held sub turned into a same is no longer asked to start by itself.
  const becomesSub = (glob.type === 'same' || glob.type === 'super') && type === 'sub';
  const wasHeld =
    glob.waiting != null &&
    glob.status === 'planning' &&
    glob.type !== 'super' &&
    type !== 'super';
  // A glob parked as a super doesn't wait for anything: a person picks it up.
  if (type === 'super' && glob.waiting != null) b.set({ waiting: null });
  if (wasHeld && glob.type === 'sub' && type === 'same') b.set({ waiting: null });
  else if (becomesSub || wasHeld) {
    const impliedAfter = becomesSub
      ? mergeImplied(glob.impliedAfter, changes.impliedAfter ?? [])
      : glob.impliedAfter;
    const awaited = awaitedOf(relations);
    if (awaited.length > 0) {
      if (!wasHeld) {
        b.set({
          waiting: { since: ctx.now },
          ...(impliedAfter === undefined ? {} : { impliedAfter }),
        }).event('Waiting', { for: awaited.map((a) => a.id), note: waitSummary(awaited) });
      }
    } else if (wasHeld) {
      b.set({ waiting: null })
        .event('Released', { after: [] })
        .status('implementing')
        .queueRun(glob.creator);
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
  // A sub and a super swap only while parked in Planning with no run.
  if ((from === 'sub' && to === 'super') || (from === 'super' && to === 'sub')) {
    if (glob.status !== 'planning' || hasLiveRun(glob) || glob.implementer !== null) {
      return invalidTransition(
        glob,
        actor,
        'A sub and a super can only be swapped while in planning with no run and nobody implementing',
      );
    }
    if (to === 'super' && (actor.role === 'qa' || actor.role === 'po')) {
      return forbidden('QA and PO members cannot create supers');
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

/** A type change the glob view may offer. */
export interface TypeChangeOption {
  readonly to: SlopType;
}

/** The type changes `changeFields` would accept now, so the glob view never offers one the server refuses. */
export const allowedTypeChanges = (glob: Glob, role: Role): TypeChangeOption[] =>
  SLOP_TYPES.flatMap((to): TypeChangeOption[] => {
    if (to === glob.type || !checkTypeChange(glob, to, { email: '', role }).ok) return [];
    return isValidCombination(to, glob.category) ? [{ to }] : [];
  });

// ---------------------------------------------------------------------------
// Events from integrations and routines

/**
 * Draft PRs are recorded without changing status. Recording the glob's current PR again is a no-op
 * (slop's own open response and the `opened` event both report it).
 */
export const prOpened = (
  glob: Glob,
  pr: { number: number; headSha: string | null },
  ctx: Context,
): Result<Transition> => {
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
    .set({
      provisioning: 'ok',
      ...(glob.failure?.kind === 'provisioning' ? { failure: null } : {}),
    })
    .event('BranchCreated', { ok: true, branch: result.branch });
  if (result.pr !== null) {
    b.set({ pr: { number: result.pr.number, state: 'draft', headSha: result.pr.headSha } }).event(
      'PROpened',
      {
        number: result.pr.number,
      },
    );
  }
  return b.done();
};

/**
 * Provisioning failed. A retryable failure only records the attempt; one that won't be retried (`final`: a 404 or 403
 * from the code host, or the last attempt) puts the reason on the glob and ends its queued run with it, so the card
 * and glob view say why and nothing keeps waiting for a branch that will not come.
 */
export const provisioningFailed = (
  glob: Glob,
  reason: string,
  ctx: Context,
  final = false,
): Result<Transition> => {
  const b = new Builder(glob, ctx)
    .set({ provisioning: 'failed' })
    .event('BranchCreated', { ok: false, reason });
  if (!final) return b.done();
  if (currentRun(glob)?.state === 'queued') b.endRun('failed', reason);
  b.set({ failure: { reason, at: ctx.now, kind: 'provisioning' } });
  if (glob.status === 'implementing') b.status('failed');
  return b.done();
};

const isStartPush = (glob: Glob, push: { message?: string | null }): boolean =>
  push.message?.trim() === `${glob.id}: start`;

/** A push to the glob branch: records the new head; results for older commits stop counting. */
export const commitPushed = (
  glob: Glob,
  push: {
    sha: string;
    runId: string | null;
    message?: string | null;
    agentSetVersion?: number | null;
  },
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
    b.set({
      failure: null,
      headChecks: null,
      mergeMode: null,
      ...(glob.conflict == null ? {} : { conflict: null }),
    })
      .event('MergeFailureRecovered', { sha: push.sha, reason: glob.failure.reason })
      .status('pr_open')
      .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
  }
  const run = currentRun(glob);
  const superseded =
    push.runId !== null && (run === null || run.id !== push.runId || run.state === 'ended');
  if (!superseded && run !== null && run.state !== 'ended' && push.runId === run.id) {
    b.updateRun({ lastProgressAt: ctx.now, state: run.state === 'queued' ? 'active' : run.state });
  }
  // A new head is a different commit from the one the person armed the merge on: they press Merge again.
  if (isMergeArmed(glob)) b.set({ mergeMode: null }).event('MergeDisarmed', { reason: 'new push' });
  // A failed-checks run failure ("Auto-fix didn't respond …") is about the head that was red; a new head replaces it, so
  // the glob reads as waiting on the new head's checks instead of staying on Resume until it merges. Failures of another
  // kind (needs_pairing, merge, provisioning, reverted) are not about a head and stay.
  if (glob.status === 'pr_open' && glob.failure !== null && glob.failure.kind === undefined && GAVE_UP.test(glob.failure.reason)) {
    b.set({ failure: null });
  }
  if (!recovers && (glob.status === 'pr_open' || glob.status === 'merging')) {
    b.set({ headChecks: null }).effect({
      kind: 'refresh_checks',
      globId: glob.id,
      generation: glob.generation,
    });
  }
  // A push while the PR is ready (before the developer merges) is reviewed again; the older commit's review is cancelled.
  if (
    glob.type !== 'sub' &&
    glob.pr?.state === 'ready' &&
    (glob.status === 'pr_open' || recovers) &&
    !superseded &&
    !isStartPush(glob, push)
  ) {
    b.effect({
      kind: 'review_change',
      globId: glob.id,
      generation: glob.generation,
      stage: 'pre_merge',
      sha: push.sha,
    });
  }
  // A push may have fixed a flagged conflict (or not): look again.
  if (glob.conflict != null && glob.pr !== null) {
    b.effect({ kind: 'check_conflict', globId: glob.id, generation: glob.generation, since: null });
  }
  // Doing: look again at how far the branch is behind the base (the card warns before a conflict exists).
  if (glob.status === 'in_progress' && glob.pr !== null) {
    b.effect({ kind: 'check_behind', globId: glob.id, generation: glob.generation });
  }
  // A ready PR picked up into Doing and pushed with no conflict flagged goes back to review; a flagged one waits for the recheck.
  if (backToReview(glob) && glob.conflict == null && !superseded && !isStartPush(glob, push)) {
    returnToReview(b, push.sha);
  }
  // After Merge and continue the glob has no PR until the next push opens one, once there's new
  // work on the branch (main is merged back into it first, so the PR shows only the new work).
  if (glob.status === 'in_progress' && glob.pr === null && glob.provisioning === 'ok') {
    b.effect({ kind: 'open_pr', globId: glob.id, generation: glob.generation });
  }
  // Each push deploys exactly that commit to the glob's environment; not a superseded run's push,
  // nor the empty `<id>: start` commit slop creates the branch with.
  const isStart = isStartPush(glob, push);
  if (glob.environment !== null && !superseded && !isStart && listOf(glob.status) === 'doing') {
    b.effect({
      kind: 'request_deploy',
      globId: glob.id,
      generation: glob.generation,
      sha: push.sha,
    });
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
  if (before?.with === clash.with && before.paths.join('\n') === clash.paths.join('\n'))
    return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ clash: { with: clash.with, paths: [...clash.paths] } })
    .event('ClashChanged', { with: clash.with, paths: [...clash.paths] })
    .done();
};

/** Whether an edge is a prediction a recheck may replace: implied, not learned or explicit, not blocking, not overridden. */
export const isReplaceableOverlap = (edge: ImpliedAfter): boolean =>
  (edge.source ?? 'implied') === 'implied' &&
  (edge.kind ?? 'overlaps') === 'overlaps' &&
  edge.overridden !== true;

/**
 * A recheck of a glob's predicted overlaps: the replaceable ones become `edges` (the others are kept as they are), with an
 * event for each edge added or dropped and its reason. Nothing changes when the lists agree, so a repeat is a no-op.
 */
export const overlapsRechecked = (
  glob: Glob,
  result: {
    readonly edges: readonly ImpliedAfter[];
    readonly dropReasons: ReadonlyMap<string, string>;
  },
  ctx: Context,
  /** The globs this one starts after (their start relations): an overlap with one of them isn't recorded. */
  needs: readonly string[] = [],
): Result<Transition> => {
  if (listOf(glob.status) !== 'planning' && listOf(glob.status) !== 'doing') return unchanged(glob);
  const existing = glob.impliedAfter ?? [];
  const before = existing.filter(isReplaceableOverlap);
  const kept = existing.filter((e) => !isReplaceableOverlap(e));
  const edges = result.edges.filter(
    (e) => !kept.some((k) => k.id === e.id) && !needs.includes(e.id),
  );
  const same = (a: ImpliedAfter, b: ImpliedAfter) =>
    a.id === b.id && a.paths.join('\n') === b.paths.join('\n');
  const dropped = before.filter((b) => !edges.some((e) => e.id === b.id));
  const added = edges.filter((e) => !before.some((b) => b.id === e.id));
  const moved = edges.filter((e) => before.some((b) => b.id === e.id && !same(b, e)));
  if (dropped.length === 0 && added.length === 0 && moved.length === 0) return unchanged(glob);
  const b = new Builder(glob, ctx);
  const next = [...kept, ...edges];
  b.set({ impliedAfter: next });
  for (const edge of dropped)
    b.event('OverlapDropped', {
      with: edge.id,
      reason: result.dropReasons.get(edge.id) ?? 'it no longer changes an exclusive path',
    });
  for (const edge of added) b.event('OverlapAdded', { with: edge.id, paths: [...edge.paths] });
  return b.done();
};

/**
 * An inference of a glob's edges (plan saved, investigation pushed): the inferred edges become `edges`, the other recorded
 * ones are kept (see `mergeInferred`). Needs only count while the glob is in Planning; once it has started they are kept
 * as overlaps would be, so nothing blocks it. An event says what was added, dropped and which candidates were refused
 * (`notes`). Nothing changes when the lists agree, so a repeat is a no-op.
 */
export const edgesInferred = (
  glob: Glob,
  result: { readonly edges: readonly ImpliedAfter[]; readonly notes: readonly string[]; readonly planHash: string },
  ctx: Context,
  /** The globs this one starts after (their start relations): an inferred edge to one of them is dropped. */
  needs: readonly string[] = [],
): Result<Transition> => {
  if (listOf(glob.status) !== 'planning' && listOf(glob.status) !== 'doing') return unchanged(glob);
  if (glob.type === 'super') return unchanged(glob);
  const existing = glob.impliedAfter ?? [];
  const started = glob.status !== 'planning';
  const fresh = result.edges.map((e) => (started && e.kind === 'needs' ? { ...e, kind: 'overlaps' as const } : e));
  const next = mergeInferred(existing, fresh, needs, result.planHash);
  const before = existing.filter((e) => isReplaceableInferred(e, result.planHash));
  const after = next.filter((e) => isReplaceableInferred(e, result.planHash));
  // The reason is the model's wording and changes between answers: the edge is the same while its glob and kind are.
  const sig = (e: ImpliedAfter) => `${e.id}|${e.kind ?? 'overlaps'}`;
  const added = after.filter((e) => !before.some((b) => sig(b) === sig(e)));
  const dropped = before.filter((b) => !after.some((e) => e.id === b.id));
  if (added.length === 0 && dropped.length === 0) return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ impliedAfter: next })
    .event('EdgesInferred', {
      added: added.map((e) => ({ id: e.id, kind: e.kind ?? 'overlaps', reason: e.evidence ?? '' })),
      dropped: dropped.map((e) => e.id),
      notes: [...result.notes],
      planHash: result.planHash,
    })
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
    .updateRun({
      sessionId: fired.sessionId ?? run.sessionId,
      sessionUrl: fired.sessionUrl ?? run.sessionUrl,
    })
    .event('RunTriggered', {
      runId: run.id,
      fired: true,
      sessionUrl: fired.sessionUrl,
      ...(run.purpose === undefined ? {} : { purpose: run.purpose }),
    })
    .done();
};

const minutesSince = (from: string, now: string): number =>
  (Date.parse(now) - Date.parse(from)) / 60_000;

/** `2026-10-07 02:01 UTC`: a time in a failure reason. */
const queuedAtText = (at: string): string =>
  `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * A queued run whose cloud session exists but hasn't called slop within this many minutes of
 * being queued never reached slop (typically the Slop connector didn't attach). Shorter than the
 * board's `runStartMinutes`, which still covers runs whose session was never created.
 */
export const SESSION_NEVER_REACHED_SLOP_MINUTES = 5;

const SESSION_NEVER_REACHED_SLOP =
  "The run's session never reached slop (the Slop connector may not have attached). Discard & restart.";

/** How long a live run on a failed glob may go without progress before the run watch ends it. */
export const FAILED_RUN_QUIET_MINUTES = 30;

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
  // A conflict isn't a failing check: there is nothing for the watching run to react to.
  return glob.conflict == null &&
    glob.pr?.headSha != null &&
    checks?.sha === glob.pr.headSha &&
    checks.state === 'failed' &&
    checks.inheritedFrom === undefined
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
  board: Pick<
    Board,
    'runNoProgressHours' | 'runReadyHours' | 'runStartMinutes' | 'runRespondMinutes'
  >,
  now: string,
): string | null => {
  const run = currentRun(glob);
  if (run === null || run.state === 'ended') return null;
  // Queued runs have made no slop call yet: one that never starts (no session, a session that never called slop).
  if (run.state === 'queued') {
    const waited = minutesSince(run.queuedAt, now);
    if (run.sessionId !== null && waited >= SESSION_NEVER_REACHED_SLOP_MINUTES)
      return SESSION_NEVER_REACHED_SLOP;
    return waited >= board.runStartMinutes
      ? `Routine run never started (queued at ${queuedAtText(run.queuedAt)})`
      : null;
  }
  const hours = (from: string | null) =>
    from === null ? 0 : (Date.parse(now) - Date.parse(from)) / 3_600_000;
  const lastProgress = run.lastProgressAt ?? run.startedAt ?? run.queuedAt;
  // A run on a failed glob has nothing left to do and no way to be ended by anyone else: a quiet one is ended early.
  if (glob.status === 'failed') {
    return minutesSince(lastProgress, now) >= FAILED_RUN_QUIET_MINUTES
      ? `No progress for ${String(FAILED_RUN_QUIET_MINUTES)} minutes on a failed glob`
      : null;
  }
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
  // An investigate-only run never marks a PR ready.
  if (run.purpose !== undefined) return null;
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
      // A run retried on a ready PR watches it; there is no PR to mark ready. A conflict-fix run has work to do first, unless the conflict already cleared.
      state:
        run.state === 'queued'
          ? glob.status === 'pr_open' && (run.purpose !== 'resolve_conflict' || glob.conflict == null)
            ? 'watching'
            : 'active'
          : run.state,
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
    .set({
      pr: { number: pr.number, state: 'ready', headSha: pr.headSha },
      // An armed merge never outlives the ready PR it was pressed on.
      ...(glob.mergeMode === 'when_green' && { mergeMode: null }),
    })
    .event('PRReadyForReview', { number: pr.number, sha: pr.headSha });
  const run = currentRun(glob);
  if (run !== null && (run.state === 'active' || run.state === 'queued')) {
    b.updateRun({
      state: 'watching',
      lastProgressAt: ctx.now,
      startedAt: run.startedAt ?? ctx.now,
    });
  }
  b.status('pr_open').effect({
    kind: 'refresh_checks',
    globId: glob.id,
    generation: glob.generation,
  });
  // A sub doesn't wait for the PR's checks: the board's policy decides at once, and the checks run on the base after it merges.
  if (glob.type === 'sub')
    b.effect({
      kind: 'evaluate_sub_gate',
      globId: glob.id,
      generation: glob.generation,
      sha: pr.headSha,
    });
  // A same or super is reviewed as it would apply to the latest main; a sub is reviewed after it merges.
  else
    b.effect({
      kind: 'review_change',
      globId: glob.id,
      generation: glob.generation,
      stage: 'pre_merge',
      sha: pr.headSha,
    });
  return b.done();
};

/** Whether a glob has a PR that webhooks can still change: not merged or closed, and not yet reviewing. */
export const isReconcilable = (glob: Glob): boolean =>
  glob.pr !== null &&
  (glob.pr.state === 'draft' || glob.pr.state === 'ready') &&
  (glob.status === 'implementing' ||
    glob.status === 'in_progress' ||
    glob.status === 'pr_open' ||
    glob.status === 'merging');

/** Re-read the PR from the code host (on start, or when a webhook may have been lost) and apply what changed. */
export const reconcileRequested = (glob: Glob, ctx: Context): Result<Transition> => {
  if (!isReconcilable(glob)) return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({ kind: 'reconcile_pr', globId: glob.id, generation: glob.generation })
    .done();
};

/** A check suite or run changed on the glob's branch: re-read the head's merge state. */
export const checksChanged = (glob: Glob, ctx: Context): Result<Transition> => {
  if (glob.pr === null || (glob.status !== 'pr_open' && glob.status !== 'merging'))
    return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation })
    .done();
};

/** Flag the open PR's conflict on the builder's glob when it isn't flagged yet (the first conflict found is kept). */
const withConflict = (b: Builder, conflict: MergeConflict | undefined, ctx: Context): Builder => {
  const glob = b.current;
  if (conflict === undefined || !hasOpenPr(glob) || glob.conflict?.base === conflict.base) return b;
  b.set({ conflict: { ...conflict, since: null, at: ctx.now } }).event('ConflictFlagged', {
    base: conflict.base,
    files: [...conflict.files],
    since: null,
  });
  // A conflicted PR runs no checks: an armed merge would wait for ever.
  if (isMergeArmed(glob)) b.set({ mergeMode: null }).event('MergeDisarmed', { reason: 'conflict' });
  return b;
};

/**
 * A merge that would have started waits for a `merge` relation: the hold is recorded on the glob (once per head and set of
 * globs, so a repeated webhook adds no event) and the merge stays as it is (armed, or a sub's passed gate).
 */
const holdMerge = (b: Builder, glob: Glob, sha: string, held: readonly Unmet[], ctx: Context): Builder => {
  const waitingFor = held.map((u) => u.relation.to);
  const same = glob.mergeHold != null && glob.mergeHold.sha === sha && glob.mergeHold.for.join(',') === waitingFor.join(',');
  if (same) return b;
  return b.set({ mergeHold: { since: ctx.now, sha, for: waitingFor } }).event('MergeHeld', { for: waitingFor, sha });
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
    /** With `conflict`: what the head's own check runs say. GitHub usually runs none on a conflicting PR (`pending`). */
    real?: { state: 'passed' | 'pending' | 'failed'; failure: CheckFailure | null };
  },
  ctx: Context,
  /** The glob's relations: an armed merge waits while a `merge` relation is unmet. */
  relations?: RelationFacts,
): Result<Transition> => {
  if (glob.pr?.headSha !== checks.sha) return unchanged(glob);
  // A conflict on an open PR is not failed checks: it sets `conflict` only, and the head keeps its last real result.
  const conflictOnly = checks.conflict !== undefined && glob.status !== 'merging';
  const real = conflictOnly ? checks.real : undefined;
  if (conflictOnly && (real === undefined || real.state === 'pending')) {
    const current = glob.headChecks;
    const stale =
      current?.sha === checks.sha && current.state === 'failed' && current.failure === undefined;
    const b = new Builder(glob, ctx);
    if (stale) b.set({ headChecks: null });
    return withConflict(b, checks.conflict, ctx).done();
  }
  const passed = real === undefined ? checks.passed : real.state === 'passed';
  const reported = real === undefined ? checks.failure : real.failure;
  const failure = passed ? undefined : (reported ?? undefined);
  const inherited = inheritedFailure(failure, checks.base, checks.baseBranch ?? 'the base branch');
  const b = new Builder(glob, ctx)
    .set({
      headChecks: {
        sha: checks.sha,
        state: passed ? 'passed' : 'failed',
        // A re-read of the same failure keeps its first time.
        ...(!passed && {
          at:
            glob.headChecks?.sha === checks.sha && glob.headChecks.state === 'failed'
              ? (glob.headChecks.at ?? ctx.now)
              : ctx.now,
        }),
        ...(failure !== undefined && { failure }),
        ...(inherited !== null && { inheritedFrom: inherited }),
      },
    })
    .event('BuildCompleted', {
      sha: checks.sha,
      passed,
      ...(failure !== undefined && { failure: failureSummary(failure) }),
      ...(inherited !== null && { inheritedFrom: inherited.base }),
    });
  // Merge is armed: the head's checks decide whether slop merges now or hands the failure back.
  if (isMergeArmed(glob)) {
    if (checks.conflict !== undefined || !passed) {
      return withConflict(b, checks.conflict, ctx)
        .set({ mergeMode: null })
        .event('MergeDisarmed', { reason: checks.conflict !== undefined ? 'conflict' : 'checks failed' })
        .done();
    }
    const held = mergeGate(relations);
    // Merge when checks pass stays armed while a merge relation is unmet; the release resumes it (`gateReleased`).
    if (held.length > 0) return holdMerge(b, glob, checks.sha, held, ctx).done();
    return b
      .set({ mergeMode: null, ...(glob.mergeHold == null ? {} : { mergeHold: null }) })
      .status('merging')
      .effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha: checks.sha })
      .done();
  }
  // Slop updated the branch while merging: the checks on the new head decide (rows 12, 14, 16).
  if (glob.status === 'merging') {
    if (checks.conflict !== undefined) {
      // An ordinary "merge the base into the branch" job, not a failure: back to pr_open with the conflict recorded.
      const reason = conflictReason(checks.conflict);
      return withConflict(b.set({ mergeMode: null }).status('pr_open'), checks.conflict, ctx)
        .event('MergeFailed', { reason, conflict: true })
        .done();
    }
    if (!passed) {
      const reason = `Checks failed after updating the branch${failure === undefined ? '' : `: ${failureSummary(failure)}`}`;
      const mergeFailure: Failure = { reason, at: ctx.now, kind: 'merge' };
      return b
        .endRunsOnFailure(reason, mergeFailure)
        .set({ failure: mergeFailure, mergeMode: null })
        .event('MergeFailed', { reason: 'checks failed after update' })
        .status('failed')
        .done();
    }
    b.effect({
      kind: 'squash_merge',
      globId: glob.id,
      generation: glob.generation,
      sha: checks.sha,
    });
  }
  return (conflictOnly ? withConflict(b, checks.conflict, ctx) : b).done();
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
  if (JSON.stringify(inherited) === JSON.stringify(checks.inheritedFrom ?? null))
    return unchanged(glob);
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
  if (
    !hasFailedHead(glob) ||
    glob.headChecks?.inheritedFrom === undefined ||
    glob.pr?.headSha == null
  )
    return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({
      kind: 'update_branch',
      globId: glob.id,
      generation: glob.generation,
      sha: glob.pr.headSha,
    })
    .done();
};

/** Where `mark_ready` came from: the board offers it to supers only, once the implementation record is at the head. */
export type ReadySource =
  { readonly from: 'tool' } | { readonly from: 'board'; readonly facts: ActionFacts };

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
    return invalidTransition(
      glob,
      ctx.actor,
      `A glob in ${glob.status} has no draft PR to mark ready`,
    );
  }
  if (glob.pr === null) return invalidTransition(glob, ctx.actor, 'The glob has no PR yet');
  if (source.from === 'board') {
    const agentSet = isAgentSetGlob(glob);
    if (glob.type !== 'super' && !agentSet)
      return invalidTransition(glob, ctx.actor, 'Only a super is marked ready from the board');
    if (restrictedFrom(requireActor(ctx), glob))
      return forbidden('QA and PO members cannot mark a super ready');
    // An agent-set glob has no implementation record: slop's commit is the work.
    if (!agentSet && !recordAtHead(glob, source.facts))
      return invalidTransition(glob, ctx.actor, RECORD_NOT_AT_HEAD);
  }
  const run = currentRun(glob);
  if (runId !== null && (run === null || run.id !== runId || run.state === 'ended')) {
    return invalidTransition(glob, ctx.actor, `Run ${runId} is not the glob's current run`);
  }
  // Already ready (a conflict fixed, a second call): GitHub raises no ready event, and slop's stored head may be stale
  // (a missed push webhook), so the executor reads the PR's real head and records pr_open with it.
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
  if (glob.status !== 'pr_open' || glob.type !== 'sub' || glob.pr?.headSha !== check.sha)
    return unchanged(glob);
  // Failing checks are left to the routine's auto-fix; only policy flags convert a sub.
  if (!check.passed) return unchanged(glob);
  return new Builder(glob, ctx)
    .effect({
      kind: 'evaluate_sub_gate',
      globId: glob.id,
      generation: glob.generation,
      sha: check.sha,
    })
    .done();
};

/**
 * A sub is flagged as needing a human (the investigator's findings in Planning, the implementer or change_reviewer, with the reason; or a person): it
 * becomes a same in place, keeping its branch and PR, so the sub gate no longer merges it. A run that is no longer
 * current is ignored. Escalating a same is a no-op.
 */
export const escalateToSame = (
  glob: Glob,
  input: {
    reason: string;
    evidence?: string | null;
    criterion?: string | null;
    runId?: string | null;
    /** Who escalated when there is no actor (slop itself, for the size check). */
    by?: string;
  },
  ctx: Context,
): Result<Transition> => {
  const runId = input.runId ?? null;
  if (runId !== null) {
    const run = currentRun(glob);
    if (run === null || run.id !== runId || run.state === 'ended') return unchanged(glob);
  }
  if (glob.type !== 'sub') return unchanged(glob);
  if (
    glob.status !== 'planning' &&
    glob.status !== 'implementing' &&
    glob.status !== 'in_progress' &&
    glob.status !== 'pr_open'
  ) {
    return invalidTransition(glob, ctx.actor, 'A sub can only be escalated before it merges');
  }
  const reason = input.reason.trim();
  if (reason === '') return invalidInput('An escalation needs a reason');
  const evidence = input.evidence?.trim() ?? '';
  const criterion = criterionOf(input.criterion, reason, evidence);
  const escalation = {
    reason,
    criterion,
    ...(evidence === '' ? {} : { evidence }),
    by: input.by ?? ctx.actor?.email ?? 'routine',
    at: ctx.now,
    ...(runId === null ? {} : { runId }),
  };
  const b = new Builder(glob, ctx)
    .set({ type: 'same', escalation })
    .event('FieldsChanged', { type: { from: 'sub', to: 'same' } })
    .event('Escalated', {
      reason,
      criterion,
      ...(evidence === '' ? {} : { evidence }),
      ...(runId === null ? {} : { runId }),
    });
  if (glob.pr !== null)
    b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  return b.done();
};

/**
 * Slop's own cleanup of risk areas: a same still in Planning, escalated only for risk areas that have since been dropped, is a
 * sub again and starts like one (unless something it starts after hasn't merged, which it keeps waiting for). Not a person's
 * de-escalation, so no `Deescalated` event: the outcome learning must not read it as a correction. The note is on the event.
 */
export const liftRiskAreaEscalation = (
  glob: Glob,
  ctx: Context,
  relations: RelationFacts | undefined,
  dropped: readonly string[],
): Result<Transition> => {
  const prefix = "Touches the board's risk areas: ";
  const reason = glob.escalation?.reason ?? '';
  const named = reason.startsWith(prefix) ? reason.slice(prefix.length).split(', ') : [];
  if (
    glob.type !== 'same' ||
    glob.status !== 'planning' ||
    glob.escalation?.criterion !== 'risk_area' ||
    glob.pr !== null ||
    hasLiveRun(glob) ||
    named.length === 0 ||
    !named.every((n) => dropped.includes(n))
  )
    return unchanged(glob);
  const note = `De-escalated by slop: the risk area${named.length === 1 ? '' : 's'} it was escalated for (${named.join(', ')}) ${named.length === 1 ? 'was' : 'were'} dropped as too wide or too thinly evidenced`;
  const b = new Builder(glob, ctx)
    .set({ type: 'sub', escalation: null })
    .event('FieldsChanged', { type: { from: 'same', to: 'sub' }, note });
  const awaited = awaitedOf(relations ?? NO_RELATIONS);
  if (awaited.length > 0) {
    b.set({ waiting: { since: ctx.now } }).event('Waiting', { for: awaited.map((a) => a.id), note: waitSummary(awaited) });
  } else {
    b.status('implementing').queueRun(glob.creator);
  }
  return b.done();
};

/**
 * A person decides an escalation was unnecessary: the glob is a sub again. On a ready PR whose checks passed, the sub
 * gate runs on the head, so a sub with nothing else to flag merges.
 */
export const deescalate = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.escalation == null || glob.type !== 'same') {
    return invalidTransition(glob, actor, 'Only an escalated same can be made a sub again');
  }
  if (
    glob.status !== 'implementing' &&
    glob.status !== 'in_progress' &&
    glob.status !== 'pr_open'
  ) {
    return invalidTransition(
      glob,
      actor,
      'An escalation can only be undone before the glob merges',
    );
  }
  const b = new Builder(glob, ctx)
    .set({ type: 'sub', escalation: null })
    .event('FieldsChanged', { type: { from: 'same', to: 'sub' } })
    .event('Deescalated', { reason: glob.escalation.reason });
  if (glob.pr !== null)
    b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  const sha = glob.pr?.headSha;
  if (
    glob.status === 'pr_open' &&
    glob.pr?.state === 'ready' &&
    sha != null &&
    glob.headChecks?.sha === sha &&
    glob.headChecks.state === 'passed'
  ) {
    b.effect({ kind: 'evaluate_sub_gate', globId: glob.id, generation: glob.generation, sha });
  }
  return b.done();
};

/** Whether the routine reported that a person has to decide something (`report_failure` with `kind: 'needs_pairing'`). */
const needsPairing = (glob: Glob): boolean =>
  glob.status === 'failed' &&
  glob.failure?.kind === 'needs_pairing' &&
  glob.type !== 'super' &&
  glob.category !== 'bug';

/**
 * Make it a super: a person takes over a glob whose routine asked for pairing. The type becomes super with the person
 * implementing, the failure clears and the glob goes to In progress; its branch, PR and provisioning stay as they are.
 */
export const makeSuper = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (!needsPairing(glob))
    return invalidTransition(
      glob,
      actor,
      'Only a failed sub or same whose routine asked for pairing can be made a super',
    );
  if (actor.role === 'qa' || actor.role === 'po')
    return forbidden('QA and PO members cannot create supers');
  if (hasBusyRun(glob))
    return runActive('A routine run is active or watching; pick up to supersede it');
  const b = new Builder(glob, ctx)
    .endRun('superseded', null, { cause: 'make_super' })
    .set({
      type: 'super',
      implementer: actor.email,
      failure: null,
      escalation: null,
      ...(glob.waiting == null ? {} : { waiting: null }),
    })
    .status('in_progress')
    .event('FieldsChanged', { type: { from: glob.type, to: 'super' } })
    .event('PickedUp', { takeOver: false, madeSuper: true });
  if (glob.pr !== null)
    b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  return b.done();
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
  /** The glob's relations: a passed gate waits while a `merge` relation is unmet. */
  relations?: RelationFacts,
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
    ...(gate.ignoredLines !== undefined &&
      gate.ignoredLines > 0 && { ignoredLines: gate.ignoredLines }),
    ...(gate.limit !== undefined && { limit: gate.limit }),
  });
  if (gate.passed) {
    const held = mergeGate(relations);
    // The sub stays in pr_open with its passed gate: `gateReleased` merges it once the relations are met.
    if (held.length > 0) return holdMerge(b, glob, gate.sha, held, ctx).done();
    return b
      .set(glob.mergeHold == null ? {} : { mergeHold: null })
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
export const merged = (
  glob: Glob,
  merge: { sha: string; number?: number },
  ctx: Context,
): Result<Transition> => {
  // GitHub is the source of truth for merges, so any status before merging moves to reviewing.
  if (glob.status === 'reviewing' || glob.status === 'signed_off') return unchanged(glob);
  // A PR already landed with Merge and continue: its second observation.
  if (merge.number !== undefined && glob.prs.some((p) => p.number === merge.number))
    return unchanged(glob);
  if (glob.type === 'super' && glob.mergeMode === 'continue') {
    // Row 31: the glob keeps going on its branch; the next push opens a fresh draft PR.
    const number = merge.number ?? glob.pr?.number;
    const prs =
      number === undefined
        ? glob.prs
        : [...glob.prs, { number, mergeSha: merge.sha, mergedAt: ctx.now }];
    return new Builder(glob, ctx)
      .set({
        prs,
        pr: null,
        headChecks: null,
        mergeMode: null,
        ...(glob.mergeHold == null ? {} : { mergeHold: null }),
        failure: null,
        ...(glob.conflict == null ? {} : { conflict: null }),
      })
      .event('Merged', {
        sha: merge.sha,
        ...(number === undefined ? {} : { number }),
        mode: 'continue',
      })
      .status('in_progress')
      .effect({ kind: 'flag_conflicts', globId: glob.id, generation: glob.generation })
      .done();
  }
  const b = new Builder(glob, ctx)
    .endRun('completed')
    .set({
      labels: requiredLabels(glob.type),
      checklists: {},
      failure: null,
      mergeMode: null,
      ...(glob.mergeHold == null ? {} : { mergeHold: null }),
      pr: glob.pr === null ? null : { ...glob.pr, state: 'merged' },
      ...(glob.conflict == null ? {} : { conflict: null }),
    })
    .event('Merged', { sha: merge.sha })
    .status('reviewing')
    .effect({ kind: 'flag_conflicts', globId: glob.id, generation: glob.generation })
    // Only the final merge releases the globs waiting for this one (a Merge and continue leaves it open).
    .effect({ kind: 'release_waiting', globId: glob.id, generation: glob.generation })
    // Likewise: a Merge and continue is not the change that is rolled out.
    .effect({ kind: 'check_rollout_paths', globId: glob.id, generation: glob.generation, sha: merge.sha });
  // A sub merges without human review, so its one review runs after the merge (a same or super was reviewed before it).
  if (glob.type === 'sub')
    b.effect({
      kind: 'review_change',
      globId: glob.id,
      generation: glob.generation,
      stage: 'post_merge',
      sha: merge.sha,
    });
  return b.done();
};

/**
 * Row 16: slop's own merge failed. A conflict is an ordinary "merge the base into the branch" job, not a failure: the
 * glob stays in pr_open with the conflict flagged (the same as when the conflict shows on the updated head's checks), and
 * a conflict-fix run already queued carries on. Anything else fails the glob.
 */
export const mergeFailed = (
  glob: Glob,
  reason: string,
  ctx: Context,
  conflict?: MergeConflict,
): Result<Transition> => {
  if (glob.status !== 'merging') return unchanged(glob);
  if (conflict !== undefined) {
    return withConflict(new Builder(glob, ctx).set({ mergeMode: null }).status('pr_open'), conflict, ctx)
      .event('MergeFailed', { reason, conflict: true })
      .done();
  }
  const failure: Failure = { reason, at: ctx.now, kind: 'merge' };
  return new Builder(glob, ctx)
    .endRunsOnFailure(reason, failure)
    .set({ failure, mergeMode: null })
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
  red: { sha: string; failure: CheckFailure | null; base: string; parent: string },
  ctx: Context,
): Result<Transition> => {
  if (glob.type !== 'sub' || glob.status !== 'reviewing' || glob.pr?.state !== 'merged')
    return unchanged(glob);
  const check = red.failure === null ? 'the checks' : red.failure.name;
  const link = red.failure?.url == null ? '' : ` (${red.failure.url})`;
  return new Builder(glob, ctx)
    .set({
      failure: {
        reason: `Reverted from ${red.base}: ${check} failed on its merge commit${link}`,
        at: ctx.now,
        kind: 'reverted',
      },
    })
    .event('MergeReverted', {
      sha: red.sha,
      parent: red.parent,
      parentChecks: 'passed',
      ...(red.failure === null ? {} : { check: red.failure.name }),
    })
    .status('failed')
    .effect({ kind: 'revert_merge', globId: glob.id, generation: glob.generation, sha: red.sha })
    .done();
};

/**
 * A merged sub's commit is the first red one's neighbour but not clearly the cause (the base was already red, or its
 * parent's checks aren't known to have passed): nothing is reverted, and the decision is recorded on the glob's activity.
 */
export const revertDeclined = (
  glob: Glob,
  declined: { sha: string; parent: string | null; parentChecks: string; reason: string },
  ctx: Context,
): Result<Transition> => {
  if (glob.type !== 'sub' || glob.status !== 'reviewing' || glob.pr?.state !== 'merged') return unchanged(glob);
  return new Builder(glob, ctx)
    .event('MergeRevertDeclined', {
      sha: declined.sha,
      parent: declined.parent,
      parentChecks: declined.parentChecks,
      reason: declined.reason,
    })
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
  report: {
    reason: string;
    runId: string | null;
    agentSetVersion?: number | null;
    kind?: 'needs_pairing';
    decision?: string | null;
  },
  ctx: Context,
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  // Every failure report records the agent-set version it ran with (spec: provenance).
  const agentSetVersion = report.agentSetVersion ?? null;
  // Pairing is offered on a sub or same only (a super already has a person); it is never retried by slop.
  const pairing = report.kind === 'needs_pairing' && glob.type !== 'super';
  const decision = report.decision?.trim() ?? '';
  const failure: Failure = {
    reason: report.reason,
    at: ctx.now,
    ...(agentSetVersion === null ? {} : { agentSetVersion }),
    ...(pairing
      ? {
          kind: 'needs_pairing' as const,
          ...(decision === '' ? {} : { decision: decision.slice(0, 1000) }),
        }
      : {}),
  };
  if (report.runId === null) {
    // Row 18: an interactive session gave up.
    if (glob.status !== 'in_progress') {
      return invalidTransition(
        glob,
        ctx.actor,
        'Only a glob in progress can be failed without a run',
      );
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
      .event('RunFailed', {
        runId: report.runId,
        reason: report.reason,
        ignored: true,
        agentSetVersion,
      })
      .done();
  }
  if ((glob.status === 'planning' || glob.status === 'in_progress') && run.purpose === 'investigate') {
    // An investigate-only run failed: the glob stays in Planning (nothing was started) and the run's history says why.
    return new Builder(glob, ctx)
      .endRun('failed', report.reason, { agentSetVersion })
      .startAfterInvestigation(run, relations)
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
  if (
    run.purpose === 'resolve_conflict' &&
    (glob.status === 'pr_open' || glob.status === 'in_progress')
  ) {
    // A conflict-resolving run gave up: the conflict stays flagged and Resolve conflict is offered again, with the reason.
    return new Builder(glob, ctx)
      .endRun('failed', report.reason, { agentSetVersion })
      .set({ failure })
      .done();
  }
  if (glob.status === 'pr_open' && run.state === 'watching') {
    // Row 25: auto-fix ended; the glob stays in pr_open and shows the failure.
    const b = new Builder(glob, ctx).endRun('failed', report.reason, { agentSetVersion });
    // A watcher that gave up is retried once by slop itself, on the same PR and branch; only if that run also ends
    // without fixing it does the glob show the failure and the Retry auto-fix button.
    const retried = glob.runs.some((r) => r.autoRetry === true);
    if (
      !pairing &&
      GAVE_UP.test(report.reason) &&
      !retried &&
      glob.type !== 'super' &&
      glob.implementer === null &&
      glob.pr !== null
    ) {
      return b.queueRun(run.triggeredBy, { failureSummary: failureSummaryOf(glob) }).done();
    }
    return b.set({ failure }).done();
  }
  if (glob.status === 'failed') {
    // A live run on a failed glob (a conflict fix queued for the failure, or a run that went quiet) must be endable by its own
    // report: it ends and says why, and the glob keeps the failure it already shows.
    return new Builder(glob, ctx).endRun('failed', report.reason, { agentSetVersion }).done();
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
    .set({
      failure: { reason: 'PR closed without merging', at: ctx.now },
      ...(isMergeArmed(glob) && { mergeMode: null }),
    })
    .status('failed')
    .done();
};

// ---------------------------------------------------------------------------
// What a person can do next (drives the glob view's buttons and error messages)

export const allowedActions = (glob: Glob, actor: Actor, facts: ActionFacts = {}): Action[] => {
  if (glob.category === 'decision') return decisionActions(glob, actor);
  if (glob.category === 'action') return actionActions(glob);
  if (isAgentSetGlob(glob)) return agentSetActions(glob, actor);
  const actions: Action[] = [];
  const restricted = restrictedFrom(actor, glob);
  // Held: waiting for another glob to merge. Without the relations loaded, the glob's own mark says it.
  const held =
    glob.status === 'planning' &&
    glob.type !== 'super' &&
    !startQueued(glob) &&
    (facts.relations === undefined ? glob.waiting != null : awaitedOf(facts.relations).length > 0);
  if (!restricted && glob.status === 'planning' && glob.type === 'same' && !held && !startQueued(glob)) actions.push('start');
  if (!restricted && canInvestigate(glob)) actions.push('investigate');
  if (reviewOffer(glob, facts.reviews) !== null) actions.push('review_now');
  if (held && !restricted) actions.push('start_anyway');
  // Start (the machine takes over): picked up, but no session has started and no run is live.
  if (
    !restricted &&
    glob.status === 'in_progress' &&
    glob.type !== 'super' &&
    glob.implementer !== null &&
    !hasLiveRun(glob)
  ) {
    actions.push('start_anyway');
  }
  const canPickUp =
    !restricted &&
    !hasBusyRun(glob) &&
    (glob.status === 'planning' ||
      glob.status === 'failed' ||
      glob.status === 'in_progress' ||
      glob.status === 'pr_open');
  // The glob's own implementer is offered it too (row 8: a no-op that reopens their session), so their own glob is never a dead end.
  if (canPickUp) actions.push('pick_up');
  if (
    !restricted &&
    glob.type !== 'super' &&
    hasLiveRun(glob) &&
    (glob.status === 'implementing' || glob.status === 'pr_open' || glob.status === 'failed')
  ) {
    actions.push('take_over');
  }
  // A merge failure on a glob a person implements is theirs to fix and push: a routine run is the wrong answer.
  const personMergeFailure = glob.failure?.kind === 'merge' && glob.implementer !== null;
  if (
    !restricted &&
    glob.status === 'failed' &&
    glob.type !== 'super' &&
    !hasLiveRun(glob) &&
    !personMergeFailure
  ) {
    actions.push('retrigger');
  }
  if (!restricted && !hasLiveRun(glob) && canRetryAutofix(glob)) actions.push('retry_autofix');
  if (!restricted && !hasLiveRun(glob) && canRetryMerge(glob)) actions.push('retry_merge');
  if (!restricted && canRequestConflictFix(glob)) actions.push('resolve_conflict');
  if (!restricted && glob.status !== 'reviewing' && glob.status !== 'signed_off') actions.push('start_again');
  if (isMergeArmed(glob)) {
    if (!restricted) actions.push('cancel_merge');
  } else if (mergeBlocker(glob, facts.relations) === null) {
    actions.push('merge');
    if (headChecksPassed(glob) && recordAtHead(glob, facts)) actions.push('merge_continue');
  }
  if (
    !restricted &&
    glob.status === 'in_progress' &&
    glob.pr?.state === 'draft' &&
    recordAtHead(glob, facts)
  ) {
    actions.push('mark_ready');
  }
  if (
    !restricted &&
    canChooseType(actor.role, 'sub') &&
    glob.escalation != null &&
    glob.type === 'same' &&
    ['implementing', 'in_progress', 'pr_open'].includes(glob.status)
  ) {
    actions.push('deescalate');
  }
  if (actor.role !== 'qa' && actor.role !== 'po' && canChooseType(actor.role, 'super') && needsPairing(glob) && !hasBusyRun(glob))
    actions.push('make_super');
  actions.push('delete');
  return actions;
};

/**
 * Slop's own "Agent set vN" glob: nobody works on it (slop commits the set), so no pick up, start
 * again. A person reviews the diff, marks the PR ready when slop hasn't yet, and merges once the checks pass.
 */
const agentSetActions = (glob: Glob, actor: Actor): Action[] => {
  const actions: Action[] = [];
  const restricted = restrictedFrom(actor, glob);
  if (canReviewNow(glob)) actions.push('review_now');
  if (
    !restricted &&
    (glob.status === 'in_progress' || glob.status === 'implementing') &&
    glob.pr?.state === 'draft'
  )
    actions.push('mark_ready');
  if (isMergeArmed(glob)) {
    if (!restricted) actions.push('cancel_merge');
  } else if (mergeBlocker(glob) === null) {
    actions.push('merge');
  }
  actions.push('delete');
  return actions;
};

// ---------------------------------------------------------------------------
// Decision globs (rows D1-D11)
//
// A decision is the board's face for a proposed knowledge change: it never has a branch, PR, run or merge. It moves
// Planning -> Doing (picked up) -> Reviewing (accepted) -> Signed off, or ends Signed off when rejected or closed.

const mayDecide = (actor: Actor): boolean => actor.role === 'admin' || actor.role === 'po';

/** The attributes of a decision glob; a decision without them is a broken record, never a state to handle. */
export const decisionAttributesOf = (glob: Glob): DecisionAttributes => {
  const attributes = glob.attributes;
  if (glob.category !== 'decision' || !isDecisionAttributes(attributes))
    throw new Error(`${glob.id} is not a decision glob`);
  return attributes;
};

const scopeJson = (scope: DecisionScope): JsonValue => ({ kind: scope.kind, ref: scope.ref });

const outcomeJson = (outcome: DecisionOutcome): JsonValue => ({
  kind: outcome.kind,
  ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  ...(outcome.linkedGlobId === undefined ? {} : { linkedGlobId: outcome.linkedGlobId }),
});

type MutableAttributes = { -readonly [K in keyof DecisionAttributes]: DecisionAttributes[K] };

/** The attributes with `outcome` set (or cleared) and the archived flag as given; the rest is kept. */
const withOutcome = (
  attributes: DecisionAttributes,
  outcome: DecisionOutcome | null,
  archived: boolean,
): DecisionAttributes => {
  const next: MutableAttributes = { ...attributes, outcome };
  if (archived) next.archived = true;
  else delete next.archived;
  return next;
};

/** The attributes with the conflict flags replaced (none when `ids` is empty); the rest is kept. */
const withConflicts = (
  attributes: DecisionAttributes,
  ids: readonly string[],
): DecisionAttributes => {
  const next: MutableAttributes = { ...attributes };
  if (ids.length === 0) delete next.conflictsWith;
  else next.conflictsWith = [...ids];
  return next;
};

const linkJson = (link: GlobLink): JsonValue => ({
  id: link.id,
  kind: link.kind,
  source: link.source,
  ...(link.detail === undefined ? {} : { detail: link.detail }),
});

/** Row D1: a decision enters Planning with no run, no provisioning and no labels. */
const createDecision = (input: CreateInput, ctx: Context, actor: Actor): Result<Transition> => {
  const attributes = validateAttributes('decision', input.attributes);
  if (!attributes.ok) return attributes;
  if (!isDecisionAttributes(attributes.value) || attributes.value.outcome !== null) {
    return invalidInput('A new decision has no outcome yet');
  }
  if (input.environment !== null) return invalidInput('A decision has no environment');
  const glob: Glob = {
    id: input.id,
    boardId: input.boardId,
    title: input.title.trim(),
    type: null,
    category: 'decision',
    attributes: attributes.value,
    group: input.group,
    environment: null,
    status: 'planning',
    version: 0,
    generation: 1,
    creator: actor.email,
    planner: actor.email,
    implementer: null,
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
    doingSince: null,
    listSince: ctx.now,
  };
  return new Builder(glob, ctx)
    .event('GlobCreated', {
      type: glob.type,
      category: glob.category,
      group: glob.group,
      environment: null,
      status: glob.status,
    })
    .done();
};

// ---------------------------------------------------------------------------
// Action globs (rows A1-A3)
//
// An action is something a person does: it never has a branch, PR, run, label or deploy. It is open in Planning and ends
// Signed off, done or dismissed (the outcome says which). Anyone on the board may complete or dismiss it.

/** The attributes of an action glob; an action without them is a broken record, never a state to handle. */
export const actionAttributesOf = (glob: Glob): ActionAttributes => {
  const attributes = glob.attributes;
  if (glob.category !== 'action' || !isActionAttributes(attributes)) throw new Error(`${glob.id} is not an action glob`);
  return attributes;
};

/** Row A1: an action enters Planning with no run, no provisioning and no labels. */
const createAction = (input: CreateInput, ctx: Context, actor: Actor): Result<Transition> => {
  const attributes = validateAttributes('action', input.attributes ?? { assignee: null, outcome: null });
  if (!attributes.ok) return attributes;
  if (!isActionAttributes(attributes.value) || attributes.value.outcome !== null) {
    return invalidInput('A new action has no outcome yet');
  }
  if (input.environment !== null) return invalidInput('An action has no environment');
  const glob: Glob = {
    id: input.id,
    boardId: input.boardId,
    title: input.title.trim(),
    type: null,
    category: 'action',
    attributes: attributes.value,
    group: input.group,
    environment: null,
    status: 'planning',
    version: 0,
    generation: 1,
    creator: actor.email,
    planner: actor.email,
    implementer: null,
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
    doingSince: null,
    listSince: ctx.now,
  };
  return new Builder(glob, ctx)
    .event('GlobCreated', {
      type: null,
      category: glob.category,
      group: glob.group,
      environment: null,
      status: glob.status,
    })
    .done();
};

const notAction = (glob: Glob, actor: Actor | null): Result<never> =>
  invalidTransition(glob, actor, 'This only applies to an action glob');

/** The new assignee from an `attributes` PATCH on an action (undefined: no change); only while the action is open. */
const assigneeEdit = (glob: Glob, value: unknown): Result<string | null | undefined> => {
  const assignee = validateActionEdit(value);
  if (!assignee.ok) return assignee;
  const attributes = actionAttributesOf(glob);
  if (attributes.outcome !== null) return invalidInput('A finished action cannot be reassigned');
  return ok(assignee.value === attributes.assignee ? undefined : assignee.value);
};

/** An open action ends: done or dismissed. What waited for it is released either way. */
const finishAction = (glob: Glob, outcome: ActionOutcome, ctx: Context, event: DomainEventType): Result<Transition> =>
  releaseWaiting(new Builder(glob, ctx), glob)
    .set({ attributes: { ...actionAttributesOf(glob), outcome }, signedOffAt: ctx.now })
    .status('signed_off')
    .event(event, {
      by: outcome.by,
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    })
    .done();

/** Row A2: a person did the action's work. A repeat on a finished action changes nothing. */
export const completeAction = (glob: Glob, input: { readonly note?: string }, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'action') return notAction(glob, actor);
  const { outcome } = actionAttributesOf(glob);
  if (outcome !== null) {
    return outcome.kind === 'done' ? unchanged(glob) : invalidTransition(glob, actor, 'This action was dismissed');
  }
  if (glob.status !== 'planning') return invalidTransition(glob, actor, 'This action is not open');
  const note = input.note?.trim() ?? '';
  return finishAction(glob, { kind: 'done', by: actor.email, at: ctx.now, ...(note === '' ? {} : { note }) }, ctx, 'ActionDone');
};

/** Row A3: the action is not needed. Needs a reason; a repeat on a dismissed action changes nothing. */
export const dismissAction = (glob: Glob, input: { readonly reason: string }, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'action') return notAction(glob, actor);
  const { outcome } = actionAttributesOf(glob);
  if (outcome !== null) {
    return outcome.kind === 'dismissed' ? unchanged(glob) : invalidTransition(glob, actor, 'This action is already done');
  }
  if (glob.status !== 'planning') return invalidTransition(glob, actor, 'This action is not open');
  const reason = input.reason.trim();
  if (reason === '') return invalidInput('Dismissing needs a reason');
  return finishAction(glob, { kind: 'dismissed', by: actor.email, at: ctx.now, reason }, ctx, 'ActionDismissed');
};

/** What a person can do with an action: finish it while it is open, and delete it. */
const actionActions = (glob: Glob): Action[] =>
  glob.status === 'planning' ? ['complete_action', 'dismiss_action', 'delete'] : ['delete'];

/** A scope edit on a decision (admins and POs): null when it changes nothing. */
const scopeEdit = (glob: Glob, value: unknown, actor: Actor): Result<DecisionScope | null> => {
  const scope = validateScopeEdit(glob.category, value);
  if (!scope.ok) return scope;
  if (!mayDecide(actor)) return forbidden("Only admins and POs can change a decision's scope");
  return ok(sameScope(decisionAttributesOf(glob).scope, scope.value) ? null : scope.value);
};

const notDecision = (glob: Glob, actor: Actor | null): Result<never> =>
  invalidTransition(glob, actor, 'This only applies to a decision glob');

/** Rows D2 and D3: an admin or PO picks a decision up (or takes it over); no provisioning, no run. */
export const pickUpDecision = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'decision') return notDecision(glob, actor);
  if (!mayDecide(actor)) return forbidden('Only admins and POs can pick up a decision');
  if (glob.status === 'in_progress' && glob.implementer === actor.email) return unchanged(glob);
  if (glob.status === 'planning') {
    return new Builder(glob, ctx)
      .set({ implementer: actor.email })
      .status('in_progress')
      .event('PickedUp', { takeOver: false })
      .done();
  }
  if (glob.status === 'in_progress') {
    return new Builder(glob, ctx)
      .set({ implementer: actor.email })
      .event('PickedUp', { takeOver: true })
      .done();
  }
  return invalidTransition(glob, actor, `A decision in ${glob.status} cannot be picked up`);
};

/** What a person chooses for a decision in Doing. */
export interface DecideInput {
  readonly outcome: Exclude<DecisionOutcomeKind, 'closed'>;
  /** Required for a rejection. */
  readonly reason?: string;
  /** Required for needs work: the work glob that will make the change. Accepting a hotspot records the refactor glob it created. */
  readonly linkedGlobId?: string;
}

/**
 * What other globs wait for in this one can have been reached (it was decided, or signed off): the outbox's `release_waiting`
 * starts and resumes them. Idempotent, like the release after a merge.
 */
const releaseWaiting = (b: Builder, glob: Glob): Builder =>
  b.effect({ kind: 'release_waiting', globId: glob.id, generation: glob.generation });

/**
 * Rows D4, D5, D7 and D11. The caller has already applied the knowledge change in the same transaction. Accept goes to
 * Reviewing, reject to Signed off (archived); needs work and retarget stay in Doing (needs work records the linked glob,
 * retarget only an event, since the item is redrafted before it can be accepted).
 */
export const decideDecision = (
  glob: Glob,
  input: DecideInput,
  ctx: Context,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'decision') return notDecision(glob, actor);
  if (!mayDecide(actor)) return forbidden('Only admins and POs can decide a decision');
  if (glob.status !== 'in_progress')
    return invalidTransition(glob, actor, 'A decision is decided in Doing: pick it up first');
  const attributes = decisionAttributesOf(glob);
  if (attributes.outcome !== null && attributes.outcome.kind !== 'needs_work') {
    return invalidTransition(
      glob,
      actor,
      'This decision already has an outcome: reopen it to choose again',
    );
  }
  const reason = input.reason?.trim() ?? '';
  if (input.outcome === 'reject' && reason === '') return invalidInput('Rejecting needs a reason');
  if (input.outcome === 'needs_work' && (input.linkedGlobId ?? '') === '')
    return invalidInput('Needs work needs the work glob that will make the change');
  const outcome: DecisionOutcome = {
    kind: input.outcome,
    by: actor.email,
    at: ctx.now,
    ...(reason === '' ? {} : { reason }),
    ...((input.outcome === 'needs_work' || input.outcome === 'accept') && input.linkedGlobId !== undefined
      ? { linkedGlobId: input.linkedGlobId }
      : {}),
  };
  const b = new Builder(glob, ctx);
  switch (input.outcome) {
    case 'accept':
    case 'accept_with_edits':
      b.set({ attributes: withOutcome(attributes, outcome, false) }).status('reviewing');
      break;
    case 'needs_work':
      b.set({ attributes: withOutcome(attributes, outcome, false) });
      break;
    case 'reject':
      b.set({ attributes: withOutcome(attributes, outcome, true), signedOffAt: ctx.now }).status(
        'signed_off',
      );
      break;
    case 'retarget':
      break;
  }
  // Accepted or rejected: the decision is made, so what waited for it is released (not for needs work or retarget).
  if (input.outcome === 'accept' || input.outcome === 'accept_with_edits' || input.outcome === 'reject') releaseWaiting(b, glob);
  return b.event('DecisionDecided', { outcome: outcomeJson(outcome) }).done();
};

/**
 * Confirm or dismiss an unverified replacement (a decision glob of origin `replacement`), from Planning or Doing: no
 * pick-up is needed, there is nothing to apply but the pair. Confirm records an accepted outcome and Dismiss a rejected
 * one; either way the glob is Signed off and archived. The caller has applied the choice rows in the same transaction.
 */
export const decideReplacement = (
  glob: Glob,
  input: { readonly confirm: boolean; readonly reason?: string },
  ctx: Context,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'decision') return notDecision(glob, actor);
  if (!mayDecide(actor)) return forbidden('Only admins and POs can decide a decision');
  if (glob.status !== 'planning' && glob.status !== 'in_progress')
    return invalidTransition(glob, actor, 'This replacement has already been decided');
  const attributes = decisionAttributesOf(glob);
  if (attributes.origin.kind !== 'replacement')
    return invalidTransition(glob, actor, 'Only a replacement is confirmed or dismissed');
  const reason = input.reason?.trim() ?? '';
  const outcome: DecisionOutcome = {
    kind: input.confirm ? 'accept' : 'reject',
    by: actor.email,
    at: ctx.now,
    ...(reason === '' ? {} : { reason }),
  };
  return releaseWaiting(new Builder(glob, ctx), glob)
    .set({ attributes: withOutcome(attributes, outcome, true), signedOffAt: ctx.now })
    .status('signed_off')
    .event('DecisionDecided', { outcome: outcomeJson(outcome) })
    .done();
};

/** The pair a replacement asks about changed before anyone decided (a choice was replaced or deleted): the card closes itself, archived. */
export const closeReplacement = (
  glob: Glob,
  ctx: Context,
  reason = 'No longer relevant: one of the choices was replaced or deleted',
): Result<Transition> => {
  if (glob.category !== 'decision' || glob.status === 'signed_off') return unchanged(glob);
  const attributes = decisionAttributesOf(glob);
  if (attributes.origin.kind !== 'replacement') return unchanged(glob);
  const outcome: DecisionOutcome = { kind: 'closed', by: 'slop', at: ctx.now, reason };
  return releaseWaiting(new Builder(glob, ctx), glob)
    .set({ attributes: withOutcome(attributes, outcome, true), signedOffAt: ctx.now })
    .status('signed_off')
    .event('DecisionDecided', { outcome: outcomeJson(outcome) })
    .done();
};

/** Row D6: the work glob a needs-work decision waits on merged; the decision moves to Reviewing. A repeat changes nothing. */
export const decisionWorkLanded = (glob: Glob, ctx: Context): Result<Transition> => {
  if (glob.category !== 'decision' || glob.status !== 'in_progress') return unchanged(glob);
  const attributes = decisionAttributesOf(glob);
  const outcome = attributes.outcome;
  if (outcome?.kind !== 'needs_work' || outcome.workLanded === true) return unchanged(glob);
  const landed: DecisionOutcome = { ...outcome, workLanded: true };
  return new Builder(glob, ctx)
    .set({ attributes: withOutcome(attributes, landed, false) })
    .status('reviewing')
    .event('DecisionWorkLanded', { linkedGlobId: outcome.linkedGlobId ?? null })
    .done();
};

/** Row D8: sign off an accepted decision. */
export const signOffDecision = (
  glob: Glob,
  ctx: Context,
  rollout: BlockProgress | null = null,
  relations?: RelationFacts,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'decision') return notDecision(glob, actor);
  if (!mayDecide(actor)) return forbidden('Only admins and POs can sign off a decision');
  if (glob.status !== 'reviewing')
    return invalidTransition(glob, actor, 'Only a decision in Reviewing can be signed off');
  if (rollout !== null && rollout.open > 0) return invalidTransition(glob, actor, rolloutPending(rollout));
  const held = relations === undefined ? [] : unmet(relations, 'sign_off');
  if (held.length > 0) return invalidTransition(glob, actor, gateText(held));
  return releaseWaiting(new Builder(glob, ctx), glob).set({ signedOffAt: ctx.now }).status('signed_off').done();
};

/**
 * The last work step holding back sign-off was done or dismissed: a merged glob whose labels are all approved moves on to
 * Signed off (one still short of approvals just stays in Reviewing, and now shows there). A no-op while any step is open.
 */
export const rolloutSettled = (glob: Glob, rollout: BlockProgress, ctx: Context, relations?: RelationFacts): Result<Transition> => {
  if (rollout.open > 0 || glob.category === 'decision' || glob.status !== 'reviewing') return unchanged(glob);
  if (!Object.values(glob.labels).every((s) => s === 'approved')) return unchanged(glob);
  // A `sign_off` relation still unmet: `gateReleased` moves the glob when the last one is met.
  if (relations !== undefined && unmet(relations, 'sign_off').length > 0) return unchanged(glob);
  return releaseWaiting(new Builder(glob, ctx), glob).set({ signedOffAt: ctx.now }).event('RolloutDone', {}).status('signed_off').done();
};

/**
 * A relation of this glob's was met (what it waits for merged, was decided or signed off, or was deleted, dismissed or removed):
 * resumes a merge held for a `merge` relation, and moves a Reviewing glob with approved labels and nothing else holding it to
 * Signed off. Idempotent: a no-op while any gate it needs is still unmet and once it has run, so the outbox and every release
 * path may call it any number of times.
 */
export const gateReleased = (
  glob: Glob,
  relations: RelationFacts,
  rollout: BlockProgress | null,
  ctx: Context,
): Result<Transition> => {
  if (glob.category === 'decision') return unchanged(glob);
  if (glob.status === 'pr_open' && glob.pr?.headSha != null) {
    const head = glob.pr.headSha;
    // Merge when checks pass was armed, or a sub's gate passed, and the merge only waited for the relation.
    const armed = isMergeArmed(glob);
    const subPassed = glob.type === 'sub' && glob.mergeHold != null && glob.mergeHold.sha === head;
    if ((!armed && !subPassed) || glob.conflict != null || !headChecksPassed(glob)) return unchanged(glob);
    if (mergeGate(relations).length > 0) return unchanged(glob);
    return new Builder(glob, ctx)
      .set({ mergeMode: null, mergeHold: null })
      .event('MergeResumed', { sha: head })
      .status('merging')
      .effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha: head })
      .done();
  }
  if (glob.status !== 'reviewing') return unchanged(glob);
  if (rollout !== null && rollout.open > 0) return unchanged(glob);
  if (!Object.values(glob.labels).every((s) => s === 'approved')) return unchanged(glob);
  if (unmet(relations, 'sign_off').length > 0) return unchanged(glob);
  return releaseWaiting(new Builder(glob, ctx), glob).set({ signedOffAt: ctx.now }).event('SignOffReleased', {}).status('signed_off').done();
};

/** Row D9: an accepted decision goes back to Doing, its outcome cleared, to be chosen again. */
export const reopenDecision = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'decision') return notDecision(glob, actor);
  if (!mayDecide(actor)) return forbidden('Only admins and POs can reopen a decision');
  if (glob.status !== 'reviewing')
    return invalidTransition(glob, actor, 'Only a decision in Reviewing can be reopened');
  return new Builder(glob, ctx)
    .set({ attributes: withOutcome(decisionAttributesOf(glob), null, false) })
    .status('in_progress')
    .done();
};

/**
 * Row D10′: the KB pipeline closed the learning without a decision (merged into an open one, suppressed by a rejected one,
 * covered by approved knowledge). The decision ends Signed off and archived with a `closed` outcome, `closedAs`, and the
 * link to what closed it (none when a document's text covers it). Nothing to do once it is signed off.
 */
export const closeDecision = (
  glob: Glob,
  closedAs: DecisionClosedAs,
  link: GlobLink | null,
  ctx: Context,
): Result<Transition> => {
  if (glob.category !== 'decision' || glob.status === 'signed_off') return unchanged(glob);
  if (link !== null && !CLOSING_EDGE_KINDS.includes(link.kind))
    return invalidInput(`A ${link.kind} link does not close a decision`);
  const outcome: DecisionOutcome = {
    kind: 'closed',
    by: 'slop',
    at: ctx.now,
    reason: `The knowledge pipeline closed the item as ${closedAs}`,
  };
  const attributes: MutableAttributes = {
    ...withOutcome(decisionAttributesOf(glob), outcome, true),
    closedAs,
  };
  const links = (glob.links ?? []).filter(
    (l) => link === null || !(l.id === link.id && l.kind === link.kind),
  );
  return releaseWaiting(new Builder(glob, ctx), glob)
    .set({ attributes, links: link === null ? links : [...links, link], signedOffAt: ctx.now })
    .status('signed_off')
    .event('DecisionDecided', {
      outcome: outcomeJson(outcome),
      closedAs,
      link: link === null ? null : linkJson(link),
    })
    .done();
};

/**
 * Row D12: an admin reopens a learning the pipeline closed. The decision goes back to Planning with no outcome, no
 * implementer and no sign-off; `closedAs`, `archived`, the text coverage and the closing link go. A merge the admin undid
 * keeps the pair apart: the merged-into learning becomes a `kept_apart_from` link, so consolidation never merges them again.
 */
export const reopenClosedDecision = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'decision') return notDecision(glob, actor);
  if (actor.role !== 'admin')
    return forbidden('Only admins can reopen a learning the pipeline closed');
  const attributes = decisionAttributesOf(glob);
  const closedAs = attributes.closedAs;
  if (glob.status !== 'signed_off' || closedAs === undefined)
    return invalidTransition(
      glob,
      actor,
      'Only a decision the knowledge pipeline closed can be reopened this way',
    );
  const before = glob.links ?? [];
  const former = before.find((l) => l.kind === 'duplicate_of')?.id ?? null;
  const links = before.filter((l) => !CLOSING_EDGE_KINDS.includes(l.kind));
  const keepApart =
    former !== null && !links.some((l) => l.kind === 'kept_apart_from' && l.id === former);
  const next: MutableAttributes = { ...withOutcome(attributes, null, false) };
  delete next.closedAs;
  delete next.coveredByText;
  return new Builder(glob, ctx)
    .set({
      attributes: next,
      links: keepApart
        ? [...links, { id: former, kind: 'kept_apart_from', source: 'explicit' }]
        : links,
      implementer: null,
      signedOffAt: null,
    })
    .status('planning')
    .event('DecisionReopened', { closedAs })
    .done();
};

/**
 * The learning was approved (on the Knowledge page, by an agent, or through the decision's own Accept): the decision is
 * accepted, picked up or not, and moves to Reviewing. `kind` says whether the draft was edited first.
 */
export const decisionApproved = (
  glob: Glob,
  approval: {
    readonly by: string;
    readonly kind?: 'accept' | 'accept_with_edits';
    readonly reason?: string | null;
  },
  ctx: Context,
): Result<Transition> => {
  if (glob.category !== 'decision') return unchanged(glob);
  const attributes = decisionAttributesOf(glob);
  const current = attributes.outcome?.kind;
  if (current === 'accept' || current === 'accept_with_edits') return unchanged(glob);
  const reason = approval.reason ?? null;
  const outcome: DecisionOutcome = {
    kind: approval.kind ?? 'accept',
    by: approval.by,
    at: ctx.now,
    ...(reason === null ? {} : { reason }),
  };
  return releaseWaiting(new Builder(glob, ctx), glob)
    .set({ attributes: withOutcome(attributes, outcome, false) })
    .status('reviewing')
    .event('DecisionDecided', { outcome: outcomeJson(outcome), via: 'knowledge' })
    .done();
};

/** The item behind a decision was rejected on the Knowledge page (or by an agent): the decision ends Signed off, archived. */
export const decisionRejected = (
  glob: Glob,
  rejection: { readonly by: string; readonly reason: string },
  ctx: Context,
): Result<Transition> => {
  if (glob.category !== 'decision') return unchanged(glob);
  const attributes = decisionAttributesOf(glob);
  if (attributes.outcome?.kind === 'reject' && attributes.archived === true) return unchanged(glob);
  const outcome: DecisionOutcome = {
    kind: 'reject',
    by: rejection.by,
    at: ctx.now,
    reason: rejection.reason,
  };
  return releaseWaiting(new Builder(glob, ctx), glob)
    .set({ attributes: withOutcome(attributes, outcome, true), signedOffAt: ctx.now })
    .status('signed_off')
    .event('DecisionDecided', { outcome: outcomeJson(outcome), via: 'knowledge' })
    .done();
};

/**
 * The learning is open again after an agent's decision was reopened: the decision goes back to Planning with no
 * outcome. Nothing to do for a decision that is already open or waits on work. (One the pipeline closed is reopened by D12.)
 */
export const decisionReopened = (glob: Glob, ctx: Context): Result<Transition> => {
  if (glob.category !== 'decision') return unchanged(glob);
  const attributes = decisionAttributesOf(glob);
  const kind = attributes.outcome?.kind;
  // An item that stays open beside a needs-work decision is the expected state (the work lands first).
  if (kind === 'needs_work') return unchanged(glob);
  if (kind === undefined && attributes.archived !== true && glob.status !== 'signed_off')
    return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ attributes: withOutcome(attributes, null, false), implementer: null, signedOffAt: null })
    .status('planning')
    .event('AttributesChanged', { outcome: null })
    .done();
};

/** The broader decisions this one contradicts changed (`conflictsWith`); a repeat changes nothing. */
export const decisionConflicts = (
  glob: Glob,
  ids: readonly string[],
  ctx: Context,
): Result<Transition> => {
  if (glob.category !== 'decision') return unchanged(glob);
  const attributes = decisionAttributesOf(glob);
  const before = attributes.conflictsWith ?? [];
  if (before.join('\n') === ids.join('\n')) return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ attributes: withConflicts(attributes, ids) })
    .event('AttributesChanged', { conflictsWith: [...ids] })
    .done();
};

/** What a person can do with a decision (drives the glob view's buttons): there is no start, merge, retrigger or labels. */
const decisionActions = (glob: Glob, actor: Actor): Action[] => {
  const actions: Action[] = [];
  if (mayDecide(actor)) {
    if (
      glob.status === 'planning' ||
      (glob.status === 'in_progress' && glob.implementer !== actor.email)
    )
      actions.push('pick_up');
    if (glob.status === 'in_progress') {
      const outcome =
        glob.attributes !== undefined && isDecisionAttributes(glob.attributes)
          ? glob.attributes.outcome
          : null;
      if (outcome === null || outcome.kind === 'needs_work') actions.push('decide');
    }
    if (glob.status === 'reviewing') actions.push('sign_off', 'reopen');
    const attributes =
      glob.attributes !== undefined && isDecisionAttributes(glob.attributes)
        ? glob.attributes
        : null;
    // A learning the KB pipeline closed: admins reopen it (row D12).
    if (
      glob.status === 'signed_off' &&
      attributes?.closedAs !== undefined &&
      actor.role === 'admin'
    )
      actions.push('reopen');
    // A learning an agent submitted or slop mined is never deleted: it is rejected instead.
    const learning = attributes?.origin.kind === 'submitted' || attributes?.origin.kind === 'mined';
    if (!learning) actions.push('delete');
  }
  return actions;
};
