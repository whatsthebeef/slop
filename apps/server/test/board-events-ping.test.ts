import { BoardService, GlobService } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('GET /api/boards/:b/events', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let app: Hono<Env>;
  let boardId = 0;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('board_events_ping'));
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
    const boards = new BoardService({ store, notifier: hub });
    app = createApp({
      auth: new Auth(db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub,
      outbox: new OutboxRunner(db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
      pingMs: 20,
    });
    await store.transaction((tx) => tx.upsertUser({ email: 'member@example.com', name: 'Member', active: true }));
    const created = await boards.create('member@example.com', { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] });
    if (!created.ok) throw new Error(created.error.message);
    boardId = created.value.id;
  });

  afterAll(async () => {
    await drop();
  });

  it('sends ready, then a named ping event while idle (a comment would be invisible to EventSource)', async () => {
    const response = await app.request(`/api/boards/${boardId}/events`, { headers: { authorization: 'Bearer dev:member@example.com' } });
    expect(response.status).toBe(200);
    if (response.body === null) throw new Error('no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: ping')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toMatch(/event: ready/);
    expect(text).toMatch(/event: ping\ndata: \{\}/);
    expect(text).not.toContain('keep-alive');
  });
});
