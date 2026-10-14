import type { BoardService, IntegrationTokenService, TestRunService } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface AtfSpecsRoutesDeps {
  readonly testRuns: Pick<TestRunService, 'atfBatch'>;
  readonly boards: Pick<BoardService, 'get'>;
  readonly tokens: Pick<IntegrationTokenService, 'authenticate'>;
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
 * `/integrations/boards/:b/atf-specs` for the pipeline, with the board's integration token as a bearer credential. The
 * token is bound to its board, so neither door answers for another board. A pipeline that gets any failure runs its
 * default suite: ATF is a flag and never blocks anything.
 */
export const mountAtfSpecs = (app: Hono<Env>, deps: AtfSpecsRoutesDeps): void => {
  const answer = async (c: Context<Env>, boardId: number) => {
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
    const header = c.req.header('authorization');
    if (header?.startsWith('Bearer ') !== true || boardId === null) {
      return c.json(
        { code: 'unauthenticated', message: 'Send the integration token as a bearer token' },
        401,
      );
    }
    const auth = await deps.tokens.authenticate(boardId, header.slice(7).trim());
    if (!auth.ok) return c.json({ code: 'unauthenticated', message: auth.error.message }, 401);
    return answer(c, auth.value.boardId);
  });
};
