import type { BaseChecks, Board, BoardService, ObjectStore, CheckFailure, HealthSink, EffectKind, Glob, GlobService, NotificationService } from '@slop/core';
import { conflictInstructions, fireRoutine, investigateInstructions, runInstructions } from './routines.js';
import type { RoutineSource } from './routines.js';
import { isRepoAccessFailure, isSetupFailure, machine, refusalText, parseId, provisioningFailureReason, repoAccessNotification, REPO_ACCESS_SOURCE, sizeIgnoredPathsOf, subGateCheckOf, subGatePolicy } from '@slop/core';
import type { Executor } from './jobs/outbox.js';
import type { CodeHost } from './codehost.js';
import type { Repo } from './codehost.js';
import { QueueDetectionError, repoOf } from './codehost.js';

/** How long a cancelled check run may wait for a newer run on the same head before it is re-requested. */
const CANCELLED_CHECK_WAIT_MS = 5 * 60_000;

/** How often a run held for pending files looks again. */
const FILES_POLL_MS = 15_000;
/** How soon a run whose branch is still being created looks again (it starts within this of the branch existing). */
const PROVISION_POLL_MS = 3_000;
/** GitHub's refusal when a merge names a head the PR no longer has. */
const HEAD_MODIFIED = /head branch was modified/i;

/** A dequeue with no reason this soon after the enqueue may just be the host not showing the entry yet: look again first. */
const QUEUE_GRACE_MS = 2 * 60_000;

/** The merge queue's removal reasons in words (the host's `MergeQueueDequeueReason` values). */
const QUEUE_REASON_TEXT: Readonly<Record<string, string>> = {
  MANUAL: 'Removed from the merge queue',
  CI_FAILURE: 'Removed from the merge queue: its checks failed',
  CI_TIMEOUT: 'Removed from the merge queue: its checks timed out',
  BRANCH_PROTECTIONS: 'Removed from the merge queue: a branch protection rule was not met',
  QUEUE_CLEARED: 'Removed from the merge queue: the queue was cleared',
  GIT_TREE_INVALID: 'Removed from the merge queue: GitHub could not build the merge commit',
  INVALID_MERGE_COMMIT: 'Removed from the merge queue: GitHub could not build the merge commit',
};

/** The HTTP status of a code host error (Octokit's `status`), when it has one. */
const httpStatus = (error: unknown): number | null =>
  typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : null;

/**
 * Outbox executors for the code host (the GitHub App today). Each turns one effect into GitHub calls and feeds what
 * happened back through the state machine. Throwing makes the outbox retry with backoff.
 */
export const codeHostExecutors = (
  host: CodeHost,
  boardOf: (id: number) => Promise<Board | null>,
  routines: RoutineSource,
  boards: Pick<BoardService, 'recordBaseChecks'>,
  now: () => string = () => new Date().toISOString(),
  health: HealthSink | null = null,
  notifications: Pick<NotificationService, 'syncMainRed' | 'raise' | 'clear'> | null = null,
  /** The board's merge policy's `sizeIgnoredPaths` (undefined: none set, so the defaults apply). */
  sizeIgnoredPaths: (boardId: number) => Promise<readonly string[] | undefined> = () => Promise.resolve(undefined),
  log: (task: string, message: string) => void = () => undefined,
  /** File attachments' storage; without it (no bucket configured) no `delete_object` effect is ever queued. */
  objects: Pick<ObjectStore, 'delete'> | null = null,
  /** Milliseconds the glob's pending file uploads can still arrive (0: none); a run waits for them. Absent: file attachments are off. */
  pendingFiles: ((globId: string) => Promise<number>) | null = null,
  /** The board's merge policy's `subGateCheck` (undefined: none set, so the default applies). */
  subGateCheck: (boardId: number) => Promise<string | undefined> = () => Promise.resolve(undefined),
): Partial<Record<EffectKind, Executor>> => {
  const repoFor = async (boardId: number) => {
    const board = await boardOf(boardId);
    return board === null ? null : repoOf(board);
  };

  /**
   * A sub's gate check can finish before slop records the PR as ready, and its webhook is then ignored: look up a
   * completed run on the head and feed it through the machine (which ignores it unless the sub is in pr_open there).
   */
  const lookUpSubGate = async (repo: Repo, glob: Glob, sha: string, globs: GlobService) => {
    if (glob.type !== 'sub' || glob.status !== 'pr_open') return;
    const check = await host.completedCheckRun(repo, sha, subGateCheckOf({ subGateCheck: await subGateCheck(glob.boardId) }));
    // Not finished yet: its webhook will come.
    if (check === null) return;
    await globs.applyEvent(glob.id, (g, ctx) => machine.subGateCheckCompleted(g, check, ctx));
  };

  /**
   * A cancelled check run leaves the head pending until a newer run on the same head replaces it. When none has come
   * after `CANCELLED_CHECK_WAIT_MS`, ask the app to run it again; before that, retry the effect later.
   */
  const waitForCancelledChecks = async (repo: Repo, sha: string) => {
    const cancelled = await host.cancelledChecks(repo, sha);
    if (cancelled.length === 0) return;
    const waited = cancelled.every((c) => c.completedAt !== null && Date.parse(now()) - Date.parse(c.completedAt) >= CANCELLED_CHECK_WAIT_MS);
    if (!waited) throw new Error('A check run was cancelled; waiting for the newer run on the same head');
    for (const c of cancelled) await host.rerequestCheck(repo, c.id);
  };

  /** The failing check's name, step and first error lines; best effort, since the checks' state is already known. */
  const explainFailure = async (repo: Repo, sha: string): Promise<CheckFailure | null> => {
    try {
      return (await host.commitChecks(repo, sha)).failure;
    } catch {
      return null;
    }
  };

  /** The checks on a base commit's parent: read from the stored green result when it is that commit, else from the host. */
  const parentChecksOf = async (
    repo: Repo,
    previous: BaseChecks | null | undefined,
    head: { parent: string | null },
  ): Promise<'passed' | 'pending' | 'failed' | 'unknown'> => {
    if (head.parent === null) return 'unknown';
    if (previous?.state === 'passed' && previous.sha === head.parent) return 'passed';
    try {
      return (await host.commitChecks(repo, head.parent, { pushedOnly: true })).state;
    } catch {
      return 'unknown';
    }
  };

  /** The glob a base-branch commit merged: slop squash-merges as `<id>: <title>`. */
  const globOfSubject = (subject: string): string | null => {
    const id = subject.split(':')[0]?.trim() ?? '';
    return parseId(id) === null ? null : id;
  };

  return {
    provision: async (_effect, glob, { globs }, attempt) => {
      if (glob === null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null || !host.configured) {
        // Boards without a repo (or before the app exists) only reserve the branch name.
        await globs.applyEvent(glob.id, (g, ctx) => machine.provisioned(g, { branch: g.id, pr: null }, ctx));
        return 'done';
      }
      const name = `${repo.owner}/${repo.name}`;
      try {
        const result = await host.provision(repo, glob, await globs.peekPlan(glob.id));
        await globs.applyEvent(glob.id, (g, ctx) => machine.provisioned(g, result, ctx));
        await notifications?.clear(glob.boardId, REPO_ACCESS_SOURCE);
        return 'done';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = httpStatus(error);
        // A 404 or 403 means the App can't reach the repo: say so on the glob and the board, and don't retry.
        const impossible = isRepoAccessFailure(code, message);
        const reason = provisioningFailureReason(glob.id, name, code, message);
        await globs.applyEvent(glob.id, (g, ctx) => machine.provisioningFailed(g, reason, ctx, impossible || attempt?.final === true));
        if (impossible) {
          await notifications?.raise(repoAccessNotification(glob.boardId, name));
          return 'done';
        }
        throw error;
      }
    },

    sync_pr_labels: async (_effect, glob) => {
      if (glob?.pr == null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      await host.syncLabels(repo, glob, glob.pr.number);
      return 'done';
    },

    close_pr: async (effect, glob) => {
      if (effect.kind !== 'close_pr' || effect.prNumber === null || glob === null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      await host.closePr(repo, effect.prNumber);
      return 'done';
    },

    delete_branch: async (effect, glob) => {
      if (glob === null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      await host.deleteBranch(repo, effect.globId);
      return 'done';
    },

    reopen_pr: async (_effect, glob, { globs }) => {
      if (glob === null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const reopened = glob.pr === null ? 'missing' : await host.reopenPr(repo, glob.pr.number, glob.id);
      if (reopened === 'missing') {
        // The branch was deleted: provision a fresh branch and draft PR.
        const result = await host.provision(repo, glob, await globs.peekPlan(glob.id));
        await globs.applyEvent(glob.id, (g, ctx) => machine.provisioned(g, result, ctx));
      }
      return 'done';
    },

    open_pr: async (_effect, glob, { globs }) => {
      // After Merge and continue: only while the glob is still in progress without a PR.
      if (glob === null || glob.pr !== null || glob.status !== 'in_progress') return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null || !host.configured) return 'dropped';
      const pr = await host.openDraftPr(repo, glob, await globs.peekPlan(glob.id));
      // Nothing to merge yet: the next push tries again.
      if (pr === null) return 'done';
      // The `opened` webhook may have recorded it first; recording it again is a no-op.
      await globs.applyEvent(glob.id, (g, ctx) => machine.prOpened(g, pr, ctx));
      return 'done';
    },

    /**
     * Webhooks are best effort (a restart or tunnel blip loses them), so the code host is the source of truth: read the
     * PR and apply what slop missed through the transitions the webhooks use. Idempotent; raises no notifications of its own.
     */
    reconcile_pr: async (_effect, glob, { globs }) => {
      if (glob === null || !machine.isReconcilable(glob) || glob.pr === null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const prNumber = glob.pr.number;
      const pr = await host.prState(repo, prNumber);
      const caught = (what: string) => log('reconcile', `${glob.id} ${what} (missed webhook)`);
      if (pr.state === 'merged') {
        caught(`merged as ${pr.mergeSha ?? pr.headSha}`);
        await globs.applyEvent(glob.id, (g, ctx) => machine.merged(g, { sha: pr.mergeSha ?? pr.headSha, number: prNumber }, ctx));
        return 'done';
      }
      if (pr.state === 'closed') {
        caught('PR closed');
        await globs.applyEvent(glob.id, (g, ctx) => machine.prClosed(g, ctx));
        return 'done';
      }
      if (pr.headSha !== glob.pr.headSha) {
        caught(`head moved to ${pr.headSha}`);
        await globs.applyEvent(glob.id, (g, ctx) => machine.commitPushed(g, { sha: pr.headSha, runId: null }, ctx));
      }
      if (!pr.draft && glob.pr.state === 'draft') {
        caught('PR ready for review');
        await globs.applyEvent(glob.id, (g, ctx) => machine.prReadyForReview(g, { number: prNumber, headSha: pr.headSha }, ctx));
      }
      // The head's checks: re-read them when slop has no result for this head (the effect records it like a webhook would).
      const now = await globs.peek(glob.id);
      if ((now?.status === 'pr_open' || now?.status === 'merging') && (now.headChecks === null ||
          now.headChecks.sha !== pr.headSha ||
          now.headChecks.state === 'pending' ||
          // Recorded as failed with no detail while the PR conflicts: that was the conflict, not the checks.
          (now.conflict != null && now.headChecks.state === 'failed' && now.headChecks.failure === undefined))) {
        log('reconcile', `${glob.id} rereading head checks (no result recorded)`);
        await globs.applyEvent(glob.id, (g, ctx) => machine.checksChanged(g, ctx));
      }
      // A queued merge re-reads its queue entry too (a missed dequeue or merge, and the position behind it).
      if (now?.status === 'merging' && now.mergeQueue != null) {
        await globs.applyEvent(glob.id, (g, ctx) => machine.mergeQueueEvent(g, { kind: 'reconcile' }, ctx));
      }
      return 'done';
    },

    refresh_checks: async (_effect, glob, { globs }) => {
      if (glob?.pr == null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const { sha, state } = await host.mergeState(repo, glob.pr.number);
      const board = await boardOf(glob.boardId);
      // GitHub computes mergeability in the background; retry until it has an answer.
      if (state === 'unknown') throw new Error('GitHub has not computed the merge state yet');
      await lookUpSubGate(repo, glob, sha, globs);
      // A flagged conflict clears once the PR can merge into the base branch again.
      if (state !== 'conflict' && glob.conflict != null) await globs.applyEvent(glob.id, (g, ctx) => machine.conflictCleared(g, ctx));
      if (state === 'pending') {
        await waitForCancelledChecks(repo, sha);
        return 'done';
      }
      // A behind head counts only by its own check runs: `behind` is not a pass.
      const passed = state === 'passed';
      // A conflict after slop updated the branch is its own failure, not a failing check.
      const conflict = state === 'conflict' ? { base: repo.base, files: await host.conflictFiles(repo, glob.pr.number) } : undefined;
      // Say what failed, and whether the base branch fails the same way (then it isn't this glob's change).
      const failure = state === 'failed' ? await explainFailure(repo, sha) : null;
      // A conflict says nothing about the head's own checks: read what its check runs report (GitHub usually runs none).
      const real = state === 'conflict' ? await host.commitChecks(repo, sha) : undefined;
      // The relations are read so an armed merge waits while a `merge` relation is unmet.
      await globs.applyEvent(
        glob.id,
        (g, ctx, facts) =>
          machine.checksCompleted(
            g,
            {
              sha,
              passed,
              ...(conflict !== undefined && { conflict }),
              ...(real !== undefined && { real }),
              ...(failure !== null && { failure, base: board?.baseChecks ?? null, baseBranch: repo.base }),
            },
            ctx,
            facts.relations,
          ),
        { relations: true },
      );
      return 'done';
    },

    refresh_base_checks: async (effect, _glob, { globs }) => {
      if (effect.kind !== 'refresh_base_checks') return 'dropped';
      const board = await boardOf(effect.boardId);
      const repo = board === null ? null : repoOf(board);
      if (board === null || repo === null || !host.configured) return 'dropped';
      const head = await host.headOf(repo, repo.base);
      if (head === null) return 'dropped';
      // Only checks the push triggered: an issue_comment or review workflow borrows the base head's sha and says nothing about it.
      const result = await host.commitChecks(repo, head.sha, { pushedOnly: true });
      // The calls above reached the repo, so the App can see it again.
      await notifications?.clear(board.id, REPO_ACCESS_SOURCE);
      // Still running: the check's completion sends another event.
      if (result.state === 'pending') return 'done';
      const passed = result.state === 'passed';
      // A failure in CI's own setup says nothing about the commit: run the failed jobs again once, and record nothing
      // until they finish. A second setup failure (or no permission to re-run) is recorded, but never blamed on a sub.
      const setupFailure = !passed && result.failure !== null && isSetupFailure(result.failure);
      if (setupFailure && (await host.rerunFailedJobs(repo, head.sha)) === 'rerun') return 'done';
      // Blame and revert only a commit whose parent passed its checks: otherwise the base was already red before it.
      const blameable = !passed && !setupFailure;
      const parentChecks = blameable ? await parentChecksOf(repo, board.baseChecks, head) : 'unknown';
      const fromGreen = parentChecks === 'passed';
      const recorded = await boards.recordBaseChecks(
        board.id,
        { sha: head.sha, passed, failure: result.failure, merged: blameable && fromGreen ? globOfSubject(head.subject) : null, fromGreen },
        now(),
      );
      if (recorded === null) return 'done';
      // Whether or not the result changed: a retry after a crash between recording and raising still raises it.
      await notifications?.syncMainRed(board.id, repo.base, recorded.checks);
      if (!recorded.change.changed) return 'done';
      const { checks, change } = recorded;
      // A sub whose merge commit turned the base red is reverted and failed; sames are left to a person.
      const headGlob = globOfSubject(head.subject);
      if (blameable && headGlob !== null) {
        const culprit = await globs.peek(headGlob);
        if (culprit?.type === 'sub') {
          // Clear evidence only: this commit is the first red one and its parent was green.
          if (fromGreen && head.parent !== null && checks.since === headGlob && checks.redSha === head.sha) {
            const parent = head.parent;
            await globs.applyEvent(culprit.id, (g, ctx) =>
              machine.mergeTurnedBaseRed(g, { sha: head.sha, failure: result.failure, base: repo.base, parent }, ctx),
            );
          } else {
            const reason = `${repo.base} was already red or its parent's checks are unknown, so this merge is not clearly the cause`;
            await globs.applyEvent(culprit.id, (g, ctx) =>
              machine.revertDeclined(g, { sha: head.sha, parent: head.parent, parentChecks, reason }, ctx),
            );
          }
        }
      }
      for (const other of await globs.peekAll(board.id, { status: ['pr_open', 'in_progress'] })) {
        // A red base marks the globs that fail the same way; a base that just turned green brings them up to date.
        await globs.applyEvent(other.id, (g, ctx) =>
          change.turnedGreen ? machine.baseTurnedGreen(g, ctx) : machine.baseChecksChanged(g, { checks, branch: repo.base }, ctx),
        );
      }
      return 'done';
    },

    update_branch: async (effect, glob, { globs }) => {
      if (effect.kind !== 'update_branch' || glob?.pr == null) return 'dropped';
      // Pushed to since, or no longer red because of the base: nothing to update.
      if (glob.pr.headSha !== effect.sha || glob.headChecks?.inheritedFrom === undefined) return 'dropped';
      const board = await boardOf(glob.boardId);
      const repo = board === null ? null : repoOf(board);
      if (board === null || repo === null) return 'dropped';
      const prNumber = glob.pr.number;
      const result = await host.updateBranch(repo, prNumber, effect.sha);
      if (result === 'updating') return 'done'; // The push resets the head checks and they run again.
      if (result === 'conflict') {
        const found = { base: repo.base, files: await host.conflictFiles(repo, prNumber), since: glob.headChecks.inheritedFrom.since };
        await globs.applyEvent(glob.id, (g, ctx) => machine.conflictFound(g, found, ctx));
        return 'done';
      }
      // Already up to date: the base moved on without a change this branch needs; drop the stale mark.
      const checks = board.baseChecks;
      if (checks != null) await globs.applyEvent(glob.id, (g, ctx) => machine.baseChecksChanged(g, { checks, branch: repo.base }, ctx));
      return 'done';
    },

    flag_conflicts: async (effect, glob, { globs }) => {
      if (effect.kind !== 'flag_conflicts' || glob === null) return 'dropped';
      // Each open PR rechecks through its own effect, which retries while GitHub computes mergeability.
      for (const other of await globs.peekAll(glob.boardId, { status: ['pr_open', 'in_progress'] })) {
        await globs.applyEvent(other.id, (g, ctx) => machine.baseMerged(g, { since: glob.id }, ctx));
      }
      return 'done';
    },

    release_waiting: async (effect, glob, { globs, decisions }) => {
      // Only a glob that really merged releases others (a Merge and continue never queues this).
      if (effect.kind !== 'release_waiting' || glob === null || (glob.status !== 'reviewing' && glob.status !== 'signed_off')) {
        return 'dropped';
      }
      // Each release is its own version-checked write that queues the provision and the run; a repeat changes nothing.
      await globs.releaseDependents(glob.id, glob.boardId);
      // Decisions that asked for this work (needs work, linked to it) are done: they go to Reviewing.
      await decisions?.linkedMerged(glob.id, glob.boardId);
      // A clash warning about this glob is over: it merged.
      for (const other of await globs.peekAll(glob.boardId, { status: ['in_progress', 'pr_open', 'implementing'] })) {
        if (other.clash?.with === glob.id) await globs.applyEvent(other.id, (g, ctx) => machine.clashChanged(g, null, ctx));
      }
      return 'done';
    },

    check_conflict: async (effect, glob, { globs }) => {
      if (effect.kind !== 'check_conflict' || glob?.pr == null) return 'dropped';
      if (glob.status !== 'pr_open' && glob.status !== 'in_progress') return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const prNumber = glob.pr.number;
      const { state } = await host.mergeState(repo, prNumber);
      if (state === 'unknown') throw new Error('GitHub has not computed the merge state yet');
      if (state !== 'conflict') {
        await globs.applyEvent(glob.id, (g, ctx) => machine.conflictCleared(g, ctx));
        return 'done';
      }
      const found = { base: repo.base, files: await host.conflictFiles(repo, prNumber), since: effect.since ?? glob.conflict?.since ?? null };
      await globs.applyEvent(glob.id, (g, ctx) => machine.conflictFound(g, found, ctx));
      return 'done';
    },

    check_behind: async (effect, glob, { globs }) => {
      if (effect.kind !== 'check_behind' || glob?.pr == null || glob.status !== 'in_progress') return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const found = await host.behindBase(repo, glob.pr.number);
      // The host couldn't tell: keep what the card shows.
      if (found === null) return 'done';
      await globs.applyEvent(glob.id, (g, ctx) => machine.behindChecked(g, { base: repo.base, ...found }, ctx));
      return 'done';
    },

    squash_merge: async (effect, glob, { globs }, attempt) => {
      if (effect.kind !== 'squash_merge' || glob?.pr == null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const prNumber = glob.pr.number;
      let result;
      try {
        result = await host.squashMerge(repo, glob, prNumber, effect.sha);
      } catch (error) {
        // The host couldn't say whether the branch has a merge queue: never merge on a guess. Retry, and hand the glob back at the end.
        if (!(error instanceof QueueDetectionError) || attempt?.final !== true) throw error;
        await globs.applyEvent(glob.id, (g, ctx) => machine.mergeFailed(g, `Not merged: ${error.message}`, ctx));
        return 'done';
      }
      switch (result.outcome) {
        case 'queued':
          // The host's merge queue merges it in order; its events (and the reconcile sweep) report back.
          await globs.applyEvent(glob.id, (g, ctx) =>
            machine.mergeQueued(g, { sha: effect.sha, position: result.position, state: result.state }, ctx),
          );
          break;
        case 'merged':
          // Slop's own merge response; the `closed` webhook that follows is a no-op (rows 15 and 31).
          await globs.applyEvent(glob.id, (g, ctx) => machine.merged(g, { sha: result.sha, number: prNumber }, ctx));
          break;
        case 'updating':
          // The update pushes a new head; its checks resume the merge. A behind head is never merged as it is.
          if ((glob.mergeUpdates ?? 0) >= 1) log('merge', `${glob.id} was behind ${repo.base} again; updated the branch again`);
          await globs.applyEvent(glob.id, (g, ctx) => machine.mergeBranchUpdated(g, ctx));
          break;
        case 'checks_not_green':
          // Slop's own gate (its App bypasses the ruleset): the head's checks aren't green, so it isn't merged. Pending ones
          // are retried; the outbox's last attempt, and a failed head, hand the glob back.
          if (result.state !== 'failed' && attempt?.final !== true) throw new Error('The PR head\'s checks are not green yet');
          await globs.applyEvent(glob.id, (g, ctx) =>
            machine.mergeFailed(g, `Not merged: the head's checks ${result.state === 'failed' ? 'failed' : 'have not passed'}`, ctx),
          );
          break;
        case 'conflict':
          {
            const conflict = { base: repo.base, files: await host.conflictFiles(repo, prNumber) };
            await globs.applyEvent(glob.id, (g, ctx) => machine.mergeFailed(g, machine.conflictReason(conflict), ctx, conflict));
          }
          break;
        case 'undecided':
          // Throwing makes the outbox retry with backoff (5 s, 10 s, 20 s…); once it runs out the glob fails.
          if (attempt?.final !== true) throw new Error('GitHub has not decided whether the PR can merge yet');
          await globs.applyEvent(glob.id, (g, ctx) =>
            machine.mergeFailed(g, "GitHub hasn't decided whether the PR can merge; try again", ctx),
          );
          break;
        case 'refused': {
          // "Head branch was modified": slop merged at a head GitHub no longer has (a missed push webhook). Take the real
          // head, as the reconcile job does, so its checks run and the merge is tried again, instead of failing the glob.
          if (HEAD_MODIFIED.test(result.reason)) {
            const pr = await host.prState(repo, prNumber);
            if (pr.state === 'open' && pr.headSha !== effect.sha) {
              log('merge', `${glob.id} head moved to ${pr.headSha} (missed webhook)`);
              await globs.applyEvent(glob.id, (g, ctx) => machine.commitPushed(g, { sha: pr.headSha, runId: null }, ctx));
              break;
            }
          }
          await globs.applyEvent(glob.id, (g, ctx) => machine.mergeFailed(g, result.reason, ctx));
          break;
        }
      }
      return 'done';
    },

    /**
     * A merge queue webhook or reconcile hint: read the PR and its queue entry from the host and apply the truth. Merged,
     * closed and moved heads go through the transitions the webhooks use; an entry records its place; an entry that is gone
     * with the PR still open means the queue removed it, which fails the glob with the queue's reason (or flags a conflict).
     */
    read_merge_queue: async (effect, glob, { globs }, attempt) => {
      if (effect.kind !== 'read_merge_queue' || glob?.pr == null || glob.status !== 'merging') return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const prNumber = glob.pr.number;
      const pr = await host.prState(repo, prNumber);
      if (pr.state === 'merged') {
        await globs.applyEvent(glob.id, (g, ctx) => machine.merged(g, { sha: pr.mergeSha ?? pr.headSha, number: prNumber }, ctx));
        return 'done';
      }
      if (pr.state === 'closed') {
        await globs.applyEvent(glob.id, (g, ctx) => machine.prClosed(g, ctx));
        return 'done';
      }
      if (pr.headSha !== glob.pr.headSha) {
        log('merge', `${glob.id} head moved to ${pr.headSha} while queued (missed webhook)`);
        await globs.applyEvent(glob.id, (g, ctx) => machine.commitPushed(g, { sha: pr.headSha, runId: null }, ctx));
        return 'done';
      }
      const entry = await host.mergeQueueEntry(repo, prNumber);
      if (entry !== null) {
        await globs.applyEvent(glob.id, (g, ctx) => machine.mergeQueued(g, { sha: pr.headSha, ...entry }, ctx));
        return 'done';
      }
      // Not recorded as queued: the enqueue is still in flight, so there is nothing to have been removed from.
      const queued = glob.mergeQueue;
      if (queued == null) return 'done';
      // Webhook reasons come in both cases (`merge_group` is lowercase, GraphQL and `pull_request` upper).
      const reason = effect.reason?.toUpperCase();
      // The host reports the merge itself a moment before the PR reads as merged, and the entry a moment after the enqueue.
      const merging = reason === 'SUCCEEDED' || reason === 'ALREADY_MERGED' || reason === 'MERGED';
      const fresh = reason === undefined && Date.parse(now()) - Date.parse(queued.since) < QUEUE_GRACE_MS;
      if ((merging || fresh) && attempt?.final !== true) throw new Error('The merge queue entry is gone but the PR has not merged yet');
      if (reason === 'MERGE_CONFLICT') {
        const conflict = { base: repo.base, files: await host.conflictFiles(repo, prNumber) };
        await globs.applyEvent(glob.id, (g, ctx) => machine.mergeQueueDequeued(g, { reason: machine.conflictReason(conflict), conflict }, ctx));
        return 'done';
      }
      // `failedSha` is only ever recorded on the glob whose PR the failing group names, so it is this PR's failure.
      const failed = reason === 'CI_FAILURE' || reason === 'CI_TIMEOUT' || queued.failedSha !== undefined;
      const checks = failed && queued.failedSha !== undefined ? await explainFailure(repo, queued.failedSha) : null;
      const text =
        reason !== undefined && QUEUE_REASON_TEXT[reason] !== undefined
          ? QUEUE_REASON_TEXT[reason]
          : failed
            ? QUEUE_REASON_TEXT['CI_FAILURE']
            : 'Left the merge queue without merging';
      await globs.applyEvent(glob.id, (g, ctx) =>
        machine.mergeQueueDequeued(g, { reason: text ?? 'Left the merge queue without merging', ...(checks !== null && { checks }) }, ctx),
      );
      return 'done';
    },

    /** Cancel merge on a queued PR: the glob is already back in pr_open, so only the host's queue entry is left to remove. */
    dequeue_merge: async (effect, glob, { globs }) => {
      // A later merge may have queued the PR again (Cancel merge, then the gate re-merges): a delayed dequeue must not remove it.
      if (effect.kind !== 'dequeue_merge' || glob?.pr == null || glob.status === 'merging') return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const prNumber = glob.pr.number;
      if ((await host.dequeue(repo, prNumber)) === 'not_queued') {
        // It wasn't in the queue any more: the queue may have merged it first.
        const pr = await host.prState(repo, prNumber);
        if (pr.state === 'merged') {
          await globs.applyEvent(glob.id, (g, ctx) => machine.merged(g, { sha: pr.mergeSha ?? pr.headSha, number: prNumber }, ctx));
        }
      }
      return 'done';
    },

    revert_merge: async (effect, glob, { globs }) => {
      if (effect.kind !== 'revert_merge' || glob === null || glob.failure?.kind !== 'reverted') return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      if ((await host.revertCommit(repo, effect.sha)) === 'moved') {
        await globs.applyEvent(glob.id, (g, ctx) =>
          machine.revertFailed(g, `${repo.base} has moved on, so slop could not revert ${effect.sha.slice(0, 7)}: revert it by hand`, ctx),
        );
      }
      return 'done';
    },

    mark_pr_ready: async (_effect, glob, { globs }) => {
      if (glob?.pr == null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const { wasDraft, sha } = await host.markReady(repo, glob.pr.number);
      // An already-ready PR (a re-triggered or conflict-resolving run) raises no ready event: record it here.
      if (!wasDraft) {
        const number = glob.pr.number;
        await globs.applyEvent(glob.id, (g, ctx) => machine.prReadyForReview(g, { number, headSha: sha }, ctx));
      }
      return 'done';
    },

    refresh_sub_gate: async (_effect, glob, { globs }) => {
      if (glob?.pr?.headSha == null || glob.type !== 'sub' || glob.status !== 'pr_open') return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      await lookUpSubGate(repo, glob, glob.pr.headSha, globs);
      return 'done';
    },

    evaluate_sub_gate: async (effect, glob, { globs }) => {
      if (effect.kind !== 'evaluate_sub_gate' || glob === null) return 'dropped';
      if (glob.status !== 'pr_open' || glob.type !== 'sub' || glob.pr?.headSha !== effect.sha) return 'dropped';
      const board = await boardOf(glob.boardId);
      const repo = board === null ? null : repoOf(board);
      if (board === null || repo === null) return 'dropped';
      // The board was read just now, so the verdict uses the learned limit as it is at this decision.
      const ignored = sizeIgnoredPathsOf({ sizeIgnoredPaths: await sizeIgnoredPaths(board.id) });
      const verdict = subGatePolicy(await host.diffSummary(repo, effect.sha), board, ignored);
      const limit = board.subMaxChangedLines;
      await globs.applyEvent(glob.id, (g, ctx, facts) => machine.subGateCompleted(g, { sha: effect.sha, ...verdict, limit }, ctx, facts.relations), { relations: true });
      return 'done';
    },

    fire_routine: async (effect, glob, { globs }) => {
      if (effect.kind !== 'fire_routine' || glob === null) return 'dropped';
      const run = machine.currentRun(glob);
      if (run?.id !== effect.runId || run.state !== 'queued') return 'dropped';
      // Don't spend a session to find out in Phase 1 that prerequisites haven't merged (unless a person said to go ahead).
      if (effect.checkPrerequisites === true) {
        const awaited = await globs.startHolds(glob.id);
        if (awaited.length > 0) {
          await globs.applyEvent(
            glob.id,
            (g, ctx, facts) => machine.reportFailure(g, { reason: `Not fired: ${refusalText(awaited)}`, runId: effect.runId }, ctx, facts.relations),
            { relations: true },
          );
          return 'done';
        }
      }
      // A run waits for the files its glob was created with (until their links expire), so its first context has them.
      const filesWait = pendingFiles === null ? 0 : await pendingFiles(glob.id);
      if (filesWait > 0) return { state: 'pending', retryAfterMs: Math.min(filesWait, FILES_POLL_MS), reason: 'Waiting for uploaded files' };
      // A routine works on the glob's branch, so it is only fired once that exists. An investigate-only run works on the
      // base branch of a glob in Planning, which has no branch yet.
      // Provisioning in flight is a wait, not a failure: look again shortly without spending an attempt. Any other state
      // (failed, never queued) keeps throwing, so the job's attempts run out instead of it polling for ever.
      if (effect.purpose !== 'investigate' && glob.provisioning !== 'ok') {
        if (glob.provisioning === 'pending') return { state: 'pending', retryAfterMs: PROVISION_POLL_MS, reason: 'Waiting for the branch' };
        throw new Error(`${glob.id} is not provisioned yet`);
      }
      const secret = await routines.secretFor(effect.routineOwner, glob.boardId);
      if (secret === null) {
        await globs.applyEvent(
          glob.id,
          (g, ctx, facts) => machine.reportFailure(g, { reason: `${effect.routineOwner} has no routine set up`, runId: effect.runId }, ctx, facts.relations),
          { relations: true },
        );
        return 'done';
      }
      const repo = await repoFor(glob.boardId);
      const repoName = repo === null ? null : `${repo.owner}/${repo.name}`;
      const board = await boardOf(glob.boardId);
      const text =
        effect.purpose === 'investigate'
          ? investigateInstructions(glob, effect.runId, repoName, board?.baseBranch ?? null)
          : effect.purpose === 'resolve_conflict'
            ? conflictInstructions(glob, effect.runId, repoName, board?.baseBranch ?? null, glob.conflict ?? null)
            : runInstructions(glob, effect.runId, repoName, glob.status === 'pr_open', effect.failureSummary ?? null);
      const result = await fireRoutine(secret, text, health);
      if (result.outcome === 'retry') throw new Error(result.reason);
      if (result.outcome === 'failed') {
        await globs.applyEvent(glob.id, (g, ctx, facts) => machine.reportFailure(g, { reason: result.reason, runId: effect.runId }, ctx, facts.relations), { relations: true });
        return 'done';
      }
      await globs.applyEvent(glob.id, (g, ctx) =>
        machine.runFired(g, { runId: effect.runId, sessionId: result.sessionId, sessionUrl: result.sessionUrl }, ctx),
      );
      return 'done';
    },

    delete_glob_data: async (effect) => {
      if (effect.kind !== 'delete_glob_data') return 'dropped';
      const repo = await repoFor(effect.boardId);
      if (repo !== null && host.configured) {
        if (effect.prNumber !== null) await host.closePr(repo, effect.prNumber);
        await host.deleteBranch(repo, effect.globId);
      }
      // The glob's file objects have their own `delete_object` effects, queued by the delete.
      return 'done';
    },
    delete_object: async (effect) => {
      if (effect.kind !== 'delete_object' || objects === null) return 'dropped';
      await objects.delete(effect.key);
      return 'done';
    },
  };
};
