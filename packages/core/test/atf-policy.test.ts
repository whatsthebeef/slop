import { describe, expect, it } from 'vitest';
import { ATF_PUSH_OFF, atfPushRefusal, roleAccount, samePushTarget } from '../src/domain/atf-policy.js';
import type { AtfIntegration } from '../src/domain/types.js';

const atf: AtfIntegration = { provider: 'codebuild', region: 'us-east-1', project: 'atf-smoke', mode: 'push' };
const ROLE = 'arn:aws:iam::123456789012:role/slop-atf';

describe('roleAccount', () => {
  it('reads the account ID from a role ARN', () => {
    expect(roleAccount(ROLE)).toBe('123456789012');
  });
  it('is null for anything that is not an IAM role ARN with a 12-digit account', () => {
    expect(roleAccount('arn:aws:iam::123:role/x')).toBeNull();
    expect(roleAccount('arn:aws:iam::123456789012:user/x')).toBeNull();
    expect(roleAccount('nope')).toBeNull();
  });
});

describe('atfPushRefusal', () => {
  it('refuses everything without a project allow-list', () => {
    expect(atfPushRefusal(atf, ATF_PUSH_OFF)).toMatch(/push mode is off/);
  });
  it('matches projects exactly, or by a trailing * prefix', () => {
    expect(atfPushRefusal(atf, { projects: ['atf-smoke'], roleAccounts: [] })).toBeNull();
    expect(atfPushRefusal(atf, { projects: ['atf-*'], roleAccounts: [] })).toBeNull();
    expect(atfPushRefusal(atf, { projects: ['atf-smoke-2'], roleAccounts: [] })).toMatch(/not on the server's push allow-list/);
    expect(atfPushRefusal(atf, { projects: ['other-*'], roleAccounts: [] })).not.toBeNull();
  });
  it('does not treat a * inside a name as a wildcard', () => {
    expect(atfPushRefusal({ ...atf, project: 'a-b' }, { projects: ['a*b'], roleAccounts: [] })).not.toBeNull();
  });
  it('allows a role only in a listed account', () => {
    const projects = ['atf-smoke'];
    expect(atfPushRefusal({ ...atf, roleArn: ROLE }, { projects, roleAccounts: ['123456789012'] })).toBeNull();
    expect(atfPushRefusal({ ...atf, roleArn: ROLE }, { projects, roleAccounts: ['999999999999'] })).toMatch(/Role/);
    expect(atfPushRefusal({ ...atf, roleArn: ROLE }, { projects, roleAccounts: [] })).toMatch(/Role/);
  });
  it('refuses a role that is not a parseable role ARN', () => {
    expect(atfPushRefusal({ ...atf, roleArn: 'garbage' }, { projects: ['atf-smoke'], roleAccounts: ['123456789012'] })).toMatch(/Role/);
  });
});

describe('samePushTarget', () => {
  it('is true for the same region, project and role in push mode', () => {
    expect(samePushTarget(atf, { ...atf })).toBe(true);
  });
  it('is false when any part differs, or either side is pull or missing', () => {
    expect(samePushTarget(atf, { ...atf, project: 'x' })).toBe(false);
    expect(samePushTarget(atf, { ...atf, region: 'eu-west-1' })).toBe(false);
    expect(samePushTarget(atf, { ...atf, roleArn: ROLE })).toBe(false);
    expect(samePushTarget(atf, { ...atf, mode: 'pull' })).toBe(false);
    expect(samePushTarget(atf, null)).toBe(false);
    expect(samePushTarget(undefined, atf)).toBe(false);
  });
});
