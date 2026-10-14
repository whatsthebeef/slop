import { BoardService, GlobService, LABEL_NAMES } from '@slop/core';
import type { Relation, Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { StallWatch } from '../src/jobs/stall-watch.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const AT = '2026-10-05T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const relation = (patch: Partial<Relation> & Pick<Relation, 'id' | 'from' | 'to'>): Relation => ({
  boardId: 1,
  gate: 'start',
  until: 'merged',
  reason: null,
  evidence: [],
  source: 'person',
  dismissedAt: null,
  dismissedPlanHash: null,
  overriddenAt: null,
  createdAt: AT,
  ...patch,
});

/** The relation reads and writes of the Postgres store, and the service's writes over them (the memory store has the same tests in core). */
describe('relations in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let boardId = 0;

  const create = async (patch: Record<string, unknown> = {}) =>
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
  const rows = () => store.transaction((tx) => tx.listRelations(boardId));

  beforeAll(async () => {
    const test = await createTestDatabase('relations_store');
    drop = test.drop;
    store = new PgStore(test.database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const boards = new BoardService({ store, notifier: { publish: () => undefined } });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: 'Dev', active: true }));
    boardId = unwrap(await boards.create(DEV, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('inserts, reads by board, by from and by to, patches and deletes', async () => {
    const a = relation({ id: 'rel_a', from: 's1t1', to: 's1t2', evidence: ['a.ts'], reason: 'uses it' });
    const b = relation({ id: 'rel_b', from: 's1t1', to: 's1t3', gate: 'sign_off', source: 'split' });
    await store.transaction(async (tx) => {
      expect(await tx.insertRelation(a)).toBe(true);
      expect(await tx.insertRelation(b)).toBe(true);
      // One relation per glob, target and gate.
      expect(await tx.insertRelation({ ...a, id: 'rel_dup' })).toBe(false);
    });
    expect(await rows()).toEqual([a, b]);
    expect(await store.transaction((tx) => tx.listRelationsFrom(['s1t1', 's1t9']))).toEqual([a, b]);
    expect(await store.transaction((tx) => tx.listRelationsFrom([]))).toEqual([]);
    expect(await store.transaction((tx) => tx.listRelationsTo(['s1t3']))).toEqual([b]);
    await store.transaction((tx) => tx.updateRelation('rel_a', { dismissedAt: AT, dismissedPlanHash: 'h1', reason: 'changed' }));
    expect((await rows())[0]).toMatchObject({ dismissedAt: AT, dismissedPlanHash: 'h1', reason: 'changed', evidence: ['a.ts'] });
    await store.transaction((tx) => tx.updateRelation('rel_a', { dismissedAt: null, dismissedPlanHash: null, overriddenAt: AT }));
    expect((await rows())[0]).toMatchObject({ dismissedAt: null, dismissedPlanHash: null, overriddenAt: AT });
    await store.transaction((tx) => tx.deleteRelation('rel_b'));
    expect(await rows()).toHaveLength(1);
    await store.transaction((tx) => tx.deleteRelationsFrom('s1t1'));
    expect(await rows()).toEqual([]);
  });

  it('reads a long list of IDs as one parameter', async () => {
    const ids = Array.from({ length: 70_000 }, (_, i) => `s1t${String(i + 100)}`);
    expect(await store.transaction((tx) => tx.listRelationsFrom(ids))).toEqual([]);
    expect(await store.transaction((tx) => tx.listRelationsTo(ids))).toEqual([]);
  });

  it('a transaction that throws leaves no relation behind', async () => {
    await expect(
      store.transaction(async (tx) => {
        await tx.insertRelation(relation({ id: 'rel_gone', from: 's1t1', to: 's1t2' }));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await rows()).toEqual([]);
  });

  it('the service writes needs with the glob, bumps the version of what changes, and deleting the glob removes its own rows only', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    expect(second.status).toBe('planning');
    expect((await rows()).map((r) => [r.from, r.to, r.gate, r.source])).toEqual([[second.id, first.id, 'start', 'person']]);
    const edited = unwrap(await globs.update(DEV, second.id, second.version, { after: [] }));
    expect(edited.version).toBeGreaterThan(second.version);
    expect(await rows()).toEqual([]);
    expect(edited.status).toBe('implementing');
    const third = await create({ type: 'sub', after: [first.id] });
    expect(third.status).toBe('planning');
    unwrap(await globs.delete(DEV, first.id, first.version));
    // The relation pointing at the deleted glob stays, and what waited for it started.
    expect((await rows()).map((r) => r.to)).toEqual([first.id]);
    const started = await globs.peek(third.id);
    expect(started?.status).toBe('implementing');
    expect(started?.version ?? 0).toBeGreaterThan(third.version);
    unwrap(await globs.delete(DEV, third.id, started?.version ?? 0));
    expect(await rows()).toEqual([]);
  });

  it('two cycle-closing writes at once: exactly one wins, under the board lock', async () => {
    const a = await create();
    const b = await create();
    const results = await Promise.all([
      globs.update(DEV, a.id, a.version, { after: [b.id] }),
      globs.update(DEV, b.id, b.version, { after: [a.id] }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.flatMap((r) => (r.ok ? [] : [r.error.message]))).toEqual([expect.stringContaining('cycle')]);
    expect(await rows()).toHaveLength(1);
  });
  it('two cycle-closing addRelation calls across gates at once (start and merge, and a decision-direction add): exactly one wins', async () => {
    const a = await create();
    const b = await create();
    const mixed = await Promise.all([
      globs.addRelation(DEV, a.id, a.version, { to: b.id, gate: 'start' }),
      globs.addRelation(DEV, b.id, b.version, { to: a.id, gate: 'merge' }),
    ]);
    expect(mixed.filter((r) => r.ok)).toHaveLength(1);
    expect(mixed.flatMap((r) => (r.ok ? [] : [r.error.message]))).toEqual([expect.stringContaining('cycle')]);

    const c = await create();
    const d = await create();
    const reverse = await Promise.all([
      globs.addRelation(DEV, c.id, c.version, { to: d.id }),
      globs.addRelation(DEV, c.id, null, { to: d.id }, 'holds_back'),
    ]);
    expect(reverse.filter((r) => r.ok)).toHaveLength(1);
    expect((await rows()).filter((r) => [c.id, d.id].includes(r.from) && [c.id, d.id].includes(r.to))).toHaveLength(1);
  });

  /** A service whose store bumps glob `target`'s version right before its first conditional write, as a webhook would between read and write. */
  const racingOn = (target: string): GlobService => {
    let bumped = false;
    return new GlobService({
      store: {
        transaction: (work) =>
          store.transaction((tx) =>
            work(
              new Proxy(tx, {
                get: (inner, prop) => {
                  if (prop !== 'updateGlob') {
                    const member: unknown = Reflect.get(inner, prop);
                    return typeof member === 'function' ? (...args: unknown[]): unknown => Reflect.apply(member, inner, args) : member;
                  }
                  return async (next: Parameters<typeof tx.updateGlob>[0], version: number) => {
                    if (!bumped && next.id === target) {
                      bumped = true;
                      await store.transaction(async (other) => {
                        const current = await other.getGlob(target);
                        if (current !== null) await other.updateGlob({ ...current, version: current.version + 1 }, current.version);
                      });
                    }
                    return inner.updateGlob(next, version);
                  };
                },
              }),
            ),
          ),
      },
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
  };

  it('a lost version race rolls the relation rows back with it (no row, no event, a version_conflict)', async () => {
    const a = await create();
    const b = await create();
    const racing = racingOn(a.id);
    const lost = await racing.addRelation(DEV, a.id, a.version, { to: b.id, gate: 'merge' });
    expect(lost.ok ? null : lost.error.code).toBe('version_conflict');
    expect((await rows()).filter((r) => r.from === a.id)).toEqual([]);
    const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['RelationAdded'], [a.id]));
    expect(events.some((e) => e.type === 'RelationAdded')).toBe(false);
  });

  it('the stall watch does not raise a Reviewing glob that waits only for an unmet sign-off relation', async () => {
    const part = await create();
    const source = await create({ relations: [{ to: part.id, gate: 'sign_off' }] });
    // Reviewing with every label approved and nothing else to do: only the relation holds the sign-off.
    await store.transaction((tx) =>
      tx.updateGlob(
        {
          ...source,
          status: 'reviewing',
          provisioning: 'ok',
          version: source.version + 1,
          labels: Object.fromEntries(LABEL_NAMES.map((name) => [name, 'approved'])),
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
        source.version,
      ),
    );
    const raised: string[] = [];
    const watch = new StallWatch(store, globs, { raise: (n) => Promise.resolve(void raised.push(n.source)), clear: () => Promise.resolve() }, () => undefined);
    await watch.check();
    expect(raised.filter((r) => r.includes(source.id))).toEqual([]);
  });

  it('deleting a glob retries when a glob waiting for it changes meanwhile, and still releases it once', async () => {
    const gone = await create();
    const waiting = await create({ after: [gone.id] });
    const deleted = await racingOn(waiting.id).delete(DEV, gone.id, gone.version);
    expect(deleted.ok).toBe(true);
    expect(await store.transaction((tx) => tx.getGlob(gone.id))).toBeNull();
    const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['RelationReleased'], [waiting.id]));
    expect(events).toHaveLength(1);
  });
});
