import { MERGING_WHEN_CHECKS_PASS_TEXT, mergingFromBaseText, modeOf } from '@slop/core';
import type { GlobView } from './api';

/** The head moved past the checks slop recorded: it just merged the base in and waits for the new head's checks. */
const catchingUp = (glob: GlobView): boolean => {
  const sha = glob.pr?.headSha ?? null;
  return sha !== null && glob.headChecks != null && glob.headChecks.sha !== sha;
};

/** Whether a merging glob's head still waits for its checks: none recorded yet, still pending, or recorded on an older head. */
export const checksInFlightWhileMerging = (glob: GlobView): boolean =>
  catchingUp(glob) || glob.headChecks == null || glob.headChecks.state === 'pending';

/**
 * What a glob slop will merge says while its checks are in flight; the status line and the position text both use it.
 * `base` is the board's base branch; after slop pushes the base merge `behind` is cleared, so it usually names the base.
 */
export const mergingChecksText = (glob: GlobView, base?: string): string =>
  catchingUp(glob)
    ? mergingFromBaseText(glob.conflict?.base ?? glob.behind?.base ?? base ?? 'the base')
    : MERGING_WHEN_CHECKS_PASS_TEXT;

/** The tooltip for checks running on a PR slop isn't merging: the head, what comes after they pass, and what a failure does. */
export const checksRunningTip = (glob: GlobView): string => {
  const sha = glob.pr?.headSha ?? null;
  const next =
    glob.pr?.state === 'draft'
      ? 'nothing changes: the PR stays a draft until the work is marked ready'
      : (glob.allowedActions ?? []).includes('merge')
        ? 'a person merges it with Merge (pressed before then, slop merges it once they pass)'
        : modeOf(glob) === 'sub'
          ? "the board's sub gate decides whether slop merges it or a person reviews it"
          : 'the glob goes on to its next step';
  return `Checks are running on ${sha === null ? 'the PR head' : sha.slice(0, 7)}. When they pass, ${next}; if any fail, the glob says which one failed.`;
};
