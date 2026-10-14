import { forbidden, notFound, ok } from '@slop/core';
import type { ChatFeedback, ChatFeedbackService, ChatTestCase, Result } from '@slop/core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { mountChatFeedback } from '../src/http/chat-feedback.js';
import type { Env } from '../src/http/app.js';

const DEV = 'dev@example.com';
const AT = '2026-10-05T12:00:00.000Z';
const feedback: ChatFeedback = {
  id: 1,
  boardId: 1,
  chatId: 7,
  messageId: 3,
  email: DEV,
  rating: 'down',
  note: 'wrong',
  question: 'q',
  answer: 'a',
  citations: null,
  tools: null,
  page: null,
  createdAt: AT,
  updatedAt: AT,
};
const testCase: ChatTestCase = {
  id: 1,
  boardId: 1,
  question: 'q',
  answer: 'a',
  citations: [],
  tools: [],
  page: null,
  note: 'wrong',
  email: DEV,
  createdAt: AT,
};

/** The routes with a stand-in service: the service itself is covered in core. */
describe('chat feedback routes', () => {
  let submitted: Parameters<ChatFeedbackService['submit']>[];
  let listed: Parameters<ChatFeedbackService['testCases']>[];
  let next: Result<ChatFeedback>;
  let app: Hono<Env>;

  const service = {
    submit: (...args: Parameters<ChatFeedbackService['submit']>) => {
      submitted.push(args);
      return Promise.resolve(next);
    },
    mine: (_email: string, board: number, chat: number) =>
      Promise.resolve(board === 1 && chat === 7 ? ok([feedback]) : notFound('No conversation')),
    testCases: (...args: Parameters<ChatFeedbackService['testCases']>) => {
      listed.push(args);
      return Promise.resolve(
        args[1] === 1 ? ok([testCase]) : forbidden('Only board admins can do this'),
      );
    },
  };

  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api/boards/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });

  beforeEach(() => {
    submitted = [];
    listed = [];
    next = ok(feedback);
    app = new Hono<Env>();
    app.use('/api/*', async (c, nextHandler) => {
      c.set('email', DEV);
      await nextHandler();
    });
    mountChatFeedback(app, { feedback: service });
  });

  it('POST passes the rating, note and page to the service and returns the stored feedback', async () => {
    const res = await send('POST', '1/chats/7/messages/3/feedback', {
      rating: 'down',
      note: '  wrong ',
      page: { type: 'glob', id: 's1t1' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ feedback });
    expect(submitted).toEqual([
      [DEV, 1, 7, 3, { rating: 'down', note: 'wrong', page: { type: 'glob', id: 's1t1' } }],
    ]);
  });

  it('POST takes just a rating, and refuses a bad rating, a long note, a bad page or bad ids', async () => {
    expect((await send('POST', '1/chats/7/messages/3/feedback', { rating: 'up' })).status).toBe(
      200,
    );
    expect(submitted[0]?.[4]).toEqual({ rating: 'up' });
    expect((await send('POST', '1/chats/7/messages/3/feedback', { rating: 'meh' })).status).toBe(
      422,
    );
    expect(
      (
        await send('POST', '1/chats/7/messages/3/feedback', {
          rating: 'down',
          note: 'x'.repeat(201),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await send('POST', '1/chats/7/messages/3/feedback', {
          rating: 'down',
          page: { type: 'nowhere' },
        })
      ).status,
    ).toBe(422);
    expect((await send('POST', '1/chats/7/messages/3/feedback', 'not json')).status).toBe(422);
    expect((await send('POST', '1/chats/x/messages/3/feedback', { rating: 'up' })).status).toBe(
      422,
    );
    expect(submitted).toHaveLength(1);
  });

  it("POST maps the service's refusals to their statuses", async () => {
    next = notFound('No conversation 7');
    expect((await send('POST', '1/chats/7/messages/3/feedback', { rating: 'up' })).status).toBe(
      404,
    );
    next = forbidden('not a member');
    expect((await send('POST', '1/chats/7/messages/3/feedback', { rating: 'up' })).status).toBe(
      403,
    );
  });

  it("GET returns the person's own feedback in a conversation", async () => {
    expect(await (await send('GET', '1/chats/7/feedback')).json()).toEqual({
      feedback: [feedback],
    });
    expect((await send('GET', '1/chats/8/feedback')).status).toBe(404);
    expect((await send('GET', '1/chats/x/feedback')).status).toBe(422);
  });

  it('GET chat-feedback returns the test cases with since and limit, and 403 for a non-admin', async () => {
    expect(
      await (await send('GET', '1/chat-feedback?since=2026-10-01T00:00:00.000Z&limit=5')).json(),
    ).toEqual({ cases: [testCase] });
    expect(listed[0]).toEqual([DEV, 1, { since: '2026-10-01T00:00:00.000Z', limit: 5 }]);
    await send('GET', '1/chat-feedback');
    expect(listed[1]).toEqual([DEV, 1, {}]);
    expect((await send('GET', '2/chat-feedback')).status).toBe(403);
    expect((await send('GET', '1/chat-feedback?since=yesterday')).status).toBe(422);
    expect((await send('GET', '1/chat-feedback?limit=0')).status).toBe(422);
    expect((await send('GET', 'x/chat-feedback')).status).toBe(422);
  });
});
