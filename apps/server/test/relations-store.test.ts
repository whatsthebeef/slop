import { BoardService, GlobService, LABEL_NAMES, RELATION_SCAN_DEBOUNCE_MS, sentenceHash } from '@slop/core';
import type { Effect, Relation, RelationScanRow, Result } from '@slop/core';
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
  kind: 'waits',
  group: null,
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

  it('keeps a supersession out of the three list methods and reads it with its own two (the memory store has the same test)', async () => {
    const waits = relation({ id: 'rel_w', from: 's1t1', to: 's1t2' });
    const supersession = relation({ id: 'rel_s', from: 's1t11', to: 's1t13', gate: 'sign_off', kind: 'superseded_by', source: 'agent', reason: 'replaces it' });
    await store.transaction(async (tx) => {
      expect(await tx.insertRelation(waits)).toBe(true);
      expect(await tx.insertRelation(supersession)).toBe(true);
      // The same pair and gate is allowed once per kind, and not twice.
      expect(await tx.insertRelation({ ...waits, id: 'rel_other_kind', kind: 'superseded_by' })).toBe(true);
      expect(await tx.insertRelation({ ...supersession, id: 'rel_dup' })).toBe(false);
    });
    expect(await rows()).toEqual([waits]);
    expect(await store.transaction((tx) => tx.listRelationsFrom(['s1t11', 's1t1']))).toEqual([waits]);
    expect(await store.transaction((tx) => tx.listRelationsTo(['s1t13', 's1t2']))).toEqual([waits]);
    expect((await store.transaction((tx) => tx.listSupersessions(['s1t11']))).map((r) => r.id)).toEqual(['rel_s']);
    expect((await store.transaction((tx) => tx.listSupersededBy(['s1t13']))).map((r) => r.id)).toEqual(['rel_s']);
    expect(await store.transaction((tx) => tx.listSupersessions([]))).toEqual([]);
    expect(await store.transaction((tx) => tx.listSupersededBy(['s1t11']))).toEqual([]);
    const long = Array.from({ length: 70_000 }, (_, i) => `s1t${String(i + 100)}`);
    expect(await store.transaction((tx) => tx.listSupersessions(long))).toEqual([]);
    await store.transaction(async (tx) => {
      await tx.deleteRelationsFrom('s1t1');
      await tx.deleteRelationsFrom('s1t11');
    });
    expect(await rows()).toEqual([]);
  });

  it('lists a cross-board relation under the holder\'s board and to the target on any board', async () => {
    const cross = relation({ id: 'rel_x', from: 's1t1', to: 's2t5' });
    await store.transaction((tx) => tx.insertRelation(cross));
    expect(await store.transaction((tx) => tx.listRelationsTo(['s2t5']))).toEqual([cross]);
    expect(await store.transaction((tx) => tx.listRelations(2))).toEqual([]);
    await store.transaction((tx) => tx.deleteRelation('rel_x'));
  });

  it('serialises relation writers with one instance-wide lock, whichever way it is taken', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.transaction(async (tx) => {
      await tx.lockRelations();
      order.push('first locked');
      await held;
      order.push('first done');
    });
    // Let the first transaction take the lock before the second asks for it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = store.transaction(async (tx) => {
      await tx.lockBoardRelations(boardId + 1);
      order.push('second locked');
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(order).toEqual(['first locked']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first locked', 'first done', 'second locked']);
  });

  describe('the relation scan', () => {
    const scan = (patch: Partial<RelationScanRow> = {}): RelationScanRow => ({
      globId: 's1t1',
      mentionedId: 's1t2',
      sentenceHash: sentenceHash('Waits for s1t2.'),
      boardId,
      kind: 'mention',
      decision: 'suggested',
      gate: 'sign_off',
      reason: 'Waits for s1t2.',
      sentence: 'Waits for s1t2.',
      relationId: null,
      state: 'open',
      model: null,
      createdAt: AT,
      decidedAt: null,
      ...patch,
    });

    it('keeps the first decision for a pair and sentence, lists open suggestions, patches one row, and reads a long list as one parameter', async () => {
      await store.transaction((tx) => tx.upsertRelationScans([scan(), scan({ mentionedId: 's1t3', decision: 'history', state: 'done' })]));
      await store.transaction((tx) => tx.upsertRelationScans([scan({ decision: 'not_prerequisite', state: 'dismissed' })]));
      expect((await store.transaction((tx) => tx.listRelationScans('s1t1'))).map((r) => [r.mentionedId, r.decision, r.state])).toEqual([
        ['s1t2', 'suggested', 'open'],
        ['s1t3', 'history', 'done'],
      ]);
      expect(await store.transaction((tx) => tx.listRelationScans('s1t1'))).toContainEqual(scan());
      expect((await store.transaction((tx) => tx.listOpenSuggestions(['s1t1', 's1t9']))).map((r) => r.mentionedId)).toEqual(['s1t2']);
      expect(await store.transaction((tx) => tx.listOpenSuggestions([]))).toEqual([]);
      const long = Array.from({ length: 70_000 }, (_, i) => `s1t${String(i + 100)}`);
      expect(await store.transaction((tx) => tx.listOpenSuggestions(long))).toEqual([]);
      await store.transaction((tx) => tx.updateRelationScan('s1t1', 's1t2', sentenceHash('Waits for s1t2.'), { state: 'dismissed', decidedAt: AT, relationId: 'rel_a' }));
      expect(await store.transaction((tx) => tx.listOpenSuggestions(['s1t1']))).toEqual([]);
      expect((await store.transaction((tx) => tx.listRelationScans('s1t1')))[0]).toMatchObject({ state: 'dismissed', decidedAt: AT, relationId: 'rel_a', decision: 'suggested' });
    });

    it('a transaction that throws leaves no scan row behind', async () => {
      await expect(
        store.transaction(async (tx) => {
          await tx.upsertRelationScans([scan({ globId: 's1t77' })]);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await store.transaction((tx) => tx.listRelationScans('s1t77'))).toEqual([]);
    });

    it('queues one unclaimed scan_relations job per glob on the llm lane and pushes its runAfter out on every trigger', async () => {
      const effect = (globId: string): Effect => ({ kind: 'scan_relations', globId });
      const jobs = () => store.transaction((tx) => tx.latestOutboxJobs(['s1t5', 's1t6'], ['scan_relations']));
      const before = Date.now();
      await store.transaction((tx) => tx.enqueueEffects([effect('s1t5')]));
      const first = (await jobs())[0];
      expect(first?.state).toBe('pending');
      expect(Date.parse(first?.runAfter ?? '') - before).toBeGreaterThanOrEqual(RELATION_SCAN_DEBOUNCE_MS - 1_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await store.transaction((tx) => tx.enqueueEffects([effect('s1t5'), effect('s1t5'), effect('s1t6')]));
      const after = await jobs();
      expect(after).toHaveLength(2);
      const again = after.find((j) => j.globId === 's1t5');
      expect(again?.id).toBe(first?.id);
      expect(Date.parse(again?.runAfter ?? '')).toBeGreaterThan(Date.parse(first?.runAfter ?? ''));
    });
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
