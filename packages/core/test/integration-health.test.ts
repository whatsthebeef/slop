import { describe, expect, it } from 'vitest';
import { anyDown, classifyHttpAuthFailure, signInOffered, worst } from '../src/index.js';

describe('integration health rules', () => {
  it('orders down before degraded before ok', () => {
    expect(worst([])).toBe('ok');
    expect(worst([{ state: 'ok' }, { state: 'degraded' }])).toBe('degraded');
    expect(worst([{ state: 'degraded' }, { state: 'down' }, { state: 'ok' }])).toBe('down');
    expect(anyDown([{ state: 'degraded' }])).toBe(false);
    expect(anyDown([{ state: 'ok' }, { state: 'down' }])).toBe(true);
  });

  it('treats a rejected routine credential as an auth failure, but not rate limits or outages', () => {
    expect(classifyHttpAuthFailure(401, 'routine')?.reason).toBe('Routine credential rejected');
    expect(classifyHttpAuthFailure(403, 'routine')?.fix).toContain('.routines.json');
    for (const status of [404, 429, 500, 503])
      expect(classifyHttpAuthFailure(status, 'routine')).toBeNull();
    expect(classifyHttpAuthFailure(null, 'routine')).toBeNull();
  });

  it('treats GitHub 401 and credential-shaped 403s as auth failures, but not permission or rate-limit 403s', () => {
    expect(classifyHttpAuthFailure(401, 'github')?.fix).toContain('/setup/github-app');
    expect(classifyHttpAuthFailure(403, 'github', 'Bad credentials')).not.toBeNull();
    expect(
      classifyHttpAuthFailure(
        403,
        'github',
        "'Expiration time' claim ('exp') must be a numeric value",
      ),
    ).not.toBeNull();
    expect(
      classifyHttpAuthFailure(403, 'github', 'Resource not accessible by integration'),
    ).toBeNull();
    for (const status of [404, 422, 429, 502])
      expect(classifyHttpAuthFailure(status, 'github', 'Bad credentials')).toBeNull();
  });

  it('offers AWS sign-in only for an expired SSO sign-in the server can redo', () => {
    expect(signInOffered({ state: 'down', code: 'sso_expired', ssoAvailable: true })).toBe(true);
    expect(signInOffered({ state: 'down', code: 'sso_expired', ssoAvailable: false })).toBe(false);
    expect(signInOffered({ state: 'down', code: undefined, ssoAvailable: true })).toBe(false);
    expect(signInOffered({ state: 'ok', code: 'sso_expired', ssoAvailable: true })).toBe(false);
  });
});
