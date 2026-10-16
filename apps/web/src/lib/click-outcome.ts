import type { Action } from '@slop/core';
import { hasAfterMergeStep, ROLLOUT_AFTER_MERGE_TEXT } from '@slop/core';
import type { ListedHumanStep } from './api';

/** What a merge action did, as a toast: merged, armed to merge when the checks pass, cancelled, or why it can't. Null for other actions. */
export const mergeOutcomeText = (
  action: Action,
  glob: {
    status: string;
    mergeMode?: string | null;
    failure?: { reason: string } | null;
    humanSteps?: readonly ListedHumanStep[];
  },
): string | null => {
  if (action === 'cancel_merge') return 'Merge cancelled';
  if (
    action !== 'merge' &&
    action !== 'merge_anyway' &&
    action !== 'merge_continue' &&
    action !== 'retry_merge' &&
    action !== 'retry_checks'
  )
    return null;
  const after = hasAfterMergeStep(glob.humanSteps) ? `; ${ROLLOUT_AFTER_MERGE_TEXT}` : '';
  if (glob.mergeMode === 'when_green' && glob.status === 'pr_open')
    return `Will merge when checks pass${after}`;
  if (glob.status === 'failed') return `Can't merge: ${glob.failure?.reason ?? 'the merge failed'}`;
  return glob.status === 'reviewing' ? 'Merged' : `Merging…${after}`;
};

/** Pick up (take_over included, both labelled "Pick up" on the card): once it succeeds, the glob's view opens. */
export const opensGlobView = (action: Action): boolean =>
  action === 'pick_up' || action === 'take_over';

/**
 * Whether a refused click is on the glob now: the glob was read again after the click and carries the refusal as its last outcome
 * (the server stores it, which bumps the version), so the notice says why and the person needs no toast.
 */
export const outcomeRecorded = (
  fresh: { readonly version: number; readonly lastOutcome?: { readonly kind: Action } | null },
  clicked: { readonly version: number },
  action: Action,
): boolean => fresh.version > clicked.version && fresh.lastOutcome?.kind === action;

/**
 * A refused click on the board card: the glob is reloaded (the refusal bumped its version) and the reason is always toasted, because
 * the card shows status only and the stored notice lives in the glob view. A failed reload toasts too.
 */
export const reportRefusal = <G>(
  reload: () => Promise<G>,
  store: (glob: G) => void,
  toast: (message: string) => void,
  message: string,
): Promise<void> =>
  reload().then(
    (fresh) => {
      store(fresh);
      toast(message);
    },
    () => toast(message),
  );
