import type { GlobView } from './api';

/** Said before Discard runs: what is discarded and that nothing starts. */
export const startAgainConfirmation = (glob: Pick<GlobView, 'branch' | 'pr'>): string => {
  const closes = glob.pr === null ? '' : `Closes PR #${glob.pr.number} and `;
  const deletes = `${closes === '' ? 'Deletes' : 'deletes'} branch ${glob.branch}`;
  return `${closes}${deletes}, clears the implementer and moves the glob back to Planning. Nothing starts; the plan, questions and relations stay.`;
};
