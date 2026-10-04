import type { Board, DiffSummary, Glob } from '@slop/core';

/** A board's repository on its code host. */
export interface Repo {
  readonly owner: string;
  readonly name: string;
  readonly base: string;
}

export const repoOf = (board: Board): Repo | null => {
  const [owner, name] = (board.repo ?? '').split('/');
  return owner !== undefined && owner !== '' && name !== undefined && name !== ''
    ? { owner, name, base: board.baseBranch }
    : null;
};

/** Whether a review's head can merge, in the host's own view (required checks, conflicts, up to date). */
export type MergeState = 'passed' | 'pending' | 'failed' | 'behind' | 'conflict' | 'unknown';

export type MergeResult =
  | { readonly outcome: 'merged'; readonly sha: string }
  | { readonly outcome: 'updating' }
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'refused'; readonly reason: string };

/**
 * The code-host port: everything slop does to a repository. GitHub (pull requests) is the only
 * implementation today; GitLab merge requests or Forgejo would implement the same operations,
 * with a webhook adapter translating their events into the same state-machine events.
 */
export interface CodeHost {
  /** True once the host integration is configured (e.g. the GitHub App exists). */
  readonly configured: boolean;
  /** Creates the glob's branch (empty `<id>: start` commit) and draft review with labels. Idempotent. */
  provision(repo: Repo, glob: Glob): Promise<{ branch: string; pr: { number: number; headSha: string } }>;
  syncLabels(repo: Repo, glob: Glob, prNumber: number): Promise<void>;
  closePr(repo: Repo, prNumber: number): Promise<void>;
  deleteBranch(repo: Repo, branch: string): Promise<void>;
  reopenPr(repo: Repo, prNumber: number, branch: string): Promise<'reopened' | 'missing'>;
  mergeState(repo: Repo, prNumber: number): Promise<{ sha: string; state: MergeState }>;
  /** Lines changed and files touched between the base branch and `sha`. */
  diffSummary(repo: Repo, sha: string): Promise<DiffSummary>;
  /** Squash-merges at exactly `sha` as `<id>: <title>`, or updates a branch that is behind. */
  squashMerge(repo: Repo, glob: Glob, prNumber: number, sha: string): Promise<MergeResult>;
}
