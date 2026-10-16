import { readFile } from 'node:fs/promises';
import { BoardService, GlobService, RelationLearningService } from '@slop/core';
import type { Relation, RelationSignal, Result } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';
import type { Database } from '../src/db/store.js';

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
  source: 'inferred',
  kind: 'waits',
  group: null,
  dismissedAt: null,
  dismissedPlanHash: null,
  overriddenAt: null,
  createdAt: AT,
  ...patch,
});

const signal = (patch: Partial<RelationSignal> & Pick<RelationSignal, 'id' | 'key'>): RelationSignal => ({
  boardId: 1,
  from: 's9t1',
  to: 's9t2',
  relationId: null,
  source: 'inferred',
  signal: 'fp_override',
  at: AT,
  evidence: 'went ahead anyway',
  ...patch,
});

/** The relation learning tables and columns (migration 0084), the store reads over them, and the service over Postgres. */
describe('relation learning in Postgres', () => {
  let drop: () => Promise<void>;
  let database: Database;
  let store: PgStore;
  let globs: GlobService;
  let learning: RelationLearningService;
  let boardId = 0;

  beforeAll(async () => {
    const test = await createTestDatabase('relation_learning');
    drop = test.drop;
    database = test.database;
    store = new PgStore(test.database.db);
    const notifier = { publish: (): void => undefined };
    const clock = { now: (): string => new Date().toISOString() };
    const ids = { runId: (): string => crypto.randomUUID() };
    learning = new RelationLearningService({ store, notifier, clock, ids });
    globs = new GlobService({ store, notifier, clock, ids, routines: { hasRoutine: () => Promise.resolve(true) }, relationLearning: learning });
    const boards = new BoardService({ store, notifier });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: 'Dev', active: true }));
    boardId = unwrap(await boards.create(DEV, { name: 'b', repo: null, timeZone: 'UTC', environments: [] })).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('applies twice: the migration is idempotent and leaves the tables and columns in place', async () => {
    const text = await readFile(new URL('../drizzle/0084_relation_learning.sql', import.meta.url), 'utf8');
    for (let round = 0; round < 2; round++) {
      for (const statement of text.split('--> statement-breakpoint')) await database.db.execute(sql.raw(statement));
    }
    const tables = await database.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('relation_signals', 'relation_learning')`,
    );
    expect(tables.map((t) => t.table_name).sort()).toEqual(['relation_learning', 'relation_signals']);
    const columns = await database.db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'relations' and column_name like 'verdict%'`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(['verdict', 'verdict_at', 'verdict_by', 'verdict_reason']);
  });

  it('records a signal once per board and key, and reads a board within a window, oldest first', async () => {
    const later = '2026-10-10T12:00:00.000Z';
    await store.transaction(async (tx) => {
      expect(await tx.insertRelationSignal(signal({ id: 'sig_1', key: 'override:rel_1', relationId: 'rel_1' }))).toBe(true);
      expect(await tx.insertRelationSignal(signal({ id: 'sig_2', key: 'override:rel_1', relationId: 'rel_1' }))).toBe(false);
      expect(await tx.insertRelationSignal(signal({ id: 'sig_3', key: 'person:a>b', source: 'person', signal: 'fn_person_added', at: later }))).toBe(true);
    });
    const all = await store.transaction((tx) => tx.listRelationSignals(boardId));
    expect(all.map((s) => [s.id, s.signal, s.source, s.relationId])).toEqual([
      ['sig_1', 'fp_override', 'inferred', 'rel_1'],
      ['sig_3', 'fn_person_added', 'person', null],
    ]);
    expect(all[0]).toEqual(signal({ id: 'sig_1', key: 'override:rel_1', relationId: 'rel_1' }));
    expect((await store.transaction((tx) => tx.listRelationSignals(boardId, '2026-10-08T00:00:00.000Z'))).map((s) => s.id)).toEqual(['sig_3']);
    expect(await store.transaction((tx) => tx.listRelationSignals(boardId + 1))).toEqual([]);
  });

  it('round-trips the verdict columns and leaves them out of a row that has none', async () => {
    const plain = relation({ id: 'rel_v1', from: 's9t1', to: 's9t7' });
    await store.transaction((tx) => tx.insertRelation(plain));
    expect(await store.transaction((tx) => tx.getRelation('rel_v1'))).toEqual(plain);
    await store.transaction((tx) => tx.updateRelation('rel_v1', { verdict: 'needed', verdictReason: 'uses holdWords from s9t7', verdictBy: 'git', verdictAt: AT }));
    expect(await store.transaction((tx) => tx.getRelation('rel_v1'))).toMatchObject({ verdict: 'needed', verdictReason: 'uses holdWords from s9t7', verdictBy: 'git', verdictAt: AT });
    expect(await store.transaction((tx) => tx.getRelation('rel_missing'))).toBeNull();
  });

  it('keeps a weak link and a gate for one pair side by side, and no gate list reads the weak one', async () => {
    const gate = relation({ id: 'rel_g', from: 's9t3', to: 's9t4' });
    const weak = relation({ id: 'rel_w', from: 's9t3', to: 's9t4', kind: 'may_relate', source: 'mention' });
    await store.transaction(async (tx) => {
      expect(await tx.insertRelation(weak)).toBe(true);
      expect(await tx.insertRelation(gate)).toBe(true);
      // Still one weak link per glob, target and gate.
      expect(await tx.insertRelation({ ...weak, id: 'rel_w2' })).toBe(false);
    });
    expect(await store.transaction((tx) => tx.listRelationsFrom(['s9t3']))).toEqual([gate]);
    expect(await store.transaction((tx) => tx.listRelationsTo(['s9t4']))).toEqual([gate]);
    expect((await store.transaction((tx) => tx.listRelations(boardId))).map((r) => r.id)).not.toContain('rel_w');
    expect(await store.transaction((tx) => tx.listSupersessions(['s9t3']))).toEqual([]);
    expect(await store.transaction((tx) => tx.listSupersededBy(['s9t4']))).toEqual([]);
    expect(await store.transaction((tx) => tx.listWeakRelationsFrom(['s9t3', 's9t9']))).toEqual([weak]);
    expect(await store.transaction((tx) => tx.listWeakRelationsFrom([]))).toEqual([]);
    expect(await store.transaction((tx) => tx.listWeakRelations(boardId))).toEqual([weak]);
    // Promoting flips the kind; the gate for the pair has to go first (one gate per pair).
    await store.transaction(async (tx) => {
      await tx.deleteRelation('rel_g');
      await tx.updateRelation('rel_w', { kind: 'waits' });
    });
    expect(await store.transaction((tx) => tx.listRelationsFrom(['s9t3']))).toEqual([{ ...weak, kind: 'waits' }]);
    expect(await store.transaction((tx) => tx.listWeakRelations(boardId))).toEqual([]);
  });

  it('keeps a board admin pins, empty by default, replaced on each write', async () => {
    expect(await store.transaction((tx) => tx.getRelationLearning(boardId))).toEqual({});
    const pins = { precisionThreshold: 0.4, postures: { mention: 'weak' as const }, history: [{ at: AT, by: DEV, what: 'pinned' }] };
    await store.transaction((tx) => tx.setRelationLearning(boardId, pins));
    expect(await store.transaction((tx) => tx.getRelationLearning(boardId))).toEqual(pins);
    await store.transaction((tx) => tx.setRelationLearning(boardId, { minSamples: 8 }));
    expect(await store.transaction((tx) => tx.getRelationLearning(boardId))).toEqual({ minSamples: 8 });
  });

  it('records a person-added relation and a weak mention link through the services', async () => {
    const make = async (): Promise<string> =>
      unwrap(await globs.create(DEV, { boardId, title: 'Work', plan: 'A plan long enough to count as one.', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null })).id;
    const a = await make();
    const b = await make();
    unwrap(await globs.addRelation(DEV, b, null, { to: a }, 'held_by', 'person'));
    const signals = await store.transaction((tx) => tx.listRelationSignals(boardId));
    expect(signals.find((s) => s.signal === 'fn_person_added' && s.from === b)).toMatchObject({ from: b, to: a, source: 'person', key: `person:${b}>${a}` });
    // A weak link is promoted to a gate, which holds the glob and records the promotion.
    const c = await make();
    const d = await make();
    await store.transaction((tx) => tx.insertRelation(relation({ id: 'rel_weak_cd', from: d, to: c, kind: 'may_relate', source: 'mention' })));
    unwrap(await globs.promoteRelation(DEV, d, null, 'rel_weak_cd'));
    expect((await store.transaction((tx) => tx.listRelationsFrom([d]))).map((r) => [r.id, r.kind])).toEqual([['rel_weak_cd', 'waits']]);
    expect((await store.transaction((tx) => tx.listRelationSignals(boardId))).find((s) => s.signal === 'tp_promoted')).toMatchObject({ from: d, to: c, source: 'mention', relationId: 'rel_weak_cd' });
    // Pins are admin only: the board's creator is its admin.
    expect(unwrap(await learning.pin(DEV, boardId, { postures: { mention: 'weak' } })).sources.find((s) => s.source === 'mention')?.posture).toMatchObject({ posture: 'weak', pinned: true });
  });
});
