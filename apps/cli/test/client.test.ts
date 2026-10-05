import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SlopClient } from '../src/client.js';
import { SlopError } from '../src/errors.js';
import { startStubServer, type StubServer } from './support.js';

interface SeenRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: unknown;
}

function toolResult(text: string, isError?: boolean): object {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }], ...(isError === undefined ? {} : { isError }) },
  };
}

function sendJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

describe('SlopClient.call', () => {
  let stub: StubServer | undefined;
  const seen: SeenRequest[] = [];

  afterEach(async () => {
    seen.length = 0;
    await stub?.close();
    stub = undefined;
  });

  async function serve(
    reply: (request: SeenRequest, response: ServerResponse) => void,
  ): Promise<string> {
    stub = await startStubServer((request, body, response) => {
      const record: SeenRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(body),
      };
      seen.push(record);
      reply(record, response);
    });
    return stub.url;
  }

  function client(slopUrl: string, tokens: string[] = ['t1', 't2']): SlopClient {
    const forced: boolean[] = [];
    return new SlopClient({
      slopUrl,
      fetch: (input, init) => fetch(input, init),
      accessToken: (forceRefresh) => {
        forced.push(forceRefresh);
        return Promise.resolve(tokens[forced.length - 1] ?? 'none');
      },
    });
  }

  it('posts one tools/call request and returns the parsed JSON result', async () => {
    const url = await serve((_request, response) =>
      sendJson(response, 200, toolResult('{"email":"ann@x.test"}')),
    );
    expect(await client(url).call('whoami', { board: 1 })).toEqual({ email: 'ann@x.test' });
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/mcp');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers.accept).toBe('application/json, text/event-stream');
    expect(request?.headers.authorization).toBe('Bearer t1');
    expect(request?.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: { board: 1 } },
    });
  });

  it('reads a result sent as an event stream', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: message\ndata: ${JSON.stringify(toolResult('[1,2]'))}\n\n`);
    });
    expect(await client(url).call('list_globs')).toEqual([1, 2]);
  });

  it('turns an isError result into a SlopError with its text', async () => {
    const url = await serve((_request, response) =>
      sendJson(response, 200, toolResult('board 9 not found', true)),
    );
    await expect(client(url).call('get_board', { board: 9 })).rejects.toThrow(
      new SlopError('board 9 not found'),
    );
  });

  it("turns slop's domain errors (isError with the error as JSON) into code: message", async () => {
    // The shape slop's MCP server sends: errorBody pretty-printed, isError set.
    const errorText = JSON.stringify(
      { code: 'forbidden', message: 'not a member of board 3' },
      null,
      2,
    );
    const url = await serve((_request, response) =>
      sendJson(response, 200, toolResult(errorText, true)),
    );
    await expect(client(url).call('get_board', { board: 3 })).rejects.toThrow(
      new SlopError('forbidden: not a member of board 3'),
    );
  });

  it('returns a successful result that happens to have code and message fields', async () => {
    const url = await serve((_request, response) =>
      sendJson(response, 200, toolResult('{"code":"x","message":"y"}')),
    );
    expect(await client(url).call('get_thing')).toEqual({ code: 'x', message: 'y' });
  });

  it('reports JSON-RPC errors', async () => {
    const url = await serve((_request, response) =>
      sendJson(response, 200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } }),
    );
    await expect(client(url).call('nope')).rejects.toThrow(new SlopError('nope: bad'));
  });

  it('retries once with a forced refresh after a 401', async () => {
    const url = await serve((request, response) => {
      if (request.headers.authorization === 'Bearer stale') {
        sendJson(response, 401, { error: 'invalid_token' });
        return;
      }
      sendJson(response, 200, toolResult('{"ok":true}'));
    });
    expect(await client(url, ['stale', 'fresh']).call('whoami')).toEqual({ ok: true });
    expect(seen.map((request) => request.headers.authorization)).toEqual([
      'Bearer stale',
      'Bearer fresh',
    ]);
  });

  it('gives up after the retry is also refused', async () => {
    const url = await serve((_request, response) => sendJson(response, 401, { error: 'no' }));
    await expect(client(url).call('whoami')).rejects.toThrow('whoami failed (401)');
    expect(seen).toHaveLength(2);
  });

  it('reports an unreachable slop', async () => {
    const url = await serve((_request, response) => response.end());
    await stub?.close();
    stub = undefined;
    await expect(client(url).call('whoami')).rejects.toThrow(`could not reach ${url}/mcp`);
  });
});

describe('SlopClient.rest', () => {
  let stub: StubServer | undefined;
  const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];

  afterEach(async () => {
    seen.length = 0;
    await stub?.close();
    stub = undefined;
  });

  async function serve(statuses: number[], reply: object): Promise<SlopClient> {
    stub = await startStubServer((request, body, response) => {
      seen.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
      sendJson(response, statuses[seen.length - 1] ?? 200, reply);
    });
    const tokens = ['t1', 't2'];
    let n = 0;
    return new SlopClient({
      slopUrl: stub.url,
      fetch: (input, init) => fetch(input, init),
      accessToken: () => Promise.resolve(tokens[n++] ?? 'none'),
    });
  }

  it('sends the method, path, body and token, and returns the JSON', async () => {
    const client = await serve([200], { id: 15, version: 4 });
    expect(await client.rest('PATCH', '/api/boards/15/settings', { version: 3 })).toEqual({ id: 15, version: 4 });
    expect(seen).toEqual([{ method: 'PATCH', url: '/api/boards/15/settings', auth: 'Bearer t1', body: '{"version":3}' }]);
  });

  it('retries once with a fresh token after a 401', async () => {
    const client = await serve([401, 200], { ok: true });
    expect(await client.rest('GET', '/api/me')).toEqual({ ok: true });
    expect(seen.map((s) => s.auth)).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it("throws slop's message on failure and refuses paths outside /api", async () => {
    const client = await serve([403], { code: 'forbidden', message: 'Only admins can change settings' });
    await expect(client.rest('PATCH', '/api/boards/1/settings', {})).rejects.toThrow(/403.*Only admins/);
    await expect(client.rest('GET', '/mcp')).rejects.toBeInstanceOf(SlopError);
  });
});
