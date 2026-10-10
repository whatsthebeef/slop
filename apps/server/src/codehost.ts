import type { Board, CheckFailure, DiffSummary, Glob } from '@slop/core';

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

/** A PR as the host reports it: what its webhooks would have said. */
export interface PrSnapshot {
  readonly state: 'open' | 'merged' | 'closed';
  readonly draft: boolean;
  readonly headSha: string;
  /** The merge commit, once merged. */
  readonly mergeSha: string | null;
}

export type MergeResult =
  | { readonly outcome: 'merged'; readonly sha: string }
  | { readonly outcome: 'updating' }
  | { readonly outcome: 'conflict' }
  /** GitHub hasn't decided whether the PR can merge (mergeable still null, or a 405 on a PR that looked clean): retry. */
  | { readonly outcome: 'undecided' }
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

/** How far a branch is behind the base branch (see `CodeHost.behindBase`). */
export interface BehindBase {
  readonly behindBy: number;
  readonly files: readonly string[];
}

/** What the host's integration is subscribed to, read with its own credentials. */
export interface AppSettings {
  readonly slug: string;
  readonly events: readonly string[];
  readonly owner: { readonly login: string; readonly type: string };
}

export interface CodeHost {
  /** True once the host integration is configured (e.g. the GitHub App exists). */
  readonly configured: boolean;
  /** Checks whether slop can reach the repo right now. */
  connection(repo: Repo): Promise<RepoConnection>;
  /** The integration's own settings (its event subscriptions and owner); null when it isn't set up or the host can't say. */
  appSettings(): Promise<AppSettings | null>;
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
  /** The PR as the host has it now: open (draft or ready), merged (with its merge commit) or closed, and its head. */
  prState(repo: Repo, prNumber: number): Promise<PrSnapshot>;
  /** The latest completed check run named `name` on commit `sha`, or null if none has completed yet. */
  completedCheckRun(repo: Repo, sha: string, name: string): Promise<{ sha: string; passed: boolean } | null>;
  /** A file's text on a branch, or null when the file (or branch) doesn't exist. `signal` aborts the request. */
  readFile(repo: Repo, ref: string, path: string, signal?: AbortSignal): Promise<string | null>;
  /** The names of the files directly in directory `dir` on a branch; empty when the directory (or branch) doesn't exist. */
  listFiles(repo: Repo, ref: string, dir: string, signal?: AbortSignal): Promise<string[]>;
  /** The files commit `sha` changed against its first parent (mined signals read its dependency manifests). */
  commitFiles(repo: Repo, sha: string, signal?: AbortSignal): Promise<CommitFiles>;
  /** Marks a draft PR ready for review. */
  markReady(repo: Repo, prNumber: number): Promise<{ wasDraft: boolean; sha: string }>;
  /** Whether the PR's branch merges cleanly into its base, in the host's own view; `unknown` while the host is still working it out. */
  conflictState(repo: Repo, prNumber: number): Promise<'clean' | 'conflict' | 'unknown'>;
  /** Files changed on both the PR's branch and the base branch since they diverged: where a conflict can be. Best effort; empty when unknown. */
  conflictFiles(repo: Repo, prNumber: number): Promise<string[]>;
  /**
   * How far the PR's branch is behind the base branch: the commits on the base it lacks (a merge each, under squash
   * merging) and the files changed on both sides since they diverged. Best effort; null when the host can't tell.
   */
  behindBase(repo: Repo, prNumber: number): Promise<BehindBase | null>;
  /** Posts a PR comment containing `marker` unless one with it exists already (so a retried effect comments once). */
  commentOnce(repo: Repo, prNumber: number, marker: string, body: string): Promise<'posted' | 'exists'>;
  /** Lines changed and files touched between the base branch and `sha`. */
  diffSummary(repo: Repo, sha: string): Promise<DiffSummary>;
  /** Lines changed (the commit's stats) and files touched by commit `sha` against its first parent: a merged sub's size. */
  commitDiffSummary(repo: Repo, sha: string, signal?: AbortSignal): Promise<DiffSummary>;
  /** The head commit of `ref` (a branch) and its subject line; null when the branch doesn't exist. */
  headOf(repo: Repo, ref: string): Promise<{ sha: string; subject: string } | null>;
  /**
   * The state of the checks on a commit and, when one failed, the first failing check's name, failed step and first
   * error lines from its log. Explaining is best effort: a failure with no lines still names the check.
   */
  commitChecks(repo: Repo, sha: string): Promise<{ state: 'passed' | 'pending' | 'failed'; failure: CheckFailure | null }>;
  /** The head's latest check runs that were cancelled and their end times: a newer run normally replaces them. */
  cancelledChecks(repo: Repo, sha: string): Promise<{ id: number; completedAt: string | null }[]>;
  /** Asks the app that owns a check run to run it again; best effort (another app's run can't be re-requested). */
  rerequestCheck(repo: Repo, checkRunId: number): Promise<void>;
  /**
   * Re-runs the failed jobs of the workflow runs that failed on `sha`, once per commit: `rerun` when it asked for
   * them, `already_rerun` when a failed run on the commit is already a re-run (so a redelivered event never re-runs
   * twice), `unavailable` when the host refused (the integration lacks permission) or nothing could be re-run.
   */
  rerunFailedJobs(repo: Repo, sha: string): Promise<'rerun' | 'already_rerun' | 'unavailable'>;
  /** Merges the base branch into the PR's branch (GitHub's update-branch) when it's behind, at exactly `sha`. */
  updateBranch(repo: Repo, prNumber: number, sha: string): Promise<'updating' | 'up_to_date' | 'conflict'>;
  /** Squash-merges at exactly `sha` as `<id>: <title>`, or updates a branch that is behind. */
  squashMerge(repo: Repo, glob: Glob, prNumber: number, sha: string): Promise<MergeResult>;
  /**
   * Reverts commit `sha` on the base branch as a new commit `Revert "<subject>"`. `moved` when the base has commits
   * after `sha` (the revert is then left to a person).
   */
  revertCommit(repo: Repo, sha: string): Promise<'reverted' | 'moved'>;
}

/**
 * Commit ancestry on the code host, apart from `CodeHost` so its test fakes don't need it: release and integration
 * deploys are matched to globs by whether the deployed commit contains each glob's merge commit.
 */
export interface CommitGraph {
  /** Whether `descendant` contains `ancestor` (or is it); null when the host doesn't know either commit. */
  contains(repo: Repo, descendant: string, ancestor: string, signal?: AbortSignal): Promise<boolean | null>;
}
