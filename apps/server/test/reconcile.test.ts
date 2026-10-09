import { GlobService, machine } from '@slop/core';
import type { Board, Effect, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { PrSnapshot } from '../src/codehost.js';
import { ReconcileWatch } from '../src/jobs/reconcile.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

class FakeHost extends FakeCodeHost {
  pr: PrSnapshot = { state: 'open', draft: false, headSha: 'h1', mergeSha: null };
  mergeStateNow: 'passed' | 'pending' | 'failed' = 'passed';
  override prState = () => Promise.resolve(this.pr);
  override mergeState = () => Promise.resolve({ sha: this.pr.headSha, state: this.mergeStateNow });
}

describe('reconcile: catching up on webhooks slop missed', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let host: FakeHost;
  let executors: ReturnType<typeof codeHostExecutors>;
  let nowMs = Date.parse('2026-10-09T12:00:00Z');
  const logged: string[] = [];

  const boardOf = (boardId: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(boardId));

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('reconcile'));
    store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date(nowMs).toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({ name: 'test', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: DEV, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    host = new FakeHost();
    const boards = { recordBaseChecks: () => Promise.resolve(null) };
    executors = codeHostExecutors(host, boardOf, new FileRoutines('/nonexistent/routines.json'), boards, () => new Date(nowMs).toISOString(), null, null, undefined, (task, message) => logged.push(`${task}: ${message}`));
  });

  afterAll(() => drop());

  const current = async (id: string) => unwrap(await globs.get(DEV, id)).glob;

  /** A same in review whose recorded state is what a lost webhook left behind. */
  const newOpenGlob = async (title: string, pr: { state: 'draft' | 'ready'; headSha: string }, status: 'in_progress' | 'pr_open' = 'pr_open') => {
    const created = unwrap(await globs.create(DEV, { boardId: 1, title, summary: '', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(created.id);
      if (g === null) throw new Error('missing');
      await tx.updateGlob({ ...g, status, pr: { number: 7, ...pr }, version: g.version + 1 }, g.version);
    });
    return created.id;
  };

  const pending = async (globId: string, kind: Effect['kind']) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter((row) => row.kind === kind && row.state === 'pending');

  /** Runs every pending effect of `kind` on `globId` as the outbox would. */
  const run = async (globId: string, kind: Effect['kind']) => {
    const executor = executors[kind];
    if (executor === undefined) throw new Error(`No executor for ${kind}`);
    const outcomes = [];
    for (const row of await pending(globId, kind)) {
      outcomes.push(await executor(row.effect, await globs.peek(globId), { globs }));
      await database.db.update(schema.outbox).set({ state: 'done' }).where(and(eq(schema.outbox.id, row.id), eq(schema.outbox.state, 'pending')));
    }
    return outcomes;
  };

  const reconcile = async (id: string) => {
    await globs.applyEvent(id, (g, ctx) => machine.reconcileRequested(g, ctx));
    const outcomes = await run(id, 'reconcile_pr');
    await run(id, 'refresh_checks');
    return outcomes;
  };

  it('records passed checks on a ready PR that has none, and a second run changes nothing', async () => {
    host.pr = { state: 'open', draft: false, headSha: 'h1', mergeSha: null };
    host.mergeStateNow = 'passed';
    const id = await newOpenGlob('Missed checks', { state: 'ready', headSha: 'h1' });
    expect(await reconcile(id)).toEqual(['done']);
    expect((await current(id)).headChecks).toMatchObject({ sha: 'h1', state: 'passed' });
    expect(logged.some((line) => line.includes(`${id} rereading head checks`))).toBe(true);
    const before = await current(id);
    await reconcile(id);
    const after = await current(id);
    expect({ status: after.status, pr: after.pr, headChecks: after.headChecks }).toEqual({ status: before.status, pr: before.pr, headChecks: before.headChecks });
    expect(await pending(id, 'refresh_checks')).toEqual([]);
  });

  it('applies a missed merge as the webhook would', async () => {
    host.pr = { state: 'merged', draft: false, headSha: 'h1', mergeSha: 'm9' };
    const id = await newOpenGlob('Missed merge', { state: 'ready', headSha: 'h1' });
    await reconcile(id);
    expect((await current(id)).status).toBe('reviewing');
    // Nothing is left to reconcile, so a second run is dropped.
    await globs.applyEvent(id, (g, ctx) => machine.reconcileRequested(g, ctx));
    expect(await pending(id, 'reconcile_pr')).toEqual([]);
  });

  it('applies a missed close, a missed push and a missed ready', async () => {
    host.pr = { state: 'closed', draft: false, headSha: 'h1', mergeSha: null };
    const closed = await newOpenGlob('Missed close', { state: 'ready', headSha: 'h1' });
    await reconcile(closed);
    expect((await current(closed)).status).toBe('failed');

    host.pr = { state: 'open', draft: false, headSha: 'h2', mergeSha: null };
    const pushed = await newOpenGlob('Missed push', { state: 'ready', headSha: 'h1' });
    await reconcile(pushed);
    expect((await current(pushed)).pr?.headSha).toBe('h2');

    host.pr = { state: 'open', draft: false, headSha: 'h1', mergeSha: null };
    const readied = await newOpenGlob('Missed ready', { state: 'draft', headSha: 'h1' }, 'in_progress');
    await reconcile(readied);
    expect(await current(readied)).toMatchObject({ status: 'pr_open', pr: { state: 'ready' } });
  });

  it('the periodic sweep only touches stale globs, and start touches every open one', async () => {
    host.pr = { state: 'open', draft: false, headSha: 'h1', mergeSha: null };
    const stale = await newOpenGlob('Stale', { state: 'ready', headSha: 'h1' });
    nowMs += 11 * 60_000;
    const fresh = await newOpenGlob('Fresh', { state: 'ready', headSha: 'h1' });
    const watch = new ReconcileWatch(store, globs, () => undefined, () => nowMs);
    const swept = await watch.sweep(false);
    expect(swept).toContain(stale);
    expect(swept).not.toContain(fresh);
    expect(await watch.sweep(true)).toEqual(expect.arrayContaining([stale, fresh]));
  });
});
