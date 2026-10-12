import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { requestOrigin } from '../src/http/origin.js';

const originFor = async (headers: Record<string, string>, aliases: string[] = []): Promise<string> => {
  const app = new Hono();
  app.get('/', (c) => c.text(requestOrigin(c, 'https://d1.cloudfront.net', aliases)));
  return (await app.request('http://d1.cloudfront.net/', { headers })).text();
};

describe('requestOrigin', () => {
  it('takes the scheme from X-Forwarded-Proto', async () => {
    expect(await originFor({ host: 'd1.cloudfront.net', 'x-forwarded-proto': 'https' })).toBe('https://d1.cloudfront.net');
  });

  it("takes CloudFront's scheme from CloudFront-Forwarded-Proto", async () => {
    expect(await originFor({ host: 'd1.cloudfront.net', 'cloudfront-forwarded-proto': 'https' })).toBe('https://d1.cloudfront.net');
  });

  it('falls back to the public URL for a host it does not own', async () => {
    expect(await originFor({ host: 'evil.example', 'cloudfront-forwarded-proto': 'https' })).toBe('https://d1.cloudfront.net');
  });

  it('serves an alias as itself', async () => {
    const headers = { host: 'slopmux.example.com', 'cloudfront-forwarded-proto': 'https' };
    expect(await originFor(headers, ['https://slopmux.example.com'])).toBe('https://slopmux.example.com');
  });

  it('still serves the public URL when aliases are set', async () => {
    expect(await originFor({ host: 'd1.cloudfront.net', 'x-forwarded-proto': 'https' }, ['https://slopmux.example.com'])).toBe(
      'https://d1.cloudfront.net',
    );
  });

  it('falls back to the public URL for a host that is not an alias', async () => {
    expect(await originFor({ host: 'evil.example', 'x-forwarded-proto': 'https' }, ['https://slopmux.example.com'])).toBe(
      'https://d1.cloudfront.net',
    );
  });

  it('serves localhost as itself', async () => {
    expect(await originFor({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }, ['https://slopmux.example.com'])).toBe(
      'http://localhost:3000',
    );
  });
});
