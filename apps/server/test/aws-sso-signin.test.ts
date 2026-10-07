import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AwsSignIn, tokenCachePath } from '../src/aws-sso-signin.js';
import type { SsoOidc, TokenPoll } from '../src/aws-sso-signin.js';

const PROFILE = {
  session: 'work',
  startUrl: 'https://work.awsapps.com/start',
  region: 'eu-west-1',
  scopes: ['sso:account:access'],
};
const CLIENT = { clientId: 'client-id', clientSecret: 'client-secret', expiresAt: 1_900_000_000 };
const AUTH = {
  deviceCode: 'DEVICE-CODE-SECRET',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://device.sso.eu-west-1.amazonaws.com/',
  verificationUriComplete: 'https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH',
  expiresIn: 600,
  interval: 5,
};
const TOKEN: TokenPoll = {
  kind: 'ok',
  accessToken: 'ACCESS-TOKEN',
  refreshToken: 'REFRESH-TOKEN',
  expiresIn: 28800,
};

describe('AwsSignIn', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'slop-sso-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const setup = (polls: TokenPoll[], overrides: Partial<{ authExpiresIn: number }> = {}) => {
    const calls = { register: 0, start: 0, create: 0 };
    const sleeps: number[] = [];
    let clock = Date.parse('2026-10-07T12:00:00.000Z');
    const oidc: SsoOidc = {
      registerClient: () => {
        calls.register++;
        return Promise.resolve(CLIENT);
      },
      startDeviceAuthorization: () => {
        calls.start++;
        return Promise.resolve({ ...AUTH, expiresIn: overrides.authExpiresIn ?? AUTH.expiresIn });
      },
      createToken: () => {
        calls.create++;
        return Promise.resolve(polls.shift() ?? { kind: 'pending' });
      },
    };
    const events: string[] = [];
    const signIn = new AwsSignIn({
      oidc,
      profile: PROFILE,
      home,
      onSignedIn: () => {
        events.push('probe');
        return Promise.resolve();
      },
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    return { signIn, calls, sleeps, events };
  };

  it('waits through pending, backs off on slow_down, then writes the CLI cache file and probes', async () => {
    const { signIn, sleeps, events } = setup([{ kind: 'pending' }, { kind: 'slow_down' }, TOKEN]);
    const started = await signIn.start();
    expect(started).toMatchObject({
      state: 'waiting',
      userCode: 'ABCD-EFGH',
      expiresAt: '2026-10-07T12:10:00.000Z',
    });
    await signIn.settled();

    expect(sleeps).toEqual([5000, 5000, 10_000]);
    expect(signIn.status()).toEqual({ state: 'done' });
    expect(events).toEqual(['probe']);

    const path = join(
      home,
      '.aws',
      'sso',
      'cache',
      `${createHash('sha1').update('work').digest('hex')}.json`,
    );
    expect(tokenCachePath(home, 'work')).toBe(path);
    expect(await readdir(join(home, '.aws', 'sso', 'cache'))).toEqual([
      `${createHash('sha1').update('work').digest('hex')}.json`,
    ]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      startUrl: PROFILE.startUrl,
      region: 'eu-west-1',
      accessToken: 'ACCESS-TOKEN',
      expiresAt: new Date(
        Date.parse('2026-10-07T12:00:00.000Z') + 20_000 + 28_800_000,
      ).toISOString(),
      clientId: 'client-id',
      clientSecret: 'client-secret',
      registrationExpiresAt: new Date(1_900_000_000_000).toISOString(),
      refreshToken: 'REFRESH-TOKEN',
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.aws', 'sso', 'cache'))).mode & 0o777).toBe(0o700);
  });

  it('never exposes the device code or client secret in its status', async () => {
    const { signIn } = setup([TOKEN]);
    const started = await signIn.start();
    await signIn.settled();
    expect(JSON.stringify([started, signIn.status()])).not.toMatch(
      /DEVICE-CODE-SECRET|client-secret|ACCESS-TOKEN/,
    );
  });

  it('fails when the code is denied or expires, and writes no cache', async () => {
    for (const [poll, message] of [
      [{ kind: 'denied' }, 'The sign-in was denied in the browser'],
      [{ kind: 'expired' }, 'The sign-in code expired'],
    ] as const) {
      const { signIn, events } = setup([poll]);
      await signIn.start();
      await signIn.settled();
      expect(signIn.status()).toEqual({ state: 'failed', message });
      expect(events).toEqual([]);
    }
    expect(await readdir(home)).toEqual([]);
  });

  it('gives up when the authorization lapses unanswered', async () => {
    const { signIn } = setup([], { authExpiresIn: 12 });
    await signIn.start();
    await signIn.settled();
    expect(signIn.status()).toEqual({ state: 'failed', message: 'The sign-in code expired' });
  });

  it('runs one flow at a time, and can start again once it has ended', async () => {
    const { signIn, calls } = setup([{ kind: 'pending' }, TOKEN]);
    const [a, b] = await Promise.all([signIn.start(), signIn.start()]);
    expect(b).toEqual(a);
    expect(await signIn.start()).toEqual(a);
    expect(calls.register).toBe(1);
    await signIn.settled();
    expect(signIn.status().state).toBe('done');
    await signIn.start();
    expect(calls.register).toBe(2);
    await signIn.settled();
  });

  it('reports a failure to start without leaking why', async () => {
    const signIn = new AwsSignIn({
      oidc: {
        registerClient: () => Promise.reject(new Error('boom with details')),
        startDeviceAuthorization: () => Promise.reject(new Error('unused')),
        createToken: () => Promise.reject(new Error('unused')),
      },
      profile: PROFILE,
      home,
      onSignedIn: () => Promise.resolve(),
    });
    expect(await signIn.start()).toEqual({
      state: 'failed',
      message: 'AWS would not start a sign-in',
    });
  });
});
