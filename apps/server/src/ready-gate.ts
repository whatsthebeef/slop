import type { BoardService, GlobService, Result } from '@slop/core';
import { err, ok } from '@slop/core';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';

/** How often and how long `mark_ready` waits for the host to work out whether the branch merges. */
const UNKNOWN_ATTEMPTS = 3;
const UNKNOWN_WAIT_MS = 1_000;

/** What `mark_ready` tells the caller beyond the glob: a branch behind its base that still merges cleanly. */
export interface ReadyCheck {
  readonly warning?: string;
}

const list = (files: readonly string[]) => {
  if (files.length === 0) return 'files changed on both sides';
  const shown = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${shown} and ${String(files.length - 3)} more files` : shown;
};

export type ReadyGate = (email: string, id: string) => Promise<Result<ReadyCheck>>;

/**
 * The check before a PR is marked ready: a branch that conflicts with its base is refused (a conflicted PR runs no
 * checks, so nothing would ever tell the run), a branch only behind its base is allowed with a warning, and a host that
 * can't say after a few tries is trusted: the post-ready conflict check catches it.
 */
export const readyGate =
  (
    host: Pick<CodeHost, 'configured' | 'conflictState' | 'conflictFiles' | 'behindBase'>,
    globs: Pick<GlobService, 'peek'>,
    boards: Pick<BoardService, 'get'>,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ): ReadyGate =>
  async (email, id) => {
    const glob = await globs.peek(id);
    // Anything the machine would refuse anyway (no PR, wrong status) is left to it.
    if (glob?.pr == null || !host.configured) return ok({});
    // Only a member of the glob's board learns anything about its branch.
    const member = await boards.get(email, glob.boardId);
    if (!member.ok) return member;
    const repo = repoOf(member.value.board);
    if (repo === null) return ok({});
    const prNumber = glob.pr.number;
    try {
      let state = await host.conflictState(repo, prNumber);
      for (let attempt = 1; state === 'unknown' && attempt < UNKNOWN_ATTEMPTS; attempt++) {
        await wait(UNKNOWN_WAIT_MS);
        state = await host.conflictState(repo, prNumber);
      }
      if (state === 'conflict') {
        const files = await host.conflictFiles(repo, prNumber);
        return err({
          code: 'invalid_transition',
          message: `This branch conflicts with ${repo.base} in ${list(files)}. Merge origin/${repo.base}, resolve, run the checks, push, then call mark_ready again. The PR is still a draft.`,
          status: glob.status,
          allowedActions: [],
        });
      }
      if (state === 'clean') {
        const behind = await host.behindBase(repo, prNumber);
        if (behind !== null && behind.behindBy > 0) {
          const n = behind.behindBy;
          return ok({
            warning: `This branch is ${String(n)} commit${n === 1 ? '' : 's'} behind ${repo.base} but merges cleanly. Merge origin/${repo.base}, run the checks and push before you stop, so the PR is checked against what it will merge into.`,
          });
        }
      }
    } catch {
      // The host being down is not the branch's fault: the post-ready check follows up.
    }
    return ok({});
  };
