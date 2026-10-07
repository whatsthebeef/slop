import { describe, expect, it } from 'vitest';
import { isLocalUrl, readSsoProfile } from '../src/aws-sso.js';

const CONFIG = `
# comment
[default]
region = us-east-1

[profile dev]
sso_session = work
sso_account_id = 123456789012
sso_role_name = Dev

[profile legacy]
sso_start_url = https://legacy.awsapps.com/start
sso_region = us-east-1

[profile broken]
sso_session = missing

[sso-session work]
sso_start_url = https://work.awsapps.com/start
sso_region = eu-west-1
sso_registration_scopes = sso:account:access, other
`;

describe('readSsoProfile', () => {
  it("reads the profile's sso-session start URL, region and scopes", () => {
    expect(readSsoProfile({ AWS_PROFILE: 'dev' }, CONFIG)).toEqual({
      ok: true,
      value: {
        session: 'work',
        startUrl: 'https://work.awsapps.com/start',
        region: 'eu-west-1',
        scopes: ['sso:account:access', 'other'],
      },
    });
  });

  it('defaults to the account-access scope when the session lists none', () => {
    const config = CONFIG.replace('sso_registration_scopes = sso:account:access, other\n', '');
    expect(readSsoProfile({ AWS_PROFILE: 'dev' }, config)).toMatchObject({
      ok: true,
      value: { scopes: ['sso:account:access'] },
    });
  });

  it('is unavailable without a profile, an sso_session, or a usable session section', () => {
    expect(readSsoProfile({}, CONFIG).ok).toBe(false);
    expect(readSsoProfile({ AWS_PROFILE: '' }, CONFIG).ok).toBe(false);
    expect(readSsoProfile({ AWS_PROFILE: 'default' }, CONFIG).ok).toBe(false);
    expect(readSsoProfile({ AWS_PROFILE: 'legacy' }, CONFIG).ok).toBe(false);
    expect(readSsoProfile({ AWS_PROFILE: 'broken' }, CONFIG).ok).toBe(false);
    expect(readSsoProfile({ AWS_PROFILE: 'nope' }, CONFIG).ok).toBe(false);
    expect(readSsoProfile({ AWS_PROFILE: 'dev' }, '').ok).toBe(false);
  });

  it('refuses a session name that is not a plain name, and a non-https start URL', () => {
    const odd =
      '[profile p]\nsso_session = ../x\n[sso-session ../x]\nsso_start_url = https://a\nsso_region = r\n';
    expect(readSsoProfile({ AWS_PROFILE: 'p' }, odd).ok).toBe(false);
    const http =
      '[profile p]\nsso_session = s\n[sso-session s]\nsso_start_url = http://a\nsso_region = r\n';
    expect(readSsoProfile({ AWS_PROFILE: 'p' }, http).ok).toBe(false);
  });
});

describe('isLocalUrl', () => {
  it('is true only for this machine', () => {
    expect(isLocalUrl('http://localhost:3000')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLocalUrl('https://slop.example.com')).toBe(false);
    expect(isLocalUrl('https://localhost.evil.com')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });
});
