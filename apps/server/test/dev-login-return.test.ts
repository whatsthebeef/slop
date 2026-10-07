import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoardService, GlobService } from '@slop/core';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

describe('POST /auth/dev-login', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let app: Hono<Env>;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('dev_login_return'));
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
    app = createApp({
      auth: new Auth(db, loadConfig({})),
      links: new SignedLinks('test'),
      boards: new BoardService({ store, notifier: hub }),
      globs,
      hub,
      outbox: new OutboxRunner(db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
  });

  afterAll(async () => {
    await drop();
  });

  const login = async (returnTo?: string) => {
    const response = await app.request('/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'dev@example.com',
        ...(returnTo === undefined ? {} : { returnTo }),
      }),
    });
    return (await response.json()) as { returnTo: string };
  };

  it('keeps a valid return path', async () => {
    expect((await login('/boards/3/knowledge?x=1')).returnTo).toBe('/boards/3/knowledge?x=1');
  });

  it('sends a missing or unsafe return path to /', async () => {
    for (const bad of [undefined, '//evil.com', 'https://evil.com', '/\\evil.com']) {
      expect((await login(bad)).returnTo).toBe('/');
    }
  });
});
