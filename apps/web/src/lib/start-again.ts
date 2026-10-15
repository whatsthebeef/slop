import type { SlopType } from '@slop/core';
import type { GlobView } from './api';

/** What Discard does to each glob type once the PR and branch are gone. */
const DISCARD_OUTCOME = (type: SlopType | null, base: string): string =>
  type === 'sub'
    ? `a new machine run starts from ${base}`
    : type === 'same'
      ? 'it goes back to Planning'
      : 'it stays in Doing with its creator';

/** Said before Discard runs: where the glob goes, whether a run starts, and what is discarded. */
export const startAgainConfirmation = (
  glob: Pick<GlobView, 'id' | 'type' | 'branch' | 'pr'>,
  base: string,
): string => {
  const closes = glob.pr === null ? '' : `Closes PR #${glob.pr.number} and `;
  const deletes = `${closes === '' ? 'Deletes' : 'deletes'} branch ${glob.branch}`;
  return `${closes}${deletes}; ${DISCARD_OUTCOME(glob.type, base)}.`;
};
