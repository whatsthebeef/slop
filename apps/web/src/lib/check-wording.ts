import { MERGING_WHEN_CHECKS_PASS_TEXT, mergingFromBaseText } from '@slop/core';
import type { GlobView } from './api';

/** The head moved past the checks slop recorded: it just merged the base in and waits for the new head's checks. */
const catchingUp = (glob: GlobView): boolean => {
  const sha = glob.pr?.headSha ?? null;
  return sha !== null && glob.headChecks != null && glob.headChecks.sha !== sha;
};

/** What a glob slop will merge says while its checks are in flight; the status line and the position text both use it. */
export const mergingChecksText = (glob: GlobView): string =>
  catchingUp(glob) ? mergingFromBaseText(glob.conflict?.base ?? glob.behind?.base ?? 'main') : MERGING_WHEN_CHECKS_PASS_TEXT;
