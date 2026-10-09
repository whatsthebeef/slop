import {
  IMPORT_SOURCES,
  INBOX_STATUSES,
  INBOX_TEXT_LIMIT,
  MAX_ATTACH_GLOBS,
  MAX_IMPORT_ITEMS,
} from '@slop/core';
import type { InboxService } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { isDate, parseBound } from '../search-request.js';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface InboxRoutesDeps {
  readonly inbox: Pick<InboxService, 'add' | 'importItems' | 'list' | 'get' | 'attach' | 'keep' | 'discard'>;
}

const pasteBody = z.object({
  text: z.string().min(1).max(INBOX_TEXT_LIMIT),
  title: z.string().max(200).optional(),
  occurredAt: z.string().refine(isDate, 'Use an ISO date').optional(),
  sourceLabel: z.string().max(100).optional(),
});
const importBody = z.object({
  items: z
    .array(
      z.object({
        source: z.enum(IMPORT_SOURCES),
        sourceKey: z.string().min(1).max(200),
        title: z.string().max(500),
        // Cut to the limit by the service, so a long Doc is imported by its start.
        text: z.string().min(1),
        sourceType: z.enum(['thread', 'doc']),
        sourceLabel: z.string().max(200).optional(),
        occurredAt: z.string().refine(isDate, 'Use an ISO date').optional(),
      }),
    )
    .min(1)
    .max(MAX_IMPORT_ITEMS),
});
const attachBody = z.object({ globIds: z.array(z.string().min(1)).min(1).max(MAX_ATTACH_GLOBS) });
const statusParam = z.enum(INBOX_STATUSES);

const bad = (c: Context<Env>, message: string) => c.json({ code: 'invalid_input', message }, 422);

/** The board inbox (spec, Inbox and ingest), board-scoped like the rest of the API; members only, checked by the service. */
export const mountInbox = (app: Hono<Env>, deps: InboxRoutesDeps): void => {
  const send = <T extends object>(
    c: Context<Env>,
    result: { ok: true; value: T } | { ok: false; error: Parameters<typeof statusOf>[0] },
    status: 200 | 201 = 200,
  ) =>
    result.ok
      ? c.json(result.value, status)
      : c.json(errorBody(result.error), statusOf(result.error));
  const ids = (c: Context<Env>) => ({
    board: Number(c.req.param('b')),
    item: Number(c.req.param('id')),
  });

  app.get('/api/boards/:b/inbox', async (c) => {
    const { board } = ids(c);
    if (!Number.isSafeInteger(board)) return bad(c, 'Bad board');
    const status = c.req.query('status');
    const statuses =
      status === undefined || status === ''
        ? undefined
        : status.split(',').map((s) => statusParam.safeParse(s));
    if (statuses?.some((s) => !s.success) === true)
      return bad(c, `status is one of ${INBOX_STATUSES.join(', ')}`);
    const result = await deps.inbox.list(
      c.get('email'),
      board,
      statuses?.flatMap((s) => (s.success ? [s.data] : [])),
    );
    return result.ok
      ? c.json({ items: result.value })
      : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.get('/api/boards/:b/inbox/:id', async (c) => {
    const { board, item } = ids(c);
    if (!Number.isSafeInteger(board) || !Number.isSafeInteger(item))
      return bad(c, 'Bad inbox item');
    return send(c, await deps.inbox.get(c.get('email'), board, item));
  });

  // Before the paste route's `:id` siblings, and a POST of its own: a backfill's batches (the CLI's `slop import`).
  app.post('/api/boards/:b/inbox/import', async (c) => {
    const { board } = ids(c);
    if (!Number.isSafeInteger(board)) return bad(c, 'Bad board');
    const body = importBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return bad(c, body.error.issues[0]?.message ?? 'Bad import');
    const result = await deps.inbox.importItems(c.get('email'), board, body.data.items);
    return result.ok
      ? c.json({ outcomes: result.value })
      : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.post('/api/boards/:b/inbox', async (c) => {
    const { board } = ids(c);
    if (!Number.isSafeInteger(board)) return bad(c, 'Bad board');
    const body = pasteBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return bad(c, body.error.issues[0]?.message ?? 'Bad paste');
    const { text, title, sourceLabel, occurredAt } = body.data;
    const result = await deps.inbox.add(c.get('email'), board, {
      text,
      title,
      sourceLabel,
      occurredAt:
        occurredAt === undefined ? undefined : (parseBound(occurredAt, 'from') ?? undefined),
    });
    return send(c, result, 201);
  });

  app.post('/api/boards/:b/inbox/:id/attach', async (c) => {
    const { board, item } = ids(c);
    if (!Number.isSafeInteger(board) || !Number.isSafeInteger(item))
      return bad(c, 'Bad inbox item');
    const body = attachBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return bad(c, `Give globIds: 1 to ${String(MAX_ATTACH_GLOBS)} glob IDs`);
    return send(c, await deps.inbox.attach(c.get('email'), board, item, body.data.globIds));
  });

  app.post('/api/boards/:b/inbox/:id/keep', async (c) => {
    const { board, item } = ids(c);
    if (!Number.isSafeInteger(board) || !Number.isSafeInteger(item))
      return bad(c, 'Bad inbox item');
    return send(c, await deps.inbox.keep(c.get('email'), board, item));
  });

  app.post('/api/boards/:b/inbox/:id/discard', async (c) => {
    const { board, item } = ids(c);
    if (!Number.isSafeInteger(board) || !Number.isSafeInteger(item))
      return bad(c, 'Bad inbox item');
    return send(c, await deps.inbox.discard(c.get('email'), board, item));
  });
};
