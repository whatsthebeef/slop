import type { MergeState } from '../codehost.js';

/** The conclusions of a completed check run that count as a failure. */
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

/**
 * Maps GitHub's `mergeable_state` to a merge state. `unstable` (a non-required check failed or is running) and
 * `blocked` (a required check is missing or failed) don't say which, so the head's check runs decide: any failed
 * run fails the head, any unfinished run leaves it pending, and an `unstable` head with neither is a failing
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
      if (runs.some((r) => r.status !== 'completed')) return 'pending';
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
