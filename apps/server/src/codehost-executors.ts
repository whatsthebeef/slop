import type { Board, EffectKind, Glob, GlobService } from '@slop/core';
import { fireRoutine, runInstructions } from './routines.js';
import type { FileRoutines } from './routines.js';
import { machine, subGatePolicy } from '@slop/core';
import type { Executor } from './jobs/outbox.js';
import type { CodeHost } from './codehost.js';
import type { Repo } from './codehost.js';
import { SUB_GATE_CHECK, repoOf } from './codehost.js';

/**
 * Outbox executors for the code host (the GitHub App today). Each turns one effect into GitHub calls and feeds what
 * happened back through the state machine. Throwing makes the outbox retry with backoff.
 */
export const codeHostExecutors = (
  host: CodeHost,
  boardOf: (id: number) => Promise<Board | null>,
  routines: FileRoutines,
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

  return {
    provision: async (_effect, glob, { globs }) => {
      if (glob === null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null || !host.configured) {
        // Boards without a repo (or before the app exists) only reserve the branch name.
        await globs.applyEvent(glob.id, (g, ctx) => machine.provisioned(g, { branch: g.id, pr: null }, ctx));
        return 'done';
      }
      try {
        const result = await host.provision(repo, glob);
        await globs.applyEvent(glob.id, (g, ctx) => machine.provisioned(g, result, ctx));
        return 'done';
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await globs.applyEvent(glob.id, (g, ctx) => machine.provisioningFailed(g, reason, ctx));
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
      // GitHub computes mergeability in the background; retry until it has an answer.
      if (state === 'unknown') throw new Error('GitHub has not computed the merge state yet');
      await lookUpSubGate(repo, glob, sha, globs);
      if (state === 'pending') return 'done';
      const passed = state === 'passed' || state === 'behind';
      await globs.applyEvent(glob.id, (g, ctx) => machine.checksCompleted(g, { sha, passed }, ctx));
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
          await globs.applyEvent(glob.id, (g, ctx) => machine.mergeFailed(g, 'Merge conflict with the base branch', ctx));
          break;
        case 'refused':
          await globs.applyEvent(glob.id, (g, ctx) => machine.mergeFailed(g, result.reason, ctx));
          break;
      }
      return 'done';
    },

    mark_pr_ready: async (_effect, glob) => {
      if (glob?.pr == null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      await host.markReady(repo, glob.pr.number);
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
      const verdict = subGatePolicy(await host.diffSummary(repo, effect.sha), board);
      await globs.applyEvent(glob.id, (g, ctx) => machine.subGateCompleted(g, { sha: effect.sha, ...verdict }, ctx));
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
      const result = await fireRoutine(secret, runInstructions(glob, effect.runId, repo === null ? null : `${repo.owner}/${repo.name}`));
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
