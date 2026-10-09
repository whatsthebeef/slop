import type { Board, BoardService, CheckFailure, HealthSink, EffectKind, Glob, GlobService, NotificationService } from '@slop/core';
import { fireRoutine, runInstructions } from './routines.js';
import type { FileRoutines } from './routines.js';
import { isRepoAccessFailure, machine, parseId, provisioningFailureReason, repoAccessNotification, REPO_ACCESS_SOURCE, subGatePolicy } from '@slop/core';
import type { Executor } from './jobs/outbox.js';
import type { CodeHost } from './codehost.js';
import type { Repo } from './codehost.js';
import { SUB_GATE_CHECK, repoOf } from './codehost.js';
import { conflictCommentBody, conflictCommentMarker } from './conflict-comment.js';

/** How long a cancelled check run may wait for a newer run on the same head before it is re-requested. */
const CANCELLED_CHECK_WAIT_MS = 5 * 60_000;

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
  routines: FileRoutines,
  boards: Pick<BoardService, 'recordBaseChecks'>,
  now: () => string = () => new Date().toISOString(),
  health: HealthSink | null = null,
  notifications: Pick<NotificationService, 'syncMainRed' | 'raise' | 'clear'> | null = null,
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
    const check = await host.completedCheckRun(repo, sha, SUB_GATE_CHECK);
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
        const result = await host.provision(repo, glob);
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
        const result = await host.provision(repo, glob);
        await globs.applyEvent(glob.id, (g, ctx) => machine.provisioned(g, result, ctx));
      }
      return 'done';
    },

    open_pr: async (_effect, glob, { globs }) => {
      // After Merge and continue: only while the glob is still in progress without a PR.
      if (glob === null || glob.pr !== null || glob.status !== 'in_progress') return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null || !host.configured) return 'dropped';
      const pr = await host.openDraftPr(repo, glob);
      // Nothing to merge yet: the next push tries again.
      if (pr === null) return 'done';
      // The `opened` webhook may have recorded it first; recording it again is a no-op.
      await globs.applyEvent(glob.id, (g, ctx) => machine.prOpened(g, pr, ctx));
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
      const passed = state === 'passed' || state === 'behind';
      // A conflict after slop updated the branch is its own failure, not a failing check.
      const conflict = state === 'conflict' ? { base: repo.base, files: await host.conflictFiles(repo, glob.pr.number) } : undefined;
      // Say what failed, and whether the base branch fails the same way (then it isn't this glob's change).
      const failure = state === 'failed' ? await explainFailure(repo, sha) : null;
      await globs.applyEvent(glob.id, (g, ctx) =>
        machine.checksCompleted(
          g,
          {
            sha,
            passed,
            ...(conflict !== undefined && { conflict }),
            ...(failure !== null && { failure, base: board?.baseChecks ?? null, baseBranch: repo.base }),
          },
          ctx,
        ),
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
      const result = await host.commitChecks(repo, head.sha);
      // The calls above reached the repo, so the App can see it again.
      await notifications?.clear(board.id, REPO_ACCESS_SOURCE);
      // Still running: the check's completion sends another event.
      if (result.state === 'pending') return 'done';
      const passed = result.state === 'passed';
      const recorded = await boards.recordBaseChecks(
        board.id,
        { sha: head.sha, passed, failure: result.failure, merged: passed ? null : globOfSubject(head.subject) },
        now(),
      );
      if (recorded === null) return 'done';
      // Whether or not the result changed: a retry after a crash between recording and raising still raises it.
      await notifications?.syncMainRed(board.id, repo.base, recorded.checks);
      if (!recorded.change.changed) return 'done';
      const { checks, change } = recorded;
      // A sub whose merge commit turned the base red is reverted and failed; sames are left to a person.
      const headGlob = globOfSubject(head.subject);
      const culprit = passed || headGlob === null || checks.since !== headGlob ? null : await globs.peek(headGlob);
      if (culprit?.type === 'sub') {
        await globs.applyEvent(culprit.id, (g, ctx) =>
          machine.mergeTurnedBaseRed(g, { sha: head.sha, failure: result.failure, base: repo.base }, ctx),
        );
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

    release_waiting: async (effect, glob, { globs }) => {
      // Only a glob that really merged releases others (a Merge and continue never queues this).
      if (effect.kind !== 'release_waiting' || glob === null || (glob.status !== 'reviewing' && glob.status !== 'signed_off')) {
        return 'dropped';
      }
      // Each release is its own version-checked write that queues the provision and the run; a repeat changes nothing.
      await globs.releaseDependents(glob.id, glob.boardId);
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

    request_conflict_fix: async (_effect, glob, { globs }) => {
      const conflict = glob?.conflict;
      if (glob?.pr == null || conflict?.requestedAt === undefined) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const merged = conflict.since === null ? null : await globs.peek(conflict.since);
      const marker = conflictCommentMarker(glob, conflict.requestedAt);
      await host.commentOnce(repo, glob.pr.number, marker, conflictCommentBody(glob, merged, conflict, marker));
      return 'done';
    },

    squash_merge: async (effect, glob, { globs }) => {
      if (effect.kind !== 'squash_merge' || glob?.pr == null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const prNumber = glob.pr.number;
      const result = await host.squashMerge(repo, glob, prNumber, effect.sha);
      switch (result.outcome) {
        case 'merged':
          // Slop's own merge response; the `closed` webhook that follows is a no-op (rows 15 and 31).
          await globs.applyEvent(glob.id, (g, ctx) => machine.merged(g, { sha: result.sha, number: prNumber }, ctx));
          break;
        case 'updating':
          // The update pushes a new head; its checks resume the merge.
          break;
        case 'conflict':
          {
            const conflict = { base: repo.base, files: await host.conflictFiles(repo, prNumber) };
            await globs.applyEvent(glob.id, (g, ctx) => machine.mergeFailed(g, machine.conflictReason(conflict), ctx, conflict));
          }
          break;
        case 'refused':
          await globs.applyEvent(glob.id, (g, ctx) => machine.mergeFailed(g, result.reason, ctx));
          break;
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
      const verdict = subGatePolicy(await host.diffSummary(repo, effect.sha), board);
      const limit = board.subMaxChangedLines;
      await globs.applyEvent(glob.id, (g, ctx) => machine.subGateCompleted(g, { sha: effect.sha, ...verdict, limit }, ctx));
      return 'done';
    },

    fire_routine: async (effect, glob, { globs }) => {
      if (effect.kind !== 'fire_routine' || glob === null) return 'dropped';
      const run = machine.currentRun(glob);
      if (run?.id !== effect.runId || run.state !== 'queued') return 'dropped';
      // A routine works on the glob's branch, so it is only fired once that exists.
      if (glob.provisioning !== 'ok') throw new Error(`${glob.id} is not provisioned yet`);
      const secret = await routines.secretFor(effect.routineOwner, glob.boardId);
      if (secret === null) {
        await globs.applyEvent(glob.id, (g, ctx) =>
          machine.reportFailure(g, { reason: `${effect.routineOwner} has no routine set up`, runId: effect.runId }, ctx),
        );
        return 'done';
      }
      const repo = await repoFor(glob.boardId);
      const result = await fireRoutine(secret, runInstructions(glob, effect.runId, repo === null ? null : `${repo.owner}/${repo.name}`, glob.status === 'pr_open'), health);
      if (result.outcome === 'retry') throw new Error(result.reason);
      if (result.outcome === 'failed') {
        await globs.applyEvent(glob.id, (g, ctx) => machine.reportFailure(g, { reason: result.reason, runId: effect.runId }, ctx));
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
      // S3 artifacts join this clean-up when artifacts arrive.
      return 'done';
    },
  };
};
