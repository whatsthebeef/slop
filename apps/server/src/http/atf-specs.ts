import type { AtfRunnerService, BoardService, TestRunService } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { bearerOf, deprecationHeaders } from '../atf-auth.js';
import type { RunnerAuthenticator } from '../atf-auth.js';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface AtfSpecsRoutesDeps {
  readonly testRuns: Pick<TestRunService, 'atfBatch'>;
  readonly boards: Pick<BoardService, 'get'>;
  /** Resolves the pipeline's bearer credential (a runner's own, or the deprecated board token) to a runner of the board. */
  readonly authenticate: RunnerAuthenticator;
  readonly runners: Pick<AtfRunnerService, 'seen'>;
  readonly log?: (task: string, message: string) => void;
}

/** How long a pipeline waits before asking again while the deploy's check is running. */
export const RETRY_AFTER_SECONDS = 15;

const querySchema = z.object({
  environment: z.string().min(1).max(100),
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i)
    .transform((sha) => sha.toLowerCase()),
});

/**
 * The spec list the board's ATF stage runs after a deploy (spec, ATF results): the union of the specs (and greps) of the
 * test plans of the globs the deploy newly holds, each with the globs that asked for it. Two doors onto one answer:
 * `/api/boards/:b/atf-specs` for a signed-in member (a session or a person's bearer token), and
 * `/integrations/boards/:b/atf-specs` for a runner, with its own credential as a bearer token (or the board's integration
 * token, deprecated: those answers carry `Deprecation: true`). A credential is bound to its board and a runner to the
 * environments it serves, so neither door answers for another board. A pipeline that gets any failure runs its
 * default suite: ATF is a flag and never blocks anything.
 */
export const mountAtfSpecs = (app: Hono<Env>, deps: AtfSpecsRoutesDeps): void => {
  const answer = async (c: Context<Env>, boardId: number, serves: readonly string[] | null = null) => {
    const query = querySchema.safeParse({
      environment: c.req.query('environment'),
      sha: c.req.query('sha'),
    });
    if (!query.success) {
      return c.json(
        { code: 'invalid_input', message: 'Send ?environment=<name>&sha=<7 to 40 hex characters>' },
        422,
      );
    }
    if (serves !== null && !serves.includes(query.data.environment)) {
      return c.json({ code: 'forbidden', message: 'This runner does not serve that environment' }, 403);
    }
    const result = await deps.testRuns.atfBatch(boardId, query.data.environment, query.data.sha);
    if (!result.ok) return c.json(errorBody(result.error), statusOf(result.error));
    const found = result.value;
    if (found.status === 'pending') {
      c.header('Retry-After', String(RETRY_AFTER_SECONDS));
      return c.json({ status: 'pending', retryAfterSeconds: RETRY_AFTER_SECONDS }, 202);
    }
    if (found.status === 'superseded')
      return c.json({ status: 'superseded', latestSha: found.latestSha }, 409);
    const { batch } = found;
    return c.json({
      status: 'ready',
      environment: batch.environment,
      sha: batch.sha,
      specs: batch.specs.map((s) => ({ spec: s.spec, globs: s.globIds })),
      greps: batch.greps.map((g) => ({ grep: g.grep, globs: g.globIds })),
      batchId: batch.id,
    });
  };

  const boardOf = (c: Context<Env>): number | null => {
    const id = Number(c.req.param('b'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };

  app.get('/api/boards/:b/atf-specs', async (c) => {
    const boardId = boardOf(c);
    if (boardId === null) return c.json({ code: 'invalid_input', message: 'Bad board' }, 422);
    const membership = await deps.boards.get(c.get('email'), boardId);
    if (!membership.ok) return c.json(errorBody(membership.error), statusOf(membership.error));
    return answer(c, boardId);
  });

  app.get('/integrations/boards/:b/atf-specs', async (c) => {
    const boardId = boardOf(c);
    const bearer = bearerOf(c.req.header('authorization'));
    const runner = bearer === null || boardId === null ? null : await deps.authenticate(boardId, bearer);
    // Plain on purpose: nothing says which check failed.
    if (runner === null) return c.json({ code: 'unauthenticated', message: 'Unauthenticated' }, 401);
    for (const [name, value] of Object.entries(deprecationHeaders(runner))) c.header(name, value);
    if (runner.runnerId !== null) {
      await deps.runners.seen(runner.boardId, runner.runnerId).catch(() => deps.log?.('atf specs', `Could not note runner ${String(runner.runnerId)} as seen`));
    }
    return answer(c, runner.boardId, runner.environments);
  });
};
