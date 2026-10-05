import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSignInState, issueSignInState } from '../src/http/sign-in-state.js';
import { SignedLinks } from '../src/signed-links.js';

describe('board sign-in state', () => {
  const links = new SignedLinks('test-secret');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts its own state with the matching nonce cookie', () => {
    const { state, nonce } = issueSignInState(links);
    expect(checkSignInState(links, state, nonce, true)).toEqual({ ok: true });
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
    expect(checkSignInState(links, state, undefined, false)).toEqual({ ok: true });
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
    for (const state of [undefined, '', 'abc', 'a.b', '.1.sig', 'a.b.c.d']) {
      expect(checkSignInState(links, state, undefined, false)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});
