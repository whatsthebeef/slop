import type { Glob, PendingAction } from './types.js';

/** A click's in-progress state is shown for this long; after it, with nothing new on the glob, the click counts as without effect. */
export const PENDING_TIMEOUT_MS = 60_000;

/** The pending action still in force at `now` (an ISO time): none once it is older than `PENDING_TIMEOUT_MS`. Pure, so a timeout needs no write. */
export const pendingInForce = (
  glob: Pick<Glob, 'pendingAction'>,
  now: string,
): PendingAction | null => {
  const pending = glob.pendingAction;
  if (pending == null) return null;
  return Date.parse(now) - Date.parse(pending.at) < PENDING_TIMEOUT_MS ? pending : null;
};

/**
 * Whether the click `pending` has timed out at `now`: older than `PENDING_TIMEOUT_MS` and the thing it started is not still going.
 * A run it named that is queued or active, or a merge that is armed (when checks pass) or merging (waiting in the merge line or at its head), is the click doing its
 * job slowly, not having no effect. Pure; one rule for the notice, the activity log and the write in `Builder.settlePending`.
 */
export const pendingTimedOut = (
  glob: Pick<Glob, 'runs' | 'mergeMode' | 'status'>,
  pending: PendingAction,
  now: string,
): boolean => {
  if (Date.parse(now) - Date.parse(pending.at) < PENDING_TIMEOUT_MS) return false;
  if (pending.runId !== undefined) {
    const run = glob.runs.find((r) => r.id === pending.runId);
    if (run !== undefined && run.state !== 'ended') return false;
  }
  const merging = glob.mergeMode === 'when_green' || glob.status === 'merging';
  return !merging;
};
