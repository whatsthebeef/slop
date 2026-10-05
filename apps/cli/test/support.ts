import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Fetch } from '../src/http.js';
import type { StoredTokens, TokenStore } from '../src/token-store.js';

export class MemoryTokenStore implements TokenStore {
  readonly entries = new Map<string, StoredTokens>();
  saves = 0;

  load(slopUrl: string): Promise<StoredTokens | undefined> {
    return Promise.resolve(this.entries.get(slopUrl));
  }

  save(slopUrl: string, tokens: StoredTokens): Promise<void> {
    this.saves += 1;
    this.entries.set(slopUrl, tokens);
    return Promise.resolve();
  }

  delete(slopUrl: string): Promise<void> {
    this.entries.delete(slopUrl);
    return Promise.resolve();
  }
}

export const SLOP_URL = 'https://slop.test';
export const TOKEN_ENDPOINT = 'https://auth.test/oauth2/token';
export const AUTHORIZE_ENDPOINT = 'https://auth.test/oauth2/authorize';

export interface TokenRequestRecord {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * A fake fetch serving slop's OAuth metadata and a token endpoint; `tokenReply` decides each
 * token response. Every token request is recorded.
 */
export function fakeAuthFetch(tokenReply: (fields: Record<string, string>) => Response): {
  readonly fetch: Fetch;
  readonly tokenRequests: TokenRequestRecord[];
} {
  const tokenRequests: TokenRequestRecord[] = [];
  const fetch: Fetch = (input, init) => {
    if (input === `${SLOP_URL}/.well-known/oauth-authorization-server`) {
      return Promise.resolve(
        Response.json({
          authorization_endpoint: AUTHORIZE_ENDPOINT,
          token_endpoint: TOKEN_ENDPOINT,
        }),
      );
    }
    if (input === TOKEN_ENDPOINT && typeof init?.body === 'string') {
      const fields = Object.fromEntries(new URLSearchParams(init.body));
      tokenRequests.push({ url: input, fields });
      return Promise.resolve(tokenReply(fields));
    }
    return Promise.reject(new Error(`unexpected request to ${input}`));
  };
  return { fetch, tokenRequests };
}

export interface StubServer {
  readonly url: string;
  close(): Promise<void>;
}

/** An HTTP server on 127.0.0.1 with a random port, answering through `handler`. */
export async function startStubServer(
  handler: (request: IncomingMessage, body: string, response: ServerResponse) => void,
): Promise<StubServer> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      handler(request, Buffer.concat(chunks).toString('utf8'), response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function freePort(): Promise<number> {
  const stub = await startStubServer((_request, _body, response) => response.end());
  const port = Number(new URL(stub.url).port);
  await stub.close();
  return port;
}
