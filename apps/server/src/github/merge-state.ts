import type { MergeState } from '../codehost.js';

/**
 * The conclusions of a completed check run that count as a failure. `cancelled` is not one: a run is cancelled when a
 * newer run replaces it (a concurrency group), so the head waits for the newer run instead of reading red.
 */
export const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/** A cancelled run that no newer run replaced within this long is asked to run again. */
export const CANCELLED_RERUN_MINUTES = 5;

/** A completed check run that was cancelled: neither passed nor failed, and waiting for a newer run on the same head. */
export const isCancelled = (r: { status: string; conclusion: string | null }): boolean =>
  r.status === 'completed' && r.conclusion === 'cancelled';

/** Whether the run has not finished with a result: queued, running, or cancelled and waiting for its replacement. */
export const isUnfinished = (r: { status: string; conclusion: string | null }): boolean => r.status !== 'completed' || isCancelled(r);

/**
 * The cancelled runs (latest per name, so none has a newer run yet) that are old enough to ask the App to run again.
 * Runs only carry an ID and completion time here.
 */
export const staleCancelledRuns = <T extends { status: string; conclusion: string | null; completed_at?: string | null }>(
  runs: readonly T[],
  now: number,
): T[] =>
  runs.filter(
    (r) =>
      isCancelled(r) &&
      r.completed_at != null &&
      (now - Date.parse(r.completed_at)) / 60_000 >= CANCELLED_RERUN_MINUTES,
  );

/**
 * Maps GitHub's `mergeable_state` to a merge state. `unstable` (a non-required check failed or is running) and
 * `blocked` (a required check is missing or failed) don't say which, so the head's check runs decide: any failed
 * run fails the head, any unfinished or cancelled run leaves it pending, and an `unstable` head with neither is a failing
 * commit status, which also fails it. A `sub-gate` that isn't a required check lands here as `unstable`.
 */
export const classifyMergeState = (
  mergeableState: string,
  runs: readonly { status: string; conclusion: string | null }[],
): MergeState => {
  switch (mergeableState) {
    case 'clean':
    case 'has_hooks':
      return 'passed';
    case 'unstable':
    case 'blocked': {
      if (runs.some((r) => r.status === 'completed' && r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion))) {
        return 'failed';
      }
      if (runs.some(isUnfinished)) return 'pending';
      return mergeableState === 'unstable' ? 'failed' : 'pending';
    }
    case 'behind':
      return 'behind';
    case 'dirty':
      return 'conflict';
    case 'draft':
      return 'pending';
    default:
      return 'unknown';
  }
};
