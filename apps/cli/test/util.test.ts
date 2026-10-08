import { describe, expect, it } from 'vitest';
import { describeError } from '../src/util.js';

function fetchFailure(cause: Error): Error {
  return new TypeError('fetch failed', { cause });
}

describe('describeError', () => {
  it('reports the cause code and message of a fetch failure', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND cognito.test'), {
      code: 'ENOTFOUND',
    });
    const text = describeError(fetchFailure(cause));
    expect(text).toContain('fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND cognito.test)');
    expect(text).toContain('inside a sandbox?');
  });

  it('hints at the sandbox for certificate errors', () => {
    const cause = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    expect(describeError(fetchFailure(cause))).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('shows a cause with only a code, and no hint for other causes', () => {
    const empty = Object.assign(new Error(''), { code: 'EPIPE' });
    expect(describeError(fetchFailure(empty))).toBe('fetch failed (EPIPE)');
  });

  it('never echoes request secrets that are not on the cause', () => {
    const error = fetchFailure(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
    Object.assign(error, { body: 'refresh_token=SECRET' });
    expect(describeError(error)).not.toContain('SECRET');
  });

  it('falls back to the message or string', () => {
    expect(describeError(new Error('plain'))).toBe('plain');
    expect(describeError('text')).toBe('text');
  });
});
