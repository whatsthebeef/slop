import type { Board, CheckFailure, DiffSummary, Glob } from '@slop/core';

/** A board's repository on its code host. */
export interface Repo {
  readonly owner: string;
  readonly name: string;
  readonly base: string;
}

/** The host can't say whether a branch has a merge queue: nothing is merged on a guess (the outbox retries). */
export class QueueDetectionError extends Error {}

export const repoOf = (board: Board): Repo | null => {
  const [owner, name] = (board.repo ?? '').split('/');
  return owner !== undefined && owner !== '' && name !== undefined && name !== ''
    ? { owner, name, base: board.baseBranch }
    : null;
};

/**
 * The neutral check run slop reports "N findings" under. It is informational, so every reading of a head's checks
 * leaves it out (a repo with no other CI would otherwise never look passed).
 */
export const REVIEW_CHECK = 'slop-review';

/** What a review's head's own checks say, or that it conflicts (`mergeState`); whether it is behind the base is a separate flag. */
export type MergeState = 'passed' | 'pending' | 'failed' | 'conflict' | 'unknown';

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
  /** The head isn't behind the base but its checks aren't green (still running, or failed): slop never merges it. */
  | { readonly outcome: 'checks_not_green'; readonly state: 'pending' | 'failed' | 'unknown' }
  /** The branch has a merge queue: the PR is in it (the host tests it with the PRs ahead and merges it in order). */
  | ({ readonly outcome: 'queued' } & MergeQueueEntry)
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

/** A file to commit to a branch; `executable` sets the mode 100755 (hooks run as commands). */
export interface BranchFile {
  readonly path: string;
  readonly content: string;
  readonly executable?: boolean;
}

/** What the host's integration is subscribed to, read with its own credentials. */
export interface AppSettings {
  readonly slug: string;
  readonly events: readonly string[];
  readonly owner: { readonly login: string; readonly type: string };
}

/** What an independent review reads: a git ref to read files from, and the change as a unified diff against it. */
export interface ReviewDiff {
  /** Where the reviewer reads files and greps: the PR's test-merge ref before merge, the base branch after. */
  readonly ref: string;
  /** The commit under review: the test-merge commit, or the squash commit. Reviews are deduplicated by it. */
  readonly sha: string;
  /** The base-branch commit the change applies to (the test merge's first parent, the squash commit's parent). */
  readonly baseSha: string | null;
  readonly diff: string;
}

/** The PR as it would land on the latest base branch, or why that can't be known yet. */
export type TestMergeTarget =
  | ({ readonly outcome: 'ready' } & ReviewDiff)
  | { readonly outcome: 'conflict' }
  /** The host hasn't built (or has outdated) the test merge; ask again shortly. */
  | { readonly outcome: 'undecided' }
  | { readonly outcome: 'not_open' };

/** One review submission on a PR: a summary and inline comments, all on one commit. */
export interface PostedReview {
  /** The commit the review is attached to (the PR head); inline comments are anchored in its diff. */
  readonly commitSha: string;
  readonly body: string;
  readonly comments: readonly { readonly path: string; readonly line: number; readonly body: string }[];
}

/** An inline comment on a PR, as the host lists it (slop's own review comments and people's replies to them). */
export interface PrReviewComment {
  readonly id: number;
  readonly body: string;
  /** The comment this one replies to; null for the first comment of a thread. */
  readonly inReplyTo: number | null;
  /** The author's login; null for a deleted account. */
  readonly author: string | null;
  readonly authorIsBot: boolean;
  readonly path: string;
  readonly line: number | null;
  /** How many people reacted with a thumbs-down. */
  readonly thumbsDown: number;
  readonly createdAt: string;
}

/** A check run slop reports (not a gate: its conclusion is neutral). */
export interface ReportedCheck {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
}

/** What the host's rules say about merging into a branch, as far as the integration can read them. */
export interface BranchRules {
  /** The status checks the rules require before merging. */
  readonly requiredChecks: readonly string[];
  /** Whether the integration is on the bypass list of the rulesets requiring checks; null when the host won't show bypass lists. */
  readonly integrationBypasses: boolean | null;
  /** Whether the branch has a merge queue rule: slop's merge then enqueues the PR instead of merging it. */
  readonly mergeQueue: boolean;
}

/** A PR's place in the host's merge queue: its 1-based position (null when unknown) and whether its group is being merged. */
export interface MergeQueueEntry {
  readonly position: number | null;
  readonly state: 'queued' | 'merging';
}

export interface CodeHost {
  /** True once the host integration is configured (e.g. the GitHub App exists). */
  readonly configured: boolean;
  /** Checks whether slop can reach the repo right now. */
  connection(repo: Repo): Promise<RepoConnection>;
  /** The integration's own settings (its event subscriptions and owner); null when it isn't set up or the host can't say. */
  appSettings(): Promise<AppSettings | null>;
  /** The rules applying to `branch` (the integration's own token); null when they can't be read. */
  branchRules(repo: Repo, branch: string): Promise<BranchRules | null>;
  /** Creates the glob's branch (empty `<id>: start` commit) and draft review with labels. Idempotent. */
  provision(repo: Repo, glob: Glob, plan: string): Promise<{ branch: string; pr: { number: number; headSha: string } }>;
  /**
   * Opens a draft review with labels for the glob's existing branch, or returns the open one.
   * Null when the host refuses one because the branch has nothing to merge yet.
   */
  openDraftPr(repo: Repo, glob: Glob, plan: string): Promise<{ number: number; headSha: string } | null>;
  syncLabels(repo: Repo, glob: Glob, prNumber: number): Promise<void>;
  closePr(repo: Repo, prNumber: number): Promise<void>;
  deleteBranch(repo: Repo, branch: string): Promise<void>;
  reopenPr(repo: Repo, prNumber: number, branch: string): Promise<'reopened' | 'missing'>;
  mergeState(repo: Repo, prNumber: number): Promise<{ sha: string; state: MergeState; behind?: boolean }>;
  /** The PR as the host has it now: open (draft or ready), merged (with its merge commit) or closed, and its head. */
  prState(repo: Repo, prNumber: number): Promise<PrSnapshot>;
  /** The latest completed check run named `name` on commit `sha`, or null if none has completed yet. */
  completedCheckRun(repo: Repo, sha: string, name: string): Promise<{ sha: string; passed: boolean } | null>;
  /** A file's text on a branch, or null when the file (or branch) doesn't exist. `signal` aborts the request. */
  readFile(repo: Repo, ref: string, path: string, signal?: AbortSignal): Promise<string | null>;
  /** The names of the files directly in directory `dir` on a branch; empty when the directory (or branch) doesn't exist. */
  listFiles(repo: Repo, ref: string, dir: string, signal?: AbortSignal): Promise<string[]>;
  /** The entries directly in directory `dir` ('' is the root) on a ref, folders included; null when the directory (or ref) doesn't exist. */
  listDir(repo: Repo, ref: string, dir: string, signal?: AbortSignal): Promise<{ name: string; type: 'file' | 'dir' }[] | null>;
  /** A short-lived read-only token for fetching the repo with git (the reviewer's temporary clone). Never log it. */
  readToken(repo: Repo): Promise<string>;
  /**
   * Commits `files` (written whole) and removes `deletions` on `branch` as one commit on its head, as the integration.
   * `changed` is false, and nothing is committed, when the result has the head's tree already. Never forces the ref.
   */
  commitToBranch(repo: Repo, branch: string, files: readonly BranchFile[], deletions: readonly string[], message: string): Promise<{ sha: string; changed: boolean }>;
  /** The files commit `sha` changed against its first parent (mined signals read its dependency manifests). */
  commitFiles(repo: Repo, sha: string, signal?: AbortSignal): Promise<CommitFiles>;
  /**
   * The open PR merged into the latest base branch, from the host's test-merge ref (`refs/pull/<n>/merge`): its diff is
   * the first parent (the base head) to the merge commit. `undecided` while the host is still computing the merge or
   * its merge commit isn't on the current base head and PR head, so a review never reads a stale merge.
   */
  testMergeTarget(repo: Repo, prNumber: number, signal?: AbortSignal): Promise<TestMergeTarget>;
  /** A merged change: the squash commit's diff against its parent, with files read from the current base branch. */
  mergedTarget(repo: Repo, sha: string, signal?: AbortSignal): Promise<ReviewDiff>;
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
  /** The PR's own diff (its merge-base with the base branch to `headSha`), as the host shows it for inline comments. */
  prDiff(repo: Repo, headSha: string, signal?: AbortSignal): Promise<string>;
  /**
   * Submits one review (event COMMENT, so it never blocks or approves) with its inline comments. When the host rejects the
   * inline comments (a line that isn't in the PR's own diff), the review is posted again with them folded into its body, so
   * a finding is never lost. Returns the review's ID and how many comments were placed inline.
   */
  submitReview(repo: Repo, prNumber: number, review: PostedReview): Promise<{ id: number; inline: number }>;
  /**
   * Marks slop's earlier reviews on the PR outdated: those whose body starts with `markerPrefix`, other than `exceptId`.
   * Each review's body is rewritten with `rewrite` (an update the host allows on a submitted review) and its inline comments
   * are minimized as outdated. Best effort; returns how many reviews it changed.
   */
  outdateReviews(repo: Repo, prNumber: number, markerPrefix: string, exceptId: number | null, rewrite: (body: string) => string): Promise<number>;
  /** The PR's inline review comments (all authors, replies included), oldest first; the reviewer's own are found by their marker. */
  reviewComments(repo: Repo, prNumber: number): Promise<PrReviewComment[]>;
  /** Reports a completed, neutral check run on `sha`; `unavailable` when the integration lacks the checks permission. */
  reportCheck(repo: Repo, sha: string, check: ReportedCheck): Promise<'created' | 'unavailable'>;
  /** Lines changed and files touched between the base branch and `sha`. */
  diffSummary(repo: Repo, sha: string): Promise<DiffSummary>;
  /** Lines changed (the commit's stats) and files touched by commit `sha` against its first parent: a merged sub's size. */
  commitDiffSummary(repo: Repo, sha: string, signal?: AbortSignal): Promise<DiffSummary>;
  /** The head commit of `ref` (a branch) and its subject line; null when the branch doesn't exist. */
  headOf(repo: Repo, ref: string): Promise<{ sha: string; subject: string; parent: string | null } | null>;
  /**
   * The state of the checks on a commit and, when one failed, the first failing check's name, failed step and first
   * error lines from its log. Explaining is best effort: a failure with no lines still names the check.
   */
  commitChecks(repo: Repo, sha: string, opts?: { pushedOnly?: boolean }): Promise<{ state: 'passed' | 'pending' | 'failed'; failure: CheckFailure | null }>;
  /** The head's latest check runs that were cancelled and their end times: a newer run normally replaces them. */
  cancelledChecks(repo: Repo, sha: string): Promise<{ id: number; completedAt: string | null }[]>;
  /** Asks the app that owns a check run to run it again; best effort (another app's run can't be re-requested). */
  rerequestCheck(repo: Repo, checkRunId: number): Promise<void>;
  /**
   * Re-runs the failed jobs of the workflow runs that failed on `sha`, once per commit: `rerun` when it asked for
   * them, `already_rerun` when a failed run on the commit is already a re-run (so a redelivered event never re-runs
   * twice; `force`, a person's Retry checks, skips that guard), `unavailable` when the host refused (the integration lacks permission) or nothing could be re-run.
   */
  rerunFailedJobs(repo: Repo, sha: string, opts?: { force?: boolean }): Promise<'rerun' | 'already_rerun' | 'unavailable'>;
  /** Merges the base branch into the PR's branch (GitHub's update-branch) when it's behind, at exactly `sha`. */
  updateBranch(repo: Repo, prNumber: number, sha: string): Promise<'updating' | 'up_to_date' | 'conflict'>;
  /**
   * Squash-merges at exactly `sha` as `<id>: <title>`. Slop's App bypasses the host's branch rules, so slop enforces them:
   * it merges only a head that is `sha` with passed checks. Where the branch has a merge queue it enqueues the PR instead
   * (`queued`), never merging it directly or updating its branch: the queue tests the combined result. Otherwise a behind
   * head is updated (the merge resumes on the new head's checks); one whose checks aren't green is not merged
   * (`checks_not_green`). Throws when it can't tell whether the branch has a merge queue.
   */
  squashMerge(repo: Repo, glob: Glob, prNumber: number, sha: string): Promise<MergeResult>;
  /** The PR's entry in the host's merge queue; null when it isn't queued. */
  mergeQueueEntry(repo: Repo, prNumber: number): Promise<MergeQueueEntry | null>;
  /** Takes the PR out of the host's merge queue; `not_queued` when it wasn't in it. */
  dequeue(repo: Repo, prNumber: number): Promise<'dequeued' | 'not_queued'>;
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

/** A release tag and the commit it points at. */
export interface ReleaseTag {
  readonly name: string;
  readonly sha: string;
}

/**
 * Refs on the code host, apart from `CodeHost` so its test fakes don't need it: a person recording a release by hand
 * names a branch, tag or commit, and slop needs the commit it means (and recent tags to offer).
 */
export interface ReleaseRefs {
  /** The commit `ref` (a branch, tag or sha) points at; null when the host doesn't know it. */
  resolveRef(repo: Repo, ref: string): Promise<string | null>;
  /** The repo's most recent tags, newest first. */
  recentTags(repo: Repo, limit: number): Promise<ReleaseTag[]>;
}
