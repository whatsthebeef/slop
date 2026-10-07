import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSignInState, issueSignInState, safeReturnPath } from '../src/http/sign-in-state.js';
import { SignedLinks } from '../src/signed-links.js';

describe('board sign-in state', () => {
  const links = new SignedLinks('test-secret');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts its own state with the matching nonce cookie', () => {
    const { state, nonce } = issueSignInState(links);
    expect(checkSignInState(links, state, nonce, true)).toEqual({ ok: true, returnTo: '/' });
  });

  it('refuses a valid state without the cookie when the cookie is required (login CSRF)', () => {
    const { state } = issueSignInState(links);
    expect(checkSignInState(links, state, undefined, true)).toEqual({
      ok: false,
      reason: 'cookie missing',
    });
  });

  it('accepts a valid state without the cookie on a localhost dev server (Chrome drops it there)', () => {
    const { state } = issueSignInState(links);
    expect(checkSignInState(links, state, undefined, false)).toEqual({ ok: true, returnTo: '/' });
  });

  it('refuses a valid state whose cookie belongs to another sign-in, even on localhost', () => {
    const { state } = issueSignInState(links);
    const other = issueSignInState(links);
    for (const required of [true, false]) {
      expect(checkSignInState(links, state, other.nonce, required)).toEqual({
        ok: false,
        reason: 'cookie differs',
      });
    }
  });

  it('refuses a state signed with another secret', () => {
    const { state, nonce } = issueSignInState(new SignedLinks('other-secret'));
    expect(checkSignInState(links, state, nonce, true)).toEqual({
      ok: false,
      reason: 'invalid or expired',
    });
  });

  it('refuses a tampered nonce', () => {
    const { state } = issueSignInState(links);
    const [, expires, signature] = state.split('.');
    expect(
      checkSignInState(links, `forged.${expires ?? ''}.${signature ?? ''}`, 'forged', true),
    ).toEqual({
      ok: false,
      reason: 'invalid or expired',
    });
  });

  it('refuses an expired state', () => {
    vi.useFakeTimers();
    const { state, nonce } = issueSignInState(links);
    vi.advanceTimersByTime(601_000);
    expect(checkSignInState(links, state, nonce, true)).toEqual({
      ok: false,
      reason: 'invalid or expired',
    });
  });

  it('refuses missing or malformed states', () => {
    for (const state of [undefined, '', 'abc', 'a.b', '.1.sig', 'a.b.c.d.e']) {
      expect(checkSignInState(links, state, undefined, false)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  describe('return path', () => {
    const good = '/boards/3?glob=s3t4';

    it('comes back from the callback check when it was signed into the state', () => {
      const { state, nonce } = issueSignInState(links, good);
      expect(checkSignInState(links, state, nonce, true)).toEqual({ ok: true, returnTo: good });
    });

    it('is / when none was given', () => {
      const { state, nonce } = issueSignInState(links);
      expect(checkSignInState(links, state, nonce, true)).toEqual({ ok: true, returnTo: '/' });
    });

    it.each(['//evil.com', 'https://evil.com', '/\\evil.com', 'evil.com', '/a\nb'])(
      'turns %j into /',
      (bad) => {
        const { state, nonce } = issueSignInState(links, bad);
        expect(safeReturnPath(bad)).toBe('/');
        expect(checkSignInState(links, state, nonce, true)).toEqual({ ok: true, returnTo: '/' });
      },
    );

    it('refuses a state whose return path was swapped after signing', () => {
      const { state, nonce } = issueSignInState(links, good);
      const [n, expires, signature] = state.split('.');
      const forged = `${n ?? ''}.${expires ?? ''}.${signature ?? ''}.${Buffer.from('/boards/9').toString('base64url')}`;
      expect(checkSignInState(links, forged, nonce, true)).toEqual({
        ok: false,
        reason: 'invalid or expired',
      });
    });

    it('still needs the nonce cookie', () => {
      const { state } = issueSignInState(links, good);
      expect(checkSignInState(links, state, undefined, true)).toEqual({
        ok: false,
        reason: 'cookie missing',
      });
    });
  });
});
