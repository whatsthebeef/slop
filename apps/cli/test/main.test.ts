import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, main, type CliContext } from '../src/main.js';
import { FakeGit, MemoryTokenStore, startStubServer, type StubServer } from './support.js';

describe('main', () => {
  let stub: StubServer | undefined;

  afterEach(async () => {
    await stub?.close();
    stub = undefined;
  });

  function context(settings: CliContext['settings']): {
    context: CliContext;
    out: string[];
    err: string[];
  } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      context: {
        settings,
        store: new MemoryTokenStore(),
        fetch: (input, init) => fetch(input, init),
        now: () => 0,
        canPrompt: false,
        openBrowser: () => undefined,
        log: (message) => err.push(message),
        stdout: (text) => out.push(text),
        gitRoot: () => undefined,
        isMcpServerConfigured: () => Promise.resolve(false),
        git: new FakeGit(),
        sleep: () => Promise.resolve(),
      },
    };
  }

  async function slopReturning(text: string): Promise<string> {
    stub = await startStubServer((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }),
      );
    });
    return stub.url;
  }

  it('prints help with --help and exits 0, or exits 2 with no command', async () => {
    const help = context({});
    expect(await main(['--help'], help.context)).toBe(EXIT_OK);
    expect(help.out.join('')).toContain('slop whoami');
    const none = context({});
    expect(await main([], none.context)).toBe(EXIT_USAGE);
    expect(none.err.join('')).toContain('Usage:');
  });

  it('exits 2 for an unknown command or bad arguments', async () => {
    expect(await main(['frobnicate'], context({}).context)).toBe(EXIT_USAGE);
    expect(await main(['whoami', 'extra'], context({}).context)).toBe(EXIT_USAGE);
    expect(await main(['call'], context({}).context)).toBe(EXIT_USAGE);
    const badJson = context({ SLOP_URL: 'http://127.0.0.1:1', SLOP_DEV_EMAIL: 'a@x.test' });
    expect(await main(['call', 'whoami', '[1]'], badJson.context)).toBe(EXIT_USAGE);
    expect(badJson.err.join('')).toContain('must be a JSON object');
  });

  it('prints the email for whoami', async () => {
    const url = await slopReturning('{"email":"ann@x.test","boards":[]}');
    const run = context({ SLOP_URL: url, SLOP_DEV_EMAIL: 'ann@x.test' });
    expect(await main(['whoami'], run.context)).toBe(EXIT_OK);
    expect(run.out).toEqual(['ann@x.test\n']);
  });

  it('prints the JSON result for call', async () => {
    const url = await slopReturning('{"id":"s1t4"}');
    const run = context({ SLOP_URL: url, SLOP_DEV_EMAIL: 'ann@x.test' });
    expect(await main(['call', 'get_glob', '{"id":"s1t4"}'], run.context)).toBe(EXIT_OK);
    expect(run.out).toEqual(['{"id":"s1t4"}\n']);
  });

  it('warns when SLOP_URL is plain http to another machine', async () => {
    const run = context({ SLOP_URL: 'http://slop.example.com' });
    await main(['whoami'], run.context);
    expect(run.err[0]).toContain('is not https');
  });

  it('exits 1 with the message on a slop or sign-in error', async () => {
    const missing = context({});
    expect(await main(['whoami'], missing.context)).toBe(EXIT_FAILURE);
    expect(missing.err.join('')).toContain('SLOP_URL is not set');
    const notSignedIn = context({ SLOP_URL: 'https://slop.test' });
    expect(await main(['whoami'], notSignedIn.context)).toBe(EXIT_FAILURE);
    expect(notSignedIn.err).toEqual(['slop: not signed in to slop: run `slop login`']);
  });
});
