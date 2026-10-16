import { describe, expect, it } from 'vitest';
import type { BoardEnvironment } from '@slop/core';
import { environmentHealth } from '../src/lib/environment-health';

const env = (patch: Partial<BoardEnvironment> = {}): BoardEnvironment => ({
  environment: 'prod',
  role: 'release',
  production: true,
  deployKnown: 'pipeline',
  latest: null,
  recordedBy: null,
  ...patch,
});

const deploy = { id: 1, boardId: 1, environment: 'prod', sha: 'abcdef1234', ref: 'v1.2', succeeded: true, url: null, at: '2026-10-16T12:00:00.000Z', eventId: 'e', checkedAt: null };

describe('environmentHealth (s15t239)', () => {
  it('tells a pipeline environment that never reported which line to add', () => {
    expect(environmentHealth(env())).toBe('No deploy reported yet. Add .sstor/report-deploy.sh prod to its pipeline.');
  });

  it('tells a manual environment with nothing recorded to record a release', () => {
    expect(environmentHealth(env({ deployKnown: 'manual' }))).toBe('No deploy recorded yet. Record each release here.');
  });

  it('shows the last deploy and who recorded it', () => {
    expect(environmentHealth(env({ deployKnown: 'manual', latest: deploy, recordedBy: 'dev@example.com' }))).toMatch(
      /^Last deploy abcdef1 \(v1\.2\) recorded by dev@example\.com at /,
    );
    expect(environmentHealth(env({ latest: deploy }))).toMatch(/^Last deploy abcdef1 \(v1\.2\) at /);
  });
});
