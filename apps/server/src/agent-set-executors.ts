import { isAgentSetGlobOpen, parseAgentSetManifest, AGENT_SET_MANIFEST_PATH } from '@slop/core';
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
): Partial<Record<EffectKind, Executor>> => ({
  commit_agent_set: async (effect) => {
    if (effect.kind !== 'commit_agent_set') return 'dropped';
    const prepared = await commit.prepare(effect.boardId);
    if (prepared.kind === 'dropped') return 'dropped';
    if (prepared.kind === 'waiting') return { state: 'pending', retryAfterMs: WAIT_MS, reason: prepared.reason };
    const repo = repoOf(prepared.board);
    if (repo === null) return 'dropped';
    const branch = prepared.glob.id;
    const previous = parseAgentSetManifest((await host.readFile(repo, branch, AGENT_SET_MANIFEST_PATH)) ?? '');
    if (previous?.version === prepared.version) return 'done';
    // Merged or closed since `prepare` looked: a retry finds no open glob and opens the next one.
    const current = await globOf(branch);
    if (current === null || !isAgentSetGlobOpen(current)) return { state: 'pending', retryAfterMs: WAIT_MS, reason: `${branch} is no longer open` };
    const paths = new Set(prepared.files.map((f) => f.path));
    const deletions = (previous?.files ?? []).filter((path) => !paths.has(path));
    await host.commitToBranch(repo, branch, prepared.files, deletions, messageOf(prepared.board, prepared.version, previous?.version ?? null, prepared.files.length - 1));
    return 'done';
  },
});

const messageOf = (board: Board, version: number, previous: number | null, files: number): string =>
  `Agent set v${String(version)}\n\n${previous === null ? `Adds board ${String(board.id)}'s agent set` : `Brings the agent set from v${String(previous)}`} to v${String(version)} (${String(files)} files).\n\nSlop-Agent-Set: ${String(version)}\n`;
