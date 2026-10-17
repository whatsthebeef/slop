import { isAgentSetGlobOpen, machine, mergeHookSettings, parseAgentSetManifest, AGENT_SET_MANIFEST_PATH, SETTINGS_REPO_PATH } from '@slop/core';
import type { AgentSetCommitService, Board, EffectKind, Glob } from '@slop/core';
import { repoOf } from './codehost.js';
import type { CodeHost } from './codehost.js';
import type { Executor } from './jobs/outbox.js';

/** The agent-set version the board's base branch holds (`.claude/slop-agent-set.json`); null without a repo, a file or a valid one. */
export const readCommittedAgentSetVersion = async (host: Pick<CodeHost, 'readFile'>, board: Board): Promise<number | null> => {
  const repo = repoOf(board);
  if (repo === null) return null;
  return parseAgentSetManifest((await host.readFile(repo, repo.base, AGENT_SET_MANIFEST_PATH)) ?? '')?.version ?? null;
};

/** How long a commit waits for the glob's branch (or for a merged glob to give way to a new one) before it looks again. */
const WAIT_MS = 30_000;

/**
 * The agent set's outbox job (`commit_agent_set`, default lane): once the debounce has passed, makes sure the board's one
 * open "Agent set vN" glob exists and commits the set's files to its branch as the App. Idempotent: a branch whose
 * manifest already says version N is left alone.
 */
export const agentSetExecutors = (
  commit: Pick<AgentSetCommitService, 'prepare'>,
  host: Pick<CodeHost, 'readFile' | 'commitToBranch'>,
  globOf: (id: string) => Promise<Glob | null>,
  /** Asks slop to mark the glob's draft PR ready, so its checks run; resolves whether or not the glob could be marked. */
  requestReady: (id: string) => Promise<unknown> = () => Promise.resolve(),
): Partial<Record<EffectKind, Executor>> => ({
  commit_agent_set: async (effect, _glob, { globs }) => {
    if (effect.kind !== 'commit_agent_set') return 'dropped';
    const prepared = await commit.prepare(effect.boardId);
    if (prepared.kind === 'dropped') return 'dropped';
    if (prepared.kind === 'waiting') return { state: 'pending', retryAfterMs: WAIT_MS, reason: prepared.reason };
    const repo = repoOf(prepared.board);
    if (repo === null) return 'dropped';
    const branch = prepared.glob.id;
    const previous = parseAgentSetManifest((await host.readFile(repo, branch, AGENT_SET_MANIFEST_PATH)) ?? '');
    if (previous?.version === prepared.version) {
      // A retry after a commit whose ready request was lost.
      if (prepared.glob.pr?.state === 'draft') await requestReady(branch);
      return 'done';
    }
    // Merged or closed since `prepare` looked: a retry finds no open glob and opens the next one.
    const current = await globOf(branch);
    if (current === null || !isAgentSetGlobOpen(current)) return { state: 'pending', retryAfterMs: WAIT_MS, reason: `${branch} is no longer open` };
    // settings.json is the repo's own file: the catalog's hooks are merged into what the branch holds, not written over it.
    const settings = await host.readFile(repo, branch, SETTINGS_REPO_PATH);
    const files = prepared.files.map((f) => (f.path === SETTINGS_REPO_PATH ? { ...f, content: mergeHookSettings(settings, f.content) } : f));
    const paths = new Set(files.map((f) => f.path));
    const deletions = (previous?.files ?? []).filter((path) => !paths.has(path));
    const message = messageOf(prepared.board, prepared.version, previous?.version ?? null, files.length - 1);
    const { sha } = await host.commitToBranch(repo, branch, files, deletions, message);
    // Record the commit as the PR head now, as its push webhook would, so Merge, the checks and the review use it and not the
    // start commit even when that webhook is late or lost. The webhook for the same sha is then a no-op.
    if (current.pr !== null && current.pr.headSha !== sha) {
      await globs.applyEvent(branch, (g, ctx) => machine.commitPushed(g, { sha, runId: null, message }, ctx));
    }
    // Slop's commit is the whole change: open the PR for review so the checks run and the card offers Merge.
    if (current.pr?.state === 'draft') await requestReady(branch);
    return 'done';
  },
});

const messageOf = (board: Board, version: number, previous: number | null, files: number): string =>
  `Agent set v${String(version)}\n\n${previous === null ? `Adds board ${String(board.id)}'s agent set` : `Brings the agent set from v${String(previous)}`} to v${String(version)} (${String(files)} files).\n\nSlop-Agent-Set: ${String(version)}\n`;
