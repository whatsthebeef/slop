import {
  CHAT_FEEDBACK_LIST_LIMIT,
  CHAT_FEEDBACK_NOTE_MAX,
  CHAT_FEEDBACK_RATINGS,
  PAGE_TYPES,
} from '@slop/core';
import type { ChatFeedbackService } from '@slop/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface ChatFeedbackRoutesDeps {
  readonly feedback: Pick<ChatFeedbackService, 'submit' | 'mine' | 'testCases'>;
}

const feedbackBody = z.object({
  rating: z.enum(CHAT_FEEDBACK_RATINGS),
  note: z.string().trim().max(CHAT_FEEDBACK_NOTE_MAX).optional(),
  page: z
    .object({ type: z.enum(PAGE_TYPES), id: z.string().trim().min(1).max(100).optional() })
    .optional(),
});

const listQuery = z.object({
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(CHAT_FEEDBACK_LIST_LIMIT).optional(),
});

/**
 * Feedback on chat answers (spec, Chat): members rate answers in their own conversations; the board's 👎 answers are
 * listed as test cases for admins only. The service checks who may do what.
 */
export const mountChatFeedback = (app: Hono<Env>, deps: ChatFeedbackRoutesDeps): void => {
  const idOf = (param: string) => {
    const id = Number(param);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const bad = (message: string) => ({ code: 'invalid_input', message }) as const;

  app.post('/api/boards/:b/chats/:c/messages/:m/feedback', async (c) => {
    const board = idOf(c.req.param('b'));
    const chat = idOf(c.req.param('c'));
    const message = idOf(c.req.param('m'));
    if (board === null || chat === null || message === null)
      return c.json(bad('Bad board, conversation or message'), 422);
    const body = feedbackBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        bad(
          `Give a rating of up or down, and optionally a note of at most ${String(CHAT_FEEDBACK_NOTE_MAX)} characters and a page`,
        ),
        422,
      );
    }
    const { rating, note, page } = body.data;
    const result = await deps.feedback.submit(c.get('email'), board, chat, message, {
      rating,
      ...(note === undefined ? {} : { note }),
      ...(page === undefined
        ? {}
        : { page: { type: page.type, ...(page.id === undefined ? {} : { id: page.id }) } }),
    });
    return result.ok
      ? c.json({ feedback: result.value })
      : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.get('/api/boards/:b/chats/:c/feedback', async (c) => {
    const board = idOf(c.req.param('b'));
    const chat = idOf(c.req.param('c'));
    if (board === null || chat === null) return c.json(bad('Bad board or conversation'), 422);
    const result = await deps.feedback.mine(c.get('email'), board, chat);
    return result.ok
      ? c.json({ feedback: result.value })
      : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.get('/api/boards/:b/chat-feedback', async (c) => {
    const board = idOf(c.req.param('b'));
    if (board === null) return c.json(bad('Bad board'), 422);
    const query = listQuery.safeParse({ since: c.req.query('since'), limit: c.req.query('limit') });
    if (!query.success)
      return c.json(
        bad(`Give since as an ISO time and limit from 1 to ${String(CHAT_FEEDBACK_LIST_LIMIT)}`),
        422,
      );
    // Only 👎 answers are test cases, so a rating filter would promise something this list never does.
    const result = await deps.feedback.testCases(c.get('email'), board, {
      ...(query.data.since === undefined ? {} : { since: query.data.since }),
      ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
    });
    return result.ok
      ? c.json({ cases: result.value })
      : c.json(errorBody(result.error), statusOf(result.error));
  });
};
