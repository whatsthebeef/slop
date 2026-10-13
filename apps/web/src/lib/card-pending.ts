import type { Action } from '@slop/core';

/** How long a card shows its move as working before it gives up and says so. */
export const CARD_PENDING_MS = 20_000;

/** What a card says while its move is in flight. */
const WORKING: Partial<Record<Action, string>> = {
  start: 'Starting…',
  start_anyway: 'Starting…',
  investigate: 'Investigating…',
  pick_up: 'Picking up…',
  take_over: 'Taking over…',
  retrigger: 'Re-triggering…',
  retry_autofix: 'Retrying…',
  resolve_conflict: 'Resolving…',
  start_again: 'Starting again…',
  merge: 'Merging…',
  retry_merge: 'Merging…',
  cancel_merge: 'Cancelling…',
  mark_ready: 'Marking ready…',
};

/** The present participle shown on a card whose action is in flight. */
export const workingLabel = (action: Action): string => WORKING[action] ?? 'Working…';

/** What a merge action did, as a toast: merged, armed to merge when the checks pass, cancelled, or why it can't. Null for other actions. */
export const mergeOutcomeText = (
  action: Action,
  glob: { status: string; mergeMode?: string | null; failure?: { reason: string } | null },
): string | null => {
  if (action === 'cancel_merge') return 'Merge cancelled';
  if (action !== 'merge' && action !== 'merge_continue' && action !== 'retry_merge') return null;
  if (glob.mergeMode === 'when_green') return 'Will merge when checks pass';
  if (glob.status === 'failed') return `Can't merge: ${glob.failure?.reason ?? 'the merge failed'}`;
  return glob.status === 'reviewing' ? 'Merged' : 'Merging…';
};

/** The moves in flight, by glob ID. */
export type CardPending = Readonly<Record<string, Action>>;

/**
 * Runs a card's move with one in-flight action per glob. The card shows pending at once (`set`) and the
 * state clears when the work settles; a request that never answers is cleared after the timeout with `onSlow`.
 * Resolves null when ignored because the glob already has an action in flight (a repeat click, a key, a drop).
 */
export const runCardAction = async (
  inFlight: Set<string>,
  id: string,
  action: Action,
  work: () => Promise<boolean>,
  set: (id: string, action: Action | null) => void,
  onSlow: () => void,
  timeoutMs: number = CARD_PENDING_MS,
): Promise<boolean | null> => {
  if (inFlight.has(id)) return null;
  inFlight.add(id);
  set(id, action);
  const timer = setTimeout(() => {
    if (!inFlight.delete(id)) return;
    set(id, null);
    onSlow();
  }, timeoutMs);
  try {
    return await work();
  } finally {
    clearTimeout(timer);
    if (inFlight.delete(id)) set(id, null);
  }
};
