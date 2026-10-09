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
