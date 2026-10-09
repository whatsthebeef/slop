import { INBOX_TEXT_LIMIT, INTEGRATION_SOURCES, SOURCE_REF_LIMIT } from '@slop/core';
import type { InboxService, IntegrationTokenService } from '@slop/core';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { isDate, parseBound } from '../search-request.js';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface IntegrationRoutesDeps {
  readonly inbox: Pick<InboxService, 'deliver'>;
  readonly tokens: Pick<IntegrationTokenService, 'status' | 'create' | 'revoke' | 'authenticate'>;
}

/** A little over the text limit in UTF-8 bytes (4 per character at worst is far more than a notes doc needs). */
const BODY_LIMIT_BYTES = INBOX_TEXT_LIMIT * 4 + 4_096;

const deliveryBody = z.object({
  source: z.enum(INTEGRATION_SOURCES),
  sourceRef: z.string().min(1).max(SOURCE_REF_LIMIT),
  text: z.string().min(1).max(INBOX_TEXT_LIMIT),
  title: z.string().max(200).optional(),
  occurredAt: z.string().refine(isDate, 'Use an ISO date').optional(),
  sourceLabel: z.string().max(100).optional(),
});

/**
 * Integration ingest (spec, Inbox and ingest): an outside script adds items to one board's inbox with that board's
 * integration token as a bearer credential. It lives outside `/api` (which needs a person's session) and can do nothing
 * but add inbox items to the board its token belongs to. The token is managed under `/api` by the board's admins.
 */
export const mountIntegrations = (app: Hono<Env>, deps: IntegrationRoutesDeps): void => {
  const board = (c: Context<Env>) => Number(c.req.param('b'));

  app.post(
    '/integrations/boards/:b/inbox',
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => c.json({ code: 'invalid_input', message: 'The request is too large' }, 413),
    }),
    async (c) => {
      const boardId = board(c);
      const header = c.req.header('authorization');
      if (header?.startsWith('Bearer ') !== true || !Number.isSafeInteger(boardId))
        return c.json({ code: 'unauthenticated', message: 'Send the integration token as a bearer token' }, 401);
      const auth = await deps.tokens.authenticate(boardId, header.slice(7).trim());
      if (!auth.ok) return c.json({ code: 'unauthenticated', message: auth.error.message }, 401);
      const body = deliveryBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success)
        return c.json({ code: 'invalid_input', message: body.error.issues[0]?.message ?? 'Bad delivery' }, 422);
      const { occurredAt, ...rest } = body.data;
      const result = await deps.inbox.deliver(auth.value.boardId, {
        ...rest,
        occurredAt: occurredAt === undefined ? undefined : (parseBound(occurredAt, 'from') ?? undefined),
      });
      return result.ok
        ? c.json(result.value, result.value.created ? 201 : 200)
        : c.json(errorBody(result.error), statusOf(result.error));
    },
  );

  const send = <T extends object>(
    c: Context<Env>,
    result: { ok: true; value: T } | { ok: false; error: Parameters<typeof statusOf>[0] },
    status: 200 | 201 = 200,
  ) =>
    result.ok ? c.json(result.value, status) : c.json(errorBody(result.error), statusOf(result.error));
  const checked = (c: Context<Env>) => {
    const id = board(c);
    return Number.isSafeInteger(id) ? id : null;
  };

  app.get('/api/boards/:b/integration-token', async (c) => {
    const id = checked(c);
    if (id === null) return c.json({ code: 'invalid_input', message: 'Bad board' }, 422);
    return send(c, await deps.tokens.status(c.get('email'), id));
  });
  // The one response that carries the secret: it is not kept anywhere else.
  app.post('/api/boards/:b/integration-token', async (c) => {
    const id = checked(c);
    if (id === null) return c.json({ code: 'invalid_input', message: 'Bad board' }, 422);
    c.header('cache-control', 'no-store');
    return send(c, await deps.tokens.create(c.get('email'), id), 201);
  });
  app.delete('/api/boards/:b/integration-token', async (c) => {
    const id = checked(c);
    if (id === null) return c.json({ code: 'invalid_input', message: 'Bad board' }, 422);
    return send(c, await deps.tokens.revoke(c.get('email'), id));
  });
};
