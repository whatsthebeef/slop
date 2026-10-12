export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const DOMAIN_EVENT_TYPES = [
  'GlobCreated',
  'FieldsChanged',
  'StatusChanged',
  'RunTriggered',
  'RunFailed',
  'RunEnded',
  'BranchCreated',
  'CommitPushed',
  'PROpened',
  'PRReadyForReview',
  'PRClosed',
  'SubReviewCompleted',
  'ReviewReceived',
  'Merged',
  'MergeFailed',
  'MergeReverted',
  'MergeRevertFailed',
  'MergeFailureRecovered',
  'ConflictFlagged',
  'ConflictCleared',
  'ConflictFixRequested',
  'BehindChanged',
  'LabelChanged',
  'LabelItemTicked',
  'PickedUp',
  'ArtifactAdded',
  /** A person asked for an independent review now (data: the stage it will run at). */
  'ReviewRequested',
  'DeployRequested',
  'DeployReplaced',
  'DeployStarted',
  'DeployFailed',
  'BuildCompleted',
  'BaseChecksChanged',
  'ATFCompleted',
  'Deployed',
  /** A release or integration environment no longer holds a glob it held (a rollback). */
  'DeployRolledBack',
  /** A glob was held in Planning for globs it starts after (`after`, or a merge-policy hold). */
  'Waiting',
  /** What a glob waited for merged: it started by itself. */
  'Released',
  /** A person started a held glob (or picked it up) before what it waits for merged. */
  'HoldOverridden',
  /** Another open glob started or stopped changing the same exclusive paths as this one. */
  'ClashChanged',
  /** An overlap edge was predicted for a glob (data: the other glob, its paths and why) by a recheck. */
  'OverlapAdded',
  /** A predicted overlap edge no longer holds and was dropped (data: the other glob and why). */
  'OverlapDropped',
  /** A glob was cut into parts (`split_glob`): on every part, with the source, its place and the other parts' IDs. */
  'GlobSplit',
  /** A running sub was escalated to a same because a human should check it (reason and evidence in the data). */
  'Escalated',
  /** A person made an escalated glob a sub again. */
  'Deescalated',
  'GlobDeleted',
  /** A person chose an outcome for a decision glob (accept, retarget, needs work, reject), or the pipeline closed it. */
  'DecisionDecided',
  /** The work glob a decision waited on merged. */
  'DecisionWorkLanded',
  /** An admin reopened a learning the KB pipeline closed (data: how it was closed). */
  'DecisionReopened',
  /** A glob's attributes changed (a decision's scope, or its conflict flags). */
  'AttributesChanged',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** Events of an investigate-only run (it never starts the glob), so run-history learning leaves them out. */
export const isInvestigateEvent = (e: Pick<DomainEvent, 'data'>): boolean => e.data.purpose === 'investigate';

/** A row in the append-only event log. `actor` is null for system and integration events. */
export interface DomainEvent {
  readonly type: DomainEventType;
  readonly globId: string;
  readonly actor: string | null;
  readonly at: string;
  readonly data: { readonly [key: string]: JsonValue };
}

/**
 * Side effects, written to the outbox in the same transaction as the state change.
 * Executors re-check the glob's generation (and the run's state) before acting, so
 * effects queued under an older generation are dropped.
 */
export type Effect =
  | { readonly kind: 'provision'; readonly globId: string; readonly generation: number }
  | {
      readonly kind: 'fire_routine';
      readonly globId: string;
      readonly generation: number;
      readonly runId: string;
      readonly routineOwner: string;
      /** `investigate`: the run only investigates a glob in Planning (no branch yet, nothing is committed). */
      readonly purpose?: 'investigate';
      /** An automatic retry of a watcher that gave up: the failed check it is asked to fix (name and first lines). */
      readonly failureSummary?: string;
      /** Set for Start and Retrigger: the executor refuses to fire while prerequisites are unmerged (Start anyway doesn't set it). */
      readonly checkPrerequisites?: true;
    }
  | { readonly kind: 'squash_merge'; readonly globId: string; readonly generation: number; readonly sha: string }
  /** Revert a sub's merge commit on the base branch after the checks on it failed. */
  | { readonly kind: 'revert_merge'; readonly globId: string; readonly generation: number; readonly sha: string }
  | { readonly kind: 'reopen_pr'; readonly globId: string; readonly generation: number }
  /** Open a fresh draft PR for the glob's branch (after Merge and continue, on the next push). */
  | { readonly kind: 'open_pr'; readonly globId: string; readonly generation: number }
  | { readonly kind: 'close_pr'; readonly globId: string; readonly generation: number; readonly prNumber: number | null }
  | { readonly kind: 'delete_branch'; readonly globId: string; readonly generation: number }
  /** Runs after the glob is gone, so it carries what the clean-up needs. */
  | { readonly kind: 'delete_glob_data'; readonly globId: string; readonly boardId: number; readonly prNumber: number | null }
  /** Re-read whether the PR's current head can merge (required checks, conflicts). */
  | { readonly kind: 'refresh_checks'; readonly globId: string; readonly generation: number }
  /**
   * Webhooks are best effort: read the PR's state, head and merge from the code host and apply what was missed through
   * the same transitions the webhooks use. Queued on start and by a periodic sweep; idempotent.
   */
  | { readonly kind: 'reconcile_pr'; readonly globId: string; readonly generation: number }
  /** Mark the glob's draft PR ready for review (the `ready_for_review` webhook then moves the glob, row 11). */
  | { readonly kind: 'mark_pr_ready'; readonly globId: string; readonly generation: number }
  /** Apply the board's sub-gate policy (size, sensitive paths) to the PR's head after its checks passed. */
  | { readonly kind: 'evaluate_sub_gate'; readonly globId: string; readonly generation: number; readonly sha: string }
  /**
   * Look up a `sub-gate` check run that already completed on a sub's PR head, in case it finished before
   * slop recorded the PR as ready (its webhook was then ignored).
   */
  | { readonly kind: 'refresh_sub_gate'; readonly globId: string; readonly generation: number }
  /** A push to a glob with an environment asks for a deploy of exactly that commit. */
  | { readonly kind: 'request_deploy'; readonly globId: string; readonly generation: number; readonly sha: string }
  /** Start a deploy with the board's deploy integration; the deploy record says what and where. */
  | { readonly kind: 'start_deploy'; readonly deployId: string; readonly globId: string }
  /** A glob merged to the base branch: recheck the board's other open PRs for conflicts with it. */
  | { readonly kind: 'flag_conflicts'; readonly globId: string; readonly generation: number }
  /** Read whether the glob's open PR conflicts with the base branch (`since`: the glob whose merge prompted it). */
  | { readonly kind: 'check_conflict'; readonly globId: string; readonly generation: number; readonly since: string | null }
  /** Read how far the glob's branch is behind the base branch (its branch or the base received a push). */
  | { readonly kind: 'check_behind'; readonly globId: string; readonly generation: number }
  /** Ask the Claude GitHub App, in a PR comment, to merge the base branch in and resolve the conflict. */
  | { readonly kind: 'request_conflict_fix'; readonly globId: string; readonly generation: number }
  /**
   * Read the base branch head's check result (a check ran on the base branch) and record it on the board. Board-wide,
   * so `globId` is `board-<id>` and it isn't generation-checked; re-reading is idempotent.
   */
  | { readonly kind: 'refresh_base_checks'; readonly globId: string; readonly boardId: number }
  /**
   * A release or integration environment now runs `sha`: work out which recently merged globs (and which globs it
   * held before, for rollbacks) that commit contains. Board-wide like `refresh_base_checks` (`globId` is `board-<id>`,
   * not generation-checked); dropped when a newer deploy to the environment has been recorded since.
   */
  | {
      readonly kind: 'check_environment';
      readonly globId: string;
      readonly boardId: number;
      readonly environment: string;
      readonly sha: string;
    }
  /** Bring the glob's PR branch up to date with the base branch so its checks run again (the base went green). */
  | { readonly kind: 'update_branch'; readonly globId: string; readonly generation: number; readonly sha: string }
  /**
   * A glob merged: start the globs that waited for it, if nothing else holds them. Runs after commit; each released
   * glob is its own version-checked write, so a retry or a second delivery changes nothing.
   */
  | { readonly kind: 'release_waiting'; readonly globId: string; readonly generation: number }
  /** Read which exclusive paths the glob's branch changes and whether another open glob changes them too. */
  | { readonly kind: 'check_exclusive_paths'; readonly globId: string; readonly generation: number }
  /**
   * Something changed on the board that predicted overlaps depend on (a merge, a push, a status change, a plan save):
   * recompute every open glob's implied overlap edges. Board-wide like `refresh_base_checks` (`globId` is `board-<id>`,
   * not generation-checked); the outbox keeps one pending job per board and delays it a few seconds, so a burst runs once.
   */
  | { readonly kind: 'recheck_overlaps'; readonly globId: string; readonly boardId: number }
  /** Put the glob's type and environment on its PR as labels (`slop:<type>`, `env:<name>`). */
  | { readonly kind: 'sync_pr_labels'; readonly globId: string; readonly generation: number }
  /**
   * Independent review of the change (spec, "When it runs"). `sha` is the reviewed target: the PR head for a pre-merge
   * review of a same or super, the squash commit for a sub's post-merge review. The outbox keeps one job per glob, stage
   * and sha, and cancels a pre-merge job whose head a newer push replaced; the executor drops one that is no longer current.
   * `requestId` marks an on-demand review (Review now): it is never deduplicated or cancelled, and it reviews whatever the
   * PR is when it runs (the stage follows the PR's state, so `stage` and `sha` only say what it was when asked).
   */
  | { readonly kind: 'review_change'; readonly globId: string; readonly generation: number; readonly stage: ReviewStage; readonly sha: string; readonly requestId?: string }
  /**
   * The KB pipeline's steps for one learning (`globId` is the KB item's ID): route and deduplicate it, or draft it against
   * its target. No generation: the executor re-derives the step from the item and drops a job that no longer applies, so a
   * repeat costs at most one model call. The outbox keeps one pending job per item and kind.
   */
  | { readonly kind: 'kb_route'; readonly globId: string }
  | { readonly kind: 'kb_draft'; readonly globId: string };

export type ReviewStage = 'pre_merge' | 'post_merge';

export type EffectKind = Effect['kind'];

/** The outbox lanes. Each has its own runner, so a slow lane never holds up the others. */
export type OutboxLane = 'default' | 'llm';

export const OUTBOX_LANES: readonly OutboxLane[] = ['default', 'llm'];

/**
 * The one place an effect kind is assigned its lane. Every kind is `default` except the slow LLM effects, which go in
 * `llm`: the KB pipeline's routing and drafting.
 */
const LANE_OF_KIND: Partial<Record<EffectKind, OutboxLane>> = { kb_route: 'llm', kb_draft: 'llm' };

export const laneOf = (kind: EffectKind): OutboxLane => LANE_OF_KIND[kind] ?? 'default';

/**
 * Attempts a job may spend before it ends `failed`. A model that keeps giving unusable answers is given up on sooner
 * (the item stays decidable by hand); waits for an unavailable or busy model spend none.
 */
const MAX_ATTEMPTS_OF_LANE: Readonly<Record<OutboxLane, number>> = { default: 8, llm: 3 };

export const maxAttemptsOf = (lane: OutboxLane): number => MAX_ATTEMPTS_OF_LANE[lane];

/** How long a claimed job waits before it may run again (a crash mid-job, or a thrown failure): 5 s doubling, capped at an hour. */
export const outboxBackoffMs = (attempts: number): number => Math.min(2 ** attempts * 5, 3_600) * 1000;

/**
 * An executor's request to run again later without spending an attempt (an LLM that is busy or unavailable, or a record
 * that changed under it). `reason` is kept as the job's last error, so the item can say why it waits; without one the
 * last error stays as it was.
 */
export interface RetryLater {
  readonly state: 'pending';
  readonly retryAfterMs: number;
  readonly reason?: string;
}

/** What running an effect did: done, dropped because it no longer applies, or asked to run again later. Throwing spends an attempt. */
export type EffectOutcome = 'done' | 'dropped' | RetryLater;

export const OUTBOX_STATES = ['pending', 'done', 'dropped', 'failed'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

/** An outbox job as readers see it (without the effect): where it is, how many attempts it spent, and its last error. */
export interface OutboxJob {
  readonly id: number;
  readonly globId: string;
  readonly kind: EffectKind;
  readonly state: OutboxState;
  readonly attempts: number;
  /** The last failure, or why it waits (an executor's retry-later reason). */
  readonly lastError: string | null;
  /** When it may run next. */
  readonly runAfter: string;
}

/** The board's overlap recheck: its `globId` is `board-<id>`, as for the other board-wide effects. */
export const recheckOverlapsEffect = (boardId: number): Effect => ({ kind: 'recheck_overlaps', globId: `board-${String(boardId)}`, boardId });
