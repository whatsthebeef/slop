import { llmUnavailable, forbidden, ok } from '@slop/core';
import type { ChatCitation, ChatMessage, ChatService, Result } from '@slop/core';
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
const message = (id: number, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, boardId: 1, email: DEV, role, content, citations: null, createdAt: AT });
const citation: ChatCitation = { n: 1, source: 'decision', sourceLabel: 'Decision', title: 'Use backoff', date: AT, link: '/boards/1?glob=s1t1', globId: 's1t1', status: 'active', supersededBy: null };

type Ask = ChatService['ask'];
type Answer = ChatService['answer'];

/** The routes and the MCP tool with a stand-in service: the service itself is covered in core. */
describe('chat route and ask_board', () => {
  let asked: Parameters<Ask>[];
  let answered: Parameters<Answer>[];
  let next: Result<{ question: ChatMessage; reply: ChatMessage; answered: boolean }>;
  let cleared: [string, number][];
  let app: Hono<Env>;

  const chat = {
    ask: (...args: Parameters<Ask>) => {
      asked.push(args);
      return Promise.resolve(next);
    },
    answer: (...args: Parameters<Answer>) => {
      answered.push(args);
      return Promise.resolve(ok({ answer: 'Exponential [1]', answered: true, citations: [citation] }));
    },
    history: (email: string, board: number) => Promise.resolve(board === 1 ? ok([message(1, 'user', 'q')]) : forbidden(`${email} is not on board ${String(board)}`)),
    clear: (email: string, board: number) => {
      cleared.push([email, board]);
      return Promise.resolve(ok(null));
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
    cleared = [];
    next = ok({ question: message(2, 'user', 'q'), reply: message(3, 'assistant', 'a'), answered: true });
    app = new Hono<Env>();
    app.use('/api/*', async (c, nextHandler) => {
      c.set('email', DEV);
      await nextHandler();
    });
    mountChat(app, { chat });
  });

  it('GET returns the person\'s messages, and the service\'s refusal as 403', async () => {
    const ok200 = await send('GET', '1/chat');
    expect(ok200.status).toBe(200);
    expect(await ok200.json()).toEqual({ messages: [message(1, 'user', 'q')] });
    expect((await send('GET', '2/chat')).status).toBe(403);
    expect((await send('GET', 'x/chat')).status).toBe(422);
  });

  it('POST passes the question and scope to the service and returns both messages', async () => {
    const res = await send('POST', '1/chat', { question: '  why backoff? ', history: true, glob: 's1t1', group: 'sync' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reply: { content: 'a' }, answered: true });
    expect(asked).toEqual([[DEV, { boardId: 1, question: 'why backoff?', history: true, globId: 's1t1', group: 'sync' }]]);
  });

  it('POST rejects a missing, blank, over-long or non-JSON question with 422 and does not call the service', async () => {
    for (const body of [{}, { question: '   ' }, { question: 'x'.repeat(2001) }, { question: 'q', history: 'yes' }, 'not json']) {
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

  it('DELETE clears the conversation', async () => {
    expect((await send('DELETE', '1/chat')).status).toBe(200);
    expect(cleared).toEqual([[DEV, 1]]);
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
