import type { BoardService, Glob, GlobService, Result } from '@slop/core';
import { AGENT_SET_MANIFEST_PATH, agentSetVersionOfTitle, err, isAgentSetGlob, ok, parseAgentSetManifest } from '@slop/core';
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
 * can't say after a few tries is trusted: the post-ready conflict check catches it. Slop's own "Agent set vN" glob is
 * ready only once its branch holds the manifest for version N: slop's commit is the whole change, so before it lands
 * there is nothing to review (the commit job marks it ready itself, after committing).
 */
export const readyGate =
  (
    host: Pick<CodeHost, 'configured' | 'conflictState' | 'conflictFiles' | 'behindBase' | 'readFile'>,
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
    if (isAgentSetGlob(glob)) {
      const version = agentSetVersionOfTitle(glob.title);
      // Fails closed: a branch that can't be read can't be shown to hold the commit.
      const committed = await host
        .readFile(repo, glob.id, AGENT_SET_MANIFEST_PATH)
        .then((text) => parseAgentSetManifest(text ?? '')?.version ?? null, () => null);
      if (committed !== version) {
        return err({
          code: 'invalid_transition',
          message: `slop hasn't committed agent set v${String(version)} yet`,
          status: glob.status,
          allowedActions: [],
        });
      }
    }
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

export type MergeGate = (email: string, id: string) => Promise<Result<null>>;

/**
 * The check before a merge is requested: an agent-set PR whose branch doesn't hold its manifest (slop's commit never
 * landed) is refused, since merging it would land nothing. When the branch does hold it but the recorded head is still
 * the start commit (the push webhook was late), the head is refreshed instead of refusing. Anything else is left to the machine.
 */
export const mergeGate =
  (
    host: Pick<CodeHost, 'configured' | 'diffSummary' | 'readFile'>,
    globs: Pick<GlobService, 'peek'>,
    boards: Pick<BoardService, 'get'>,
    /** Brings the glob's recorded head up to the host's (as the reconcile job would). */
    refreshHead: (glob: Glob) => Promise<void> = () => Promise.resolve(),
  ): MergeGate =>
  async (email, id) => {
    const glob = await globs.peek(id);
    if (glob?.pr?.headSha == null || !host.configured || !isAgentSetGlob(glob)) return ok(null);
    const member = await boards.get(email, glob.boardId);
    if (!member.ok) return member;
    const repo = repoOf(member.value.board);
    if (repo === null) return ok(null);
    const empty = await host.diffSummary(repo, glob.pr.headSha).then(
      (diff) => diff.files.length === 0,
      () => false,
    );
    if (!empty) return ok(null);
    // Fails closed, as in `readyGate`: a branch that can't be read can't be shown to hold the commit.
    const committed = await host
      .readFile(repo, glob.id, AGENT_SET_MANIFEST_PATH)
      .then((text) => parseAgentSetManifest(text ?? '')?.version ?? null, () => null);
    if (committed !== null && committed === agentSetVersionOfTitle(glob.title)) {
      await refreshHead(glob).catch(() => undefined);
      return ok(null);
    }
    return err({
      code: 'invalid_transition',
      message: `slop hasn't committed agent set v${String(agentSetVersionOfTitle(glob.title))} yet`,
      status: glob.status,
      allowedActions: [],
    });
  };
