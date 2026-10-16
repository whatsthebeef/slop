import { BoardService, GlobService } from '@slop/core';
import type { Glob } from '@slop/core';
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

const globOf = (patch: Partial<Glob> & Pick<Glob, 'id' | 'boardId'>): Glob => ({
  title: `Change ${patch.id}`,
  type: 'sub',
  category: 'task',
  group: null,
  environment: null,
  status: 'reviewing',
  version: 1,
  generation: 1,
  creator: 'member@example.com',
  planner: 'member@example.com',
  implementer: null,
  labels: {},
  checklists: {},
  pr: null,
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  signedOffAt: null,
  doingSince: null,
  ...patch,
});

describe('the board keeps the latest signed-off globs', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let app: Hono<Env>;
  let globs: GlobService;
  let boardId = 0;
  const auth = { authorization: 'Bearer dev:member@example.com' };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('signed_off_cap'));
    const { db } = database;
    const store = new PgStore(db);
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
      auth: new Auth(db, loadConfig({})),
      links: new SignedLinks('test'),
      boards,
      globs,
      hub,
      outbox: new OutboxRunner(db, { globs }, {}, () => undefined),
      onBoardCreated: () => Promise.resolve(),
    });
    await store.transaction((tx) => tx.upsertUser({ email: 'member@example.com', name: 'Member', active: true }));
    const created = await boards.create('member@example.com', { name: 'b', repo: null, timeZone: 'UTC', environments: [{ name: 'production', allowBranchDeploy: false }] });
    if (!created.ok) throw new Error(created.error.message);
    boardId = created.value.id;
    await store.transaction(async (tx) => {
      // Signed off in id order, the oldest first; the last-edited one is the oldest, which must not bring it back.
      for (let n = 1; n <= 30; n++) {
        const signedOffAt = new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
        await tx.insertGlob(globOf({ id: `s${boardId}t${n}`, boardId, status: 'signed_off', signedOffAt, updatedAt: n === 1 ? '2026-10-09T00:00:00.000Z' : signedOffAt }), null);
      }
      await tx.insertGlob(globOf({ id: `s${boardId}t31`, boardId, status: 'in_progress' }), null);
    });
  });

  afterAll(async () => {
    await drop();
  });

  it('returns the open globs and only the 25 latest signed off, with the total beside', async () => {
    const list = (await (await app.request(`/api/boards/${boardId}/globs`, { headers: auth })).json()) as { id: string; status: string }[];
    const signedOff = list.filter((g) => g.status === 'signed_off').map((g) => g.id);
    expect(signedOff).toHaveLength(25);
    expect(signedOff).not.toContain(`s${boardId}t1`);
    expect(signedOff).toContain(`s${boardId}t30`);
    expect(list.filter((g) => g.status !== 'signed_off')).toHaveLength(1);
    const count = await app.request(`/api/boards/${boardId}/signed-off/count`, { headers: auth });
    expect(await count.json()).toEqual({ total: 30 });
  });

  it('leaves the Signed off tab with all of them', async () => {
    const page = (await (await app.request(`/api/boards/${boardId}/signed-off`, { headers: auth })).json()) as { globs: { id: string }[]; next: string | null };
    expect(page.globs).toHaveLength(30);
    expect(page.globs[0]?.id).toBe(`s${boardId}t30`);
  });

  it('keeps an older signed-off glob that still has an open rollout step, with plain Arm system (s15f176)', async () => {
    const added = await globs.addHumanStep('member@example.com', `s${boardId}t1`, null, { title: 'Roll out production', due: 'after_deploy:production' });
    expect(added.ok).toBe(true);
    const list = (await (await app.request(`/api/boards/${boardId}/globs`, { headers: auth })).json()) as { id: string; status: string; arm?: { title: string } }[];
    const signedOff = list.filter((g) => g.status === 'signed_off');
    expect(signedOff).toHaveLength(26);
    expect(signedOff.find((g) => g.id === `s${boardId}t1`)?.arm).toEqual({ title: 'Roll out production' });
    expect(signedOff.find((g) => g.id === `s${boardId}t30`)?.arm).toBeUndefined();
  });

  it('keeps a signed-off glob with an open downstream step beyond the cap, and drops it once a person ticks the step', async () => {
    const added = await globs.addHumanStep('member@example.com', `s${boardId}t2`, null, { title: 'Run on prod as each is released: Flip it', downstream: true });
    expect(added.ok).toBe(true);
    type Row = { id: string; status: string; arm?: { title: string } };
    const listed = async () => ((await (await app.request(`/api/boards/${boardId}/globs`, { headers: auth })).json()) as Row[]).filter((g) => g.status === 'signed_off');
    const before = await listed();
    expect(before).toHaveLength(27);
    expect(before.find((g) => g.id === `s${boardId}t2`)?.arm).toEqual({ title: 'Run on prod as each is released: Flip it' });
    if (!added.ok) return;
    expect((await globs.completeHumanStep('member@example.com', `s${boardId}t2`, added.value.id, null)).ok).toBe(true);
    const after = await listed();
    expect(after.map((g) => g.id)).not.toContain(`s${boardId}t2`);
    expect(after).toHaveLength(26);
  });
});
