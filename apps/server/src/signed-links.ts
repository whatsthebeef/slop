import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed links, like presigned S3 URLs: a member asks for a link through the
 * authenticated MCP, and the link alone grants that one download until it expires.
 */
export class SignedLinks {
  private readonly secret: Buffer;

  constructor(secret: string | undefined) {
    // Without a configured secret, links only survive until the server restarts.
    this.secret = secret !== undefined && secret !== '' ? Buffer.from(secret) : randomBytes(32);
  }

  sign(path: string, ttlSeconds: number): { expires: number; signature: string } {
    return this.signUntil(path, Math.floor(Date.now() / 1000) + ttlSeconds);
  }

  /** Signs `path` until a fixed time (Unix seconds), so signing again gives the same link. */
  signUntil(path: string, expires: number): { expires: number; signature: string } {
    return { expires, signature: this.mac(path, expires) };
  }

  verify(path: string, expires: number, signature: string): boolean {
    if (!Number.isInteger(expires) || expires < Date.now() / 1000) return false;
    const expected = Buffer.from(this.mac(path, expires));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private mac(path: string, expires: number): string {
    return createHmac('sha256', this.secret).update(`${path}\n${String(expires)}`).digest('base64url');
  }
}
