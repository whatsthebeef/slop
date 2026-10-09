import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestError, request } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('request', () => {
  it('rejects an OK answer that is not JSON', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(request('GET', '/api/boards/15/chat')).rejects.toBeInstanceOf(RequestError);
  });

  it('returns JSON, and carries a JSON error body', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ a: 1 })));
    expect(await request('GET', '/api/x')).toEqual({ a: 1 });
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ code: 'not_found', message: 'no' }, { status: 404 })));
    await expect(request('GET', '/api/x')).rejects.toMatchObject({ status: 404, body: { code: 'not_found' } });
  });
});
