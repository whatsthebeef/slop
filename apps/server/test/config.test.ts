import { describe, expect, it } from 'vitest';
import { JOBS, loadConfig } from '../src/config.js';

describe('SLOP_JOBS', () => {
  it('starts every job by default', () => {
    expect([...loadConfig({}).SLOP_JOBS]).toEqual([...JOBS]);
    expect([...loadConfig({ SLOP_JOBS: 'all' }).SLOP_JOBS]).toEqual([...JOBS]);
  });

  it('starts none, or only the listed ones', () => {
    expect(loadConfig({ SLOP_JOBS: 'none' }).SLOP_JOBS.size).toBe(0);
    expect([...loadConfig({ SLOP_JOBS: 'kb, outbox' }).SLOP_JOBS]).toEqual(['kb', 'outbox']);
  });

  it('refuses an unknown job rather than starting everything', () => {
    expect(() => loadConfig({ SLOP_JOBS: 'kb,mail' })).toThrow(/unknown job mail/);
  });
});
