import { llmUnavailable, forbidden, notFound, ok } from '@slop/core';
import type { ChatCitation, ChatMessage, ChatService, ChatThread, Result } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mountChat } from '../src/http/chat.js';
import type { Env } from '../src/http/app.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';

const DEV = 'dev@example.com';
const AT = '2026-10-05T12:00:00.000Z';
const thread: ChatThread = { id: 7, boardId: 1, email: DEV, title: 'q', createdAt: AT, updatedAt: AT };
const message = (id: number, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, chatId: 7, boardId: 1, email: DEV, role, content, citations: null, createdAt: AT });
const citation: ChatCitation = { n: 1, source: 'decision', sourceLabel: 'Decision', title: 'Use backoff', date: AT, link: '/boards/1?glob=s1t1', globId: 's1t1', status: 'active', supersededBy: null };

type Ask = ChatService['ask'];
type Answer = ChatService['answer'];

/** The routes and the MCP tool with a stand-in service: the service itself is covered in core. */
describe('chat route and ask_board', () => {
  let asked: Parameters<Ask>[];
  let answered: Parameters<Answer>[];
  let next: Result<{ chat: ChatThread; question: ChatMessage; reply: ChatMessage; answered: boolean }>;
  let removed: [string, number, number][];
  let saved: unknown[][];
  /** What the stand-in streams before it answers. */
  let pieces: string[];
  let app: Hono<Env>;

  const chat = {
    ask: (...args: Parameters<Ask>) => {
      asked.push(args);
      for (const piece of pieces) args[2]?.(piece);
      return Promise.resolve(next);
    },
    answer: (...args: Parameters<Answer>) => {
      answered.push(args);
      return Promise.resolve(ok({ answer: 'Exponential [1]', answered: true, citations: [citation] }));
    },
    chats: (email: string, board: number) => Promise.resolve(board === 1 ? ok([thread]) : forbidden(`${email} is not on board ${String(board)}`)),
    history: (email: string, board: number, id: number) =>
      Promise.resolve(board !== 1 ? forbidden(`${email} is not on board ${String(board)}`) : id === 7 ? ok([message(1, 'user', 'q')]) : notFound('No conversation')),
    remove: (email: string, board: number, id: number) => {
      removed.push([email, board, id]);
      return Promise.resolve(ok(null));
    },
    saveToKnowledge: (...args: unknown[]) => {
      saved.push(args);
      return Promise.resolve(ok({ id: 's1k4' }));
    },
  };

  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api/boards/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });

  beforeEach(() => {
    asked = [];
    answered = [];
    removed = [];
    saved = [];
    pieces = [];
    next = ok({ chat: thread, question: message(2, 'user', 'q'), reply: message(3, 'assistant', 'a'), answered: true });
    app = new Hono<Env>();
    app.use('/api/*', async (c, nextHandler) => {
      c.set('email', DEV);
      await nextHandler();
    });
    mountChat(app, { chat });
  });

  it('GET lists the person\'s conversations and one conversation\'s messages, with the service\'s refusals', async () => {
    const list = await send('GET', '1/chats');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ chats: [thread] });
    expect((await send('GET', '2/chats')).status).toBe(403);
    expect((await send('GET', 'x/chats')).status).toBe(422);
    const one = await send('GET', '1/chats/7');
    expect(await one.json()).toEqual({ messages: [message(1, 'user', 'q')] });
    expect((await send('GET', '1/chats/8')).status).toBe(404);
    expect((await send('GET', '1/chats/x')).status).toBe(422);
  });

  it('POST passes the question, conversation, scope, page and think to the service and returns the messages', async () => {
    const res = await send('POST', '1/chat', {
      question: '  why backoff? ',
      chat: 7,
      history: true,
      glob: 's1t1',
      group: 'sync',
      page: { type: 'glob', id: 's1t1' },
      think: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chat: { id: 7 }, reply: { content: 'a' }, answered: true });
    expect(asked.map(([email, request]) => [email, request])).toEqual([
      [DEV, { boardId: 1, question: 'why backoff?', chatId: 7, history: true, globId: 's1t1', group: 'sync', page: { type: 'glob', id: 's1t1' }, thinkHarder: true }],
    ]);
  });

  it('POST streams text pieces then the stored messages when the client accepts an event stream', async () => {
    pieces = ['Expo', 'nential [1]'];
    const res = await app.request('/api/boards/1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ question: 'why backoff?' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    const events = body
      .split('\n\n')
      .filter((e) => e.trim() !== '')
      .map((e) => ({ event: /event: (.*)/.exec(e)?.[1], data: JSON.parse(/data: (.*)/.exec(e)?.[1] ?? 'null') as unknown }));
    expect(events.map((e) => e.event)).toEqual(['text', 'text', 'done']);
    expect(events[0]?.data).toEqual({ text: 'Expo' });
    expect(events[2]?.data).toMatchObject({ chat: { id: 7 }, answered: true });
    // The service is given a signal to stop on.
    expect(asked[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('POST streams an error event with the status and body when the service refuses', async () => {
    next = llmUnavailable('Bedrock is busy', 'It is retried automatically, with a growing delay');
    const res = await app.request('/api/boards/1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ question: 'q' }),
    });
    const body = await res.text();
    expect(body).toContain('event: error');
    expect(JSON.parse(/data: (.*)/.exec(body)?.[1] ?? 'null')).toMatchObject({ status: 503, body: { code: 'llm_unavailable', reason: 'Bedrock is busy' } });
  });

  it('POST rejects a missing, blank, over-long or non-JSON question with 422 and does not call the service', async () => {
    for (const body of [{}, { question: '   ' }, { question: 'x'.repeat(2001) }, { question: 'q', history: 'yes' }, { question: 'q', page: { type: 'elsewhere' } }, { question: 'q', chat: 0 }, 'not json']) {
      expect((await send('POST', '1/chat', body)).status).toBe(422);
    }
    expect(asked).toEqual([]);
  });

  it('POST answers 503 with the reason and fix when the model is unavailable', async () => {
    next = llmUnavailable('Bedrock is busy', 'It is retried automatically, with a growing delay');
    const res = await send('POST', '1/chat', { question: 'q' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'llm_unavailable', reason: 'Bedrock is busy' });
  });

  it('DELETE removes one conversation', async () => {
    expect((await send('DELETE', '1/chats/7')).status).toBe(200);
    expect(removed).toEqual([[DEV, 1, 7]]);
    expect((await send('DELETE', '1/chats/x')).status).toBe(422);
  });

  it('save sends the answer to the proposal queue, optionally naming the page\'s glob', async () => {
    const res = await send('POST', '1/chats/7/messages/3/save', { glob: 's1t1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 's1k4' });
    expect((await send('POST', '1/chats/7/messages/4/save')).status).toBe(200);
    expect(saved).toEqual([[DEV, 1, 7, 3, 's1t1'], [DEV, 1, 7, 4, undefined]]);
    expect((await send('POST', '1/chats/7/messages/x/save')).status).toBe(422);
  });

  it('ask_board returns the answer with its citations and takes the optional glob', async () => {
    const server = buildServer({ chat } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({ name: 'ask_board', arguments: { board: 1, question: 'why backoff?', globId: 's1t1' } });
    await client.close();
    const text = z.array(z.object({ text: z.string() })).parse(result.content)[0]?.text ?? 'null';
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(text)).toMatchObject({ answer: 'Exponential [1]', answered: true, citations: [{ title: 'Use backoff' }] });
    expect(answered).toEqual([[DEV, { boardId: 1, question: 'why backoff?', globId: 's1t1' }]]);
  });
});
