import { MAX_QUERY_LENGTH, PAGE_TYPES } from '@slop/core';
import type { ChatService } from '@slop/core';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface ChatRoutesDeps {
  readonly chat: Pick<ChatService, 'ask' | 'chats' | 'history' | 'remove' | 'saveToKnowledge'>;
}

const askBody = z.object({
  question: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  /** The conversation to add to; a new one starts without it. */
  chat: z.number().int().positive().optional(),
  history: z.boolean().optional(),
  glob: z.string().trim().min(1).optional(),
  group: z.string().trim().min(1).optional(),
  page: z.object({ type: z.enum(PAGE_TYPES), id: z.string().trim().min(1).max(100).optional() }).optional(),
  /** One answer from the stronger model. */
  think: z.boolean().optional(),
});

const saveBody = z.object({ glob: z.string().trim().min(1).optional() });

/**
 * Board chat (spec, Chat): each member's own conversations with the board's records; members only, checked by the
 * service. A question answers as one JSON reply, or, when the client accepts `text/event-stream`, as events: `text`
 * (a piece of the answer), then `done` (the stored messages) or `error` (the domain error and its status).
 */
export const mountChat = (app: Hono<Env>, deps: ChatRoutesDeps): void => {
  const idOf = (param: string) => {
    const id = Number(param);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const bad = (what: string) => ({ code: 'invalid_input', message: `Bad ${what}` }) as const;

  app.get('/api/boards/:b/chats', async (c) => {
    const board = idOf(c.req.param('b'));
    if (board === null) return c.json(bad('board'), 422);
    const result = await deps.chat.chats(c.get('email'), board);
    return result.ok ? c.json({ chats: result.value }) : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.get('/api/boards/:b/chats/:c', async (c) => {
    const board = idOf(c.req.param('b'));
    const chat = idOf(c.req.param('c'));
    if (board === null || chat === null) return c.json(bad('board or conversation'), 422);
    const result = await deps.chat.history(c.get('email'), board, chat);
    return result.ok ? c.json({ messages: result.value }) : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.delete('/api/boards/:b/chats/:c', async (c) => {
    const board = idOf(c.req.param('b'));
    const chat = idOf(c.req.param('c'));
    if (board === null || chat === null) return c.json(bad('board or conversation'), 422);
    const result = await deps.chat.remove(c.get('email'), board, chat);
    return result.ok ? c.json({ ok: true }) : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.post('/api/boards/:b/chats/:c/messages/:m/save', async (c) => {
    const board = idOf(c.req.param('b'));
    const chat = idOf(c.req.param('c'));
    const message = idOf(c.req.param('m'));
    if (board === null || chat === null || message === null) return c.json(bad('board, conversation or message'), 422);
    const body = saveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: 'invalid_input', message: 'Give an optional glob' }, 422);
    const result = await deps.chat.saveToKnowledge(c.get('email'), board, chat, message, body.data.glob);
    return result.ok ? c.json(result.value) : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.post('/api/boards/:b/chat', async (c) => {
    const board = idOf(c.req.param('b'));
    if (board === null) return c.json(bad('board'), 422);
    const body = askBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { code: 'invalid_input', message: `Give a question of 1 to ${MAX_QUERY_LENGTH} characters, and optionally chat, history, glob, group, page and think` },
        422,
      );
    }
    const { question, chat, history, glob, group, page, think } = body.data;
    const request = {
      boardId: board,
      question,
      ...(chat === undefined ? {} : { chatId: chat }),
      ...(history === undefined ? {} : { history }),
      ...(glob === undefined ? {} : { globId: glob }),
      ...(group === undefined ? {} : { group }),
      ...(page === undefined ? {} : { page: { type: page.type, ...(page.id === undefined ? {} : { id: page.id }) } }),
      ...(think === true ? { thinkHarder: true } : {}),
    };
    const email = c.get('email');
    if (!(c.req.header('accept') ?? '').includes('text/event-stream')) {
      const result = await deps.chat.ask(email, request);
      return result.ok ? c.json(result.value) : c.json(errorBody(result.error), statusOf(result.error));
    }
    return streamSSE(c, async (stream) => {
      // The stop button closes the request: the model call ends and nothing is stored.
      const stop = new AbortController();
      stream.onAbort(() => stop.abort());
      // Writes are queued so the pieces reach the client in order.
      let sent: Promise<void> = Promise.resolve();
      const send = (event: string, data: unknown) => {
        sent = sent.then(() => (stream.aborted ? undefined : stream.writeSSE({ event, data: JSON.stringify(data) }))).catch(() => undefined);
      };
      const result = await deps.chat.ask(email, { ...request, signal: stop.signal }, (text) => send('text', { text }));
      if (result.ok) send('done', result.value);
      else send('error', { status: statusOf(result.error), body: errorBody(result.error) });
      await sent;
    });
  });
};
