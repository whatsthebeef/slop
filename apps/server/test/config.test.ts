import { describe, expect, it } from 'vitest';
import { JOBS, loadConfig } from '../src/config.js';

describe('SLOP_JOBS', () => {
  it('starts every job by default', () => {
    expect([...loadConfig({}).SLOP_JOBS]).toEqual([...JOBS]);
    expect([...loadConfig({ SLOP_JOBS: 'all' }).SLOP_JOBS]).toEqual([...JOBS]);
  });

  it('has the inbox job, started by default', () => {
    expect(JOBS).toContain('inbox');
    expect(loadConfig({}).SLOP_JOBS.has('inbox')).toBe(true);
    expect(loadConfig({ SLOP_JOBS: 'inbox' }).SLOP_JOBS.has('inbox')).toBe(true);
  });

  it('starts none, or only the listed ones', () => {
    expect(loadConfig({ SLOP_JOBS: 'none' }).SLOP_JOBS.size).toBe(0);
    expect([...loadConfig({ SLOP_JOBS: 'kb, outbox' }).SLOP_JOBS]).toEqual(['kb', 'outbox']);
  });

  it('refuses an unknown job rather than starting everything', () => {
    expect(() => loadConfig({ SLOP_JOBS: 'kb,mail' })).toThrow(/unknown job mail/);
    expect(() => loadConfig({ SLOP_JOBS: ' ' })).toThrow(/SLOP_JOBS is empty/);
  });
});

describe('SLACK_WORKSPACES', () => {
  it('maps workspaces to boards and is empty by default', () => {
    expect(loadConfig({}).SLACK_WORKSPACES.size).toBe(0);
    const map = loadConfig({ SLACK_WORKSPACES: 'T1=15, T2=16' }).SLACK_WORKSPACES;
    expect([...map]).toEqual([['T1', 15], ['T2', 16]]);
  });
  it('refuses a pair that is not <workspace>=<board>', () => {
    expect(() => loadConfig({ SLACK_WORKSPACES: 'T1' })).toThrow('SLACK_WORKSPACES');
    expect(() => loadConfig({ SLACK_WORKSPACES: 'T1=x' })).toThrow('SLACK_WORKSPACES');
  });
});

describe('SLOP_WORK_TIME_ZONE', () => {
  it('defaults to UTC and accepts an IANA zone', () => {
    expect(loadConfig({}).SLOP_WORK_TIME_ZONE).toBe('UTC');
    expect(loadConfig({ SLOP_WORK_TIME_ZONE: 'Europe/London' }).SLOP_WORK_TIME_ZONE).toBe('Europe/London');
  });
  it('refuses an unknown zone', () => {
    expect(() => loadConfig({ SLOP_WORK_TIME_ZONE: 'Mars/Base' })).toThrow('SLOP_WORK_TIME_ZONE');
  });
});

describe('PUBLIC_URL_ALIASES', () => {
  it('defaults to none and parses a comma-separated list', () => {
    expect(loadConfig({}).PUBLIC_URL_ALIASES).toEqual([]);
    expect(loadConfig({ PUBLIC_URL_ALIASES: 'https://a.cloudfront.net/, https://b.example.com' }).PUBLIC_URL_ALIASES).toEqual([
      'https://a.cloudfront.net',
      'https://b.example.com',
    ]);
  });
  it('refuses anything that is not an https origin', () => {
    expect(() => loadConfig({ PUBLIC_URL_ALIASES: 'http://a.example.com' })).toThrow('PUBLIC_URL_ALIASES');
    expect(() => loadConfig({ PUBLIC_URL_ALIASES: 'https://a.example.com/path' })).toThrow('PUBLIC_URL_ALIASES');
    expect(() => loadConfig({ PUBLIC_URL_ALIASES: 'nope' })).toThrow('PUBLIC_URL_ALIASES');
  });
});

describe('AUTH_MODE', () => {
  it('allows dev sign-in on a local PUBLIC_URL', () => {
    expect(loadConfig({}).AUTH_MODE).toBe('dev');
    expect(loadConfig({ AUTH_MODE: 'dev', PUBLIC_URL: 'http://127.0.0.1:3000' }).AUTH_MODE).toBe('dev');
  });
  it('refuses dev sign-in on a non-local PUBLIC_URL', () => {
    expect(() => loadConfig({ PUBLIC_URL: 'https://abc.cloudfront.net' })).toThrow(/AUTH_MODE=dev/);
    expect(() => loadConfig({ AUTH_MODE: 'dev', PUBLIC_URL: 'not a url' })).toThrow(/AUTH_MODE=dev/);
  });
  it('allows cognito on a public URL', () => {
    const env = {
      AUTH_MODE: 'cognito', PUBLIC_URL: 'https://abc.cloudfront.net', COGNITO_USER_POOL_ID: 'p',
      COGNITO_REGION: 'r', COGNITO_DOMAIN: 'd', COGNITO_CLIENT_IDS: 'c',
    };
    expect(loadConfig(env).AUTH_MODE).toBe('cognito');
  });

  it('defaults the independent reviewer to Sonnet 5.5, which the spend table prices', () => {
    expect(loadConfig({}).REVIEW_MODEL).toBe('global.anthropic.claude-sonnet-5-5');
    expect(loadConfig({ REVIEW_MODEL: 'amazon.nova-pro-v1:0' }).REVIEW_MODEL).toBe('amazon.nova-pro-v1:0');
  });
});

describe('ATF push allow-list and server admins', () => {
  it('is off by default: no projects, no role accounts, no admins', () => {
    const c = loadConfig({});
    expect(c.ATF_PUSH_ALLOWED_PROJECTS).toEqual([]);
    expect(c.ATF_PUSH_ALLOWED_ROLE_ACCOUNTS).toEqual([]);
    expect(c.SLOP_SERVER_ADMINS).toEqual([]);
  });
  it('parses comma-separated lists, trimming and lower-casing admin emails', () => {
    const c = loadConfig({
      ATF_PUSH_ALLOWED_PROJECTS: 'atf-*, smoke',
      ATF_PUSH_ALLOWED_ROLE_ACCOUNTS: '123456789012, 210987654321',
      SLOP_SERVER_ADMINS: 'Ann@Example.com, bob@example.com',
    });
    expect(c.ATF_PUSH_ALLOWED_PROJECTS).toEqual(['atf-*', 'smoke']);
    expect(c.ATF_PUSH_ALLOWED_ROLE_ACCOUNTS).toEqual(['123456789012', '210987654321']);
    expect(c.SLOP_SERVER_ADMINS).toEqual(['ann@example.com', 'bob@example.com']);
  });
  it('refuses a role account that is not 12 digits', () => {
    expect(() => loadConfig({ ATF_PUSH_ALLOWED_ROLE_ACCOUNTS: '1234' })).toThrow('ATF_PUSH_ALLOWED_ROLE_ACCOUNTS');
  });
});

describe('ATF OIDC and AWS identity settings', () => {
  it('are off by default and the audience is left to PUBLIC_URL', () => {
    const c = loadConfig({});
    expect(c.ATF_OIDC_ALLOWED_ISSUERS).toEqual([]);
    expect(c.ATF_AWS_ALLOWED_ISSUERS).toEqual([]);
    expect(c.ATF_AWS_ALLOWED_ACCOUNTS).toEqual([]);
    expect(c.ATF_OIDC_AUDIENCE).toBeUndefined();
  });
  it('parses issuers and accounts', () => {
    const c = loadConfig({
      ATF_OIDC_ALLOWED_ISSUERS: 'https://token.actions.githubusercontent.com, https://gitlab.com',
      ATF_OIDC_AUDIENCE: 'https://slop.example.com',
      ATF_AWS_ALLOWED_ISSUERS: 'https://abc.tokens.sts.global.api.aws',
      ATF_AWS_ALLOWED_ACCOUNTS: '123456789012',
    });
    expect(c.ATF_OIDC_ALLOWED_ISSUERS).toEqual(['https://token.actions.githubusercontent.com', 'https://gitlab.com']);
    expect(c.ATF_AWS_ALLOWED_ISSUERS).toEqual(['https://abc.tokens.sts.global.api.aws']);
    expect(c.ATF_AWS_ALLOWED_ACCOUNTS).toEqual(['123456789012']);
  });
  it('refuses issuers that are not exact https URLs, bad accounts, and an issuer on both lists', () => {
    for (const bad of ['http://idp.example.com', 'https://*.example.com', 'idp.example.com', 'https://idp.example.com/', 'https://idp.example.com?x=1']) {
      expect(() => loadConfig({ ATF_OIDC_ALLOWED_ISSUERS: bad })).toThrow('ATF_OIDC_ALLOWED_ISSUERS');
      expect(() => loadConfig({ ATF_AWS_ALLOWED_ISSUERS: bad })).toThrow('ATF_AWS_ALLOWED_ISSUERS');
    }
    expect(() => loadConfig({ ATF_AWS_ALLOWED_ACCOUNTS: '12' })).toThrow('ATF_AWS_ALLOWED_ACCOUNTS');
    expect(() =>
      loadConfig({ ATF_OIDC_ALLOWED_ISSUERS: 'https://a.example.com', ATF_AWS_ALLOWED_ISSUERS: 'https://a.example.com' }),
    ).toThrow('must not share');
  });
});
