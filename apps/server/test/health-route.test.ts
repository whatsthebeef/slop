import { BoardService, GlobService, LlmUnavailable } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { mountHealth } from '../src/http/health.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { AwsSignIn } from '../src/aws-sso.js';
import type { SsoOidc } from '../src/aws-sso.js';
import { IntegrationRegistry } from '../src/integration-health.js';
import { LlmHealth } from '../src/llm-health.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

describe('GET /api/health', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let app: Hono<Env>;
  let boards: BoardService;
  let boardId = 0;
  const health = new LlmHealth(undefined, () => '2026-10-07T09:00:00.000Z');
  const registry = new IntegrationRegistry(undefined, () => '2026-10-07T09:00:00.000Z');
  const oidc: SsoOidc = {
    registerClient: () => Promise.resolve({ clientId: 'c', clientSecret: 's', expiresAt: 1 }),
    startDeviceAuthorization: () =>
      Promise.resolve({ deviceCode: 'd', userCode: 'CODE-1234', verificationUri: 'https://v', verificationUriComplete: 'https://v?c=1', expiresIn: 600, interval: 1 }),
    createToken: () => Promise.resolve('pending'),
  };
  const signIn = new AwsSignIn({
    session: { name: 'slop', startUrl: 'https://s', region: 'us-east-1', scopes: [] },
    oidc,
    cacheFile: '/nonexistent/never-written.json',
    onSignedIn: () => Promise.resolve(),
    // Never reaches a token: the test only starts the sign-in.
    sleep: () => new Promise(() => undefined),
  });

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('health_route'));
    const { db } = database;
    const store = new PgStore(db);
    const hub = new HintHub();
    const globs = new GlobService({
      store,
      notifier: hub,
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    boards = new BoardService({ store, notifier: hub });
    // The real app and its sign-in check (dev mode: `Bearer dev:<email>`).
    app = createApp({
      auth: new Auth(db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub,
      outbox: new OutboxRunner(db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
    mountHealth(app, { llm: health, boards, integrations: registry, signIn });
    await store.transaction((tx) => tx.upsertUser({ email: 'member@example.com', name: 'Member', active: true }));
    const created = await boards.create('member@example.com', { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] });
    if (!created.ok) throw new Error(created.error.message);
    boardId = created.value.id;
    await store.transaction((tx) => tx.upsertUser({ email: 'viewer@example.com', name: 'Viewer', active: true }));
  });

  afterAll(async () => {
    await drop();
  });

  const get = (headers: Record<string, string> = {}) => app.request('/api/health', { headers });

  it('needs a signed-in person', async () => {
    expect((await get()).status).toBe(401);
  });

  it('is for board members only', async () => {
    const response = await get({ authorization: 'Bearer dev:nobody@example.com' });
    expect(response.status).toBe(403);
  });

  it("reports the LLM's state: unknown, then down with the reason and fix", async () => {
    const signedIn = { authorization: 'Bearer dev:member@example.com' };
    const before = await get(signedIn);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ llm: { state: 'unknown' }, integrations: [] });

    const tracked = health.track(
      { complete: () => Promise.reject(new LlmUnavailable('AWS sign-in expired', 'Run `aws sso login`')) },
      'us.anthropic.claude-opus-5-5',
    );
    await expect(tracked.complete({ system: 's', prompt: 'p', maxTokens: 1 })).rejects.toBeInstanceOf(LlmUnavailable);
    expect(await (await get(signedIn)).json()).toMatchObject({
      llm: { state: 'down', reason: 'AWS sign-in expired', fix: 'Run `aws sso login`', since: '2026-10-07T09:00:00.000Z' },
    });
  });

  it('lists the integrations that need a person, with the AWS sign-in offered only for a lapsed one', async () => {
    const signedIn = { authorization: 'Bearer dev:member@example.com' };
    registry.report('bedrock', { state: 'down', reason: 'AWS sign-in expired', fix: 'Sign in' });
    registry.report('github', { state: 'down', reason: "The GitHub App can't authenticate", fix: 'Check the key' });
    registry.report('tunnel', { state: 'ok' });
    const body = (await (await get(signedIn)).json()) as { integrations: { id: string; signIn: boolean }[]; awsSignIn: { canStart: boolean; state: string } };
    expect(body.integrations.map((i) => [i.id, i.signIn])).toEqual([
      ['bedrock', true],
      ['github', false],
    ]);
    expect(body.awsSignIn).toEqual({ canStart: true, state: 'idle' });
  });

  describe('POST /api/aws-sign-in', () => {
    const post = (headers: Record<string, string> = {}) => app.request('/api/aws-sign-in', { method: 'POST', headers });

    it('needs a signed-in person', async () => {
      expect((await post()).status).toBe(401);
    });

    it('is for board admins only', async () => {
      expect((await post({ authorization: 'Bearer dev:nobody@example.com' })).status).toBe(403);
      await boards.setMember('member@example.com', boardId, 'viewer@example.com', 'dev');
      expect((await post({ authorization: 'Bearer dev:viewer@example.com' })).status).toBe(403);
    });

    it("starts the device sign-in and returns the link and code for an admin", async () => {
      const response = await post({ authorization: 'Bearer dev:member@example.com' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: 'waiting', userCode: 'CODE-1234', verificationUri: 'https://v?c=1' });
    });
  });
});
