import { z } from 'zod';
import { SlopError } from './errors.js';
import { HTTP_TIMEOUT_MS, type Fetch } from './http.js';
import { describeError, parseJsonOrUndefined } from './util.js';

export type ToolArguments = Readonly<Record<string, unknown>>;

export interface ClientDeps {
  /** slop's base URL, without a trailing slash. */
  readonly slopUrl: string;
  readonly fetch: Fetch;
  /** A bearer token; forceRefresh is set after a 401. */
  readonly accessToken: (forceRefresh: boolean) => Promise<string>;
}

const rpcResponseSchema = z.object({
  result: z
    .object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

// slop's domain errors (forbidden, run_active, invalid_transition, ...): an isError result whose
// text is the error as JSON.
const domainErrorSchema = z.object({ code: z.string(), message: z.string() });

/**
 * Calls slop's MCP tools. slop's /mcp endpoint is stateless, so each call is a lone JSON-RPC
 * `tools/call` request with no `initialize` handshake.
 */
export class SlopClient {
  constructor(private readonly deps: ClientDeps) {}

  /** Calls `tool` with `args` and returns its JSON result; failures throw SlopError. */
  async call(tool: string, args: ToolArguments = {}): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    });
    let response = await this.post(body, await this.deps.accessToken(false));
    if (response.status === 401) {
      response = await this.post(body, await this.deps.accessToken(true));
    }
    if (response.status !== 200) {
      throw new SlopError(`${tool} failed (${response.status}): ${response.text.slice(0, 200)}`);
    }
    const message = rpcResponseSchema.safeParse(parseRpcBody(response));
    if (!message.success) throw new SlopError(`${tool}: unexpected response from slop`);
    if (message.data.error !== undefined) {
      throw new SlopError(`${tool}: ${message.data.error.message}`);
    }
    const result = message.data.result ?? { content: [] };
    const text = result.content.map((part) => part.text ?? '').join('');
    const value = parseJsonOrUndefined(text);
    if (result.isError === true) {
      const domainError = domainErrorSchema.safeParse(value);
      if (domainError.success) {
        throw new SlopError(`${domainError.data.code}: ${domainError.data.message}`);
      }
      throw new SlopError(text.trim() || `${tool} failed`);
    }
    if (value === undefined) throw new SlopError(text.trim() || `${tool}: empty result`);
    return value;
  }

  private async post(body: string, token: string): Promise<RawResponse> {
    const endpoint = `${this.deps.slopUrl}/mcp`;
    try {
      const response = await this.deps.fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        text: await response.text(),
      };
    } catch (error) {
      throw new SlopError(`could not reach ${endpoint}: ${describeError(error)}`);
    }
  }
}

interface RawResponse {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
}

/** slop answers with JSON; an SSE stream (the transport's other mode) carries it as `data:` lines. */
function parseRpcBody(response: RawResponse): unknown {
  if (!response.contentType.includes('text/event-stream')) {
    return parseJsonOrUndefined(response.text);
  }
  const data = response.text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  return parseJsonOrUndefined(data.at(-1) ?? '');
}
