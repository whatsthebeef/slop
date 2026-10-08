import { describe as group, expect, it } from 'vitest';
import type { IntegrationId, IntegrationReport, ReportedDeploy } from '@slop/core';
import { describe, LocalFollowWatch, type FollowStatus } from '../src/local-follow.js';

const SHA = 'a'.repeat(40);
const AT = '2026-10-08T15:00:00Z';
const NOW = Date.parse(AT) + 60_000;
const status = (fields: Partial<FollowStatus>): FollowStatus => ({ state: 'following', at: AT, sha: SHA, repo: 'o/slop', ...fields });

const watch = (file: string | null) => {
  const reports: [IntegrationId, IntegrationReport][] = [];
  const deploys: ReportedDeploy[] = [];
  const errors: string[] = [];
  const follow = new LocalFollowWatch(
    'follow.json',
    'local',
    { report: (id, report) => reports.push([id, report]) },
    (deploy) => {
      deploys.push(deploy);
      return Promise.resolve([15]);
    },
    (_, message) => errors.push(message),
    () => NOW,
    () => (file === null ? Promise.reject(new Error('ENOENT')) : Promise.resolve(file)),
  );
  return { follow, reports, deploys, errors };
};

group('describe', () => {
  it('shows an update for a few minutes, with its first subject, migrations and snapshot', () => {
    const update = status({ state: 'updated', subjects: 's15t19: Allow a swap;s15b14: Show the error', migrations: '0021_x', snapshot: '/s/2026-main.dump' });
    expect(describe(update, NOW)).toEqual({
      state: 'degraded',
      reason: 'Local slop updated to aaaaaaa (s15t19: Allow a swap); ran migration 0021_x (snapshot 2026-main.dump)',
      fix: 'Nothing to do: this note clears by itself',
    });
    expect(describe(update, NOW + 20 * 60_000)).toEqual({ state: 'ok' });
  });

  it('shows a hold until it clears, saying how far behind main it is', () => {
    const held = status({ state: 'held', behind: '3', reason: 'the database has run a migration main doesn\'t have', fix: 'restore' });
    expect(describe(held, NOW + 60 * 60_000)).toEqual({
      state: 'down',
      reason: "Local slop is 3 commits behind main (at aaaaaaa): the database has run a migration main doesn't have",
      fix: 'restore',
    });
  });
});

group('LocalFollowWatch', () => {
  it('records the commit it runs as one local deploy, however often it checks', async () => {
    const { follow, deploys, reports } = watch(JSON.stringify(status({ state: 'updated' })));
    await follow.check();
    await follow.check();
    expect(deploys).toEqual([
      { repo: 'o/slop', environment: 'local', sha: SHA, ref: null, succeeded: true, url: null, at: AT, eventId: `local:${SHA}` },
    ]);
    expect(reports[0]?.[0]).toBe('local');
  });

  it('records nothing while held', async () => {
    const { follow, deploys, reports } = watch(JSON.stringify(status({ state: 'held', reason: 'dirty' })));
    await follow.check();
    expect(deploys).toEqual([]);
    expect(reports[0]?.[1].state).toBe('down');
  });

  it('ignores a missing file and logs one that is not a status', async () => {
    const missing = watch(null);
    await missing.follow.check();
    expect(missing.reports).toEqual([]);
    const junk = watch(JSON.stringify({ state: 'updated', sha: 'nope' }));
    await junk.follow.check();
    await junk.follow.check();
    expect(junk.reports).toEqual([]);
    expect(junk.errors).toEqual(['follow.json is not a follow status']);
  });
});
