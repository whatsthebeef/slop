import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { appCredentialsSchema, AppCredentialsStore, fileSlot } from '../src/github/credentials.js';
import { SecretRoutines } from '../src/routines.js';
import { MemorySecretStore, secretNames, storeSlot, withSecrets } from '../src/secrets.js';

const names = secretNames('slop/test/');
const cognito = { AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: 'p', COGNITO_REGION: 'r', COGNITO_DOMAIN: 'd', COGNITO_CLIENT_IDS: 'c' };

describe('withSecrets', () => {
  it('fills the sensitive settings from the store', async () => {
    const store = new MemorySecretStore(
      new Map([
        [names.signingSecret, 'sign\n'],
        [names.cognitoBoardClientSecret, 'cog'],
        [names.slackSigningSecret, 'ss'],
        [names.slackBotToken, 'xoxb-1'],
      ]),
    );
    const config = await withSecrets(loadConfig({ ...cognito, SECRETS: 'aws', SECRETS_PREFIX: 'slop/test/' }), store);
    expect(config).toMatchObject({
      SIGNING_SECRET: 'sign',
      COGNITO_BOARD_CLIENT_SECRET: 'cog',
      SLACK_SIGNING_SECRET: 'ss',
      SLACK_BOT_TOKEN: 'xoxb-1',
    });
  });

  it('names every missing required secret and never a value', async () => {
    const store = new MemorySecretStore(new Map([[names.slackBotToken, 'xoxb-secret']]));
    const failure = withSecrets(loadConfig({ ...cognito, SECRETS: 'aws', SECRETS_PREFIX: 'slop/test/' }), store);
    await expect(failure).rejects.toThrow(`${names.signingSecret}, ${names.cognitoBoardClientSecret}`);
    await expect(failure).rejects.not.toThrow('xoxb-secret');
  });

  it('wants both Slack secrets or neither', async () => {
    const store = new MemorySecretStore(new Map([[names.signingSecret, 's'], [names.slackBotToken, 'xoxb-1']]));
    await expect(withSecrets(loadConfig({ SECRETS: 'aws', SECRETS_PREFIX: 'slop/test/' }), store)).rejects.toThrow('both');
  });

  it("doesn't need the Cognito secret outside Cognito mode", async () => {
    const store = new MemorySecretStore(new Map([[names.signingSecret, 's']]));
    const config = await withSecrets(loadConfig({ SECRETS: 'aws', SECRETS_PREFIX: 'slop/test/' }), store);
    expect(config.SIGNING_SECRET).toBe('s');
  });
});

describe('secret routines', () => {
  const secret = { url: 'https://example.com/fire', token: 'tok' };
  let store: MemorySecretStore;
  let now = 0;
  const routines = () => new SecretRoutines(store, names.routinesPrefix, 30_000, () => now);

  beforeEach(() => {
    store = new MemorySecretStore();
    now = 0;
  });

  it("uses a board's own routine, else the developer's default, case-insensitively", async () => {
    const r = routines();
    await r.set('Dev@Example.com', { ...secret, token: 'default' });
    await r.set('dev@example.com', { ...secret, token: 'board-16' }, 16);
    expect((await r.secretFor('DEV@example.com', 16))?.token).toBe('board-16');
    expect((await r.secretFor('dev@example.com', 17))?.token).toBe('default');
    expect(await r.hasRoutine('dev@example.com', 17)).toBe(true);
    expect(await r.hasRoutine('other@example.com', 16)).toBe(false);
  });

  it('stores under <prefix>routines/<email>/<board|default>', async () => {
    await routines().set('dev@example.com', secret, 16);
    expect(await store.get('slop/test/routines/dev@example.com/16')).toContain('tok');
  });

  it('picks up a routine set elsewhere after the TTL, not before', async () => {
    const r = routines();
    expect(await r.secretFor('dev@example.com', 16)).toBeNull();
    await store.put('slop/test/routines/dev@example.com/default', JSON.stringify(secret));
    now = 10_000;
    expect(await r.secretFor('dev@example.com', 16)).toBeNull();
    now = 31_000;
    expect((await r.secretFor('dev@example.com', 16))?.token).toBe('tok');
  });

  it('treats malformed stored values as no routine', async () => {
    await store.put('slop/test/routines/dev@example.com/default', 'not json');
    expect(await routines().hasRoutine('dev@example.com', 1)).toBe(false);
  });
});

describe('GitHub App credentials slots', () => {
  const credentials = appCredentialsSchema.parse({
    id: 1, slug: 'slop-prod', pem: 'pem', webhook_secret: 'wh', client_id: 'ci', client_secret: 'cs', html_url: 'https://github.com/apps/slop-prod',
  });
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slop-creds-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips through the secret store', async () => {
    const store = new MemorySecretStore();
    const slot = storeSlot(store, names.githubApp);
    expect(await new AppCredentialsStore(slot).load()).toBeNull();
    await new AppCredentialsStore(slot).save(credentials);
    expect(await new AppCredentialsStore(slot).load()).toEqual(credentials);
  });

  it('keeps the local file private', async () => {
    const file = join(dir, '.github-app.json');
    await new AppCredentialsStore(fileSlot(file)).save(credentials);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(credentials);
    expect(await new AppCredentialsStore(fileSlot(file)).load()).toEqual(credentials);
  });
});
