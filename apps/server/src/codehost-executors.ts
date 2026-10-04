import type { Board, EffectKind } from '@slop/core';
import { machine } from '@slop/core';
import type { Executor } from './jobs/outbox.js';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';

/**
 * Outbox executors for the code host (the GitHub App today). Each turns one effect into GitHub calls and feeds what
 * happened back through the state machine. Throwing makes the outbox retry with backoff.
 */
export const codeHostExecutors = (
  host: CodeHost,
  boardOf: (id: number) => Promise<Board | null>,
): Partial<Record<EffectKind, Executor>> => {
  const repoFor = async (boardId: number) => {
    const board = await boardOf(boardId);
    return board === null ? null : repoOf(board);
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

    refresh_checks: async (_effect, glob, { globs }) => {
      if (glob?.pr == null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const { sha, state } = await host.mergeState(repo, glob.pr.number);
      // GitHub computes mergeability in the background; retry until it has an answer.
      if (state === 'unknown') throw new Error('GitHub has not computed the merge state yet');
      if (state === 'pending') return 'done';
      const passed = state === 'passed' || state === 'behind';
      await globs.applyEvent(glob.id, (g, ctx) => machine.checksCompleted(g, { sha, passed }, ctx));
      return 'done';
    },

    squash_merge: async (effect, glob, { globs }) => {
      if (effect.kind !== 'squash_merge' || glob?.pr == null) return 'dropped';
      const repo = await repoFor(glob.boardId);
      if (repo === null) return 'dropped';
      const result = await host.squashMerge(repo, glob, glob.pr.number, effect.sha);
      switch (result.outcome) {
        case 'merged':
          // Slop's own merge response; the `closed` webhook that follows is a no-op (row 15).
          await globs.applyEvent(glob.id, (g, ctx) => machine.merged(g, { sha: result.sha }, ctx));
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
