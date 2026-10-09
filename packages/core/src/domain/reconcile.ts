import type { Glob } from './types.js';
import { currentRun, isReconcilable } from './machine.js';

/** A ready PR whose head has no check result this long after the glob last changed is probably waiting on a lost webhook. */
export const RECONCILE_CHECKS_AFTER_MS = 10 * 60_000;
/** A glob nothing has changed for this long while a run is watching it may have missed any webhook. */
export const RECONCILE_WATCHING_AFTER_MS = 60 * 60_000;

/**
 * Whether the periodic sweep should re-read a glob's PR from the code host. `updatedAt` stands in for the last
 * webhook: every webhook that matters changes the glob, and one that was lost leaves it as it was.
 */
export const reconcileDue = (glob: Glob, nowMs: number): boolean => {
  if (!isReconcilable(glob) || glob.pr === null) return false;
  const quietMs = nowMs - Date.parse(glob.updatedAt);
  const checked = glob.headChecks !== null && glob.headChecks.state !== 'pending' && glob.headChecks.sha === glob.pr.headSha;
  if (glob.pr.state === 'ready' && !checked && quietMs > RECONCILE_CHECKS_AFTER_MS) return true;
  return currentRun(glob)?.state === 'watching' && quietMs > RECONCILE_WATCHING_AFTER_MS;
};
