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
});
