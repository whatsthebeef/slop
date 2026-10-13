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
  'MergeArmed',
  'MergeDisarmed',
  'MergeReverted',
  'MergeRevertFailed',
  'MergeFailureRecovered',
  'ConflictFlagged',
  'ConflictCleared',
  'ReturnedToReview',
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
  /** A person or agent added, ticked or dismissed a work step (data: the step and what changed). */
  'HumanStepChanged',
  /** The last work step holding back sign-off was done (or dismissed), so the glob moved on. */
  'RolloutDone',
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
      /**
       * `investigate`: the run only investigates a glob in Planning (no branch yet, nothing is committed).
       * `resolve_conflict`: the run merges the base branch into the glob's open PR and pushes.
       */
      readonly purpose?: 'investigate' | 'resolve_conflict';
      /** An automatic retry of a watcher that gave up: the failed check it is asked to fix (name and first lines). */
      readonly failureSummary?: string;
      /** Set for Start and Retrigger: the executor refuses to fire while prerequisites are unmerged (Start now doesn't set it). */
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
  /**
   * A glob merged for good: read the merge commit's files and, when they touch the board's rollout paths while the
   * implementation record has no `## Rollout`, add the "Rollout steps not written" step. Once only; a failed read flags nothing.
   */
  | { readonly kind: 'check_rollout_paths'; readonly globId: string; readonly generation: number; readonly sha: string }
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
  | { readonly kind: 'kb_draft'; readonly globId: string }
  /** Suggest for a decision glob (`globId`): one model call that recommends what to do with it. On demand, one unclaimed job per glob, `llm` lane; the executor re-reads the glob. */
  | { readonly kind: 'suggest_decision'; readonly globId: string }
  /**
   * Regenerate the board's knowledge page (a new version, unless nothing it is built from changed). Board-wide like
   * `recheck_overlaps` (`globId` is `board-<id>`, not generation-checked) and on the `llm` lane; the outbox keeps one
   * unclaimed job per board. `full` (an admin's Rebuild) skips the minimum interval and rewrites every section; a
   * `full` request upgrades the job already waiting instead of queueing another.
   */
  | { readonly kind: 'regenerate_knowledge_page'; readonly globId: string; readonly boardId: number; readonly full?: true }
  /**
   * Commit the board's current agent set to the branch of its open "Agent set vN" glob (creating the glob if there is none).
   * Board-wide like `recheck_overlaps` (`globId` is `board-<id>`, not generation-checked); the outbox keeps one unclaimed job
   * per board and pushes its `runAfter` out on every bump (a trailing debounce), so a batch of approvals makes one commit.
   */
  | { readonly kind: 'commit_agent_set'; readonly globId: string; readonly boardId: number }
  /**
   * Remove a file attachment's object from storage (a detached file, a deleted glob's files, a refused or orphaned upload).
   * `globId` is the glob the key was under, which may be gone; not generation-checked. Deleting a missing key succeeds.
   */
  | { readonly kind: 'delete_object'; readonly globId: string; readonly key: string };

export type ReviewStage = 'pre_merge' | 'post_merge';

export type EffectKind = Effect['kind'];

/** The outbox lanes. Each has its own runner, so a slow lane never holds up the others. */
export type OutboxLane = 'default' | 'llm';

export const OUTBOX_LANES: readonly OutboxLane[] = ['default', 'llm'];

/**
 * The one place an effect kind is assigned its lane. Every kind is `default` except the slow LLM effects, which go in
 * `llm`: the KB pipeline's routing and drafting and the knowledge page's regeneration. The `llm` runner starts with the `llm` job switch (or `kb`), so a new
 * llm-lane kind runs wherever those are on.
 */
const LANE_OF_KIND: Partial<Record<EffectKind, OutboxLane>> = { kb_route: 'llm', kb_draft: 'llm', suggest_decision: 'llm', regenerate_knowledge_page: 'llm' };

export const laneOf = (kind: EffectKind): OutboxLane => LANE_OF_KIND[kind] ?? 'default';

/**
 * Attempts a job may spend before it ends `failed`. A model that keeps giving unusable answers is given up on sooner
 * (the item stays decidable by hand); waits for an unavailable or busy model spend none.
 */
const MAX_ATTEMPTS_OF_LANE: Readonly<Record<OutboxLane, number>> = { default: 8, llm: 3 };

export const maxAttemptsOf = (lane: OutboxLane): number => MAX_ATTEMPTS_OF_LANE[lane];

/**
 * How long a job waits after a thrown failure before it runs again: 5 s doubling on `default`; 30 s doubling on `llm`,
 * so its three attempts span minutes rather than seconds (a model's bad minute passes). Capped at an hour.
 */
export const outboxBackoffMs = (attempts: number, lane: OutboxLane = 'default'): number =>
  Math.min(2 ** attempts * (lane === 'llm' ? 30 : 5), 3_600) * 1000;

/** How long a step on the `llm` lane may take before another runner may claim it again: above two model calls' deadlines. */
export const LLM_CLAIM_LEASE_MS = 5 * 60_000;

/**
 * How long a claim holds a job: its backoff on `default` (a crash mid-job retries after it); on `llm` at least the
 * lease, because a step can run for minutes and a second runner must not take it meanwhile.
 */
export const claimLeaseMs = (attempts: number, lane: OutboxLane = 'default'): number =>
  lane === 'llm' ? Math.max(outboxBackoffMs(attempts, lane), LLM_CLAIM_LEASE_MS) : outboxBackoffMs(attempts, lane);

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

/** Remove an attachment's object from storage; queued in the transaction that stops referring to it. */
export const deleteObjectEffect = (globId: string, key: string): Effect => ({ kind: 'delete_object', globId, key });

/** Suggest for a decision glob (an on-demand model recommendation). */
export const suggestEffect = (globId: string): Effect => ({ kind: 'suggest_decision', globId });

/** Regenerate the board's knowledge page; `full` (an admin's Rebuild) ignores the minimum interval and rewrites every section. */
export const knowledgePageEffect = (boardId: number, full = false): Effect => ({
  kind: 'regenerate_knowledge_page',
  globId: `board-${String(boardId)}`,
  boardId,
  ...(full ? { full: true as const } : {}),
});

/** How long after the last agent-set bump the board's agent set is committed (a batch of approvals makes one commit). */
export const AGENT_SET_COMMIT_DELAY_MS = 10 * 60_000;

/** Commit the board's agent set through its "Agent set vN" glob once bumps have settled. */
export const agentSetCommitEffect = (boardId: number): Effect => ({ kind: 'commit_agent_set', globId: `board-${String(boardId)}`, boardId });
