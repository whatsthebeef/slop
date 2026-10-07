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

/** The check run the sub gate's GitHub Action reports as; slop applies its policy once it passes (rows 12–13). */
export const SUB_GATE_CHECK = 'sub-gate';

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
/** Whether slop's integration can reach a repo, and where a person installs it if not. */
export interface RepoConnection {
  readonly configured: boolean;
  readonly connected: boolean;
  /** The page where a person installs or configures slop's integration for the repo. */
  readonly installUrl: string | null;
  readonly appName: string | null;
}

/** What one commit changed: its first parent (null for a root commit) and its files. */
export interface CommitFiles {
  readonly parent: string | null;
  readonly files: readonly { readonly path: string; readonly previousPath: string | null; readonly status: 'added' | 'removed' | 'modified' | 'renamed' | 'other' }[];
}

export interface CodeHost {
  /** True once the host integration is configured (e.g. the GitHub App exists). */
  readonly configured: boolean;
  /** Checks whether slop can reach the repo right now. */
  connection(repo: Repo): Promise<RepoConnection>;
  /** Creates the glob's branch (empty `<id>: start` commit) and draft review with labels. Idempotent. */
  provision(repo: Repo, glob: Glob): Promise<{ branch: string; pr: { number: number; headSha: string } }>;
  /**
   * Opens a draft review with labels for the glob's existing branch, or returns the open one.
   * Null when the host refuses one because the branch has nothing to merge yet.
   */
  openDraftPr(repo: Repo, glob: Glob): Promise<{ number: number; headSha: string } | null>;
  syncLabels(repo: Repo, glob: Glob, prNumber: number): Promise<void>;
  closePr(repo: Repo, prNumber: number): Promise<void>;
  deleteBranch(repo: Repo, branch: string): Promise<void>;
  reopenPr(repo: Repo, prNumber: number, branch: string): Promise<'reopened' | 'missing'>;
  mergeState(repo: Repo, prNumber: number): Promise<{ sha: string; state: MergeState }>;
  /** The latest completed check run named `name` on commit `sha`, or null if none has completed yet. */
  completedCheckRun(repo: Repo, sha: string, name: string): Promise<{ sha: string; passed: boolean } | null>;
  /** A file's text on a branch, or null when the file (or branch) doesn't exist. `signal` aborts the request. */
  readFile(repo: Repo, ref: string, path: string, signal?: AbortSignal): Promise<string | null>;
  /** The files commit `sha` changed against its first parent (mined signals read its dependency manifests). */
  commitFiles(repo: Repo, sha: string, signal?: AbortSignal): Promise<CommitFiles>;
  /** Marks a draft PR ready for review. */
  markReady(repo: Repo, prNumber: number): Promise<{ wasDraft: boolean; sha: string }>;
  /** Files changed on both the PR's branch and the base branch since they diverged: where a conflict can be. Best effort; empty when unknown. */
  conflictFiles(repo: Repo, prNumber: number): Promise<string[]>;
  /** Posts a PR comment containing `marker` unless one with it exists already (so a retried effect comments once). */
  commentOnce(repo: Repo, prNumber: number, marker: string, body: string): Promise<'posted' | 'exists'>;
  /** Lines changed and files touched between the base branch and `sha`. */
  diffSummary(repo: Repo, sha: string): Promise<DiffSummary>;
  /** Squash-merges at exactly `sha` as `<id>: <title>`, or updates a branch that is behind. */
  squashMerge(repo: Repo, glob: Glob, prNumber: number, sha: string): Promise<MergeResult>;
}
