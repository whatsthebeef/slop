/**
 * The glob state machine. Every function is pure: it takes the glob's current state and
 * returns the next state plus the domain events to log and the effects to queue, or a
 * domain error. The numbered rows refer to the transition table in the spec.
 */
import { canChooseType } from '../app/access.js';
import { err, forbidden, invalidCombination, invalidInput, ok, runActive } from './errors.js';
import type { Result } from './errors.js';
import { advanceMergeLineEffect, suggestEffect } from './events.js';
import { isInMergeLine, mergeHeadChecksPassed, mergeHeadStuck, mergeHeadStuckReason } from './merge-line.js';
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
import { pendingTimedOut } from './pending-action.js';
import { actionOf, actionState, hasBranchRecord, preparationOf } from './action-glob.js';
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
import { scriptMissingText } from './action-script.js';
import type { ActionScript } from './action-script.js';
import { CLOSING_EDGE_KINDS, defaultFix, defaultWorkKind, fixOf, isHumanCategory, SLOP_TYPES, storedCategory, workKindOf } from './types.js';
import { criterionOf } from './escalation-learning.js';
import { isReplaceableInferred, mergeImplied, mergeInferred } from './exclusive-paths.js';
import {
  awaitedNames,
  gateOverrideEdits,
  withEdits,
  OTHER_BOARD_GLOB,
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
import {
  MAX_QUESTIONS,
  MAX_QUESTION_ANSWER,
  MAX_QUESTION_NOTE,
  canAnswer,
  checkNewQuestion,
  holdsStart,
  isOpenQuestion,
  matchOption,
  mergeQuestions,
  isPlanChangedQuestion,
  pendingRerun,
  RERUN_OPTION,
  nextQuestionId,
  questionAwaits,
  questionGateText,
  questionsOf,
  startHoldsOf,
  startQuestions,
} from './questions.js';
import type { NewQuestion, OpenQuestion, QuestionRaiser } from './questions.js';
import { rolloutPending, reviewOpensWhenDone } from './human-steps.js';
import type { BlockProgress } from './human-steps.js';
import type {
  ClickOutcome,
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
  InferenceSource,
  HeadChecks,
  ImpliedAfter,
  LabelName,
  LabelState,
  Labels,
  MergeConflict,
  MergedPr,
  OpenConflict,
  PullRequest,
  Role,
  Run,
  RunOutcome,
  RunPurpose,
  SlopType,
  Status,
  WorkKind,
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
  /** A same, super or sub with a ready PR that `merge` relations hold back merges now (or goes on as armed), with a reason. */
  | 'merge_anyway'
  /** A merged glob with approved labels that `sign_off` relations hold back is signed off now, with a reason. */
  | 'sign_off_anyway'
  | 'pick_up'
  /** A picked-up plain action goes back to Planning. */
  | 'back_to_planning'
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
  /** Failed checks on a head nobody fixes in code (an agent-set glob, or a failure the base explains): re-run the failed jobs. */
  | 'retry_checks'
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
  /** Decision globs: take an accepted decision back to Doing to choose again. Work globs: a merged glob in Reviewing starts its next generation. */
  | 'reopen'
  /** Action globs: a person did it; marks the action done. */
  | 'complete_action'
  /** Action globs: not needed after all; ends the action with a reason. */
  | 'dismiss_action'
  /** Prepared action globs: start (or retry) a preparation round: a routine writes what the person will run. */
  | 'prepare_action'
  /** Prepared action globs: the person ran it and it failed; another preparation round starts on the same branch with the output. */
  | 'fail_action'
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
  /** An action's script and whether it is on the base branch (null: it names none); absent where not checked. */
  readonly script?: ActionScript | null;
  /** The board's base branch, for the words of a refusal about the script (main when absent). */
  readonly baseBranch?: string;
  /** The work steps holding back sign-off, where loaded (sign-off is refused while any is open). */
  readonly rollout?: BlockProgress;
  /** Open rollout steps holding back sign-off (`openRolloutSteps`), where loaded: a same with any lands with Merge and continue. */
  readonly rolloutSteps?: number;
  /** The glob's latest build failed and nobody has acted since (`buildFailedFor`), where loaded: Retry starts a fix run that reads the log. */
  readonly buildFailed?: boolean;
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
 * A Re-run answer on a plan-changed question that nobody is working on: no push since the answer, no one implementing, and no run
 * queued or active (none, or one idling in `watching`). Start is then the glob's next step, and the status says the re-run didn't
 * start the work.
 */
export const rerunIdle = (glob: Pick<Glob, 'status' | 'type' | 'implementer' | 'questions' | 'pr' | 'runs'>): boolean => {
  const run = glob.runs.at(-1);
  return (
    glob.status === 'pr_open' &&
    glob.type !== 'super' &&
    glob.implementer === null &&
    pendingRerun(glob) !== null &&
    !(run !== undefined && (run.state === 'queued' || run.state === 'active'))
  );
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
  /** The glob as the transition found it: what `settlePending` compares against. */
  private readonly began: Glob;

  constructor(
    private glob: Glob,
    private readonly ctx: Context,
  ) {
    this.began = glob;
  }

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
    // Human work (a decision, an action) never gets a branch or a PR, except an action whose preparation is written on a branch.
    if ((isHumanCategory(this.glob.category) && !hasBranchRecord(this.glob)) || this.glob.provisioning !== 'none') return this;
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
    const awaited = startHoldsOf(this.glob, relations);
    if (awaited.length > 0)
      return this.set({ waiting: { since: this.glob.waiting?.since ?? this.ctx.now } }).event('Waiting', {
        for: awaitedNames(awaited),
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

  /**
   * A click's pending action ends when the glob moves on: its status, provisioning, head, conflict, failure, merge mode or head
   * checks changed, or its run did (with a `runId`, that run ended or was replaced). A new failure, or the run failing, is stored as
   * the last outcome; a success leaves none. With nothing new, it ends as `timed_out` once older than the timeout (a read sees it
   * expire without a write, so this only records it when some other change is written anyway).
   */
  private settlePending(): void {
    const pending = this.began.pendingAction;
    // Nothing pending, or this very transition set (or replaced) it.
    if (pending == null || this.glob.pendingAction !== pending || !this.changed) return;
    const [was, now] = [this.began, this.glob];
    const [before, run] = [currentRun(was), currentRun(now)];
    const sig = (v: unknown): string => JSON.stringify(v ?? null);
    const failedNow = now.failure != null && sig(now.failure) !== sig(was.failure);
    const runEnded = run !== null && run.state === 'ended' && (pending.runId === undefined ? run.id === before?.id && before.state !== 'ended' : run.id === pending.runId);
    const runMoved =
      pending.runId === undefined ? run?.id !== before?.id || run?.state !== before?.state : run?.id !== pending.runId || run.state === 'ended';
    const moved =
      now.status !== was.status ||
      now.provisioning !== was.provisioning ||
      now.pr?.headSha !== was.pr?.headSha ||
      now.mergeMode !== was.mergeMode ||
      sig(now.conflict) !== sig(was.conflict) ||
      sig(now.headChecks) !== sig(was.headChecks) ||
      failedNow ||
      runMoved;
    const outcome = (result: 'failed' | 'timed_out', reason: string): ClickOutcome => ({
      kind: pending.kind,
      at: this.ctx.now,
      by: pending.by,
      result,
      reason,
    });
    if (moved) {
      const failedRun = runEnded && run.outcome === 'failed';
      const reason = failedNow ? now.failure.reason : failedRun ? (run.failureReason ?? 'The run failed') : null;
      this.glob = { ...now, pendingAction: null, lastOutcome: reason === null ? null : outcome('failed', reason) };
    } else if (pendingTimedOut(now, pending, this.ctx.now)) {
      this.glob = { ...now, pendingAction: null, lastOutcome: outcome('timed_out', `${pending.kind} had no effect after a minute`) };
    }
  }

  /**
   * A `timed_out` last outcome says the click had no effect; once any later transition moves the glob (status, run or PR), whatever
   * triggered it (web, MCP, CLI, webhook), that no longer holds. A `failed` outcome stays until the next click.
   */
  private clearStaleTimeout(): void {
    const outcome = this.glob.lastOutcome;
    if (outcome == null || outcome.result !== 'timed_out' || this.began.lastOutcome !== outcome) return;
    const [was, now] = [this.began, this.glob];
    const [before, run] = [currentRun(was), currentRun(now)];
    const moved =
      now.status !== was.status ||
      now.pr?.headSha !== was.pr?.headSha ||
      now.pr?.state !== was.pr?.state ||
      run?.id !== before?.id ||
      run?.state !== before?.state;
    if (moved) this.glob = {...now, lastOutcome: null};
  }

  /** `touch: false` leaves `updatedAt` alone (a click's own record is not activity on the glob: reconcile and stall clocks read it). */
  done(touch = true): Result<Transition> {
    this.settlePending();
    this.clearStaleTimeout();
    const glob = this.changed && touch ? { ...this.glob, updatedAt: this.ctx.now } : this.glob;
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

/**
 * A person's click went through and its effect (a queued run, a merge) is still to show: every view reads the glob as in progress
 * until it moves on (`Builder.done` settles it). A new click clears the last outcome, which is how a notice goes away.
 */
export const actionRequested = (glob: Glob, input: { readonly kind: Action; readonly runId?: string }, ctx: Context): Result<Transition> =>
  new Builder(glob, ctx)
    .set({
      pendingAction: {
        kind: input.kind,
        at: ctx.now,
        by: ctx.actor?.email ?? '',
        ...(input.runId === undefined ? {} : { runId: input.runId }),
      },
      lastOutcome: null,
    })
    .done(false);

/** Any other action click clears the last outcome, so a notice goes away on the next click whatever it was; nothing to write without one. */
export const outcomeCleared = (glob: Glob, ctx: Context): Result<Transition> =>
  glob.lastOutcome == null ? unchanged(glob) : new Builder(glob, ctx).set({ lastOutcome: null }).done(false);

/** A click the machine refused is kept as the glob's last outcome (with the reason), so the refusal shows after the toast is gone. */
export const actionRefused = (glob: Glob, input: { readonly kind: Action; readonly reason: string }, ctx: Context): Result<Transition> =>
  new Builder(glob, ctx)
    .set({ lastOutcome: { kind: input.kind, at: ctx.now, by: ctx.actor?.email ?? '', result: 'failed', reason: input.reason } })
    .done(false);

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
// Open questions: helpers

/** What the log says of a raised question. */
const questionEventData = (q: OpenQuestion): { readonly [key: string]: JsonValue } => ({
  id: q.id,
  ...(q.key === undefined ? {} : { key: q.key }),
  blocking: q.blocking,
  source: q.source,
  raisedBy: q.raisedBy.kind,
});

/** The questions a glob is created with: checked, deduplicated by key, given IDs. A parked super holds nothing, so its start questions are notices. */
const materialize = (asked: readonly NewQuestion[], parked: boolean, now: string): Result<OpenQuestion[]> => {
  const made: OpenQuestion[] = [];
  for (const raw of asked) {
    const checked = checkNewQuestion(raw);
    if (!checked.ok) return checked;
    const q = checked.value;
    if (q.key !== undefined && made.some((m) => m.key === q.key)) continue;
    if (made.length >= MAX_QUESTIONS) return invalidInput(`A glob can have at most ${String(MAX_QUESTIONS)} questions`);
    made.push({
      id: nextQuestionId(made),
      ...(q.key === undefined ? {} : { key: q.key }),
      text: q.text,
      ...(q.options === undefined ? {} : { options: q.options }),
      ...(q.commands === undefined ? {} : { commands: q.commands }),
      raisedBy: q.raisedBy,
      source: q.source,
      blocking: parked && q.blocking === 'start' ? 'none' : q.blocking,
      raisedAt: now,
    });
  }
  return ok(made);
};

/** The glob's questions with every open start hold marked as gone past by `by` (Start now, picking it up by hand). */
const overrideStart = (glob: Glob, by: string, now: string): readonly OpenQuestion[] =>
  questionsOf(glob).map((q) => (holdsStart(q) ? { ...q, startOverridden: { by, at: now } } : q));

// ---------------------------------------------------------------------------
// Creation (rows 1–4)

export interface CreateInput {
  readonly id: string;
  readonly boardId: number;
  readonly title: string;
  /** Null for human work (decision, action). */
  readonly type: SlopType | null;
  readonly category: Category;
  /** Default: the category's (bug fixes, else not). Human work is never a fix. */
  readonly fix?: boolean;
  readonly fixSource?: InferenceSource;
  /** Default: the asked category's (feature is R&D, else maintenance), read before `feature` is stored as a task. */
  readonly workKind?: WorkKind;
  readonly workKindSource?: InferenceSource;
  readonly inferenceReason?: string | null;
  /** Decisions and actions: the full attributes (scope, source, channel); validated by `create`. Work globs: none. */
  readonly attributes?: GlobAttributes;
  readonly group: string | null;
  readonly environment: string | null;
  /** Same only: start a routine run immediately (explicit instruction or `autoTrigger`). */
  readonly autoTrigger: boolean;
  /** Predicted overlaps found for this glob before it was created (merge-policy holds; they never hold a start). */
  readonly impliedAfter?: readonly ImpliedAfter[];
  /** Accepted for compatibility and ignored: a super always waits in Planning until a person picks it up to pair. */
  readonly start?: boolean;
  /** Questions raised with the glob (intake's doubts): a start-blocking one creates it held, whatever its type. */
  readonly questions?: readonly NewQuestion[];
  /** A prepared action: the globs it waits for (start relations not yet met). It is created in Planning, waiting, and prepares when they merge. */
  readonly waitingFor?: readonly string[];
}

/** The stored fix and work kind of a new glob: what was given, else the category's defaults; human work is never a fix and counts as maintenance. */
const inferenceFields = (
  input: Pick<CreateInput, 'category' | 'fixSource' | 'workKind' | 'workKindSource' | 'inferenceReason'>,
  fix: boolean,
): Pick<Glob, 'fix' | 'fixSource' | 'workKind' | 'workKindSource' | 'inferenceReason'> => ({
  fix,
  fixSource: input.fixSource ?? 'inferred',
  workKind: isHumanCategory(input.category) ? 'maintenance' : (input.workKind ?? defaultWorkKind(input.category)),
  workKindSource: input.workKindSource ?? 'inferred',
  inferenceReason: input.inferenceReason ?? null,
});

export const create = (
  asked: CreateInput,
  board: Board,
  ctx: Context,
  /** The relations the new glob starts with (made by the service, already checked) and the state of what they point at. */
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  const actor = requireActor(ctx);
  // An asked `feature` means R&D: read that before it is stored as a task.
  const input: CreateInput = {
    ...asked,
    category: storedCategory(asked.category),
    ...(isHumanCategory(asked.category) ? {} : { workKind: asked.workKind ?? defaultWorkKind(asked.category) }),
  };
  const fix = isHumanCategory(input.category) ? false : (input.fix ?? defaultFix(input.category));
  if (!isValidCombination(input.type, input.category, fix)) {
    return invalidCombination(`A ${fix ? 'fix' : input.category} cannot be a ${input.type}`);
  }
  if ((actor.role === 'qa' || actor.role === 'po') && input.type === 'super') {
    return forbidden('QA and PO members cannot create supers');
  }
  if (input.title.trim() === '') return invalidInput('A glob needs a title');
  if (input.category === 'decision') return createDecision(input, ctx, actor);
  if (input.category === 'action') return createAction(input, ctx, actor);
  const type = input.type;
  if (type === null) return invalidCombination(`A ${input.category} needs a type`);
  // No board default: GlobService.create picks one with pickEnvironment before this runs, and none stays unset.
  const environment = input.environment ?? null;
  const envCheck = checkEnvironment(board, environment);
  if (!envCheck.ok) return envCheck;

  const impliedAfter = input.impliedAfter ?? [];
  const raised = materialize(input.questions ?? [], type === 'super', ctx.now);
  if (!raised.ok) return raised;
  const questions = raised.value;
  const awaited = [...awaitedOf(relations), ...questionAwaits({ questions })];
  const wantsStart = type === 'sub' || (type === 'same' && input.autoTrigger);
  // A sub (or auto-started same) with something unmerged to wait for, or a question to be answered, sits in Planning, with no branch, until released.
  const held = wantsStart && awaited.length > 0;
  const autoStart = type === 'same' && input.autoTrigger && !held;
  // A super always waits in Planning for a person to pick it up, whatever `start` says; nobody's active glob until then.
  const parked = type === 'super';
  const status: Status =
    held || parked ? 'planning' : autoStart ? 'implementing' : initialStatus(type);
  const glob: Glob = {
    id: input.id,
    boardId: input.boardId,
    title: input.title.trim(),
    type,
    category: input.category,
    ...inferenceFields(input, fix),
    group: input.group,
    environment,
    status,
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
    doingSince: listOf(status) === 'doing' ? ctx.now : null,
    listSince: ctx.now,
    ...(impliedAfter.length > 0 && { impliedAfter }),
    ...(held && { waiting: { since: ctx.now } }),
    ...(questions.length > 0 && { questions }),
  };
  const b = new Builder(glob, ctx).event('GlobCreated', {
    type: glob.type,
    category: glob.category,
    fix,
    workKind: workKindOf(glob),
    group: glob.group,
    environment: glob.environment,
    status,
  });
  for (const q of questions) b.event('QuestionRaised', questionEventData(q));
  // Subs and auto-started sames start in Doing, so they provision now; a super waits in Planning.
  if (listOf(status) === 'doing') b.ensureProvisioned();
  if (held)
    b.event('Waiting', {
      for: awaitedNames(awaited),
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
  // A Re-run answer left nothing working: Start runs the work again on the current plan (the idle watcher is replaced).
  if (rerunIdle(glob)) {
    if (restrictedFrom(actor, glob)) return forbidden(`QA and PO members cannot start ${glob.type}s`);
    const b = new Builder(glob, ctx);
    if (hasLiveRun(glob)) b.endRun('superseded', null, { cause: 'plan_changed' });
    return b.queueRun(actor.email).done();
  }
  if (glob.status !== 'planning' || glob.type !== 'same') {
    return invalidTransition(glob, actor, 'Only a same in planning can be started');
  }
  if (restrictedFrom(actor, glob)) return forbidden(`QA and PO members cannot start ${glob.type}s`);
  // A second Start while the first waits for the investigation changes nothing.
  if (startQueued(glob)) return unchanged(glob);
  const awaited = startHoldsOf(glob, relations);
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

/**
 * Whether a glob can be independently reviewed on demand: it has a PR (open or merged) and is in Doing or Reviewing. Not
 * while it is merging: the change is about to land and the after-merge review runs anyway.
 */
/** Whether the PR holds code beyond the branch's empty start commit; a merged PR always does, and one with no start recorded is assumed to. */
export const prHasWork = (pr: PullRequest): boolean =>
  pr.state === 'merged' || pr.startSha == null || pr.headSha === null || !sameCommit(pr.headSha, pr.startSha);

export const canReviewNow = (glob: Glob): boolean =>
  glob.pr !== null &&
  glob.pr.state !== 'closed' &&
  prHasWork(glob.pr) &&
  glob.status !== 'merging' &&
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
  /** Why, in the person's words; recorded on the event (optional: older callers send none). */
  reason?: string,
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
  const awaited = startHoldsOf(glob, relations);
  if (awaited.length === 0 && glob.waiting == null) {
    return invalidTransition(glob, actor, 'Nothing holds this glob; use Start');
  }
  // The inferred and learned start relations are marked overridden (a person's and a split's keep holding on paper, but the
  // glob starts); the predicted overlaps on the glob are kept as they are, so a recheck doesn't replace them. An open start
  // question stops holding too, and the question stays open (a person still owes the answer).
  const overriding = startQuestions(glob);
  const overridden = {
    ...(glob.impliedAfter === undefined
      ? {}
      : { impliedAfter: glob.impliedAfter.map((i) => ({ ...i, overridden: true as const })) }),
    ...(overriding.length === 0 ? {} : { questions: overrideStart(glob, actor.email, ctx.now) }),
  };
  const b = new Builder(glob, ctx)
    .relationEdits(overrideEdits(relations.relations, ctx.now))
    .event('HoldOverridden', {
      for: awaitedNames(awaited),
      ...(reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() }),
      ...(overriding.length === 0 ? {} : { questions: overriding.map((q) => q.id) }),
    });
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
  if (startHoldsOf(glob, relations).length > 0) return unchanged(glob);
  // A prepared action starts its first preparation round, as a sub starts its run.
  if (glob.category === 'action') {
    if (preparationOf(glob) === null) return unchanged(glob);
    return startRound(new Builder(glob, ctx).set({ waiting: null }).event('Released', { after: startIds(relations.relations) }), glob.creator).done();
  }
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
  (actor.role === 'qa' || actor.role === 'po') && glob.type !== 'sub' && glob.category !== 'action';

export interface PickUpOptions {
  readonly takeOver: boolean;
  /** Chosen at pick-up: must exist on the board and allow branch deploys. */
  readonly environment?: string | null;
  /** The glob's relations: picking up a held glob works, and notes what hadn't merged. */
  readonly relations?: RelationFacts;
  /** Open rollout steps holding back sign-off: a merged glob can be picked up only while it has any. */
  readonly rolloutSteps?: number;
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
  if (glob.category === 'action') {
    // Row A10: a prepared action's branch is read, not worked on: no implementer, no brief. The person opens a worktree on it to run
    // the prepared script. Any other action has no branch or run: picking it up moves it to Doing with the person (see pickUpAction).
    const state = actionState(glob);
    if ((state === 'ready' || state === 'recording') && hasBranchRecord(glob) && glob.pr !== null) return unchanged(glob);
    if (options.takeOver) return invalidTransition(glob, actor, 'An action is picked up, not taken over');
    return pickUpAction(glob, ctx);
  }
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
        // A person going ahead by hand is past any start question.
        ...(startQuestions(glob).length === 0 ? {} : { questions: overrideStart(glob, actor.email, ctx.now) }),
      }).status('in_progress');
      break;
    case 'pr_open':
    case 'in_progress':
      // Rows 7 and 9.
      if (liveInvestigation(glob) === null) b.endRun('superseded', null, { cause: 'pick_up' });
      b.set({ implementer: actor.email });
      break;
    case 'reviewing':
      // Row 9a: a merged glob that is open for its rollout steps; no status change, no run to supersede.
      if (glob.pr?.state !== 'merged' || (options.rolloutSteps ?? 0) === 0)
        return invalidTransition(glob, actor, 'A merged glob can be picked up only while it has open rollout steps');
      if (glob.implementer === actor.email) return environmentChanged ? setEnvironment(b, environment).done() : unchanged(glob);
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
    ...(unmerged.length > 0 && { waitingFor: awaitedNames(unmerged) }),
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
const canRetryAutofix = (glob: Glob, facts: ActionFacts = {}): boolean => {
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
  // A failed branch deploy nobody has acted on: a fix run reads the build log (an attachment) and pushes a fix.
  if (facts.buildFailed === true && (glob.pr.state === 'ready' || glob.pr.state === 'draft') && glob.conflict == null) return true;
  return (
    glob.failure !== null &&
    glob.failure.kind === undefined &&
    run?.state === 'ended' &&
    run.outcome === 'failed' &&
    run.purpose !== 'resolve_conflict'
  );
};

/** Row 25a: Retry auto-fix. A new routine run watches the same PR on the same branch; the failure clears. */
export const retryAutofix = (glob: Glob, ctx: Context, facts: ActionFacts = {}): Result<Transition> => {
  const actor = requireActor(ctx);
  if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
  if (!canRetryAutofix(glob, facts))
    return invalidTransition(glob, actor, 'Only a ready PR whose auto-fix ended can retry it');
  // On an action's record the run is a preparation round's kind: it fixes the branch and ends at `mark_ready`, nothing watches.
  return new Builder(glob, ctx)
    .set({ failure: null })
    .queueRun(actor.email, undefined, false, glob.category === 'action' ? 'prepare' : undefined)
    .done();
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
  const headSha = glob.pr?.headSha ?? null;
  if (found.behindBy <= 0) {
    if (before === null) return unchanged(glob);
    return new Builder(glob, ctx)
      .set({ behind: null })
      .event('BehindChanged', { base: found.base, behindBy: 0 })
      .done();
  }
  if (
    before?.base === found.base &&
    (before.headSha ?? null) === headSha &&
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
    headSha,
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
  glob.category !== 'action' &&
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
  // A failed conflict-fix run's failure (no kind) is about the conflict that is now gone. Failures of another kind
  // (needs_pairing, merge, provisioning, reverted) are not about the conflict and stay.
  if (
    glob.failure !== null &&
    glob.failure.kind === undefined &&
    run?.purpose === 'resolve_conflict' &&
    run.state === 'ended' &&
    run.outcome === 'failed'
  ) {
    b.set({ failure: null });
  }
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
    return runActive('Already fixing conflict: the run merges the latest base branch');
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

/**
 * Row 23: Discard and back to Planning. The PR is closed, the branch deleted and the run superseded; the glob returns to
 * Planning for every type and nothing starts. A sub then starts like any sub in Planning (its Start, or its release rules).
 */
export const startAgain = (
  glob: Glob,
  ctx: Context,
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.status === 'reviewing' || glob.status === 'signed_off') {
    return invalidTransition(glob, actor, 'A merged glob cannot be discarded');
  }
  if (restrictedFrom(actor, glob)) {
    return forbidden(`QA and PO members cannot discard ${glob.type}s`);
  }
  const b = new Builder(glob, ctx)
    .endRun('superseded', null, { cause: 'start_again' })
    .bumpGeneration();
  const generation = b.current.generation;
  b.set({
    implementer: null,
    failure: null,
    pr: null,
    mergeMode: null,
    headChecks: null,
    provisioning: 'none',
    ...(glob.waiting == null ? {} : { waiting: null }),
  });
  leavesLine(b, glob)
    .effect({ kind: 'close_pr', globId: glob.id, generation, prNumber: glob.pr?.number ?? null })
    .effect({ kind: 'delete_branch', globId: glob.id, generation })
    .event('DiscardedToPlanning', { from: glob.implementer });
  // A sub that waits for an unmerged glob is held in Planning, as it would be after Start was refused.
  const awaited = glob.type === 'sub' ? startHoldsOf(glob, relations) : [];
  if (awaited.length > 0) {
    b.set({ waiting: { since: ctx.now } }).event('Waiting', { for: awaitedNames(awaited), note: waitSummary(awaited) });
  }
  return b.status('planning').done();
};

/** Why a sub that gained rollout steps became a same (criterion `risk_path`). */
export const ROLLOUT_ESCALATION_REASON = 'Has rollout steps: a person merges it, and it stays open for them';

/** A sub that has rollout steps becomes a same escalated for `risk_path` (row 13d), so it never merges itself with steps left dangling. */
const asRolloutSame = (b: Builder, glob: Glob, ctx: Context): void => {
  b.set({
    type: 'same',
    escalation: { reason: ROLLOUT_ESCALATION_REASON, criterion: 'risk_path', by: 'slop', at: ctx.now },
    ...(glob.mergeHold == null ? {} : { mergeHold: null }),
  })
    .event('FieldsChanged', { type: { from: 'sub', to: 'same' } })
    .event('Escalated', { reason: ROLLOUT_ESCALATION_REASON, criterion: 'risk_path' });
};

/**
 * Row 13d: a work step that holds back sign-off was written for the glob (a person's, the implementation record's or the
 * rollout check's). A sub before its merge becomes a same, so it never merges itself with steps left dangling, and an armed
 * "merge when checks pass" is disarmed (Merge and continue takes its place). Anything else changes nothing, so the caller
 * may run it after every step write.
 */
export const rolloutStepsAdded = (glob: Glob, ctx: Context): Result<Transition> => {
  if (isHumanCategory(glob.category) || isAgentSetGlob(glob)) return unchanged(glob);
  const b = new Builder(glob, ctx);
  if (
    glob.type === 'sub' &&
    (glob.status === 'planning' || glob.status === 'implementing' || glob.status === 'in_progress' || glob.status === 'pr_open')
  ) {
    asRolloutSame(b, glob, ctx);
    if (glob.pr !== null) b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  }
  if (isMergeArmed(glob)) b.set({ mergeMode: null }).event('MergeDisarmed', { reason: 'rollout_steps' });
  return b.done();
};

/**
 * Row 31a: a rollout step failed after the merge. The glob's next generation starts: the merged PR is kept in `prs` (a late
 * observation of it is then a no-op), the branch is deleted and cut again from the base with a fresh draft PR, and a new run
 * implements the fix (or the glob is the person's, with no run, when one implements it). The step stays open, so it is
 * pending until the next merge and due again after it. The failure's note travels as an attachment the service stores.
 */
export const rolloutStepFailed = (
  glob: Glob,
  input: { readonly stepId: string; readonly title: string; readonly stepState: 'open' | 'done' | 'dismissed'; readonly mergeSha?: string | null },
  ctx: Context,
): Result<Transition> => {
  const actor = requireActor(ctx);
  const landed = glob.pr;
  if (glob.status !== 'reviewing' || landed === null || landed.state !== 'merged')
    return invalidTransition(glob, actor, 'Only a merged glob that is open for its rollout steps can start its next generation');
  if (input.stepState === 'dismissed') return invalidTransition(glob, actor, 'That rollout step was dismissed');
  if (restrictedFrom(actor, glob)) return forbidden(`QA and PO members cannot start ${glob.type}s again`);
  return nextGeneration(glob, ctx, actor, landed.number, input.mergeSha ?? '', 'rollout_step_failed', (generation) => [
    'RolloutStepFailed',
    { step: input.stepId, title: input.title, generation },
  ]);
};

/**
 * Row 31b: a person sends a merged glob in Reviewing back to Doing with a reason, as a new generation (the general form of row
 * 31a, which needs a failed rollout step). The reason must be given; the service masks and caps it first, and stores it as an
 * attachment the next run reads. Done rollout steps are reopened by the service.
 */
export const reopen = (glob: Glob, input: { readonly reason: string; readonly mergeSha?: string | null }, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  const landed = glob.pr;
  if (glob.status !== 'reviewing' || landed === null || landed.state !== 'merged')
    return invalidTransition(glob, actor, 'Only a merged glob in Reviewing can be reopened');
  if (restrictedFrom(actor, glob)) return forbidden(`QA and PO members cannot reopen ${glob.type}s`);
  const reason = input.reason.trim();
  if (reason === '') return invalidInput('Say why the glob is reopened');
  return nextGeneration(glob, ctx, actor, landed.number, input.mergeSha ?? '', 'reopened', (generation) => [
    'GlobReopened',
    { reason, generation },
  ]);
};

/**
 * The next generation of a merged glob in Reviewing (rows 31a and 31b): the merged PR is kept in `prs` (a late observation of it
 * is then a no-op), the branch is deleted and cut again from the base with a fresh draft PR, and a new run implements the
 * change (or the glob is the person's, with no run, when one implements it). The callers own the guard, the event and the cause.
 */
const nextGeneration = (
  glob: Glob,
  ctx: Context,
  actor: Actor,
  prNumber: number,
  mergeSha: string,
  cause: 'rollout_step_failed' | 'reopened',
  event: (generation: number) => readonly [DomainEventType, { readonly [key: string]: JsonValue }],
): Result<Transition> => {
  const merged: MergedPr = { number: prNumber, mergeSha, mergedAt: ctx.now };
  const b = new Builder(glob, ctx).endRun('superseded', null, { cause }).bumpGeneration();
  const generation = b.current.generation;
  // A sub that merged and then gained steps (the rollout check writes them after the merge), or that a person sent back, is a
  // same from here on, so the next generation never goes through the sub gate and merges itself unchecked.
  if (glob.type === 'sub') asRolloutSame(b, glob, ctx);
  // A person who implements the glob (a super's creator, or whoever picked it up) fixes it themselves; otherwise a run does.
  const person = glob.type === 'super' || glob.implementer !== null;
  b.set({
    prs: glob.prs.some((p) => p.number === merged.number) ? glob.prs : [...glob.prs, merged],
    pr: null,
    headChecks: null,
    labels: {},
    checklists: {},
    failure: null,
    mergeMode: null,
    conflict: null,
    behind: null,
    provisioning: 'none',
    implementer: person ? (glob.implementer ?? glob.creator) : null,
    ...(glob.mergeHold == null ? {} : { mergeHold: null }),
  })
    .event(...event(generation))
    .effect({ kind: 'delete_branch', globId: glob.id, generation })
    .status(person ? 'in_progress' : 'implementing');
  return (person ? b : b.queueRun(actor.email)).done();
};

export interface MergeOptions {
  /** Row 31: Merge and continue (supers): the glob returns to in_progress once merged. */
  readonly continue: boolean;
  readonly facts?: ActionFacts;
}

/** "Merge when checks pass" is armed: the human step is done and slop merges once the head's checks pass. */
export const isMergeArmed = (glob: Glob): boolean => glob.status === 'pr_open' && glob.mergeMode === 'when_green';

/**
 * Joins the board's merge line: the one seam every merge goes through (Merge pressed on green checks, armed merge whose checks
 * passed, a sub's passed gate, a released hold, an action's record, Retry merge). The glob is `merging` and waits its turn at
 * the back; it does no work until `advanceMergeLine` makes it the head, so no `squash_merge` is queued here.
 */
const joinMergeLine = (b: Builder, ctx: Context, detail: { readonly [key: string]: JsonValue } = {}): Builder => {
  const glob = b.current;
  return b
    .set({ mergeLine: { joinedAt: ctx.now }, mergeUpdates: 0 })
    .status('merging', detail)
    .event('MergeLineJoined', { sha: glob.pr?.headSha ?? '' })
    .effect(advanceMergeLineEffect(glob.boardId));
};

/**
 * Takes the glob out of the merge line it was in (every way out of `merging`: merged, failed, conflict, closed, cancelled,
 * held, deleted) and asks for the next head. Nothing happens to a glob that is not in the line.
 */
const leavesLine = (b: Builder, glob: Glob): Builder =>
  glob.mergeLine == null ? b : b.set({ mergeLine: null }).effect(advanceMergeLineEffect(glob.boardId));

const headChecksPassed = (glob: Glob): boolean =>
  glob.pr?.headSha != null && glob.headChecks?.sha === glob.pr.headSha && glob.headChecks.state === 'passed';

const headChecksFailed = (glob: Glob): boolean =>
  glob.pr?.headSha != null && glob.headChecks?.sha === glob.pr.headSha && glob.headChecks.state === 'failed';

/** The unmet `merge` relations of a glob, where its relations were loaded (none otherwise). */
const mergeGate = (relations: RelationFacts | undefined): Unmet[] => (relations === undefined ? [] : unmet(relations, 'merge'));

/** "Can't merge until s15f82 is merged": what the unmet relations of a gate say, for a refusal. */
const gateText = (held: readonly Unmet[]): string => {
  const text = held.map((u) => holdWords(u.relation, u.external === true)).join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};

/** A same with open rollout steps (s15t228): a person merges it with Merge and continue, so plain Merge and arming are refused. */
const hasRolloutSteps = (glob: Glob, facts: ActionFacts | undefined): boolean =>
  glob.type === 'same' && (facts?.rolloutSteps ?? 0) > 0;

/** Why Merge can't be pressed on a ready same or super right now (not armed, no conflict, checks not failed), or null. */
const mergeBlocker = (glob: Glob, relations?: RelationFacts): string | null => {
  if (glob.status !== 'pr_open' || glob.type === 'sub')
    return 'Only a same or super with a ready PR can be merged';
  // An action's record merges only after the person's run: Done arms it.
  if (glob.category === 'action' && actionOf(glob)?.outcome == null) return 'Mark the action done first: its record merges after the run';
  if (glob.mergeMode === 'when_green') return 'Merge is already waiting for the checks to pass';
  const held = mergeGate(relations);
  if (held.length > 0) return gateText(held);
  return mergeBlockerBesidesRelations(glob);
};

/** What else stops a merge once no relation holds it: an open merge question, a conflict, no head, failed checks (or null). */
const mergeBlockerBesidesRelations = (glob: Glob): string | null => {
  const asks = questionGateText(mergeQuestions(glob));
  if (asks !== null) return asks;
  // Passing checks say nothing about mergeability once the base has moved: GitHub would refuse and fail the glob.
  if (glob.conflict != null)
    return `Conflicts with the base branch since ${glob.conflict.since ?? 'the last push'}: merge the base into the branch and push before merging`;
  if (glob.pr?.headSha == null) return 'The PR has no head yet';
  if (headChecksFailed(glob)) return 'Required checks failed on the current head';
  return null;
};

/**
 * Rows 14 and 31: the Merge button on a same or super. With the head's checks passed it merges
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
  const rollout = hasRolloutSteps(glob, options.facts);
  // Merge on a same with rollout steps is the same as the old Merge and continue alias.
  const keepOpen = options.continue || rollout;
  if (keepOpen) {
    if (glob.type !== 'super' && !rollout)
      return invalidTransition(glob, actor, 'Only a super, or a same with rollout steps, can merge and continue');
    if (!passed) return invalidTransition(glob, actor, 'Required checks have not passed on the current head');
    // A same's record is not required at the head: the steps are what Merge and continue is for.
    if (glob.type === 'super' && !recordAtHead(glob, options.facts ?? {}))
      return invalidTransition(glob, actor, RECORD_NOT_AT_HEAD);
  }
  if (!passed) {
    const b = new Builder(glob, ctx)
      .set({ mergeMode: 'when_green' })
      .event('MergeArmed', { sha: head });
    // A branch behind its base is updated by the merge itself (squash_merge, once it is the line's head and the checks pass).
    // Nothing reported for this head yet (a lost webhook): read it now, so a settled result isn't waited for in vain.
    if (glob.headChecks?.sha !== head)
      b.effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
    return b.done();
  }
  return joinMergeLine(
    // A same with rollout steps lands as a plain merge (Reviewing, steps due): only a super keeps `mergeMode: 'continue'`.
    new Builder(glob, ctx).set({ mergeMode: options.continue && glob.type === 'super' ? 'continue' : null }),
    ctx,
    keepOpen ? { mode: glob.type === 'super' ? 'continue' : 'rollout' } : {},
  ).done();
};

/**
 * Cancel merge: disarms "merge when checks pass", or (row 14c) takes a glob out of its board's merge line, whether it is the
 * head or waiting, and back to pr_open. The next glob in the line becomes head.
 */
export const cancelMerge = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (isInMergeLine(glob)) {
    return leavesLine(
      new Builder(glob, ctx).set({ mergeMode: null, ...(glob.mergeHold == null ? {} : { mergeHold: null }) }),
      glob,
    )
      .event('MergeDisarmed', { reason: 'cancelled' })
      .status('pr_open')
      .done();
  }
  if (!isMergeArmed(glob)) return invalidTransition(glob, actor, 'Merge is not waiting for checks');
  return new Builder(glob, ctx)
    .set({ mergeMode: null, ...(glob.mergeHold == null ? {} : { mergeHold: null }) })
    .event('MergeDisarmed', { reason: 'cancelled' })
    .done();
};

/**
 * Slop updated a behind branch for the merge in progress. The merge chases the base once per request: the next
 * `squash_merge` (on the updated head's passed checks) merges even if the base moved again, unless GitHub reports a conflict.
 */
export const mergeBranchUpdated = (glob: Glob, ctx: Context): Result<Transition> => {
  if (glob.status !== 'merging') return unchanged(glob);
  const updates = (glob.mergeUpdates ?? 0) + 1;
  return new Builder(glob, ctx).set({ mergeUpdates: updates }).event('MergeBranchUpdated', { updates }).done();
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

/**
 * Failed checks a code fix can't help: an agent-set glob (slop commits the set, no run fixes code) or a failure the base
 * branch explains. A glob a routine run or a person works on is fixed by pushing instead.
 */
const canRetryChecks = (glob: Glob): boolean =>
  (glob.status === 'failed' || glob.status === 'pr_open') &&
  glob.pr?.state === 'ready' &&
  glob.conflict == null &&
  glob.type !== 'super' &&
  headChecksFailed(glob) &&
  (isAgentSetGlob(glob) || glob.headChecks?.inheritedFrom !== undefined);

/**
 * Retry checks: re-runs the failed jobs of the head's checks and clears the failure while they run. A failed merge goes
 * back to waiting for the checks, so the glob merges when they pass.
 */
export const retryChecks = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (!canRetryChecks(glob) || hasWorkingRun(glob))
    return invalidTransition(glob, actor, 'Only a ready PR whose checks failed on the current head can retry them');
  const sha = glob.pr?.headSha ?? '';
  const b = new Builder(glob, ctx).set({ failure: null });
  if (glob.failure?.kind === 'merge') {
    b.status('pr_open', { retryChecks: true }).set({ mergeMode: 'when_green' }).event('MergeArmed', { sha });
  }
  return b.effect({ kind: 'rerun_checks', globId: glob.id, generation: glob.generation, sha }).done();
};

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
  const asks = questionGateText(mergeQuestions(glob));
  if (asks !== null) return invalidTransition(glob, actor, asks);
  // Joins the back of the line again (its old place went with the failure).
  return joinMergeLine(new Builder(glob, ctx).set({ failure: null, mergeMode: null }), ctx, { retry: true }).done();
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
  // A glob in the merge line leaves it with its deletion: the next one is made head.
  leavesLine(new Builder(glob, ctx), glob)
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
  // A merged glob whose rollout steps are due sits in Doing: review belongs to Reviewing, so no label command applies yet.
  if (glob.status === 'reviewing' && rollout !== null && rollout.open > 0) {
    return invalidTransition(glob, actor, reviewOpensWhenDone(rollout));
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
      if (signOffHeld.length > 0) b.event('SignOffHeld', { for: signOffHeld.map((u) => (u.external === true ? OTHER_BOARD_GLOB : u.relation.to)) });
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
  /** The fix flag and work kind. A source of `inferred` never overwrites a value a person set; a value given without a source is a person's. */
  readonly fix?: boolean;
  readonly fixSource?: InferenceSource;
  readonly workKind?: WorkKind;
  readonly workKindSource?: InferenceSource;
  readonly inferenceReason?: string | null;
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

/**
 * Re-inference after the plan changed: a system step that refreshes the inferred fix flag, work kind and the reason. A value a
 * person set (source `person`) is never touched, a fix is never a super, and nothing but those fields moves, so there is no
 * notification beyond the recorded `FieldsChanged`. Sources stay `inferred`.
 */
export const workReinferred = (
  glob: Glob,
  found: { readonly fix: boolean; readonly workKind: WorkKind; readonly reason: string | null },
  ctx: Context,
): Result<Transition> => {
  if (isHumanCategory(glob.category)) return unchanged(glob);
  const fixSticks = (glob.fixSource ?? 'inferred') === 'person';
  const kindSticks = (glob.workKindSource ?? 'inferred') === 'person';
  const fix = fixSticks ? fixOf(glob) : found.fix && isValidCombination(glob.type, glob.category, true);
  const workKind = kindSticks ? workKindOf(glob) : found.workKind;
  const diff: { [key: string]: JsonValue } = {};
  const patch: { -readonly [K in keyof Glob]?: Glob[K] } = {};
  if (fix !== fixOf(glob)) {
    diff['fix'] = { from: fixOf(glob), to: fix };
    patch.fix = fix;
  }
  if (workKind !== workKindOf(glob)) {
    diff['workKind'] = { from: workKindOf(glob), to: workKind };
    patch.workKind = workKind;
  }
  if (!(fixSticks && kindSticks) && found.reason !== (glob.inferenceReason ?? null)) {
    diff['inferenceReason'] = { from: glob.inferenceReason ?? null, to: found.reason };
    patch.inferenceReason = found.reason;
  }
  if (Object.keys(diff).length === 0) return unchanged(glob);
  return new Builder(glob, ctx).set(patch).event('FieldsChanged', diff).done();
};

/** Changing fields is not a transition, except same → sub from planning (row 26). */
export const changeFields = (
  glob: Glob,
  asked: FieldChanges,
  board: Board,
  ctx: Context,
  /** The glob's relations as they will be once the change is written (the service has checked and planned them). */
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  const actor = requireActor(ctx);
  // An asked `feature` is stored as a task. Its R&D meaning only moves a still-inferred work kind when the category really changes.
  const changes: FieldChanges = asked.category === 'feature' ? { ...asked, category: storedCategory(asked.category) } : asked;
  if (
    changes.category !== undefined &&
    changes.category !== glob.category &&
    (isHumanCategory(changes.category) || isHumanCategory(glob.category))
  ) {
    return invalidCombination('A glob cannot move into or out of human work, nor between a decision and an action');
  }
  const type = changes.type ?? glob.type;
  const category = changes.category ?? glob.category;
  // Fix and work kind: inference never overwrites a person's value; a bare value is a person's; a category alias (one
  // release) moves a still-inferred value to the new category's default.
  const human = isHumanCategory(category);
  // A legacy `feature` glob asked to be a task (or a feature) is not a change: both are the same stored category.
  const categoryChanged = changes.category !== undefined && storedCategory(changes.category) !== storedCategory(glob.category);
  const currentFixSource = glob.fixSource ?? 'inferred';
  const currentKindSource = glob.workKindSource ?? 'inferred';
  const fixBy: InferenceSource = changes.fixSource ?? (changes.fix === undefined ? currentFixSource : 'person');
  const kindBy: InferenceSource = changes.workKindSource ?? (changes.workKind === undefined ? currentKindSource : 'person');
  const fixSticks = changes.fix !== undefined && fixBy === 'inferred' && currentFixSource === 'person';
  const kindSticks = changes.workKind !== undefined && kindBy === 'inferred' && currentKindSource === 'person';
  const fix = human
    ? false
    : changes.fix !== undefined && !fixSticks
      ? changes.fix
      : categoryChanged && currentFixSource === 'inferred'
        ? defaultFix(category)
        : fixOf(glob);
  const workKind = human
    ? 'maintenance'
    : changes.workKind !== undefined && !kindSticks
      ? changes.workKind
      : categoryChanged && currentKindSource === 'inferred'
        ? defaultWorkKind(asked.category ?? category)
        : workKindOf(glob);
  const fixSource = fixSticks ? currentFixSource : changes.fix !== undefined ? fixBy : currentFixSource;
  const workKindSource = kindSticks ? currentKindSource : changes.workKind !== undefined ? kindBy : currentKindSource;
  if (!isValidCombination(type, category, fix)) {
    return invalidCombination(`A ${fix ? 'fix' : category} cannot be a ${type}`);
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
    if (key === 'category' && !categoryChanged) continue;
    if (value !== undefined && value !== glob[key]) {
      Object.assign(patch, { [key]: value });
      diff[key] = { from: glob[key], to: value };
    }
  }
  // The reason follows the values: given with a change, or alone (a silent re-inference that only refreshed it). A
  // sticky person's value keeps its own reason.
  const inference: Array<[string, JsonValue, JsonValue, Partial<Glob>]> = [
    ['fix', fixOf(glob), fix, { fix }],
    ['fixSource', currentFixSource, fixSource, { fixSource }],
    ['workKind', workKindOf(glob), workKind, { workKind }],
    ['workKindSource', currentKindSource, workKindSource, { workKindSource }],
  ];
  const reason = fixSticks && kindSticks ? undefined : changes.inferenceReason;
  if (reason !== undefined) inference.push(['inferenceReason', glob.inferenceReason ?? null, reason, { inferenceReason: reason }]);
  for (const [key, from, to, set] of inference) {
    if (from === to) continue;
    Object.assign(patch, set);
    diff[key] = { from, to };
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
    const awaited = startHoldsOf(glob, relations);
    if (awaited.length > 0) {
      if (!wasHeld) {
        b.set({
          waiting: { since: ctx.now },
          ...(impliedAfter === undefined ? {} : { impliedAfter }),
        }).event('Waiting', { for: awaitedNames(awaited), note: waitSummary(awaited) });
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
    return isValidCombination(to, glob.category, fixOf(glob)) ? [{ to }] : [];
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
    b.set({
      pr: { number: result.pr.number, state: 'draft', headSha: result.pr.headSha, startSha: result.pr.headSha },
    }).event(
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
  if (glob.pr !== null) {
    const startSha = isStartPush(glob, push) && glob.pr.startSha == null ? push.sha : glob.pr.startSha;
    b.set({ pr: { ...glob.pr, headSha: push.sha, ...(startSha === undefined ? {} : { startSha }) } });
  }
  // A new head keeps its place in the merge line; the merge starts over on the new head's checks (below), and a head's
  // stuck clock restarts.
  if (glob.mergeLine?.head != null) b.set({ mergeLine: { joinedAt: glob.mergeLine.joinedAt, head: { since: ctx.now } } });
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
    // A Re-run run's push is the work it was started for: from here it watches the new head like any run on a ready PR.
    const reran = glob.status === 'pr_open' && run.purpose === undefined && pendingRerun(glob) !== null;
    b.updateRun({ lastProgressAt: ctx.now, state: reran ? 'watching' : run.state === 'queued' ? 'active' : run.state });
  }
  // A new head is a different commit from the one the person armed the merge on: they press Merge again. An action's record
  // is the exception: Done armed it for whatever the branch holds, so a fix pushed after Done keeps the merge armed.
  const recording = glob.category === 'action' && actionState(glob) === 'recording';
  if (isMergeArmed(glob) && !recording) b.set({ mergeMode: null }).event('MergeDisarmed', { reason: 'new push' });
  else if (recording && (glob.status === 'pr_open' || recovers) && glob.mergeMode !== 'when_green' && glob.pr?.state === 'ready') {
    b.set({ mergeMode: 'when_green' }).event('MergeArmed', { sha: push.sha });
  }
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
    glob.category !== 'action' &&
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
  // Doing or in review: look again at how far the branch is behind the base (the card warns before a conflict exists).
  // A push that merged the base in must clear the record even when it also sends a ready PR back to review.
  if ((glob.status === 'in_progress' || glob.status === 'pr_open') && glob.pr !== null) {
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
  "The run's session never reached slop (the Slop connector may not have attached). Discard and back to Planning.";

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
      // A preparation run never watches checks: it ends at `mark_ready`.
      // A run started by a Re-run answer has work to do first (apply the new plan and push), so it is active, never watching.
      state:
        run.state === 'queued'
          ? glob.status === 'pr_open' &&
            run.purpose !== 'prepare' &&
            (run.purpose !== 'resolve_conflict' || glob.conflict == null) &&
            !(run.purpose === undefined && pendingRerun(glob) !== null)
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
  if (glob.category === 'action') {
    // Row A5 (branch record): the preparation is on the branch and the person's turn has come. The run ends completed: nothing
    // watches the checks or gets reviewed, a person's run decides whether the record is right.
    return b
      .endRun('completed')
      .set({ failure: null })
      .event('ActionPrepared', { round: preparationOf(glob)?.rounds ?? 0, record: 'branch' })
      .status('pr_open')
      .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation })
      .done();
  }
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
const holdMerge = (
  b: Builder,
  glob: Glob,
  sha: string,
  held: readonly Unmet[],
  asks: readonly OpenQuestion[],
  ctx: Context,
): Builder => {
  const waitingFor = held.map((u) => (u.external === true ? OTHER_BOARD_GLOB : u.relation.to));
  const questions = asks.map((q) => q.id);
  const same =
    glob.mergeHold != null &&
    glob.mergeHold.sha === sha &&
    glob.mergeHold.for.join(',') === waitingFor.join(',') &&
    (glob.mergeHold.questions ?? []).join(',') === questions.join(',');
  if (same) return b;
  return b
    .set({ mergeHold: { since: ctx.now, sha, for: waitingFor, ...(questions.length === 0 ? {} : { questions }) } })
    .event('MergeHeld', { for: waitingFor, sha, ...(questions.length === 0 ? {} : { questions }) });
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
    const asks = mergeQuestions(glob);
    // Merge when checks pass stays armed while a merge relation is unmet or a merge question is open; the release resumes it (`gateReleased`).
    if (held.length > 0 || asks.length > 0) return holdMerge(b, glob, checks.sha, held, asks, ctx).done();
    return joinMergeLine(b.set({ mergeMode: null, ...(glob.mergeHold == null ? {} : { mergeHold: null }) }), ctx).done();
  }
  // Slop updated the branch while merging: the checks on the new head decide (rows 12, 14, 16).
  if (glob.status === 'merging') {
    if (checks.conflict !== undefined) {
      // An ordinary "merge the base into the branch" job, not a failure: back to pr_open with the conflict recorded.
      const reason = conflictReason(checks.conflict);
      return withConflict(leavesLine(b.set({ mergeMode: null }), glob).status('pr_open'), checks.conflict, ctx)
        .event('MergeFailed', { reason, conflict: true })
        .done();
    }
    if (!passed) {
      // Only a head slop itself produced (an update-branch for this merge) is "after updating"; otherwise the push that failed is the branch's own.
      const cause = (glob.mergeUpdates ?? 0) > 0 ? 'after updating the branch' : glob.implementer !== null ? `on ${glob.implementer}'s push` : "on the run's push";
      const reason = `Checks failed ${cause}${failure === undefined ? '' : `: ${failureSummary(failure)}`}`;
      const mergeFailure: Failure = { reason, at: ctx.now, kind: 'merge' };
      return leavesLine(b.endRunsOnFailure(reason, mergeFailure).set({ failure: mergeFailure, mergeMode: null }), glob)
        .event('MergeFailed', { reason: 'checks failed after update' })
        .status('failed')
        .done();
    }
    // Only the line's head merges; a waiting glob just records its result (it merges when its turn comes).
    if (glob.mergeLine?.head != null)
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
  if (glob.category === 'action') return actionReadyRequested(glob, runId, ctx, source);
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

/**
 * `mark_ready` on a prepared action (row A5): a branch record asks slop to mark the PR ready (the PR event then makes the action ready
 * to run), an artifact or attachment record is ready at once. A run on a PR already ready or recording (a fix of the record) just ends:
 * its push re-armed the merge, and the checks are read again.
 */
const actionReadyRequested = (glob: Glob, runId: string | null, ctx: Context, source: ReadySource): Result<Transition> => {
  const preparation = preparationOf(glob);
  if (preparation === null) return invalidTransition(glob, ctx.actor, 'Only a prepared action is marked ready');
  if (source.from === 'board') return invalidTransition(glob, ctx.actor, 'A prepared action is marked ready by its routine');
  if (preparation.record !== 'branch') return actionPrepared(glob, runId, ctx);
  if (glob.status === 'pr_open') {
    const run = currentRun(glob);
    if (runId !== null && (run === null || run.id !== runId || run.state === 'ended')) {
      return invalidTransition(glob, ctx.actor, `Run ${runId} is not the glob's current run`);
    }
    return new Builder(glob, ctx)
      .endRun('completed')
      .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation })
      .done();
  }
  if (glob.status !== 'implementing') return invalidTransition(glob, ctx.actor, `A glob in ${glob.status} has no draft PR to mark ready`);
  if (glob.pr === null) return invalidTransition(glob, ctx.actor, 'The glob has no PR yet');
  const run = currentRun(glob);
  if (runId !== null && (run === null || run.id !== runId || run.state === 'ended')) {
    return invalidTransition(glob, ctx.actor, `Run ${runId} is not the glob's current run`);
  }
  return new Builder(glob, ctx).effect({ kind: 'mark_pr_ready', globId: glob.id, generation: glob.generation }).done();
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
  // The cause is always attached as a question (a notice: a same in Planning or Doing already waits for a person), once per criterion.
  const asked = escalationQuestion(glob, { reason, criterion, runId, by: input.by, actor: ctx.actor?.email ?? null }, ctx.now);
  const b = new Builder(glob, ctx)
    .set({ type: 'same', escalation, ...(asked === null ? {} : { questions: [...questionsOf(glob), asked] }) })
    .event('FieldsChanged', { type: { from: 'sub', to: 'same' } })
    .event('Escalated', {
      reason,
      criterion,
      ...(evidence === '' ? {} : { evidence }),
      ...(runId === null ? {} : { runId }),
    });
  if (asked !== null) b.event('QuestionRaised', questionEventData(asked));
  if (glob.pr !== null)
    b.effect({ kind: 'sync_pr_labels', globId: glob.id, generation: glob.generation });
  return b.done();
};

/** The question an escalation attaches (null when the glob has one for the criterion already, or no room). */
const escalationQuestion = (
  glob: Glob,
  from: { reason: string; criterion: string; runId: string | null; by: string | undefined; actor: string | null },
  now: string,
): OpenQuestion | null => {
  const key = `escalation:${from.criterion}`;
  const existing = questionsOf(glob);
  if (existing.some((q) => q.key === key) || existing.length >= MAX_QUESTIONS) return null;
  const raisedBy: QuestionRaiser =
    from.runId !== null
      ? { kind: 'routine', actor: from.by ?? from.actor, runId: from.runId }
      : from.by !== undefined
        ? { kind: 'system', actor: null }
        : { kind: 'person', actor: from.actor };
  return {
    id: nextQuestionId(existing),
    key,
    text: from.reason.slice(0, 1000),
    options: ['Keep as same', 'Make it a sub again'],
    raisedBy,
    source: from.runId !== null ? 'run' : 'other',
    blocking: 'none',
    raisedAt: now,
  };
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
  const awaited = startHoldsOf(glob, relations ?? NO_RELATIONS);
  if (awaited.length > 0) {
    b.set({ waiting: { since: ctx.now } }).event('Waiting', { for: awaitedNames(awaited), note: waitSummary(awaited) });
  } else {
    b.status('implementing').queueRun(glob.creator);
  }
  return b.done();
};

/**
 * A person decides an escalation was unnecessary: the glob is a sub again. On a ready PR whose checks passed, the sub
 * gate runs on the head, so a sub with nothing else to flag merges.
 */
export const deescalate = (glob: Glob, ctx: Context, facts: ActionFacts = {}): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.escalation == null || glob.type !== 'same') {
    return invalidTransition(glob, actor, 'Only an escalated same can be made a sub again');
  }
  // A sub merges itself, which would leave the open rollout steps dangling (the same condition as `allowedActions`).
  if (glob.escalation.criterion === 'risk_path' && (facts.rolloutSteps ?? 0) > 0) {
    return invalidTransition(glob, actor, 'A same with open rollout steps cannot be made a sub: it must be merged, which keeps it open for them');
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
  !fixOf(glob);

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
    const asks = mergeQuestions(glob);
    // The sub stays in pr_open with its passed gate: `gateReleased` merges it once the relations are met and the questions answered.
    if (held.length > 0 || asks.length > 0) return holdMerge(b, glob, gate.sha, held, asks, ctx).done();
    return joinMergeLine(b.set(glob.mergeHold == null ? {} : { mergeHold: null }), ctx).done();
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
  // An action's record has no labels, review or rollout: it is signed off once the person has said Done (row A8).
  if (glob.category === 'action') return glob.pr?.state === 'merged' ? unchanged(glob) : actionMerged(glob, merge, ctx);
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
    return leavesLine(
      new Builder(glob, ctx).set({
        prs,
        pr: null,
        headChecks: null,
        mergeMode: null,
        ...(glob.mergeHold == null ? {} : { mergeHold: null }),
        failure: null,
        ...(glob.conflict == null ? {} : { conflict: null }),
      }),
      glob,
    )
      .event('Merged', {
        sha: merge.sha,
        ...(number === undefined ? {} : { number }),
        mode: 'continue',
      })
      .status('in_progress')
      .effect({ kind: 'flag_conflicts', globId: glob.id, generation: glob.generation })
      .done();
  }
  const b = leavesLine(
    new Builder(glob, ctx)
      .endRun('completed')
      .set({
        labels: requiredLabels(glob.type),
        checklists: {},
        failure: null,
        mergeMode: null,
        ...(glob.mergeHold == null ? {} : { mergeHold: null }),
        pr: glob.pr === null ? null : { ...glob.pr, state: 'merged' },
        ...(glob.conflict == null ? {} : { conflict: null }),
      }),
    glob,
  )
    .event('Merged', { sha: merge.sha })
    .status('reviewing')
    .effect({ kind: 'flag_conflicts', globId: glob.id, generation: glob.generation })
    // Only the final merge releases the globs waiting for this one (a Merge and continue leaves it open).
    .effect({ kind: 'release_waiting', globId: glob.id, generation: glob.generation })
    // Was each relation of this glob needed? Judged from the merge's diff once; only the final merge, like the release.
    .effect({ kind: 'check_relations_after_merge', globId: glob.id, generation: glob.generation })
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
    return withConflict(leavesLine(new Builder(glob, ctx).set({ mergeMode: null }), glob).status('pr_open'), conflict, ctx)
      .event('MergeFailed', { reason, conflict: true })
      .done();
  }
  const failure: Failure = { reason, at: ctx.now, kind: 'merge' };
  return leavesLine(new Builder(glob, ctx).endRunsOnFailure(reason, failure).set({ failure, mergeMode: null }), glob)
    .event('MergeFailed', { reason })
    .status('failed')
    .done();
};

/**
 * Row 16d: the board's merge line has no head, so the first glob in it (by when it joined) becomes head: it updates its branch
 * once if behind, waits for its checks and merges. A glob a `merge` relation or open merge question holds goes back to
 * pr_open held instead and the next one is tried (the caller loops). A conflict or red checks already on the glob leave the
 * line as a failed merge would. Nothing changes for a glob that is not waiting in the line, or when it is the head already.
 */
export const becomeMergeHead = (glob: Glob, relations: RelationFacts | undefined, ctx: Context): Result<Transition> => {
  const line = glob.mergeLine;
  if (glob.status !== 'merging' || line == null || line.head != null) return unchanged(glob);
  const held = mergeGate(relations);
  const asks = mergeQuestions(glob);
  if (held.length > 0 || asks.length > 0) return mergeLineHold(glob, held, asks, ctx);
  if (glob.conflict != null) return mergeFailed(glob, conflictReason(glob.conflict), ctx, { base: glob.conflict.base, files: glob.conflict.files });
  if (headChecksFailed(glob)) return mergeFailed(glob, 'Required checks failed on the current head', ctx);
  const sha = glob.pr?.headSha ?? null;
  const b = new Builder(glob, ctx)
    .set({ mergeLine: { joinedAt: line.joinedAt, head: { since: ctx.now } } })
    .event('MergeLineHead', { sha: sha ?? '' });
  // Its checks from its last push already count; otherwise read them, and `checksCompleted` queues the merge when they pass.
  return (sha !== null && headChecksPassed(glob)
    ? b.effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha })
    : b.effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation })
  ).done();
};

/**
 * A glob in the merge line is held by a `merge` relation or an open merge question (added after it joined): it goes back to
 * pr_open held, like a merge that was held before joining, and no longer blocks the globs behind it. `gateReleased` joins it
 * again at the back. A Merge and continue is disarmed instead (a resumed hold would merge it as a final merge).
 */
export const mergeLineHold = (glob: Glob, held: readonly Unmet[], asks: readonly OpenQuestion[], ctx: Context): Result<Transition> => {
  if (!isInMergeLine(glob)) return unchanged(glob);
  const sha = glob.pr?.headSha ?? '';
  if (glob.mergeMode === 'continue') {
    return leavesLine(new Builder(glob, ctx).set({ mergeMode: null }), glob).event('MergeDisarmed', { reason: 'held' }).status('pr_open').done();
  }
  // A same or super waits as an armed merge; a sub's passed gate waits through `mergeHold` alone (see `gateReleased`).
  const b = leavesLine(new Builder(glob, ctx).set({ mergeMode: glob.type === 'sub' ? null : 'when_green' }), glob).status('pr_open');
  return holdMerge(b, glob, sha, held, asks, ctx).done();
};

/**
 * Adopts a merging glob that predates the merge line (it was merging when the line shipped, so it has no place): it joins at
 * the time it last changed, so it keeps its seniority over later joiners. Nothing changes for a glob already in the line.
 */
export const adoptIntoMergeLine = (glob: Glob, ctx: Context): Result<Transition> => {
  if (glob.status !== 'merging' || glob.mergeLine != null) return unchanged(glob);
  return new Builder(glob, ctx)
    .set({ mergeLine: { joinedAt: glob.updatedAt } })
    .event('MergeLineJoined', { sha: glob.pr?.headSha ?? '' })
    .done();
};

/**
 * Row 16e: the sweep found the head quiet (no check result for its current commit past `MERGE_HEAD_STUCK_MS`, or checks that
 * passed and no merge). The first time it asks for the checks and the PR again, and queues the merge again when the checks
 * passed; still silent a full period after that, the merge fails with the reason, which leaves the line and advances it. Nothing changes while the head is fresh, has its result, or for any other glob.
 */
export const mergeHeadChecked = (glob: Glob, nowMs: number, ctx: Context): Result<Transition> => {
  const line = glob.mergeLine;
  const stuck = mergeHeadStuck(glob, nowMs);
  if (stuck === null || line?.head == null) return unchanged(glob);
  if (stuck === 'fail') return mergeFailed(glob, mergeHeadStuckReason(glob, nowMs), ctx);
  const b = new Builder(glob, ctx)
    .set({ mergeLine: { joinedAt: line.joinedAt, head: { ...line.head, recheckedAt: ctx.now } } })
    .effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation })
    .effect({ kind: 'reconcile_pr', globId: glob.id, generation: glob.generation });
  const sha = glob.pr?.headSha;
  return (mergeHeadChecksPassed(glob) && sha != null
    ? b.effect({ kind: 'squash_merge', globId: glob.id, generation: glob.generation, sha })
    : b
  ).done();
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
    (run.purpose === 'resolve_conflict' || (run.purpose === 'prepare' && glob.category === 'action')) &&
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
  // A glob in the merge line has no merge effect in flight to fail (even the head's is dropped once the PR is gone), so its closing is the failure.
  const inLine = isInMergeLine(glob);
  leavesLine(b, glob);
  b.event('PRClosed', {});
  if (glob.status !== 'pr_open' && !inLine) return b.done();
  return b
    .endRun('superseded', null, { cause: 'pr_closed' })
    .set({
      failure: { reason: 'PR closed without merging', at: ctx.now },
      ...((isMergeArmed(glob) || inLine) && { mergeMode: null }),
    })
    .status('failed')
    .done();
};

// ---------------------------------------------------------------------------
// What a person can do next (drives the glob view's buttons and error messages)

export const allowedActions = (glob: Glob, actor: Actor, facts: ActionFacts = {}): Action[] => {
  if (glob.category === 'decision') return decisionActions(glob, actor, facts);
  if (glob.category === 'action') return actionActions(glob, facts);
  if (isAgentSetGlob(glob)) return agentSetActions(glob, actor);
  const actions: Action[] = [];
  const restricted = restrictedFrom(actor, glob);
  // Held: waiting for another glob to merge. Without the relations loaded, the glob's own mark says it.
  const held =
    glob.status === 'planning' &&
    glob.type !== 'super' &&
    !startQueued(glob) &&
    (facts.relations === undefined ? glob.waiting != null || startQuestions(glob).length > 0 : startHoldsOf(glob, facts.relations).length > 0);
  if (!restricted && glob.status === 'planning' && glob.type === 'same' && !held && !startQueued(glob)) actions.push('start');
  // After a Re-run answer with nothing working, Start is the next step (never Start anyway: no hold is left to override).
  if (!restricted && rerunIdle(glob)) actions.push('start');
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
      glob.status === 'pr_open' ||
      // A merged glob stays open while its rollout steps do (row 9a): a person runs them from a session.
      (glob.status === 'reviewing' && (facts.rolloutSteps ?? 0) > 0));
  // Not to the person who already holds the glob with their session live (rows 8 and 9a): for them it is a no-op and the status already
  // says "picked up". With nothing live (a conflict, failed checks, rollout steps) they keep Resume, so their own glob is never a dead end.
  const holdsIt =
    glob.implementer === actor.email &&
    (glob.status === 'in_progress' || glob.status === 'pr_open') &&
    hasLiveRun(glob) &&
    liveInvestigation(glob) === null;
  if (canPickUp && !holdsIt) actions.push('pick_up');
  if (
    !restricted &&
    glob.type !== 'super' &&
    hasLiveRun(glob) &&
    (glob.status === 'implementing' || glob.status === 'pr_open' || glob.status === 'failed')
  ) {
    actions.push('take_over');
  }
  // A merge failure on a glob a person implements is theirs to fix and push: a routine run is the wrong answer.
  const personMergeFailure = glob.failure?.kind === 'merge' && glob.implementer !== null && !isAgentSetGlob(glob);
  if (
    !restricted &&
    glob.status === 'failed' &&
    glob.type !== 'super' &&
    !hasLiveRun(glob) &&
    !personMergeFailure
  ) {
    actions.push('retrigger');
  }
  if (!restricted && !hasLiveRun(glob) && canRetryAutofix(glob, facts)) actions.push('retry_autofix');
  if (!restricted && !hasLiveRun(glob) && canRetryMerge(glob)) actions.push('retry_merge');
  if (!restricted && !hasLiveRun(glob) && canRetryChecks(glob)) actions.push('retry_checks');
  if (!restricted && canRequestConflictFix(glob)) actions.push('resolve_conflict');
  if (!restricted && glob.status !== 'reviewing' && glob.status !== 'signed_off') actions.push('start_again');
  // Row 31b: a merged glob in Reviewing can go back to Doing as a new generation, with a reason.
  if (!restricted && glob.status === 'reviewing' && glob.pr?.state === 'merged') actions.push('reopen');
  if (isMergeArmed(glob) || isInMergeLine(glob)) {
    if (!restricted) actions.push('cancel_merge');
  } else if (mergeBlocker(glob, facts.relations) === null) {
    // One Merge for everyone: a same with rollout steps is merged and kept open for them by slop itself, once the checks have
    // passed (it replaces arming). `merge_continue` is never offered to a same (it stays accepted as an alias for one
    // release); a super's checkpoint merge keeps it.
    if (!hasRolloutSteps(glob, facts) || headChecksPassed(glob)) actions.push('merge');
    if (glob.type === 'super' && headChecksPassed(glob) && recordAtHead(glob, facts)) actions.push('merge_continue');
  }
  // A `merge` relation is all that holds a ready PR back (a sub, or a merge already armed, too): it can be forced through.
  if (!restricted && facts.relations !== undefined && !isInMergeLine(glob) && mergeHeldOnlyByRelations(glob, facts, mergeGate(facts.relations), facts.relations) === null)
    actions.push('merge_anyway');
  // Labels approved and rolled out, and only a `sign_off` relation holds the glob in Reviewing.
  if (
    facts.relations !== undefined &&
    unmet(facts.relations, 'sign_off').length > 0 &&
    signOffBlockerBesidesRelations(glob, facts.rollout ?? null) === null
  )
    actions.push('sign_off_anyway');
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
    // A same escalated for its rollout steps stays a same while they are open (a sub would merge itself, leaving them dangling).
    !(glob.escalation.criterion === 'risk_path' && (facts.rolloutSteps ?? 0) > 0) &&
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
  if (!restricted && canRetryChecks(glob)) actions.push('retry_checks');
  if (canReviewNow(glob)) actions.push('review_now');
  if (
    !restricted &&
    (glob.status === 'in_progress' || glob.status === 'implementing') &&
    glob.pr?.state === 'draft'
  )
    actions.push('mark_ready');
  if (isMergeArmed(glob) || isInMergeLine(glob)) {
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
    ...inferenceFields({ category: 'decision' }, false),
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
      fix: false,
      workKind: 'maintenance',
      group: glob.group,
      environment: null,
      status: glob.status,
    })
    .done();
};

// ---------------------------------------------------------------------------
// Action globs (rows A1-A10)
//
// An action is work that takes effect by being done: a person applies it to the live thing. A plain action never has a branch, PR,
// run, label or deploy: it is open in Planning and ends Signed off, done or dismissed (the outcome says which). Anyone on the board
// may complete or dismiss it.
//
// A prepared action (`preparation` in its attributes) has machine preparation first: a routine writes the script, policy or document
// the person runs (a `prepare` run). It then waits for the person: Done records who and when, Failed starts another preparation round
// in the same glob. A branch record (a repo file later work edits) lives on the action's own branch and slop merges it after Done;
// an artifact or attachment record has no branch and closes at Done. No labels, environments, deploys, rollout steps or review of
// any kind apply: the board's checks gate the record's merge, and the person's run is what makes the action real.

/** The attributes of an action glob; an action without them is a broken record, never a state to handle. */
export const actionAttributesOf = (glob: Glob): ActionAttributes => {
  const attributes = glob.attributes;
  if (glob.category !== 'action' || !isActionAttributes(attributes)) throw new Error(`${glob.id} is not an action glob`);
  return attributes;
};

/** Row A1: a plain action enters Planning with no run, no provisioning and no labels; a prepared one starts its first round at once. */
const createAction = (input: CreateInput, ctx: Context, actor: Actor): Result<Transition> => {
  const attributes = validateAttributes('action', input.attributes ?? { assignee: null, outcome: null });
  if (!attributes.ok) return attributes;
  if (!isActionAttributes(attributes.value) || attributes.value.outcome !== null) {
    return invalidInput('A new action has no outcome yet');
  }
  const preparation = attributes.value.preparation;
  if (preparation !== undefined && preparation.rounds !== 0) return invalidInput('A new action has had no preparation rounds yet');
  if (input.environment !== null) return invalidInput('An action has no environment');
  const waitingFor = input.waitingFor ?? [];
  // A prepared action with nothing to wait for starts preparing now; one held by a start relation waits in Planning until released.
  const first = preparation !== undefined && waitingFor.length === 0 ? { ...preparation, rounds: 1 } : undefined;
  const starts = first !== undefined;
  const waits = preparation !== undefined && !starts;
  const glob: Glob = {
    id: input.id,
    boardId: input.boardId,
    title: input.title.trim(),
    type: null,
    category: 'action',
    ...inferenceFields({ category: 'action' }, false),
    attributes: first === undefined ? attributes.value : { ...attributes.value, preparation: first },
    group: input.group,
    environment: null,
    status: starts ? 'implementing' : 'planning',
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
    doingSince: starts ? ctx.now : null,
    listSince: ctx.now,
    ...(waits && { waiting: { since: ctx.now } }),
  };
  const b = new Builder(glob, ctx).event('GlobCreated', {
    type: null,
    category: glob.category,
    fix: false,
    workKind: 'maintenance',
    group: glob.group,
    environment: null,
    status: glob.status,
  });
  if (starts) b.ensureProvisioned().queueRun(actor.email, undefined, false, 'prepare');
  else if (waits) b.event('Waiting', { for: [...waitingFor], note: `waiting for ${waitingFor.join(', ')}` });
  return b.done();
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

/** An open action ends: done or dismissed. What waited for it is released either way. `b` carries what the caller already did. */
const finishAction = (
  glob: Glob,
  outcome: ActionOutcome,
  ctx: Context,
  event: DomainEventType,
  b: Builder = new Builder(glob, ctx),
): Result<Transition> =>
  releaseWaiting(b, glob)
    .set({ attributes: { ...actionAttributesOf(glob), outcome }, signedOffAt: ctx.now })
    .status('signed_off')
    .event(event, {
      by: outcome.by,
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    })
    .done();

/** A new preparation round: the count goes up, the action is Doing, and a `prepare` run is queued (the branch is cut on the first). */
const startRound = (b: Builder, by: string): Builder => {
  const attributes = actionAttributesOf(b.current);
  const preparation = attributes.preparation;
  if (preparation === undefined) return b;
  return b
    .set({ attributes: { ...attributes, preparation: { ...preparation, rounds: preparation.rounds + 1 } } })
    .status('implementing')
    .queueRun(by, undefined, false, 'prepare');
};

/**
 * Row A2: a person did the action's work. A repeat on a finished action changes nothing. A prepared action is done only once its
 * preparation is ready to run; with a branch record, slop then arms and starts the merge itself.
 */
export const completeAction = (glob: Glob, input: { readonly note?: string }, ctx: Context, facts: ActionFacts = {}): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'action') return notAction(glob, actor);
  const { outcome } = actionAttributesOf(glob);
  if (outcome !== null) {
    return outcome.kind === 'done' ? unchanged(glob) : invalidTransition(glob, actor, 'This action was dismissed');
  }
  const note = input.note?.trim() ?? '';
  const done: ActionOutcome = { kind: 'done', by: actor.email, at: ctx.now, ...(note === '' ? {} : { note }) };
  if (preparationOf(glob) !== null) return completePrepared(glob, done, ctx);
  if (glob.status !== 'planning' && glob.status !== 'in_progress') return invalidTransition(glob, actor, 'This action is not open');
  const held = actionHeld(facts);
  if (held !== null) return invalidTransition(glob, actor, held);
  return finishAction(glob, done, ctx, 'ActionDone');
};

/**
 * Row A7: Done on a prepared action in its ready state. The person's run is recorded whatever the checks say: Done is never refused
 * for red checks or a conflict, which only keep the record from merging until they are fixed. An artifact or attachment record, and a
 * branch whose PR was merged by hand, close at once.
 */
const completePrepared = (glob: Glob, done: ActionOutcome, ctx: Context): Result<Transition> => {
  if (actionState(glob) !== 'ready') {
    return invalidTransition(glob, ctx.actor, 'This action is not ready to run: it is Done once the preparation has finished');
  }
  const pr = glob.pr;
  if (!hasBranchRecord(glob) || pr === null || pr.state === 'merged') return finishAction(glob, done, ctx, 'ActionDone');
  const head = pr.headSha ?? '';
  const b = releaseWaiting(new Builder(glob, ctx), glob)
    .set({ attributes: { ...actionAttributesOf(glob), outcome: done } })
    .event('ActionDone', { by: done.by, ...(done.note === undefined ? {} : { note: done.note }) });
  // A conflicted or red head merges after it is fixed (Fix conflict, Fix checks); the push that fixes it arms the merge again.
  if (glob.conflict != null || headChecksFailed(glob)) return b.done();
  if (headChecksPassed(glob)) {
    return joinMergeLine(b.set({ mergeMode: null }), ctx).done();
  }
  b.set({ mergeMode: 'when_green' }).event('MergeArmed', { sha: head });
  if (glob.headChecks?.sha !== head) b.effect({ kind: 'refresh_checks', globId: glob.id, generation: glob.generation });
  return b.done();
};

/**
 * Row A3 (and A9 for a prepared action): the action is not needed. Needs a reason; a repeat on a dismissed action changes nothing.
 * A prepared action can be dismissed in any open state: a live run ends, and its PR is closed and its branch deleted (never merged).
 */
export const dismissAction = (glob: Glob, input: { readonly reason: string }, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'action') return notAction(glob, actor);
  const { outcome } = actionAttributesOf(glob);
  if (outcome !== null) {
    return outcome.kind === 'dismissed' ? unchanged(glob) : invalidTransition(glob, actor, 'This action is already done');
  }
  const prepared = preparationOf(glob) !== null;
  if (glob.status !== 'planning' && glob.status !== 'in_progress' && !prepared) return invalidTransition(glob, actor, 'This action is not open');
  if (glob.status === 'signed_off') return invalidTransition(glob, actor, 'This action is not open');
  const reason = input.reason.trim();
  if (reason === '') return invalidInput('Dismissing needs a reason');
  const dismissed: ActionOutcome = { kind: 'dismissed', by: actor.email, at: ctx.now, reason };
  if (!prepared) return finishAction(glob, dismissed, ctx, 'ActionDismissed');
  const b = new Builder(glob, ctx).endRun('superseded', null, { cause: 'dismissed' });
  if (hasBranchRecord(glob) && glob.provisioning !== 'none') {
    b.set({
      ...(glob.pr === null ? {} : { pr: { ...glob.pr, state: 'closed' as const } }),
      mergeMode: null,
      failure: null,
    });
    leavesLine(b, glob)
      .effect({ kind: 'close_pr', globId: glob.id, generation: glob.generation, prNumber: glob.pr?.number ?? null })
      .effect({ kind: 'delete_branch', globId: glob.id, generation: glob.generation });
  }
  return finishAction(glob, dismissed, ctx, 'ActionDismissed', b.set({ waiting: null }));
};

/**
 * Row A4: start (from Planning) or retry (from a failed round) the preparation of an action. Not while a start relation is unmet:
 * the glob that builds what it prepares against has to merge first.
 */
export const prepareAction = (glob: Glob, ctx: Context, relations: RelationFacts = NO_RELATIONS): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'action') return notAction(glob, actor);
  const attributes = actionAttributesOf(glob);
  if (attributes.preparation === undefined) return invalidTransition(glob, actor, 'This action has no machine preparation');
  if (attributes.outcome !== null) return invalidTransition(glob, actor, 'This action is finished');
  if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
  if (glob.status === 'planning') {
    const awaited = awaitedOf(relations);
    if (awaited.length > 0) return invalidTransition(glob, actor, `${waitSummary(awaited)} (it can be prepared when ${awaited.length === 1 ? 'it has' : 'they have'} merged)`);
    return startRound(new Builder(glob, ctx).set({ waiting: null }), actor.email).done();
  }
  if (glob.status === 'failed') return startRound(new Builder(glob, ctx).set({ failure: null }), actor.email).done();
  return invalidTransition(glob, actor, 'Only an action that has not started, or whose preparation failed, can be prepared');
};

/**
 * Row A5 (artifact or attachment record): the routine says the preparation is done. The action is ready to run, with no PR; the run
 * ends completed (nothing watches). A branch record becomes ready through `prReadyForReview`. A repeat on a ready action changes nothing.
 */
export const actionPrepared = (glob: Glob, runId: string | null, ctx: Context): Result<Transition> => {
  if (glob.category !== 'action' || preparationOf(glob) === null) return notAction(glob, ctx.actor);
  if (glob.status === 'in_progress') return unchanged(glob);
  if (glob.status !== 'implementing') return invalidTransition(glob, ctx.actor, `A glob in ${glob.status} is not being prepared`);
  const run = currentRun(glob);
  if (runId !== null && (run === null || run.id !== runId || run.state === 'ended')) {
    return invalidTransition(glob, ctx.actor, `Run ${runId} is not the glob's current run`);
  }
  return new Builder(glob, ctx)
    .endRun('completed')
    .set({ failure: null })
    .status('in_progress')
    .event('ActionPrepared', { round: preparationOf(glob)?.rounds ?? 0, record: preparationOf(glob)?.record ?? 'attachment' })
    .done();
};

/**
 * Row A6: the person ran what was prepared and it failed (the output is stored by the service as an attachment the next round reads).
 * Another round starts on the same branch and PR: nothing has merged, so no new generation. Not after Done.
 */
export const failAction = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'action') return notAction(glob, actor);
  const attributes = actionAttributesOf(glob);
  if (attributes.preparation === undefined) return invalidTransition(glob, actor, 'This action has no machine preparation');
  if (attributes.outcome !== null) return invalidTransition(glob, actor, 'This action is already finished: report the failure on a new glob');
  if (actionState(glob) !== 'ready') return invalidTransition(glob, actor, 'This action is not ready to run');
  if (hasLiveRun(glob)) return runActive('A routine run is already queued, active or watching');
  const b = new Builder(glob, ctx).set({ failure: null, mergeMode: null, headChecks: null });
  return startRound(b, actor.email)
    .event('ActionRunFailed', { by: actor.email, round: attributes.preparation.rounds })
    .done();
};

/**
 * Row A8: the merge of an action's branch record was observed. After Done the action is signed off (no labels, no review, no
 * rollout): only the waiters are released. Merged by hand before Done, it is only recorded; Done then closes it.
 */
const actionMerged = (glob: Glob, merge: { sha: string }, ctx: Context): Result<Transition> => {
  const { outcome } = actionAttributesOf(glob);
  const b = leavesLine(
    new Builder(glob, ctx)
      .endRun('completed')
      .set({
        failure: null,
        mergeMode: null,
        ...(glob.mergeHold == null ? {} : { mergeHold: null }),
        pr: glob.pr === null ? null : { ...glob.pr, state: 'merged' },
        ...(glob.conflict == null ? {} : { conflict: null }),
      }),
    glob,
  ).event('Merged', { sha: merge.sha });
  if (outcome?.kind !== 'done') return b.done();
  return releaseWaiting(b.set({ signedOffAt: ctx.now }).status('signed_off'), glob).done();
};

/**
 * Why an open action can't be done yet, or null: a start relation that has not been met (the glob that builds its script has
 * not merged) or a script that is not on the base branch. Dismissing stays allowed.
 */
const actionHeld = (facts: ActionFacts): string | null => {
  const awaited = facts.relations === undefined ? [] : awaitedOf(facts.relations);
  if (awaited.length > 0) return `${waitSummary(awaited)} (it can be done when ${awaited.length === 1 ? 'it has' : 'they have'} merged)`;
  return facts.script == null ? null : scriptMissingText(facts.script, facts.baseBranch ?? 'main');
};

/**
 * What a person can do with an action. A plain action: finish it while it is open (and nothing holds it), dismiss it, delete it.
 * A prepared one: prepare (start or retry), Done and Failed once it is ready to run, the PR actions its record needs (Fix checks, Fix
 * conflict, Merge and Cancel merge after Done), pick up (to read the branch), dismiss and delete.
 */
const actionActions = (glob: Glob, facts: ActionFacts): Action[] => {
  const state = actionState(glob);
  if (preparationOf(glob) === null) {
    // Planning: Pick up first. Doing (picked up): Done and Dismiss, and back to Planning.
    if (glob.status === 'planning') return ['pick_up', 'dismiss_action', 'delete'];
    if (glob.status !== 'in_progress') return ['delete'];
    return actionHeld(facts) === null
      ? ['complete_action', 'dismiss_action', 'back_to_planning', 'delete']
      : ['dismiss_action', 'back_to_planning', 'delete'];
  }
  const actions: Action[] = [];
  const held = facts.relations !== undefined && awaitedOf(facts.relations).length > 0;
  if (state === 'waiting' && !held) actions.push('prepare_action');
  if (state === 'preparation_failed' && !hasLiveRun(glob)) actions.push('prepare_action');
  if (state === 'ready') {
    actions.push('complete_action', 'fail_action');
    if (hasBranchRecord(glob) && glob.pr !== null) actions.push('pick_up');
  }
  if (state === 'recording' && hasBranchRecord(glob)) {
    if (isMergeArmed(glob) || isInMergeLine(glob)) actions.push('cancel_merge');
    else if (mergeBlocker(glob, facts.relations) === null) actions.push('merge');
    if (canRetryMerge(glob) && !hasLiveRun(glob)) actions.push('retry_merge');
    if (glob.pr !== null) actions.push('pick_up');
  }
  if ((state === 'ready' || state === 'recording') && !hasLiveRun(glob)) {
    if (canRetryAutofix(glob)) actions.push('retry_autofix');
    if (canRequestConflictFix(glob)) actions.push('resolve_conflict');
  }
  // Done is final for a prepared action: after it only the record's merge is left.
  if (state !== 'closed' && state !== 'recording') actions.push('dismiss_action');
  actions.push('delete');
  return actions;
};

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
      .effect(suggestEffect(glob.id))
      .done();
  }
  if (glob.status === 'in_progress') {
    return new Builder(glob, ctx)
      .set({ implementer: actor.email })
      .event('PickedUp', { takeOver: true })
      .effect(suggestEffect(glob.id))
      .done();
  }
  return invalidTransition(glob, actor, `A decision in ${glob.status} cannot be picked up`);
};

/**
 * Row A10: a person picks up a plain action. It goes to Doing with them as implementer (and assignee when it has none), with no
 * branch, PR, run or provisioning; its steps then show with their own Done and Dismiss. A prepared action never gets here.
 */
const pickUpAction = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  const attributes = actionAttributesOf(glob);
  if (preparationOf(glob) !== null || attributes.outcome !== null) {
    return invalidTransition(glob, actor, 'This action cannot be picked up');
  }
  if (glob.status === 'in_progress') {
    return glob.implementer === actor.email
      ? unchanged(glob)
      : invalidTransition(glob, actor, `${glob.implementer ?? 'Someone'} has already picked up this action`);
  }
  if (glob.status !== 'planning') return invalidTransition(glob, actor, 'This action is not open');
  return new Builder(glob, ctx)
    .set({
      implementer: actor.email,
      waiting: null,
      ...(attributes.assignee == null ? { attributes: { ...attributes, assignee: actor.email } } : {}),
    })
    .status('in_progress')
    .event('PickedUp', { takeOver: false })
    .done();
};

/** Row A11: a person puts a picked-up plain action back in Planning. Nothing is discarded and nothing starts. */
export const backToPlanning = (glob: Glob, ctx: Context): Result<Transition> => {
  const actor = requireActor(ctx);
  if (glob.category !== 'action') return notAction(glob, actor);
  if (glob.status === 'planning') return unchanged(glob);
  if (glob.status !== 'in_progress' || preparationOf(glob) !== null) {
    return invalidTransition(glob, actor, 'Only a picked-up action goes back to Planning');
  }
  return new Builder(glob, ctx).set({ implementer: null }).status('planning').event('FieldsChanged', { implementer: null }).done();
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
    if (mergeGate(relations).length > 0 || mergeQuestions(glob).length > 0) return unchanged(glob);
    return joinMergeLine(new Builder(glob, ctx).set({ mergeMode: null, mergeHold: null }).event('MergeResumed', { sha: head }), ctx).done();
  }
  if (glob.status !== 'reviewing') return unchanged(glob);
  if (rollout !== null && rollout.open > 0) return unchanged(glob);
  if (!Object.values(glob.labels).every((s) => s === 'approved')) return unchanged(glob);
  if (unmet(relations, 'sign_off').length > 0) return unchanged(glob);
  return releaseWaiting(new Builder(glob, ctx), glob).set({ signedOffAt: ctx.now }).event('SignOffReleased', {}).status('signed_off').done();
};

/** The event an "anyway" action logs: who (the actor), which globs held it and why. */
const overrideEvent = (
  type: 'MergeOverridden' | 'SignOffOverridden',
  glob: Glob,
  ctx: Context,
  held: readonly Unmet[],
  reason: string,
): DomainEvent => ({
  type,
  globId: glob.id,
  actor: ctx.actor?.email ?? null,
  at: ctx.now,
  data: { for: held.map((u) => (u.external === true ? OTHER_BOARD_GLOB : u.relation.to)), reason },
});

/** An "anyway" transition: the inner one (the normal path run on the lifted gate) with the override event first and the relation rows overridden. */
const overriding = (inner: Result<Transition>, event: DomainEvent, edits: readonly RelationEdit[]): Result<Transition> =>
  inner.ok
    ? ok({ ...inner.value, events: [event, ...inner.value.events], relationEdits: [...(inner.value.relationEdits ?? []), ...edits] })
    : inner;

/** Whether a `merge` relation is the only thing between this glob's PR and its merge (the rest of `mergeAnyway`'s checks hold). */
const mergeHeldOnlyByRelations = (glob: Glob, facts: ActionFacts | undefined, held: readonly Unmet[], relations: RelationFacts): string | null => {
  if (glob.status !== 'pr_open') return 'Only a glob with a ready PR can be merged anyway';
  if (held.length === 0) return 'Nothing holds this merge; use Merge';
  // As Merge: a same with rollout steps is merged (and kept open for them) once the checks have passed, never armed.
  if (hasRolloutSteps(glob, facts) && !headChecksPassed(glob)) return 'Required checks have not passed on the current head';
  const lifted = withEdits(relations, gateOverrideEdits(held, ''));
  // A same or super asks for Merge; a sub, or a merge already armed, only waits for its gate (`gateReleased`).
  return glob.type === 'sub' || isMergeArmed(glob) ? mergeBlockerBesidesRelations(glob) : mergeBlocker(glob, lifted);
};

/**
 * Merge anyway: a glob whose PR is ready but whose `merge` relations hold it merges now, as Merge would have (or, for a merge
 * already armed or a sub waiting for its gate, goes on without waiting for them). Every unmet `merge` relation is overridden, whatever
 * its source, and the actor and reason are logged (`MergeOverridden`). It skips nothing else: an open merge question, a conflict and
 * failed checks still refuse it. Refused when nothing holds the merge or no reason is given.
 */
export const mergeAnyway = (glob: Glob, reason: string, ctx: Context, options: MergeOptions = { continue: false }): Result<Transition> => {
  const actor = requireActor(ctx);
  if (restrictedFrom(actor, glob)) return forbidden(`QA and PO members cannot merge ${glob.type}s anyway`);
  const why = reason.trim();
  if (why === '') return invalidTransition(glob, actor, 'Say why you are merging anyway');
  const relations = options.facts?.relations ?? NO_RELATIONS;
  const held = mergeGate(relations);
  const refused = mergeHeldOnlyByRelations(glob, options.facts, held, relations);
  if (refused !== null) return invalidTransition(glob, actor, refused);
  const edits = gateOverrideEdits(held, ctx.now);
  const lifted = withEdits(relations, edits);
  const event = overrideEvent('MergeOverridden', glob, ctx, held, why);
  if (glob.type === 'sub' || isMergeArmed(glob)) {
    const resumed = gateReleased(glob, lifted, null, ctx);
    if (!resumed.ok) return resumed;
    // The merge is not ready to go (checks pending, a sub's gate not passed yet): it carries on by itself, no longer held.
    if (!resumed.value.changed && glob.mergeHold != null)
      return overriding(new Builder(glob, ctx).set({ mergeHold: null }).done(), event, edits);
    return overriding(resumed, event, edits);
  }
  return overriding(requestMerge(glob, ctx, { ...options, facts: { ...options.facts, relations: lifted } }), event, edits);
};

/** Why a glob can't be signed off anyway besides its relations (labels, rollout), or null. */
const signOffBlockerBesidesRelations = (glob: Glob, rollout: BlockProgress | null): string | null => {
  if (glob.status !== 'reviewing') return 'Only a glob in Reviewing can be signed off';
  if (rollout !== null && rollout.open > 0) return rolloutPending(rollout);
  if (glob.category !== 'decision' && !Object.values(glob.labels).every((s) => s === 'approved')) return 'Every label must be approved before the glob can be signed off';
  return null;
};

/**
 * Sign off anyway: a merged glob (or an accepted decision) whose `sign_off` relations hold it is signed off now. Every unmet
 * `sign_off` relation is overridden, whatever its source, and the actor and reason are logged (`SignOffOverridden`). Labels and
 * rollout steps are never skipped. Refused when nothing holds the sign-off or no reason is given.
 */
export const signOffAnyway = (
  glob: Glob,
  reason: string,
  ctx: Context,
  rollout: BlockProgress | null = null,
  relations: RelationFacts = NO_RELATIONS,
): Result<Transition> => {
  const actor = requireActor(ctx);
  // No role check for a work glob on purpose (QA approves the labels, so QA signs off too; spec row 21c); a decision needs mayDecide.
  if (isHumanCategory(glob.category) && glob.category !== 'decision') return invalidTransition(glob, actor, 'Only a work glob or a decision can be signed off anyway');
  if (glob.category === 'decision' && !mayDecide(actor)) return forbidden('Only admins and POs can sign off a decision');
  const why = reason.trim();
  if (why === '') return invalidTransition(glob, actor, 'Say why you are signing off anyway');
  const held = unmet(relations, 'sign_off');
  if (held.length === 0) return invalidTransition(glob, actor, 'Nothing holds this sign-off');
  const blocked = signOffBlockerBesidesRelations(glob, rollout);
  if (blocked !== null) return invalidTransition(glob, actor, blocked);
  const edits = gateOverrideEdits(held, ctx.now);
  const event = overrideEvent('SignOffOverridden', glob, ctx, held, why);
  if (glob.category === 'decision') return overriding(signOffDecision(glob, ctx, rollout, withEdits(relations, edits)), event, edits);
  return overriding(releaseWaiting(new Builder(glob, ctx), glob).set({ signedOffAt: ctx.now }).status('signed_off').done(), event, edits);
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
const decisionActions = (glob: Glob, actor: Actor, facts: ActionFacts = {}): Action[] => {
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
    if (glob.status === 'reviewing') {
      actions.push('sign_off');
      // Held by a `sign_off` relation (or an open rollout step): Sign off anyway forces the relation through, never the steps.
      if (facts.relations !== undefined && unmet(facts.relations, 'sign_off').length > 0 && signOffBlockerBesidesRelations(glob, facts.rollout ?? null) === null)
        actions.push('sign_off_anyway');
      actions.push('reopen');
    }
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

// ---------------------------------------------------------------------------
// Open questions (rows Q1-Q4)

/**
 * Row Q1: a question is raised on a glob. A repeated key changes nothing. A `start` question holds only a glob that has not
 * started: elsewhere (and on a super, which waits for a person anyway) it is stored as a notice. A sub in Planning shows the
 * hold as waiting. A `merge` question is refused once the glob has merged, and is a notice while the merge is under way.
 */
export const raiseQuestion = (glob: Glob, input: NewQuestion, ctx: Context): Result<Transition> => {
  if (isHumanCategory(glob.category)) {
    return invalidTransition(glob, ctx.actor, 'A decision or action glob cannot hold a question');
  }
  const checked = checkNewQuestion(input);
  if (!checked.ok) return checked;
  const q = checked.value;
  const existing = questionsOf(glob);
  if (q.key !== undefined && existing.some((e) => e.key === q.key)) return unchanged(glob);
  if (existing.length >= MAX_QUESTIONS) return invalidInput(`A glob can have at most ${String(MAX_QUESTIONS)} questions`);
  if (q.blocking === 'merge' && (glob.status === 'reviewing' || glob.status === 'signed_off')) {
    return invalidTransition(glob, ctx.actor, 'A merged glob cannot have its merge held');
  }
  const blocking =
    q.blocking === 'start' && (glob.status !== 'planning' || glob.type === 'super')
      ? 'none'
      : q.blocking === 'merge' && glob.status === 'merging'
        ? 'none'
        : q.blocking;
  const made: OpenQuestion = {
    id: nextQuestionId(existing),
    ...(q.key === undefined ? {} : { key: q.key }),
    text: q.text,
    ...(q.options === undefined ? {} : { options: q.options }),
    ...(q.commands === undefined ? {} : { commands: q.commands }),
    raisedBy: q.raisedBy,
    source: q.source,
    blocking,
    raisedAt: ctx.now,
  };
  const b = new Builder(glob, ctx).set({ questions: [...existing, made] });
  // A sub waits in Planning with the same mark a start relation uses, so the held state shows and `released` can start it.
  if (blocking === 'start' && glob.type === 'sub' && glob.waiting == null) {
    b.set({ waiting: { since: ctx.now } });
  }
  return b.event('QuestionRaised', questionEventData(made)).done();
};

/** Finds an open question to answer or dismiss, or says why it can't be. */
const questionToClose = (glob: Glob, questionId: string, runId: string | null | undefined, ctx: Context): Result<OpenQuestion> => {
  if (isHumanCategory(glob.category)) return invalidTransition(glob, ctx.actor, 'A decision or action glob cannot hold a question');
  if (!canAnswer(glob, runId)) return forbidden('A routine run cannot answer or dismiss a question: it is a person\'s call');
  const q = questionsOf(glob).find((e) => e.id === questionId);
  if (q === undefined) return invalidInput(`${glob.id} has no question ${questionId}`);
  return ok(q);
};

const replaceQuestion = (glob: Glob, next: OpenQuestion): readonly OpenQuestion[] =>
  questionsOf(glob).map((q) => (q.id === next.id ? next : q));

/**
 * Row Q2: a person answers a question (an option, free text, or both). The answer is the person's: the service writes it
 * into the Clarifications attachment in the same transaction and then releases whatever the question held. Answering an
 * answered question with the same text changes nothing; with another text, or a dismissed one, it is refused.
 */
export const answerQuestion = (
  glob: Glob,
  input: { readonly questionId: string; readonly answer: string; readonly option?: string | null; readonly runId?: string | null },
  ctx: Context,
): Result<Transition> => {
  const actor = requireActor(ctx);
  const found = questionToClose(glob, input.questionId, input.runId, ctx);
  if (!found.ok) return found;
  const q = found.value;
  const chosen = (input.option ?? '').trim();
  const option = chosen === '' ? null : matchOption(q, chosen);
  if (chosen !== '' && option === null) return invalidInput(`${chosen} is not one of the options of ${q.id}`);
  const text = input.answer.trim() === '' ? (option ?? '') : input.answer.trim();
  if (text === '') return invalidInput('An answer needs text or an option');
  if (text.length > MAX_QUESTION_ANSWER) return invalidInput(`An answer is limited to ${String(MAX_QUESTION_ANSWER)} characters`);
  if (q.answer !== undefined) {
    return q.answer.text === text ? unchanged(glob) : invalidTransition(glob, actor, `${q.id} is already answered`);
  }
  if (q.dismissed !== undefined) return invalidTransition(glob, actor, `${q.id} was dismissed`);
  // Re-run on a plan-changed question: the merge stays held until a run on the new plan pushes a new head, and that run starts now.
  const rerun =
    q.blocking === 'merge' &&
    isPlanChangedQuestion(q) &&
    option !== null &&
    option.toLowerCase() === RERUN_OPTION.toLowerCase() &&
    glob.status !== 'reviewing' &&
    glob.status !== 'signed_off';
  const answered: OpenQuestion = {
    ...q,
    answer: { text, ...(option === null ? {} : { option }), by: actor.email, at: ctx.now, ...(rerun ? { rerunFrom: glob.pr?.headSha ?? null } : {}) },
  };
  const b = new Builder(glob, ctx)
    .set({ questions: replaceQuestion(glob, answered) })
    .event('QuestionAnswered', { id: q.id, blocking: q.blocking, ...(option === null ? {} : { option }) });
  if (rerun && glob.implementer === null && !hasWorkingRun(glob)) {
    b.endRun('superseded', null, { cause: 'plan_changed' }).queueRun(actor.email);
  }
  return b.done();
};

/** Row Q3: a person dismisses a question: go ahead as it is (the hold clears; the note is recorded). */
export const dismissQuestion = (
  glob: Glob,
  input: { readonly questionId: string; readonly note?: string | null; readonly runId?: string | null },
  ctx: Context,
): Result<Transition> => {
  const actor = requireActor(ctx);
  const found = questionToClose(glob, input.questionId, input.runId, ctx);
  if (!found.ok) return found;
  const q = found.value;
  const note = (input.note ?? '').trim();
  if (note.length > MAX_QUESTION_NOTE) return invalidInput(`A note is limited to ${String(MAX_QUESTION_NOTE)} characters`);
  if (q.dismissed !== undefined) return unchanged(glob);
  if (q.answer !== undefined) return invalidTransition(glob, actor, `${q.id} is already answered`);
  const dismissed: OpenQuestion = { ...q, dismissed: { by: actor.email, at: ctx.now, note: note === '' ? null : note } };
  return new Builder(glob, ctx)
    .set({ questions: replaceQuestion(glob, dismissed) })
    .event('QuestionDismissed', { id: q.id, blocking: q.blocking, ...(note === '' ? {} : { note }) })
    .done();
};

/** The questions of a glob that are still open (the context bundle and the views read this). */
export const openQuestionsOf = (glob: Glob): OpenQuestion[] => questionsOf(glob).filter(isOpenQuestion);
