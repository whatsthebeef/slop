import type { Action } from '@slop/core';

/** An action the person clicked and the glob view has not yet shown the result of. */
export interface PendingAction {
  action: Action;
  /** The glob's version when it was clicked. */
  version: number;
  /** When it was clicked (ms). */
  at: number;
}

/** How long the view waits for the glob to change before it stops showing the action as working. */
export const PENDING_TIMEOUT_MS = 15_000;

/** How long a queued run counts as still being set up. */
export const QUEUED_SETTLE_MS = 30_000;

/** The parts of a glob that show whether slop is still setting it up. */
export interface Settling {
  version: number;
  provisioning?: string;
  currentRun?: { state: string; queuedAt: string } | null;
}

/** Whether slop is still setting the glob up: its branch and PR are pending, or its run was queued moments ago. */
export const isSettling = (glob: Settling, now: number): boolean => {
  if (glob.provisioning === 'pending') return true;
  const run = glob.currentRun;
  return run?.state === 'queued' && now - Date.parse(run.queuedAt) < QUEUED_SETTLE_MS;
};

/**
 * Whether the action is still pending: the glob is still at the version it was clicked on, or has moved but is still
 * being set up. Either way the 15 s timeout ends it, so a failed or stuck setup shows at once.
 */
export const isPending = (pending: PendingAction | null, glob: Settling, now: number): boolean =>
  pending !== null && now - pending.at < PENDING_TIMEOUT_MS && (pending.version === glob.version || isSettling(glob, now));

/**
 * Starts an action unless one is already pending or running, so a second click does nothing.
 * Resolves false when it was ignored; a failed action (false) clears the pending state at once.
 */
export const startAction = async (
  current: PendingAction | null,
  inFlight: boolean,
  next: PendingAction,
  glob: Settling,
  send: () => Promise<boolean>,
  set: (pending: PendingAction | null) => void,
): Promise<boolean> => {
  if (inFlight || isPending(current, glob, next.at)) return false;
  set(next);
  let ok = false;
  try {
    ok = await send();
  } finally {
    if (!ok) set(null);
  }
  return ok;
};
