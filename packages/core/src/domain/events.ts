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
  /** A glob was cut into parts (`split_glob`): on every part, with the source, its place and the other parts' IDs. */
  'GlobSplit',
  'GlobDeleted',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

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
      /** An automatic retry of a watcher that gave up: the failed check it is asked to fix (name and first lines). */
      readonly failureSummary?: string;
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
   * The PR is ready for review: ask CodeRabbit for one (`@coderabbitai review`) when the repo's `.coderabbit.yaml` turns
   * its automatic reviews off and the board has a review guide. Posted once per PR.
   */
  | { readonly kind: 'request_code_review'; readonly globId: string; readonly generation: number }
  /**
   * A glob merged: start the globs that waited for it, if nothing else holds them. Runs after commit; each released
   * glob is its own version-checked write, so a retry or a second delivery changes nothing.
   */
  | { readonly kind: 'release_waiting'; readonly globId: string; readonly generation: number }
  /** Read which exclusive paths the glob's branch changes and whether another open glob changes them too. */
  | { readonly kind: 'check_exclusive_paths'; readonly globId: string; readonly generation: number }
  /** Put the glob's type and environment on its PR as labels (`slop:<type>`, `env:<name>`). */
  | { readonly kind: 'sync_pr_labels'; readonly globId: string; readonly generation: number };

export type EffectKind = Effect['kind'];
