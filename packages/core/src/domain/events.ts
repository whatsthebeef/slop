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
  'LabelChanged',
  'PickedUp',
  'ArtifactAdded',
  'DeployStarted',
  'BuildCompleted',
  'ATFCompleted',
  'Deployed',
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
    }
  | { readonly kind: 'squash_merge'; readonly globId: string; readonly generation: number; readonly sha: string }
  | { readonly kind: 'reopen_pr'; readonly globId: string; readonly generation: number }
  | { readonly kind: 'close_pr'; readonly globId: string; readonly generation: number; readonly prNumber: number | null }
  | { readonly kind: 'delete_branch'; readonly globId: string; readonly generation: number }
  /** Runs after the glob is gone, so it carries what the clean-up needs. */
  | { readonly kind: 'delete_glob_data'; readonly globId: string; readonly boardId: number; readonly prNumber: number | null }
  /** Re-read whether the PR's current head can merge (required checks, conflicts). */
  | { readonly kind: 'refresh_checks'; readonly globId: string; readonly generation: number }
  /** Mark the glob's draft PR ready for review (the `ready_for_review` webhook then moves the glob, row 11). */
  | { readonly kind: 'mark_pr_ready'; readonly globId: string; readonly generation: number }
  /** Apply the board's sub-gate policy (size, sensitive paths) to the PR's head after its checks passed. */
  | { readonly kind: 'evaluate_sub_gate'; readonly globId: string; readonly generation: number; readonly sha: string }
  /** Put the glob's type and environment on its PR as labels (`slop:<type>`, `env:<name>`). */
  | { readonly kind: 'sync_pr_labels'; readonly globId: string; readonly generation: number };

export type EffectKind = Effect['kind'];
