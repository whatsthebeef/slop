import type { Board, BoardService, GlobService, NotificationService, ReadinessFacts, ReadinessItem, Store } from '@slop/core';
import { readiness, recentRoutineFailures, runsClaudeAction, unreactedCheckFailures } from '@slop/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { CodeHost } from '../codehost.js';
import { repoOf } from '../codehost.js';
import type { Repo } from '../codehost.js';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface ReadinessRoutesDeps {
  readonly boards: BoardService;
  readonly globs: GlobService;
  readonly store: Store;
  readonly host: CodeHost;
  readonly notifications: Pick<NotificationService, 'syncReadiness'>;
  readonly log: (task: string, message: string) => void;
}

/** What `readinessOf` needs: the code host, the board's globs and knowledge read without a signed-in person. */
export type ReadinessSources = Pick<ReadinessRoutesDeps, 'globs' | 'store' | 'host' | 'log'>;

/** How far back a routine failure still marks its readiness item as failing. */
const FAILURE_WINDOW_DAYS = 7;

const agentSetFile = z.object({ version: z.number().int() });

/** The version in `.claude/slop-agent-set.json`, or 'unreadable' when the file isn't valid. */
const parseAgentSetVersion = (text: string): number | 'unreadable' => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  const parsed = agentSetFile.safeParse(json);
  return parsed.success ? parsed.data.version : 'unreadable';
};

/** Whether any workflow file on `ref` runs the Claude Code action. */
const hasClaudeWorkflow = async (host: CodeHost, repo: Repo, ref: string): Promise<boolean> => {
  const dir = '.github/workflows';
  const names = (await host.listFiles(repo, ref, dir)).filter((n) => /\.ya?ml$/i.test(n));
  const texts = await Promise.all(names.map((n) => host.readFile(repo, ref, `${dir}/${n}`)));
  return texts.some((t) => t !== null && runsClaudeAction(t));
};

/**
 * The board's readiness checklist: what slop can check (the repo, its workflow and agent set, the
 * knowledge base, environments) plus the admin's ticks, turned red by matching routine failures.
 */
export const readinessOf = async (deps: ReadinessSources, board: Board): Promise<ReadinessItem[]> => {
  const repo = repoOf(board);

  let repoConnected: boolean | null = null;
  let installUrl: string | null = null;
  let subGateWorkflow: boolean | null = null;
  let claudeWorkflow: boolean | null = null;
  let committedAgentSetVersion: number | 'unreadable' | null = null;
  let agentSetRead = false;
  if (repo !== null && deps.host.configured) {
    try {
      const connection = await deps.host.connection(repo);
      repoConnected = connection.connected;
      installUrl = connection.installUrl === null ? null : `${connection.installUrl}?state=${String(board.id)}`;
      if (connection.connected) {
        const [workflow, agentSet, claude] = await Promise.all([
          deps.host.readFile(repo, board.baseBranch, '.github/workflows/sub-gate.yml'),
          deps.host.readFile(repo, board.baseBranch, '.claude/slop-agent-set.json'),
          hasClaudeWorkflow(deps.host, repo, board.baseBranch),
        ]);
        claudeWorkflow = claude;
        subGateWorkflow = workflow !== null;
        agentSetRead = true;
        committedAgentSetVersion = agentSet === null ? null : parseAgentSetVersion(agentSet);
      }
    } catch (error) {
      // An unreachable host leaves its items unknown rather than failing the checklist.
      deps.log('readiness', `${String(board.id)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const [docs, globs] = await Promise.all([
    deps.store.transaction((tx) => tx.listKnowledge(board.id, ['doc'])),
    deps.globs.peekAll(board.id, {}),
  ]);
  const since = new Date(Date.now() - FAILURE_WINDOW_DAYS * 86_400_000).toISOString();
  const facts: ReadinessFacts = {
    board,
    repoConnected,
    installUrl,
    subGateWorkflow,
    claudeWorkflow,
    committedAgentSetVersion: agentSetRead ? committedAgentSetVersion : 'unknown',
    hasBuildDoc: docs.some((d) => d.area === 'build'),
    ticks: board.readinessTicks,
    recentFailures: recentRoutineFailures(globs, since),
    unreactedCheckFailures: unreactedCheckFailures(globs, new Date().toISOString()),
  };
  return readiness(facts);
};

/** Checks the board's readiness and makes its notifications match; a failure is logged, never thrown. */
export const syncReadiness = async (deps: ReadinessSources & Pick<ReadinessRoutesDeps, 'notifications'>, board: Board): Promise<ReadinessItem[]> => {
  const items = await readinessOf(deps, board);
  await deps.notifications.syncReadiness(board.id, items);
  return items;
};

/** `GET /api/boards/:b/readiness`: the checklist for the settings page; reading it also refreshes the board's notifications. */
export const mountReadiness = (app: Hono<Env>, deps: ReadinessRoutesDeps): void => {
  app.get('/api/boards/:b/readiness', async (c) => {
    const email = c.get('email');
    const boardId = Number(c.req.param('b'));
    const membership = await deps.boards.get(email, boardId);
    if (!membership.ok) return c.json(errorBody(membership.error), statusOf(membership.error));
    return c.json({ items: await syncReadiness(deps, membership.value.board) });
  });
};
