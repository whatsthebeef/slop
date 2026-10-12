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

/** Whether the action is still pending: the glob is still at the version it was clicked on and the timeout has not passed. */
export const isPending = (pending: PendingAction | null, version: number, now: number): boolean =>
  pending !== null && pending.version === version && now - pending.at < PENDING_TIMEOUT_MS;

/**
 * Starts an action unless one is already pending or running, so a second click does nothing.
 * Resolves false when it was ignored; a failed action (false) clears the pending state at once.
 */
export const startAction = async (
  current: PendingAction | null,
  inFlight: boolean,
  next: PendingAction,
  send: () => Promise<boolean>,
  set: (pending: PendingAction | null) => void,
): Promise<boolean> => {
  if (inFlight || isPending(current, next.version, next.at)) return false;
  set(next);
  let ok = false;
  try {
    ok = await send();
  } finally {
    if (!ok) set(null);
  }
  return ok;
};
