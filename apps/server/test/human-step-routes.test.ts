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
const AT = '2026-10-05T12:00:00.000Z';

describe('human step routes', () => {
  let drop: () => Promise<void>;
  let app: Hono<Env>;
  let id = '';

  const post = (path: string, body: unknown, email = DEV) =>
    app.request(`/api/globs/${id}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer dev:${email}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const test = await createTestDatabase('human_step_routes');
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
    const created = await boards.create(DEV, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] });
    if (!created.ok) throw new Error(created.error.message);
    id = `s${String(created.value.id)}f1`;
    const glob: Glob = {
      id,
      boardId: created.value.id,
      title: 'Rollout glob',
      type: 'same',
      category: 'feature',
      group: null,
      environment: null,
      status: 'pr_open',
      version: 1,
      generation: 1,
      creator: DEV,
      planner: DEV,
      implementer: DEV,
      labels: {},
      checklists: {},
      pr: { number: 1, state: 'merged', headSha: 'abc' },
      prs: [],
      mergeMode: null,
      headChecks: null,
      runs: [],
      failure: null,
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

  it('adds, ticks and dismisses a step, answering with the glob view and its full steps', async () => {
    const added = await post('/human-steps', { title: 'Roll out the host', detail: 'Run it', who: 'admin', due: 'now', kind: 'rollout' });
    expect(added.status).toBe(200);
    const view = (await added.json()) as { id: string; humanSteps: { id: string; title: string; detail: string | null; state: string; doneBy: string | null }[] };
    expect(view.id).toBe(id);
    const step = view.humanSteps.find((s) => s.title === 'Roll out the host');
    expect(step).toMatchObject({ detail: 'Run it', state: 'due', doneBy: null });
    if (step === undefined) return;

    const done = await post(`/human-steps/${step.id}/complete`, {});
    const after = (await done.json()) as typeof view;
    expect(after.humanSteps.find((s) => s.id === step.id)).toMatchObject({ state: 'done', doneBy: DEV });

    const other = (await (await post('/human-steps', { title: 'Wrong step' })).json()) as typeof view;
    const wrong = other.humanSteps.find((s) => s.title === 'Wrong step');
    expect(wrong).toBeDefined();
    const dismissed = (await (await post(`/human-steps/${wrong?.id ?? ''}/dismiss`, { reason: 'Not needed' })).json()) as typeof view;
    expect(dismissed.humanSteps.find((s) => s.id === wrong?.id)?.state).toBe('dismissed');
  });

  it('refuses a missing title or reason, a stale version, and a non-member', async () => {
    expect((await post('/human-steps', { title: '' })).status).toBe(422);
    expect((await post('/human-steps/hs_x/dismiss', {})).status).toBe(422);
    expect((await post('/human-steps', { title: 'x', version: 99 })).status).toBe(409);
    expect((await post('/human-steps', { title: 'x' }, 'outsider@example.com')).status).toBeGreaterThanOrEqual(403);
  });
});
