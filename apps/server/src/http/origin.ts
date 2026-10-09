import type { Context } from 'hono';

const LOCALHOST = /^http:\/\/localhost(:\d+)?$/;

/**
 * The origin a client used to reach slop, if slop may present itself under it: the public URL,
 * or localhost during development. Anything else falls back to the public URL. ngrok and other
 * proxies forward the original host and scheme (CloudFront as `CloudFront-Forwarded-Proto`).
 */
export const requestOrigin = (c: Context, publicUrl: string): string => {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? c.req.header('cloudfront-forwarded-proto') ?? url.protocol.replace(':', '');
  const origin = `${proto}://${c.req.header('host') ?? url.host}`;
  return origin === publicUrl || LOCALHOST.test(origin) ? origin : publicUrl;
};
