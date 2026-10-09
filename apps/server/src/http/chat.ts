import { MAX_QUERY_LENGTH } from '@slop/core';
import type { ChatService } from '@slop/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface ChatRoutesDeps {
  readonly chat: Pick<ChatService, 'ask' | 'history' | 'clear'>;
}

const askBody = z.object({
  question: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  history: z.boolean().optional(),
  glob: z.string().trim().min(1).optional(),
  group: z.string().trim().min(1).optional(),
});

/** Board chat (spec, Chat): each member's own conversation with the board's records; members only, checked by the service. */
export const mountChat = (app: Hono<Env>, deps: ChatRoutesDeps): void => {
  const boardOf = (param: string) => {
    const board = Number(param);
    return Number.isSafeInteger(board) ? board : null;
  };

  app.get('/api/boards/:b/chat', async (c) => {
    const board = boardOf(c.req.param('b'));
    if (board === null) return c.json({ code: 'invalid_input', message: 'Bad board' }, 422);
    const result = await deps.chat.history(c.get('email'), board);
    return result.ok ? c.json({ messages: result.value }) : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.post('/api/boards/:b/chat', async (c) => {
    const board = boardOf(c.req.param('b'));
    if (board === null) return c.json({ code: 'invalid_input', message: 'Bad board' }, 422);
    const body = askBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ code: 'invalid_input', message: `Give a question of 1 to ${MAX_QUERY_LENGTH} characters, and optionally history, glob and group` }, 422);
    }
    const { question, history, glob, group } = body.data;
    const result = await deps.chat.ask(c.get('email'), {
      boardId: board,
      question,
      ...(history === undefined ? {} : { history }),
      ...(glob === undefined ? {} : { globId: glob }),
      ...(group === undefined ? {} : { group }),
    });
    return result.ok ? c.json(result.value) : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.delete('/api/boards/:b/chat', async (c) => {
    const board = boardOf(c.req.param('b'));
    if (board === null) return c.json({ code: 'invalid_input', message: 'Bad board' }, 422);
    const result = await deps.chat.clear(c.get('email'), board);
    return result.ok ? c.json({ ok: true }) : c.json(errorBody(result.error), statusOf(result.error));
  });
};
