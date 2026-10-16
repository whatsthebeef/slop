import { describe, expect, it } from 'vitest';
import type { Deploy } from '../src/domain/deploys.js';
import { pickEnvironment } from '../src/domain/environment-pick.js';
import type { Environment } from '../src/domain/types.js';
import { glob } from './fixtures.js';

const envs: Environment[] = [
  { name: 'dev', allowBranchDeploy: true },
  { name: 'danzig', allowBranchDeploy: true },
  { name: 'demo', allowBranchDeploy: true },
  { name: 'prod', allowBranchDeploy: false },
];

const deploy = (globId: string, environment: string, requestedAt: string): Deploy => ({
  id: `${globId}-${environment}`,
  boardId: 1,
  environment,
  globId,
  sha: 'a',
  state: 'succeeded',
  trigger: 'push',
  requestedBy: null,
  requestedAt,
  runningSince: null,
  startedAt: null,
  finishedAt: null,
  providerRef: null,
  url: null,
  error: null,
});

describe('pickEnvironment', () => {
  it('gives three new globs one environment each, never one that takes no branch deploys', () => {
    const open = [];
    const got: string[] = [];
    for (const id of ['s1t1', 's1t2', 's1t3']) {
      const pick = pickEnvironment(envs, open, []);
      got.push(pick?.environment ?? '');
      open.push(glob({ id, status: 'implementing', environment: pick?.environment ?? null }));
    }
    expect(got).toEqual(['dev', 'danzig', 'demo']);
  });

  it('shares the one whose holder is furthest along when all are busy', () => {
    const open = [
      glob({ id: 's1t1', status: 'implementing', environment: 'dev' }),
      glob({ id: 's1t2', status: 'reviewing', environment: 'danzig' }),
      glob({ id: 's1t3', status: 'implementing', environment: 'demo' }),
    ];
    const pick = pickEnvironment(envs, open, []);
    expect(pick).toEqual({ environment: 'danzig', reason: 'danzig: shared with s1t2 (all busy)' });
  });

  it('breaks a tie by the least recently deployed', () => {
    const open = [
      glob({ id: 's1t1', status: 'implementing', environment: 'dev' }),
      glob({ id: 's1t2', status: 'implementing', environment: 'danzig' }),
      glob({ id: 's1t3', status: 'implementing', environment: 'demo' }),
    ];
    const latest = [deploy('s1t1', 'dev', '2026-10-03T00:00:00.000Z'), deploy('s1t2', 'danzig', '2026-10-01T00:00:00.000Z'), deploy('s1t3', 'demo', '2026-10-02T00:00:00.000Z')];
    expect(pickEnvironment(envs, open, latest)?.environment).toBe('danzig');
  });

  it('counts a latest deploy of an open glob as in use, but not a signed-off glob', () => {
    const open = [glob({ id: 's1t1', status: 'implementing', environment: null }), glob({ id: 's1t2', status: 'signed_off', environment: 'danzig' })];
    const latest = [deploy('s1t1', 'dev', '2026-10-03T00:00:00.000Z'), deploy('s1t2', 'danzig', '2026-10-03T00:00:00.000Z')];
    expect(pickEnvironment(envs, open, latest)?.environment).toBe('danzig');
  });

  it('frees the environment of a signed-off glob', () => {
    const open = [glob({ id: 's1t1', status: 'signed_off', environment: 'dev' })];
    expect(pickEnvironment(envs, open, [])?.environment).toBe('dev');
  });

  it('breaks a full tie by the board order, whatever an old stored subDefault says', () => {
    // A board saved before the sub default went still carries the key; it is not read.
    const legacy: Environment[] = [
      { name: 'dev', allowBranchDeploy: true },
      { name: 'danzig', allowBranchDeploy: true, ...{ subDefault: true } },
    ];
    const open = [glob({ id: 's1t1', status: 'implementing', environment: 'dev' }), glob({ id: 's1t2', status: 'implementing', environment: 'danzig' })];
    expect(pickEnvironment(legacy, open, [])?.environment).toBe('dev');
  });

  it('picks nothing when there is no candidate', () => {
    expect(pickEnvironment(envs.filter((e) => !e.allowBranchDeploy), [], [])).toBeNull();
  });
});
