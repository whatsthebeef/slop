import type { Action, SlopType } from '@slop/core';
import type { GlobView } from './api';

/** What Start again is called for each glob type: it goes somewhere different for each. */
export const START_AGAIN_LABELS: Record<SlopType, string> = {
  sub: 'Start over (new run)',
  same: 'Back to Planning',
  super: 'Start over',
};

/** What Start again does to each glob type once the PR and branch are gone. */
const START_AGAIN_OUTCOME = (type: SlopType, base: string): string =>
  type === 'sub'
    ? `a new routine run starts from ${base}`
    : type === 'same'
      ? 'it goes back to Planning'
      : 'it stays in Doing with its creator';

/** An action's name for this glob: Start again is named by type (and never says "Back to Planning" from Planning), the rest are the same for all. */
export const actionLabel = (
  action: Action,
  type: SlopType,
  labels: Record<Action, string>,
  status?: string,
): string => {
  if (action !== 'start_again') return labels[action];
  return status === 'planning' && type === 'same' ? 'Start over' : START_AGAIN_LABELS[type];
};

/** Said before Start again runs: where the glob goes, whether a run starts, and what is discarded. */
export const startAgainConfirmation = (
  glob: Pick<GlobView, 'id' | 'type' | 'branch' | 'pr'>,
  base: string,
): string => {
  const closes = glob.pr === null ? '' : `Closes PR #${glob.pr.number} and `;
  const deletes = `${closes === '' ? 'Deletes' : 'deletes'} branch ${glob.branch}`;
  return `${closes}${deletes}; ${START_AGAIN_OUTCOME(glob.type, base)}.`;
};
