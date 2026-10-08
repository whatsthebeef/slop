import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AwsSignIn, readSsoSession, ssoCacheFile } from '../src/aws-sso.js';
import type { SsoOidc, SsoSession } from '../src/aws-sso.js';
import type { NotificationSink, RaisedNotification } from '@slop/core';
import { IntegrationRegistry } from '../src/integration-health.js';

const session: SsoSession = { name: 'slop', startUrl: 'https://example.awsapps.com/start', region: 'us-east-1', scopes: ['sso:account:access'] };

/** A stand-in for AWS: the person approves after `pendingPolls` polls. */
const fakeOidc = (pendingPolls: number, outcome: 'approve' | 'deny' = 'approve') => {
  const calls: string[] = [];
  let polls = 0;
  const oidc: SsoOidc = {
    registerClient: () => {
      calls.push('register');
      return Promise.resolve({ clientId: 'cid', clientSecret: 'secret', expiresAt: 1_900_000_000 });
    },
    startDeviceAuthorization: () => {
      calls.push('start');
      return Promise.resolve({
        deviceCode: 'dev',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com/',
        verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
        expiresIn: 600,
        interval: 1,
      });
    },
    createToken: () => {
      calls.push('token');
      if (outcome === 'deny') return Promise.reject(Object.assign(new Error('no'), { name: 'AccessDeniedException' }));
      polls += 1;
      return Promise.resolve(polls <= pendingPolls ? 'pending' : { accessToken: 'tok', refreshToken: 'ref', expiresIn: 28800 });
    },
  };
  return { oidc, calls };
};

describe('AwsSignIn', () => {
  const setup = async (oidc: SsoOidc, onSignedIn = () => Promise.resolve()) => {
    const dir = await mkdtemp(join(tmpdir(), 'sso-'));
    let clock = 1_000_000;
    const signIn = new AwsSignIn({
      session,
      oidc,
      cacheFile: ssoCacheFile(session, dir),
      onSignedIn,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    return { signIn, dir };
  };

  it('shows the link and code, polls until approved, writes the SDK cache entry and probes Bedrock', async () => {
    const { oidc, calls } = fakeOidc(2);
    let probed = 0;
    const { signIn, dir } = await setup(oidc, () => {
      probed += 1;
      return Promise.resolve();
    });
    const started = await signIn.start();
    expect(started).toMatchObject({ state: 'waiting', userCode: 'ABCD-EFGH', verificationUri: expect.stringContaining('user_code=ABCD-EFGH') as unknown });
    await signIn.finished();
    expect(signIn.status()).toEqual({ state: 'done' });
    expect(calls).toEqual(['register', 'start', 'token', 'token', 'token']);
    expect(probed).toBe(1);

    const file = join(dir, `${createHash('sha1').update('slop').digest('hex')}.json`);
    const entry = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    expect(entry).toMatchObject({ startUrl: session.startUrl, region: 'us-east-1', accessToken: 'tok', refreshToken: 'ref', clientId: 'cid', clientSecret: 'secret' });
    expect(new Date(entry.expiresAt ?? '').getTime()).toBe(1_000_000 + 3_000 + 28_800_000);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('returns the sign-in in flight when started again', async () => {
    const { oidc, calls } = fakeOidc(1);
    const { signIn } = await setup(oidc);
    const first = await signIn.start();
    expect(await signIn.start()).toEqual(first);
    expect(calls.filter((c) => c === 'register')).toHaveLength(1);
    await signIn.finished();
  });

  it('fails plainly when the person denies it, and writes no token', async () => {
    const { oidc } = fakeOidc(0, 'deny');
    const { signIn, dir } = await setup(oidc);
    await signIn.start();
    await signIn.finished();
    expect(signIn.status()).toEqual({ state: 'failed', message: 'The sign-in was denied' });
    await expect(stat(ssoCacheFile(session, dir))).rejects.toThrow();
  });

  it('fails when the link expires before approval', async () => {
    const { oidc } = fakeOidc(10_000);
    const { signIn } = await setup(oidc);
    await signIn.start();
    await signIn.finished();
    expect(signIn.status()).toEqual({ state: 'failed', message: 'The sign-in link expired before it was approved' });
  });

  it("fails when AWS can't start it", async () => {
    const { oidc } = fakeOidc(0);
    const { signIn } = await setup({ ...oidc, registerClient: () => Promise.reject(new Error('boom')) });
    expect((await signIn.start()).state).toBe('failed');
  });
});

describe('readSsoSession', () => {
  it("reads the profile's sso-session, and nothing for a profile without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awscfg-'));
    const file = join(dir, 'config');
    await writeFile(
      file,
      `[profile dev]\nsso_session = slop\nsso_account_id = 1\n\n[profile plain]\nregion = us-east-1\n\n[sso-session slop]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\nsso_registration_scopes = sso:account:access\n`,
    );
    expect(await readSsoSession('dev', file)).toEqual(session);
    expect(await readSsoSession('plain', file)).toBeNull();
    expect(await readSsoSession(undefined, file)).toBeNull();
    expect(await readSsoSession('dev', join(dir, 'missing'))).toBeNull();
  });
});

describe('IntegrationRegistry', () => {
  it('announces each change once, and stays quiet for repeats and for ok before any report', () => {
    const seen: string[] = [];
    const registry = new IntegrationRegistry((s) => seen.push(`${s.id}:${s.state}`), () => '2026-10-07T10:00:00.000Z');
    registry.report('github', { state: 'ok' });
    registry.report('github', { state: 'down', reason: 'r', fix: 'f' });
    registry.report('github', { state: 'down', reason: 'r', fix: 'f' });
    registry.report('github', { state: 'down', reason: 'other', fix: 'f' });
    registry.report('github', { state: 'ok' });
    expect(seen).toEqual(['github:down', 'github:down', 'github:ok']);
    expect(registry.list()).toMatchObject([{ id: 'github', state: 'ok', reason: null, fix: null }]);
  });
});

describe('IntegrationRegistry notifications', () => {
  const setup = (sso = false) => {
    const raised: RaisedNotification[] = [];
    const cleared: string[] = [];
    const sink: NotificationSink = {
      raise: (n) => Promise.resolve(void raised.push(n)),
      clear: (boardId, source) =>
        Promise.resolve(void cleared.push(`${String(boardId)}/${source}`)),
    };
    const registry = new IntegrationRegistry(
      undefined,
      () => '2026-10-07T10:00:00.000Z',
      sink,
      () => sso,
    );
    return { registry, raised, cleared };
  };

  it.each([
    ['bedrock', 'down', 'critical'],
    ['github', 'down', 'critical'],
    ['github', 'degraded', 'warning'],
    ['routines', 'down', 'critical'],
    ['tunnel', 'down', 'warning'],
    ['tunnel', 'degraded', 'warning'],
  ] as const)('%s %s raises a global %s notification, and ok clears it', (id, state, severity) => {
    const { registry, raised, cleared } = setup();
    registry.report(id, { state, reason: 'why', fix: 'do this' });
    expect(raised).toMatchObject([
      { boardId: null, source: `integration:${id}`, severity, clears: { kind: 'condition' } },
    ]);
    expect(raised[0]?.detail).toContain('do this');
    registry.report(id, { state: 'ok' });
    expect(cleared).toEqual([`null/integration:${id}`]);
  });

  it('says the KB pipeline is paused for Bedrock and offers the AWS sign-in only on a lapsed sign-in with an SSO profile', () => {
    const expired = { state: 'down', reason: 'AWS sign-in expired', fix: 'Sign in' } as const;
    const local = setup(true);
    local.registry.report('bedrock', expired);
    expect(local.raised[0]).toMatchObject({
      title: 'AI features paused: AWS sign-in expired',
      action: { label: 'Sign in to AWS', kind: 'aws-sign-in' },
    });
    expect(local.raised[0]?.detail).toContain('paused');

    const production = setup(false);
    production.registry.report('bedrock', expired);
    expect(production.raised[0]?.action).toBeNull();
    const noAccess = setup(true);
    noAccess.registry.report('bedrock', {
      state: 'down',
      reason: 'No access to the model',
      fix: 'Request it',
    });
    expect(noAccess.raised[0]?.action).toBeNull();
  });

  it('raises nothing for ok before any report, and not again for a repeat', () => {
    const { registry, raised, cleared } = setup();
    registry.report('github', { state: 'ok' });
    registry.report('github', { state: 'down', reason: 'r', fix: 'f' });
    registry.report('github', { state: 'down', reason: 'r', fix: 'f' });
    expect(raised).toHaveLength(1);
    expect(cleared).toEqual([]);
  });

  it('reports a failing sink instead of throwing', async () => {
    const errors: string[] = [];
    const sink: NotificationSink = {
      raise: () => Promise.reject(new Error('db down')),
      clear: () => Promise.resolve(),
    };
    new IntegrationRegistry(
      undefined,
      undefined,
      sink,
      () => false,
      (m) => errors.push(m),
    ).report('github', { state: 'down', reason: 'r', fix: 'f' });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(['notification for github: db down']);
  });
});
