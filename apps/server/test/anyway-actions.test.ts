import { BoardService, GlobService } from '@slop/core';
import type { Glob, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
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

/** Start now, Merge anyway and Sign off anyway over REST, on Postgres: what each overrides, who and why it is logged. */
describe('the anyway actions (REST)', () => {
  let drop: () => Promise<void>;
  let database: Database;
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
    unwrap(await globs.create(DEV, { boardId, title: 'Work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, ...patch }));
  const current = async (id: string): Promise<Glob> => {
    const glob = await store.transaction((tx) => tx.getGlob(id));
    if (glob === null) throw new Error(`No glob ${id}`);
    return glob;
  };
  const put = async (id: string, patch: Partial<Glob>): Promise<Glob> => {
    const glob = await current(id);
    const next = { ...glob, ...patch, version: glob.version + 1 };
    if (!(await store.transaction((tx) => tx.updateGlob(next, glob.version)))) throw new Error('version race');
    return next;
  };
  const eventsOf = (id: string, type: string) =>
    database.db.select().from(schema.events).where(and(eq(schema.events.globId, id), eq(schema.events.type, type)));
  const relate = async (id: string, to: string, gate: 'start' | 'merge' | 'sign_off') =>
    unwrap(await globs.addRelation(DEV, id, (await current(id)).version, { to, gate, reason: 'because' }));

  beforeAll(async () => {
    const test = await createTestDatabase('anyway_actions');
    drop = test.drop;
    database = test.database;
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
    const created = await boards.create(DEV, { name: 'b', repo: null, timeZone: 'UTC', environments: [] });
    boardId = unwrap(created).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('merge-anyway: refused without a reason, then merges a held same, lifts the relation and logs who and why', async () => {
    const first = await create();
    const held = await create();
    await relate(held.id, first.id, 'merge');
    await put(held.id, { status: 'pr_open', provisioning: 'ok', implementer: DEV, pr: { number: 7, state: 'ready', headSha: HEAD }, headChecks: { sha: HEAD, state: 'passed' } });

    const view = await app.request(`/api/globs/${held.id}`, { headers: { authorization: `Bearer dev:${DEV}` } });
    const actions = ((await view.json()) as { allowedActions: string[] }).allowedActions;
    expect(actions).toContain('merge_anyway');
    expect(actions).not.toContain('merge');

    const plain = await post(held.id, '/actions/merge', { version: (await current(held.id)).version });
    expect(plain.status).toBe(409);
    const bare = await post(held.id, '/actions/merge-anyway', { version: (await current(held.id)).version });
    expect(bare.status).toBe(409);
    expect(((await bare.json()) as { message: string }).message).toBe('Say why you are merging anyway');

    const done = await post(held.id, '/actions/merge-anyway', { version: (await current(held.id)).version, reason: 'It only changes a comment' });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { status: string }).status).toBe('merging');
    expect(await eventsOf(held.id, 'MergeOverridden')).toMatchObject([{ actor: DEV, data: { for: [first.id], reason: 'It only changes a comment' } }]);
    expect(await eventsOf(held.id, 'HoldOverridden')).toEqual([]);
    const rows = await store.transaction((tx) => tx.listRelationsFrom([held.id]));
    expect(rows[0]?.overriddenAt).not.toBeNull();
  });

  it('sign-off-anyway: signs off a merged glob with approved labels held by a sign_off relation, and logs who and why', async () => {
    const first = await create();
    const held = await create();
    await relate(held.id, first.id, 'sign_off');
    await put(held.id, { status: 'reviewing', provisioning: 'ok', pr: { number: 8, state: 'merged', headSha: HEAD }, labels: { QA: 'approved' } });

    const refused = await post(held.id, '/actions/sign-off-anyway', { version: (await current(held.id)).version });
    expect(refused.status).toBe(409);
    const done = await post(held.id, '/actions/sign-off-anyway', { version: (await current(held.id)).version, reason: 'The other glob is a nice-to-have' });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { status: string }).status).toBe('signed_off');
    expect(await eventsOf(held.id, 'SignOffOverridden')).toMatchObject([{ actor: DEV, data: { for: [first.id], reason: 'The other glob is a nice-to-have' } }]);
    // Nothing is held now: a second try is refused.
    const again = await post(held.id, '/actions/sign-off-anyway', { version: (await current(held.id)).version, reason: 'again' });
    expect(again.status).toBe(409);
  });

  it('start-anyway: the reason is optional and, when given, is logged with who did it', async () => {
    const first = await create();
    const withReason = await create({ after: [first.id] });
    const started = await post(withReason.id, '/actions/start-anyway', { version: (await current(withReason.id)).version, reason: 'Needed for the demo' });
    expect(started.status).toBe(200);
    expect(await eventsOf(withReason.id, 'HoldOverridden')).toMatchObject([{ actor: DEV, data: { for: [first.id], reason: 'Needed for the demo' } }]);

    const second = await create();
    const bare = await create({ after: [second.id] });
    expect((await post(bare.id, '/actions/start-anyway', { version: (await current(bare.id)).version })).status).toBe(200);
    expect((await eventsOf(bare.id, 'HoldOverridden'))[0]?.data).not.toHaveProperty('reason');
  });
});
