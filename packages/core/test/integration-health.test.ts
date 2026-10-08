import { describe, expect, it } from 'vitest';
import { awsSignInApplies, classifyGitHubFailure, classifyRoutineFailure, needingAttention } from '../src/index.js';
import type { IntegrationStatus } from '../src/index.js';

const status = (over: Partial<IntegrationStatus>): IntegrationStatus => ({
  id: 'bedrock',
  name: 'AI features',
  state: 'down',
  reason: 'AWS sign-in expired',
  fix: 'x',
  since: '2026-10-07T10:00:00.000Z',
  ...over,
});

describe('integration health rules', () => {
  it('lists only what needs a person, down first, then oldest', () => {
    const list = needingAttention([
      status({ id: 'github', state: 'degraded', since: '2026-10-07T08:00:00.000Z' }),
      status({ id: 'tunnel', state: 'ok' }),
      status({ id: 'routines', since: '2026-10-07T09:00:00.000Z' }),
      status({ id: 'bedrock' }),
    ]);
    expect(list.map((s) => s.id)).toEqual(['routines', 'bedrock', 'github']);
  });

  it('offers AWS sign-in only for a lapsed sign-in on a server with an SSO profile', () => {
    expect(awsSignInApplies(status({}), true)).toBe(true);
    expect(awsSignInApplies(status({}), false)).toBe(false);
    expect(awsSignInApplies(status({ reason: 'No access to the Bedrock model x' }), true)).toBe(false);
    expect(awsSignInApplies(status({ state: 'ok', reason: null }), true)).toBe(false);
    expect(awsSignInApplies(status({ id: 'github' }), true)).toBe(false);
  });

  it('reads GitHub 401 as down, a non-rate-limit 403 as degraded, and ignores the rest', () => {
    expect(classifyGitHubFailure(401)?.state).toBe('down');
    expect(classifyGitHubFailure(403, 'Resource not accessible by integration')?.state).toBe('degraded');
    expect(classifyGitHubFailure(403, 'API rate limit exceeded')).toBeNull();
    expect(classifyGitHubFailure(404)).toBeNull();
    expect(classifyGitHubFailure(500)).toBeNull();
    expect(classifyGitHubFailure(null)).toBeNull();
  });

  it('reads a rejected routine token as down, and throttling or server errors as nothing', () => {
    for (const code of [401, 403, 404]) expect(classifyRoutineFailure(code)?.state).toBe('down');
    for (const code of [400, 429, 500, null]) expect(classifyRoutineFailure(code)).toBeNull();
  });
});
