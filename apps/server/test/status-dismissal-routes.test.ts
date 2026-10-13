import { BoardService, GlobService } from '@slop/core';
import type { Glob } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const OTHER = 'other@example.com';
const AT = '2026-10-05T12:00:00.000Z';

describe('status dismissal routes', () => {
  let drop: () => Promise<void>;
  let app: Hono<Env>;
  let id = '';
  let boardId = 0;

  const send = (method: 'POST' | 'DELETE', body: unknown, email = DEV) =>
    app.request(`/api/globs/${id}/dismiss`, {
      method,
      headers: { authorization: `Bearer dev:${email}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const test = await createTestDatabase('status_dismissals');
    drop = test.drop;
    const store = new PgStore(test.database.db);
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
      auth: new Auth(test.database.db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub,
      outbox: new OutboxRunner(test.database.db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: 'Dev', active: true }));
    await store.transaction((tx) => tx.upsertUser({ email: 'outsider@example.com', name: 'Out', active: true }));
    await store.transaction((tx) => tx.upsertUser({ email: OTHER, name: 'Other', active: true }));
    const created = await boards.create(DEV, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] });
    if (!created.ok) throw new Error(created.error.message);
    boardId = created.value.id;
    id = `s${String(boardId)}f1`;
    const added = await boards.setMember(DEV, boardId, OTHER, 'dev');
    if (!added.ok) throw new Error(added.error.message);
    const glob: Glob = {
      id,
      boardId: created.value.id,
      title: 'Failed glob',
      type: 'same',
      category: 'feature',
      group: null,
      environment: null,
      status: 'failed',
      version: 1,
      generation: 1,
      creator: DEV,
      planner: DEV,
      implementer: DEV,
      labels: {},
      checklists: {},
      pr: null,
      prs: [],
      mergeMode: null,
      headChecks: null,
      runs: [],
      failure: { reason: 'Could not reproduce the bug', at: AT },
      provisioning: 'ok',
      createdAt: AT,
      updatedAt: AT,
      signedOffAt: null,
      doingSince: AT,
    };
    await store.transaction((tx) => tx.insertGlob(glob, null));
  });

  afterAll(async () => {
    await drop();
  });

  const KEY = `failure:${AT}`;
  const single = async (email: string) =>
    ((await (await app.request(`/api/globs/${id}`, { headers: { authorization: `Bearer dev:${email}` } })).json()) as { dismissedKeys: string[] }).dismissedKeys;
  const listed = async (email: string) => {
    const res = await app.request(`/api/boards/${boardId}/globs`, { headers: { authorization: `Bearer dev:${email}` } });
    return ((await res.json()) as { id: string; dismissedKeys: string[] }[]).find((g) => g.id === id)?.dismissedKeys;
  };

  it('dismisses for the caller only, on the glob view and the board list, and undoes it', async () => {
    const res = await send('POST', { key: KEY });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dismissedKeys: string[] }).dismissedKeys).toEqual([KEY]);
    expect(await single(DEV)).toEqual([KEY]);
    expect(await listed(DEV)).toEqual([KEY]);
    expect(await single(OTHER)).toEqual([]);
    expect(await listed(OTHER)).toEqual([]);
    // A second one changes nothing; a new situation's key is not dismissed.
    expect((await send('POST', { key: KEY })).status).toBe(200);
    expect(await single(DEV)).toEqual([KEY]);

    const undone = await send('DELETE', { key: KEY });
    expect(undone.status).toBe(200);
    expect(await single(DEV)).toEqual([]);
    expect(await listed(DEV)).toEqual([]);
  });

  it('refuses a malformed key and a non-member', async () => {
    expect((await send('POST', { key: '' })).status).toBe(422);
    expect((await send('POST', { key: 'has space' })).status).toBe(422);
    expect((await send('POST', {})).status).toBe(422);
    expect((await send('POST', { key: KEY }, 'outsider@example.com')).status).toBeGreaterThanOrEqual(403);
  });
});
