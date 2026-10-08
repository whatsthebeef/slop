import type { RaisedNotification } from './notifications.js';

const RATE_LIMITED = /rate limit|abuse|secondary/i;

/**
 * Whether a code host refusal can't be fixed by retrying: 404 (the App can't see the repo) or a 403 that isn't
 * throttling (it lacks a permission). Both need a person.
 */
export const isRepoAccessFailure = (status: number | null, message = ''): boolean =>
  status === 404 || (status === 403 && !RATE_LIMITED.test(message));

/** The reason a glob shows when its branch can't be created: what happened and what to do, or the host's message. */
export const provisioningFailureReason = (
  globId: string,
  repo: string | null,
  status: number | null,
  message: string,
): string => {
  const where = repo === null ? '' : ` on ${repo}`;
  if (status === 404) {
    return `Couldn't create branch ${globId}${where}: the slop GitHub App can't see that repo. Install it on the repo, or add the repo to its access, then Start over.`;
  }
  if (status === 403 && !RATE_LIMITED.test(message)) {
    return `Couldn't create branch ${globId}${where}: the slop GitHub App lacks permission (contents: write). Accept its updated permissions on the installation, then Start over.`;
  }
  return `Couldn't create branch ${globId}${where}: ${message}`;
};

export const REPO_ACCESS_SOURCE = 'repo-access';

/** The board's warning that the App can't reach its repo; it clears on the next successful code host call for that repo. */
export const repoAccessNotification = (boardId: number, repo: string): RaisedNotification => ({
  boardId,
  source: REPO_ACCESS_SOURCE,
  severity: 'warning',
  title: `slop's GitHub App can't access ${repo}`,
  detail:
    'Install the App on the repo, or add the repo to its access (and accept any updated permissions). Globs that need a branch can fail until then.',
  link: null,
  action: null,
  clears: { kind: 'condition' },
});
