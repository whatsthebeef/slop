import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntegrationHealth } from '@slop/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHub } from '../src/github/client.js';
import { AppCredentialsStore } from '../src/github/credentials.js';
import { IntegrationRegistry } from '../src/integration-health.js';

const REPO = { owner: 'acme', name: 'app', base: 'main' };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GitHub App health reporting', () => {
  let dir = '';
  let credentials: AppCredentialsStore;
  let registry: IntegrationRegistry;
  let changes: IntegrationHealth[] = [];
  let github: GitHub;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slop-github-health-'));
    credentials = new AppCredentialsStore(join(dir, 'app.json'));
    changes = [];
    registry = new IntegrationRegistry((h) => changes.push(h));
    github = new GitHub(credentials, registry);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const configure = async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await credentials.save({
      id: 1,
      slug: 'slop',
      pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      webhook_secret: 's',
      client_id: 'c',
      client_secret: 's',
      html_url: 'https://github.com/apps/slop',
    });
  };

  /** GitHub answers the installation lookup with `status`; `ok` also serves the token and repo calls. */
  const answerWith = (status: number, message = 'x') =>
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (status === 200 && url.endsWith('/access_tokens'))
        return Promise.resolve(json(201, { token: 't', expires_at: '2999-01-01T00:00:00Z' }));
      if (status === 200 && url.endsWith('/repos/acme/app')) return Promise.resolve(json(200, {}));
      return Promise.resolve(status === 200 ? json(200, { id: 9 }) : json(status, { message }));
    });

  const state = () => registry.report().find((h) => h.id === 'github_app');

  it('marks the App down when GitHub rejects its credential', async () => {
    await configure();
    answerWith(401, 'Bad credentials');
    await expect(github.connection(REPO)).rejects.toThrow();
    expect(state()).toMatchObject({ state: 'down' });
  });

  it('marks the App down for a 403 that says the credential is bad', async () => {
    await configure();
    answerWith(403, 'Bad credentials');
    await expect(github.connection(REPO)).rejects.toThrow();
    expect(state()).toMatchObject({ state: 'down' });
  });

  it('marks the App ok after a call that authenticates', async () => {
    await configure();
    registry.markDown('github_app', 'earlier', 'fix');
    answerWith(200);
    expect(await github.connection(REPO)).toMatchObject({ connected: true });
    expect(state()).toMatchObject({ state: 'ok' });
  });

  it('treats a 404 as authenticated (the App just is not installed there)', async () => {
    await configure();
    registry.markDown('github_app', 'earlier', 'fix');
    answerWith(404, 'Not Found');
    expect(await github.connection(REPO)).toMatchObject({ connected: false });
    expect(state()).toMatchObject({ state: 'ok' });
  });

  it('says nothing for a 500 or a plain 403', async () => {
    await configure();
    registry.markDown('github_app', 'earlier', 'fix');
    for (const [status, message] of [
      [500, 'Server Error'],
      [403, 'Resource not accessible by integration'],
    ] as const) {
      answerWith(status, message);
      await expect(github.connection(REPO)).rejects.toThrow();
      expect(state()).toMatchObject({ state: 'down', reason: 'earlier' });
    }
  });

  it('marks the App degraded when it is not set up', async () => {
    await expect(github.headOf(REPO, 'main')).rejects.toThrow(/not set up/);
    expect(state()).toMatchObject({ state: 'degraded' });
  });
});
