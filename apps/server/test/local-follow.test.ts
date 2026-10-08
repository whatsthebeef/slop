import { describe as group, expect, it } from 'vitest';
import type { RaisedNotification, ReportedDeploy } from '@slop/core';
import { describe, LOCAL_FOLLOW_SOURCE, LocalFollowWatch, type FollowStatus } from '../src/local-follow.js';

const SHA = 'a'.repeat(40);
const AT = '2026-10-08T15:00:00Z';
const NOW = Date.parse(AT) + 60_000;
const status = (fields: Partial<FollowStatus>): FollowStatus => ({ state: 'following', at: AT, sha: SHA, repo: 'o/slop', ...fields });

const watch = (file: string | null, now = NOW) => {
  const raised: RaisedNotification[] = [];
  const cleared: [number | null, string][] = [];
  const deploys: ReportedDeploy[] = [];
  const errors: string[] = [];
  const follow = new LocalFollowWatch(
    'follow.json',
    'local',
    {
      raise: (n) => {
        raised.push(n);
        return Promise.resolve();
      },
      clear: (boardId, source) => {
        cleared.push([boardId, source]);
        return Promise.resolve();
      },
    },
    (deploy) => {
      deploys.push(deploy);
      return Promise.resolve([15]);
    },
    (_, message) => errors.push(message),
    () => now,
    () => (file === null ? Promise.reject(new Error('ENOENT')) : Promise.resolve(file)),
  );
  return { follow, raised, cleared, deploys, errors };
};

group('describe', () => {
  it('raises an info update for ten minutes, with its first subject, migrations and snapshot', () => {
    const update = status({ state: 'updated', subjects: 's15t19: Allow a swap;s15b14: Show the error', migrations: '0021_x', snapshot: '/s/2026-main.dump' });
    expect(describe(update, NOW)).toEqual({
      boardId: null,
      source: LOCAL_FOLLOW_SOURCE,
      severity: 'info',
      title: 'Local slop updated to aaaaaaa (s15t19: Allow a swap); ran migration 0021_x (snapshot 2026-main.dump)',
      detail: 'Nothing to do: this note clears by itself.',
      clears: { kind: 'until', at: '2026-10-08T15:10:00.000Z' },
    });
    expect(describe(update, Date.parse(AT) + 11 * 60_000)).toBeNull();
  });

  it('raises a warning for a hold, saying how far behind main it is and the fix', () => {
    const held = status({ state: 'held', behind: '3', reason: "the database has run a migration main doesn't have", fix: 'restore' });
    expect(describe(held, NOW + 60 * 60_000)).toEqual({
      boardId: null,
      source: LOCAL_FOLLOW_SOURCE,
      severity: 'warning',
      title: 'Local slop is 3 commits behind main (at aaaaaaa)',
      detail: "the database has run a migration main doesn't have. restore",
      clears: { kind: 'condition' },
    });
  });

  it('raises nothing while following', () => {
    expect(describe(status({}), NOW)).toBeNull();
  });
});

group('LocalFollowWatch', () => {
  it('records the commit it runs as one local deploy, however often it checks', async () => {
    const { follow, deploys, raised } = watch(JSON.stringify(status({ state: 'updated' })));
    await follow.check();
    await follow.check();
    expect(deploys).toEqual([
      { repo: 'o/slop', environment: 'local', sha: SHA, ref: null, succeeded: true, url: null, at: AT, eventId: `local:${SHA}` },
    ]);
    expect(raised.map((n) => n.severity)).toEqual(['info', 'info']);
  });

  it('expires the info update and clears it once the ten minutes pass', async () => {
    const late = watch(JSON.stringify(status({ state: 'updated' })), Date.parse(AT) + 11 * 60_000);
    await late.follow.check();
    expect(late.raised).toEqual([]);
    expect(late.cleared).toEqual([[null, LOCAL_FOLLOW_SOURCE]]);
  });

  it('warns while held, records nothing, and clears when follow carries on', async () => {
    const held = watch(JSON.stringify(status({ state: 'held', reason: 'dirty' })));
    await held.follow.check();
    expect(held.deploys).toEqual([]);
    expect(held.raised[0]?.severity).toBe('warning');
    const following = watch(JSON.stringify(status({ state: 'following' })));
    await following.follow.check();
    expect(following.raised).toEqual([]);
    expect(following.cleared).toEqual([[null, LOCAL_FOLLOW_SOURCE]]);
    expect(following.deploys).toHaveLength(1);
  });

  it('ignores a missing file and logs one that is not a status', async () => {
    const missing = watch(null);
    await missing.follow.check();
    expect(missing.raised).toEqual([]);
    const junk = watch(JSON.stringify({ state: 'updated', sha: 'nope' }));
    await junk.follow.check();
    await junk.follow.check();
    expect(junk.raised).toEqual([]);
    expect(junk.errors).toEqual(['follow.json is not a follow status']);
  });
});
