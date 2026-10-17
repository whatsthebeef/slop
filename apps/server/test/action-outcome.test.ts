import { BoardService, GlobService } from '@slop/core';
import type { Glob, Result } from '@slop/core';
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
const HEAD = 'a2a88c8aaaa';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** A click's pending action and a refusal's last outcome, over REST on Postgres. */
describe('action outcomes (REST)', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let app: Hono<Env>;
  let globs: GlobService;
  let boardId = 0;

  const post = (id: string, path: string, body: unknown) =>
    app.request(`/api/globs/${id}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer dev:${DEV}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const create = async (patch: Record<string, unknown> = {}): Promise<Glob> =>
    unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Work',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        ...patch,
      }),
    );
  const current = async (id: string): Promise<Glob> => {
    const glob = await store.transaction((tx) => tx.getGlob(id));
    if (glob === null) throw new Error(`No glob ${id}`);
    return glob;
  };
  const put = async (id: string, patch: Partial<Glob>): Promise<Glob> => {
    const glob = await current(id);
    const next = { ...glob, ...patch, version: glob.version + 1 };
    if (!(await store.transaction((tx) => tx.updateGlob(next, glob.version))))
      throw new Error('version race');
    return next;
  };
  const viewOf = async (id: string) =>
    (await (
      await app.request(`/api/globs/${id}`, { headers: { authorization: `Bearer dev:${DEV}` } })
    ).json()) as {
      version: number;
      pendingAction?: { kind: string; by: string; runId?: string } | null;
      lastOutcome?: { kind: string; result: string; reason: string } | null;
    };

  beforeAll(async () => {
    const test = await createTestDatabase('action_outcomes');
    drop = test.drop;
    store = new PgStore(test.database.db);
    const hub = new HintHub();
    globs = new GlobService({
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
    const created = await boards.create(DEV, {
      name: 'b',
      repo: null,
      timeZone: 'UTC',
      environments: [],
    });
    boardId = unwrap(created).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('a refused Merge and continue is kept as the last outcome, with the reason the click got', async () => {
    const g = await create({ type: 'super' });
    await put(g.id, {
      status: 'pr_open',
      provisioning: 'ok',
      implementer: DEV,
      pr: { number: 7, state: 'ready', headSha: HEAD },
      headChecks: { sha: HEAD, state: 'pending' },
    });
    const before = await viewOf(g.id);
    expect(before.lastOutcome ?? null).toBeNull();

    const refused = await post(g.id, '/actions/merge-continue', { version: before.version });
    expect(refused.status).toBe(409);
    const message = ((await refused.json()) as { message: string }).message;
    expect(message).not.toBe('');

    const after = await viewOf(g.id);
    expect(after.lastOutcome).toMatchObject({
      kind: 'merge_continue',
      result: 'failed',
      reason: message,
    });
    expect(after.pendingAction ?? null).toBeNull();
    expect(after.version).toBeGreaterThan(before.version);
  });

  it('does not keep a stale-version refusal, which says nothing about the glob', async () => {
    const g = await create();
    const stale = await post(g.id, '/actions/merge', {
      version: (await current(g.id)).version + 7,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('version_conflict');
    expect((await viewOf(g.id)).lastOutcome ?? null).toBeNull();
  });

  it('an action that records no pending action still clears the last outcome (Cancel merge)', async () => {
    const g = await create({ type: 'super' });
    await put(g.id, {
      status: 'pr_open',
      provisioning: 'ok',
      implementer: DEV,
      pr: { number: 8, state: 'ready', headSha: HEAD },
      headChecks: { sha: HEAD, state: 'pending' },
      mergeMode: 'when_green',
      lastOutcome: {
        kind: 'merge',
        at: '2026-10-05T12:00:00.000Z',
        by: DEV,
        result: 'failed',
        reason: 'Merge failed: no',
      },
    });
    const before = await viewOf(g.id);
    expect(before.lastOutcome).not.toBeNull();
    const done = await post(g.id, '/actions/cancel-merge', { version: before.version });
    expect(done.status).toBe(200);
    const after = await viewOf(g.id);
    expect(after.lastOutcome ?? null).toBeNull();
    expect(after.pendingAction ?? null).toBeNull();
  });

  it('Fix conflict stores the pending action with the run it queued, and a new click clears an earlier refusal', async () => {
    const g = await create();
    await put(g.id, {
      status: 'pr_open',
      provisioning: 'ok',
      pr: { number: 9, state: 'ready', headSha: HEAD },
      headChecks: { sha: HEAD, state: 'passed' },
      conflict: { base: 'main', files: ['a.ts'], since: null, at: new Date().toISOString() },
      lastOutcome: {
        kind: 'merge',
        at: new Date().toISOString(),
        by: DEV,
        result: 'failed',
        reason: 'earlier refusal',
      },
    });
    const done = await post(g.id, '/actions/resolve-conflict', {
      version: (await current(g.id)).version,
    });
    expect(done.status).toBe(200);
    const view = (await done.json()) as {
      pendingAction?: { kind: string; by: string; runId?: string } | null;
      lastOutcome?: unknown;
      currentRun: { id: string; state: string; purpose?: string };
    };
    expect(view.currentRun).toMatchObject({ purpose: 'resolve_conflict' });
    expect(view.pendingAction).toMatchObject({
      kind: 'resolve_conflict',
      by: DEV,
      runId: view.currentRun.id,
    });
    expect(view.lastOutcome ?? null).toBeNull();
    expect((await viewOf(g.id)).pendingAction?.runId).toBe(view.currentRun.id);
  });
  it('Discard on a same applies in the request: no pending action, and no timed-out outcome afterwards', async () => {
    const g = await create();
    await put(g.id, {
      status: 'implementing',
      provisioning: 'ok',
      implementer: DEV,
      pr: { number: 11, state: 'draft', headSha: HEAD },
    });
    const done = await post(g.id, '/actions/discard-to-planning', {
      version: (await current(g.id)).version,
    });
    expect(done.status).toBe(200);
    const view = await viewOf(g.id);
    expect(view.pendingAction ?? null).toBeNull();
    expect(view.lastOutcome ?? null).toBeNull();
    expect((await current(g.id)).status).toBe('planning');
  });

  it('Discard on a sub that queued a run still records a pending click tied to that run', async () => {
    const g = await create({ type: 'sub' });
    await put(g.id, {
      status: 'implementing',
      provisioning: 'ok',
      pr: { number: 12, state: 'draft', headSha: HEAD },
    });
    const done = await post(g.id, '/actions/start-again', {
      version: (await current(g.id)).version,
    });
    expect(done.status).toBe(200);
    const view = (await done.json()) as {
      pendingAction?: { kind: string; runId?: string } | null;
      currentRun: { id: string; state: string } | null;
    };
    if (view.currentRun?.state === 'queued')
      expect(view.pendingAction).toMatchObject({ kind: 'start_again', runId: view.currentRun.id });
    else expect(view.pendingAction ?? null).toBeNull();
  });
});
