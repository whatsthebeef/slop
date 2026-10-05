import { describe, expect, it } from 'vitest';
import { createPkce, pkceChallenge } from '../src/auth.js';

describe('PKCE', () => {
  it('derives the S256 challenge from the verifier (RFC 7636 appendix B)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a fresh unreserved-character verifier of valid length with its challenge', () => {
    const first = createPkce();
    const second = createPkce();
    expect(first.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(first.challenge).toBe(pkceChallenge(first.verifier));
    expect(first.challenge).not.toMatch(/[=+/]/);
    expect(second.verifier).not.toBe(first.verifier);
  });
});
