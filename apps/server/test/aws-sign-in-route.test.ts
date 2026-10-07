import { BoardService, GlobService } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { AwsSignIn } from '../src/aws-sso-signin.js';
import type { SsoOidc } from '../src/aws-sso-signin.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { mountAwsSignIn } from '../src/http/aws-sign-in.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const oidc: SsoOidc = {
  registerClient: () =>
    Promise.resolve({ clientId: 'id', clientSecret: 'CLIENT-SECRET', expiresAt: 1_900_000_000 }),
  startDeviceAuthorization: () =>
    Promise.resolve({
      deviceCode: 'DEVICE-CODE-SECRET',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://device.example/',
      verificationUriComplete: 'https://device.example/?user_code=ABCD-EFGH',
      expiresIn: 600,
      interval: 5,
    }),
  // Never completes: the route test only needs the flow to be waiting.
  createToken: () => Promise.resolve({ kind: 'pending' }),
};

describe('/api/aws-sign-in', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let app: Hono<Env>;
  let bare: Hono<Env>;
  let signIn: AwsSignIn;

  const build = (store: PgStore, boards: BoardService, hub: HintHub, db: Database['db']) => {
    const globs = new GlobService({
      store,
      notifier: hub,
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    return createApp({
      auth: new Auth(db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub,
      outbox: new OutboxRunner(db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('aws_sign_in_route'));
    const { db } = database;
    const store = new PgStore(db);
    const hub = new HintHub();
    const boards = new BoardService({ store, notifier: hub });
    app = build(store, boards, hub, db);
    // The same app without the routes, as on a server that doesn't offer sign-in.
    bare = build(store, boards, hub, db);
    signIn = new AwsSignIn({
      oidc,
      profile: {
        session: 'work',
        startUrl: 'https://work.awsapps.com/start',
        region: 'eu-west-1',
        scopes: [],
      },
      home: '/nonexistent',
      onSignedIn: () => Promise.resolve(),
      sleep: () => new Promise(() => undefined),
    });
    mountAwsSignIn(app, { boards, signIn });

    await store.transaction(async (tx) => {
      for (const email of ['admin@example.com', 'member@example.com']) {
        await tx.upsertUser({ email, name: email, active: true });
      }
    });
    const created = await boards.create('admin@example.com', {
      name: 'b',
      repo: null,
      baseBranch: 'main',
      timeZone: 'UTC',
      environments: [],
    });
    if (!created.ok) throw new Error(created.error.message);
    const added = await boards.setMember(
      'admin@example.com',
      created.value.id,
      'member@example.com',
      'dev',
    );
    if (!added.ok) throw new Error(added.error.message);
  });

  afterAll(async () => {
    await drop();
  });

  const as = (email: string | null, method: 'GET' | 'POST', target: Hono<Env> = app) =>
    target.request('/api/aws-sign-in', {
      method,
      headers: email === null ? {} : { authorization: `Bearer dev:${email}` },
    });

  it('needs a signed-in person', async () => {
    expect((await as(null, 'POST')).status).toBe(401);
    expect((await as(null, 'GET')).status).toBe(401);
  });

  it('is for board admins: a non-admin member or a stranger is forbidden', async () => {
    for (const method of ['POST', 'GET'] as const) {
      expect((await as('member@example.com', method)).status).toBe(403);
      expect((await as('stranger@example.com', method)).status).toBe(403);
    }
  });

  it('does not exist where sign-in is not offered', async () => {
    expect((await as('admin@example.com', 'POST', bare)).status).toBe(404);
    expect((await as('admin@example.com', 'GET', bare)).status).toBe(404);
  });

  it('lets an admin start a flow and poll it, without the device code or client secret', async () => {
    const started = await as('admin@example.com', 'POST');
    expect(started.status).toBe(200);
    const body = await started.text();
    expect(JSON.parse(body)).toMatchObject({
      state: 'waiting',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://device.example/',
    });
    expect(body).not.toMatch(/DEVICE-CODE-SECRET|CLIENT-SECRET/);

    const status = await as('admin@example.com', 'GET');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ state: 'waiting', userCode: 'ABCD-EFGH' });
  });
});
