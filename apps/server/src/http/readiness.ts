import type { BoardService, GlobService, KnowledgeService, ReadinessFacts } from '@slop/core';
import { readiness, recentRoutineFailures, silentRunGlobs } from '@slop/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { CodeHost } from '../codehost.js';
import { repoOf } from '../codehost.js';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface ReadinessRoutesDeps {
  readonly boards: BoardService;
  readonly globs: GlobService;
  readonly knowledge: KnowledgeService;
  readonly host: CodeHost;
  readonly log: (task: string, message: string) => void;
}

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

/**
 * The board's readiness checklist: what slop can check (the repo, its workflow and agent set, the
 * knowledge base, environments) plus the admin's ticks, turned red by matching routine failures.
 */
export const mountReadiness = (app: Hono<Env>, deps: ReadinessRoutesDeps): void => {
  app.get('/api/boards/:b/readiness', async (c) => {
    const email = c.get('email');
    const boardId = Number(c.req.param('b'));
    const membership = await deps.boards.get(email, boardId);
    if (!membership.ok) return c.json(errorBody(membership.error), statusOf(membership.error));
    const board = membership.value.board;
    const repo = repoOf(board);

    let repoConnected: boolean | null = null;
    let installUrl: string | null = null;
    let subGateWorkflow: boolean | null = null;
    let committedAgentSetVersion: number | 'unreadable' | null = null;
    let agentSetRead = false;
    if (repo !== null && deps.host.configured) {
      try {
        const connection = await deps.host.connection(repo);
        repoConnected = connection.connected;
        installUrl = connection.installUrl === null ? null : `${connection.installUrl}?state=${String(board.id)}`;
        if (connection.connected) {
          const [workflow, agentSet] = await Promise.all([
            deps.host.readFile(repo, board.baseBranch, '.github/workflows/sub-gate.yml'),
            deps.host.readFile(repo, board.baseBranch, '.claude/slop-agent-set.json'),
          ]);
          subGateWorkflow = workflow !== null;
          agentSetRead = true;
          committedAgentSetVersion = agentSet === null ? null : parseAgentSetVersion(agentSet);
        }
      } catch (error) {
        // An unreachable host leaves its items unknown rather than failing the checklist.
        deps.log('readiness', `${String(board.id)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const [index, globs] = await Promise.all([
      deps.knowledge.index(email, boardId),
      deps.globs.list(email, boardId, {}),
    ]);
    const since = new Date(Date.now() - FAILURE_WINDOW_DAYS * 86_400_000).toISOString();
    const facts: ReadinessFacts = {
      board,
      repoConnected,
      installUrl,
      subGateWorkflow,
      committedAgentSetVersion: agentSetRead ? committedAgentSetVersion : 'unknown',
      hasBuildDoc: index.ok && index.value.some((d) => d.area === 'build'),
      ticks: board.readinessTicks,
      recentFailures: globs.ok ? recentRoutineFailures(globs.value, since) : [],
      silentRuns: globs.ok ? silentRunGlobs(globs.value, new Date().toISOString()) : [],
    };
    return c.json({ items: readiness(facts) });
  });
};
