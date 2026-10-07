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
import { LlmHealth } from '../src/llm-health.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

describe('GET /api/health', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let app: Hono<Env>;
  const health = new LlmHealth(undefined, () => '2026-10-07T09:00:00.000Z');

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
    // The real app and its sign-in check (dev mode: `Bearer dev:<email>`).
    app = createApp({
      auth: new Auth(db, loadConfig({})),
      links: new SignedLinks('test'),
      boards: new BoardService({ store, notifier: hub }),
      globs,
      hub,
      outbox: new OutboxRunner(db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
    mountHealth(app, { llm: health });
  });

  afterAll(async () => {
    await drop();
  });

  const get = (headers: Record<string, string> = {}) => app.request('/api/health', { headers });

  it('needs a signed-in person', async () => {
    expect((await get()).status).toBe(401);
  });

  it("reports the LLM's state: unknown, then down with the reason and fix", async () => {
    const signedIn = { authorization: 'Bearer dev:member@example.com' };
    const before = await get(signedIn);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ llm: { state: 'unknown' } });

    const tracked = health.track({
      complete: () => Promise.reject(new LlmUnavailable('AWS sign-in expired', 'Run `aws sso login`')),
    });
    await expect(tracked.complete({ system: 's', prompt: 'p', maxTokens: 1 })).rejects.toBeInstanceOf(LlmUnavailable);
    expect(await (await get(signedIn)).json()).toEqual({
      llm: { state: 'down', reason: 'AWS sign-in expired', fix: 'Run `aws sso login`', since: '2026-10-07T09:00:00.000Z' },
    });
  });
});
