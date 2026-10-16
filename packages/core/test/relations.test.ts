import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import {
  MAX_RELATIONS,
  UNTIL_WORDS,
  applyWrite,
  normaliseUntil,
  awaitedOf,
  checkRelation,
  checkRelationShape,
  holdWords,
  isMet,
  overrideEdits,
  refusalText,
  startIds,
  startReaches,
  toState,
  unmet,
  waitNote,
  wouldCycle,
} from '../src/domain/relations.js';
import type { RelationDraft, ToState } from '../src/domain/relations.js';
import type { Relation } from '../src/domain/types.js';
import { RELATION_SCAN_DEBOUNCE_MS, laneOf } from '../src/domain/events.js';
import type { Effect } from '../src/domain/events.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, ctx, dev, glob as fixture, relation, relationFacts } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const decision = (outcome: string | null, status: 'planning' | 'implementing' | 'reviewing' | 'signed_off' = 'implementing') =>
  fixture({
    category: 'decision',
    status,
    attributes: {
      kind: 'pattern',
      scope: { kind: 'project', ref: null },
      origin: { kind: 'manual' },
      channel: 'human',
      outcome: outcome === null ? null : { kind: outcome, by: 'x', at: NOW },
      conflictsWith: [],
    } as never,
  });

describe('the state of a glob a relation points at', () => {
  it('reads merged, signed off, planning, open and missing from the glob', () => {
    expect(toState(null)).toBe('missing');
    expect(toState(undefined)).toBe('missing');
    expect(toState(fixture({ status: 'reviewing' }))).toBe('merged');
    expect(toState(fixture({ status: 'signed_off' }))).toBe('signed_off');
    expect(toState(fixture({ status: 'planning' }))).toBe('planning');
    expect(toState(fixture({ status: 'pr_open' }))).toBe('open');
    // A super that merged and continues is still open.
    expect(toState(fixture({ status: 'in_progress', type: 'super', prs: [{ number: 1, mergeSha: 'a', mergedAt: '' }] }))).toBe('open');
  });

  it('a merged glob whose rollout holds back its dependants is in rollout', () => {
    const g = fixture({ id: 's1t5', status: 'reviewing' });
    expect(toState(g, new Set(['s1t5']))).toBe('rollout');
    expect(toState(fixture({ id: 's1t5', status: 'signed_off' }), new Set(['s1t5']))).toBe('rollout');
    expect(toState(g, new Set(['s1t6']))).toBe('merged');
  });

  it('a decision is decided by an accept, reject or closed outcome, not by needs work or none', () => {
    for (const kind of ['accept', 'accept_with_edits', 'reject', 'closed']) expect(toState(decision(kind))).toBe('decided');
    expect(toState(decision('needs_work'))).toBe('open');
    expect(toState(decision('retarget'))).toBe('open');
    expect(toState(decision(null))).toBe('open');
    expect(toState(decision(null, 'planning'))).toBe('planning');
    expect(toState(decision('accept', 'signed_off'))).toBe('signed_off');
  });
});

describe('when a relation is met', () => {
  const r = (patch: Partial<Relation> = {}) => relation('s1t1', 's1t2', patch);
  const states: ToState[] = ['open', 'planning', 'rollout', 'merged', 'decided', 'signed_off', 'missing'];
  const metBy = (rel: Relation) => states.filter((s) => isMet(rel, s));

  it('merged: the other glob has merged (or was decided or signed off); a deleted one releases it', () => {
    expect(metBy(r())).toEqual(['merged', 'decided', 'signed_off', 'missing']);
  });

  it('decided: the decision was made, or signed off', () => {
    expect(metBy(r({ until: 'decided' }))).toEqual(['decided', 'signed_off', 'missing']);
  });

  it('signed_off: only signed off', () => {
    expect(metBy(r({ until: 'signed_off' }))).toEqual(['signed_off', 'missing']);
  });

  it('a dismissed or overridden relation is met whatever the state', () => {
    expect(metBy(r({ dismissedAt: NOW, dismissedPlanHash: 'h' }))).toEqual(states);
    expect(metBy(r({ overriddenAt: NOW }))).toEqual(states);
  });
});

describe('what a glob waits for', () => {
  it('lists the unmet relations of one gate with the reason for each, and ignores the others', () => {
    const facts = {
      relations: [
        relation('s1t1', 's1t2'),
        relation('s1t1', 's1t3', { source: 'inferred', reason: 'uses its endpoint' }),
        relation('s1t1', 's1t4'),
        relation('s1t1', 's1t5', { gate: 'merge' }),
        relation('s1t1', 's1t6', { gate: 'sign_off' }),
      ],
      states: new Map<string, ToState>([
        ['s1t2', 'planning'],
        ['s1t3', 'open'],
        ['s1t4', 'merged'],
        ['s1t5', 'open'],
        ['s1t6', 'open'],
      ]),
    };
    expect(unmet(facts, 'start').map((u) => u.relation.to)).toEqual(['s1t2', 's1t3']);
    expect(unmet(facts, 'merge').map((u) => u.relation.to)).toEqual(['s1t5']);
    expect(unmet(facts, 'sign_off').map((u) => u.relation.to)).toEqual(['s1t6']);
    expect(awaitedOf(facts).map((a) => [a.id, a.state, a.why])).toEqual([
      ['s1t2', 'planning', 'Waits for s1t2 to merge (it is in Planning)'],
      ['s1t3', 'open', 'Waits for s1t3: uses its endpoint'],
    ]);
    expect(refusalText(awaitedOf(facts))).toBe('Waits for s1t2 to merge (it is in Planning); Waits for s1t3: uses its endpoint (use Start now)');
  });

  it('an unknown target reads as deleted and holds nothing', () => {
    expect(awaitedOf({ relations: [relation('s1t1', 's1t9')], states: new Map() })).toEqual([]);
  });

  it('words each gate and what it waits for', () => {
    expect(holdWords({ gate: 'start', to: 's1t2', until: 'merged' })).toBe("can't start until s1t2 is merged and rolled out");
    expect(holdWords({ gate: 'merge', to: 's1k4', until: 'decided' })).toBe("can't merge until s1k4 is decided");
    expect(holdWords({ gate: 'sign_off', to: 's1t3', until: 'signed_off' })).toBe("can't sign off until s1t3 is signed off");
    const note = (rel: Relation, state: ToState) => waitNote({ relation: rel, state });
    expect(note(relation('s1t1', 's1t2', { gate: 'sign_off' }), 'open')).toBe('Waits for s1t2 to be merged and rolled out before it can sign off');
    expect(note(relation('s1t1', 's1k4', { until: 'decided', reason: 'it picks the schema' }), 'open')).toBe('Waits for s1k4 to be decided before it can start: it picks the schema');
    expect(note(relation('s1t1', 's1t2'), 'rollout')).toBe('Waits for the rollout of s1t2 to be done (it has merged; its rollout steps are open)');
    // "to merge" only when it has not merged yet.
    expect(note(relation('s1t1', 's1t2'), 'open')).toBe('Waits for s1t2 to merge');
    expect(note(relation('s1t1', 's1t2'), 'planning')).toBe('Waits for s1t2 to merge (it is in Planning)');
    expect(UNTIL_WORDS.merged).toBe('merged and rolled out');
    expect(note(relation('s1t1', 's1t2', { source: 'learned', reason: 'run r1 failed' }), 'open')).toBe('Waits for s1t2: run r1 failed');
  });

  it('startIds lists the active start relations once each', () => {
    expect(
      startIds([relation('s1t1', 's1t2'), relation('s1t1', 's1t3', { dismissedAt: NOW }), relation('s1t1', 's1t4', { gate: 'merge' }), relation('s1t1', 's1t5', { overriddenAt: NOW })]),
    ).toEqual(['s1t2']);
  });
});

describe('Start now on relations', () => {
  it('overrides the inferred and learned start relations only', () => {
    const relations = [
      relation('s1t1', 's1t2'),
      relation('s1t1', 's1t3', { source: 'inferred' }),
      relation('s1t1', 's1t4', { source: 'learned' }),
      relation('s1t1', 's1t5', { source: 'split' }),
      relation('s1t1', 's1t6', { source: 'inferred', dismissedAt: NOW }),
      relation('s1t1', 's1t7', { source: 'inferred', gate: 'merge' }),
    ];
    expect(overrideEdits(relations, NOW)).toEqual([
      { id: relations[1]?.id, overriddenAt: NOW },
      { id: relations[2]?.id, overriddenAt: NOW },
    ]);
  });

  it('the machine carries the edits with the transition, and refuses nothing held', () => {
    const held = fixture({ type: 'same', status: 'planning' });
    const facts = {
      relations: [relation(held.id, 's1t2', { source: 'inferred' }), relation(held.id, 's1t3')],
      states: new Map<string, ToState>([['s1t2', 'open'], ['s1t3', 'open']]),
    };
    const started = machine.startAnyway(held, ctx(dev), facts);
    expect(started.ok && started.value.glob.status).toBe('implementing');
    expect(started.ok && started.value.relationEdits).toEqual([{ id: facts.relations[0]?.id, overriddenAt: NOW }]);
    expect(started.ok && started.value.events.find((e) => e.type === 'HoldOverridden')?.data).toEqual({ for: ['s1t2', 's1t3'] });
    const nothing = machine.startAnyway(held, ctx(dev), relationFacts(held.id, [['s1t2', 'merged']]));
    expect(!nothing.ok && nothing.error.code).toBe('invalid_transition');
  });

  it('Start is refused while an unmet start relation holds, and a gate other than start never holds a start', () => {
    const same = fixture({ type: 'same', status: 'planning' });
    const refused = machine.start(same, ctx(dev), relationFacts(same.id, [['s1t2', 'open']]));
    expect(!refused.ok && refused.error.message).toContain('Waits for s1t2 to merge');
    const mergeGate = { relations: [relation(same.id, 's1t2', { gate: 'merge' })], states: new Map<string, ToState>([['s1t2', 'open']]) };
    expect(machine.start(same, ctx(dev), mergeGate).ok).toBe(true);
    const dismissed = { relations: [relation(same.id, 's1t2', { dismissedAt: NOW })], states: new Map<string, ToState>([['s1t2', 'open']]) };
    expect(machine.start(same, ctx(dev), dismissed).ok).toBe(true);
  });
});

describe('cycles', () => {
  const draft = (from: string, to: string, gate: RelationDraft['gate'] = 'start', until: RelationDraft['until'] = 'merged'): RelationDraft => ({ from, to, gate, until });
  const rel = (from: string, to: string, gate: Relation['gate'] = 'start', until: Relation['until'] = 'merged', patch: Partial<Relation> = {}) => relation(from, to, { gate, until, ...patch });

  it('accepts a split: part 1 starts after part 0 merged, part 0 signs off after part 1 merged', () => {
    expect(wouldCycle([rel('p1', 'p0')], draft('p0', 'p1', 'sign_off'))).toBe(false);
    expect(wouldCycle([rel('p0', 'p1', 'sign_off')], draft('p1', 'p0'))).toBe(false);
    // Three parts, the chain and every sign-off.
    const all = [rel('p1', 'p0'), rel('p2', 'p1'), rel('p0', 'p1', 'sign_off'), rel('p0', 'p2', 'sign_off')];
    expect(wouldCycle(all.slice(0, 3), draft('p0', 'p2', 'sign_off'))).toBe(false);
    expect(all.every((r) => !wouldCycle(all.filter((o) => o.id !== r.id), r))).toBe(true);
  });

  it('refuses two globs starting after each other, directly and through others', () => {
    expect(wouldCycle([rel('a', 'b')], draft('b', 'a'))).toBe(true);
    expect(wouldCycle([rel('a', 'b'), rel('b', 'c')], draft('c', 'a'))).toBe(true);
    expect(wouldCycle([rel('a', 'b'), rel('b', 'c')], draft('c', 'd'))).toBe(false);
  });

  it('a later milestone waits for the earlier ones', () => {
    // a can't be signed off until b has merged.
    const signOffOnB = [rel('a', 'b', 'sign_off', 'merged')];
    // So b can't start, or merge, only after a is signed off: b would wait for itself.
    expect(wouldCycle(signOffOnB, draft('b', 'a', 'start', 'signed_off'))).toBe(true);
    expect(wouldCycle(signOffOnB, draft('b', 'a', 'merge', 'signed_off'))).toBe(true);
    // But b can be signed off after a was signed off, or after a merged.
    expect(wouldCycle(signOffOnB, draft('b', 'a', 'sign_off', 'signed_off'))).toBe(false);
    expect(wouldCycle(signOffOnB, draft('b', 'a', 'sign_off', 'merged'))).toBe(false);
    expect(wouldCycle(signOffOnB, draft('b', 'a', 'start', 'merged'))).toBe(false);
  });

  it('a decision is reached when decided, which is the merged milestone', () => {
    expect(wouldCycle([rel('a', 'k1', 'start', 'decided')], draft('k1', 'a', 'start', 'merged'))).toBe(true);
    expect(wouldCycle([rel('a', 'k1', 'start', 'decided')], draft('k1', 'a', 'sign_off', 'merged'))).toBe(false);
  });

  it('relations a person dismissed or Start now overrode do not close a cycle', () => {
    expect(wouldCycle([rel('a', 'b', 'start', 'merged', { dismissedAt: NOW })], draft('b', 'a'))).toBe(false);
    expect(wouldCycle([rel('a', 'b', 'start', 'merged', { overriddenAt: NOW })], draft('b', 'a'))).toBe(false);
  });

  it('startReaches follows start relations through others', () => {
    const all = [rel('a', 'b'), rel('b', 'c'), rel('c', 'd', 'merge')];
    expect(startReaches(all, 'a', 'c')).toBe(true);
    expect(startReaches(all, 'a', 'd')).toBe(false);
    expect(startReaches(all, 'c', 'a')).toBe(false);
  });

  describe('checking a new relation', () => {
    const lookup = (id: string) => (id.startsWith('x') ? undefined : { boardId: id === 'other' ? 2 : 1 });

    it('refuses itself, another board, an unknown glob, a cycle and too many', () => {
      const message = (result: Result<null>) => (result.ok ? null : result.error.message);
      expect(message(checkRelation(draft('a', 'a'), 1, [], lookup))).toContain('itself');
      // `to` may be on another board (the service checks the actor may view it); only a missing glob is refused.
      expect(checkRelation(draft('a', 'other'), 1, [], lookup).ok).toBe(true);
      expect(message(checkRelation(draft('a', 'x1'), 1, [], lookup))).toContain('No glob x1');
      // The cycle check runs across boards: a on board 1 waits for `other` on board 2, which waits for a.
      expect(message(checkRelation(draft('other', 'a'), 2, [rel('a', 'other')], lookup))).toContain('would be a cycle');
      expect(message(checkRelation(draft('b', 'a'), 1, [rel('a', 'b')], lookup))).toContain("a already waits for b, so b can't start until a is merged");
      expect(checkRelation(draft('a', 'b'), 1, [rel('a', 'b')], lookup).ok).toBe(true);
      const full = Array.from({ length: MAX_RELATIONS }, (_, i) => rel('a', `t${String(i)}`));
      expect(message(checkRelation(draft('a', 'new'), 1, full, lookup))).toContain(`at most ${MAX_RELATIONS}`);
      // The limit is per gate, and a repeat of one that exists is not counted twice.
      expect(checkRelation(draft('a', 'new', 'merge'), 1, full, lookup).ok).toBe(true);
      expect(checkRelation(draft('a', 't3'), 1, full, lookup).ok).toBe(true);
    });
  });

  describe('the shape of a relation from human work', () => {
    const message = (result: Result<null>) => (result.ok ? null : result.error.message);

    it('accepts an action waiting at its start for a code glob, and still refuses a decision as the held glob', () => {
      const action = { id: 's1a1', category: 'action' } as const;
      expect(checkRelationShape(action, { to: 's1t1', until: 'merged' }, { category: 'task' }).ok).toBe(true);
      expect(checkRelationShape(action, { to: 's1a2', until: 'done' }, { category: 'action' }).ok).toBe(true);
      expect(message(checkRelationShape({ id: 's1k1', category: 'decision' }, { to: 's1t1', until: 'merged' }, { category: 'task' }))).toContain('is a decision');
      expect(message(checkRelationShape(action, { to: 's1t1', until: 'merged', gate: 'sign_off' }, { category: 'task' }))).toContain('only wait before it is done');
    });

    it('still checks the cycle for an action: a glob that waits for the action can not be waited for by it', () => {
      const lookup = () => ({ boardId: 1 });
      expect(message(checkRelation({ ...draft('s1a1', 's1t1') }, 1, [rel('s1t1', 's1a1')], lookup))).toContain('cycle');
    });
  });
});

describe('a write to a glob\'s relations', () => {
  it('applies removals, patches and additions, and names what it inserts', () => {
    const current = [relation('s1t1', 's1t2'), relation('s1t1', 's1t3'), relation('s1t1', 's1t4')];
    let n = 0;
    const result = applyWrite(
      current,
      {
        add: [{ to: 's1t9', gate: 'start', until: 'merged', reason: 'r', evidence: ['a'], source: 'inferred' }],
        update: [{ id: current[1]?.id ?? '', patch: { dismissedAt: NOW, dismissedPlanHash: 'h' } }],
        remove: [current[0]?.id ?? ''],
      },
      { boardId: 1, from: 's1t1', now: NOW, newId: () => `rel_${String(++n)}` },
    );
    expect(result.relations.map((r) => r.to)).toEqual(['s1t3', 's1t4', 's1t9']);
    expect(result.relations[0]).toMatchObject({ dismissedAt: NOW, dismissedPlanHash: 'h' });
    expect(result.inserted).toEqual([
      { id: 'rel_1', boardId: 1, from: 's1t1', to: 's1t9', gate: 'start', until: 'merged', reason: 'r', evidence: ['a'], source: 'inferred', group: null, dismissedAt: null, dismissedPlanHash: null, overriddenAt: null, createdAt: NOW },
    ]);
  });
});

describe('relations in the memory store', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('inserts once per glob, target and gate, reads by board, from and to, patches and deletes', async () => {
    const a = relation('s1t1', 's1t2', { reason: 'uses it', evidence: ['a.ts'] });
    const b = relation('s1t1', 's1t3', { gate: 'sign_off', source: 'split' });
    const elsewhere = relation('s2t1', 's2t2', { boardId: 2 });
    await store.transaction(async (tx) => {
      expect(await tx.insertRelation(a)).toBe(true);
      expect(await tx.insertRelation(b)).toBe(true);
      expect(await tx.insertRelation(elsewhere)).toBe(true);
      expect(await tx.insertRelation({ ...a, id: 'dup' })).toBe(false);
    });
    expect(await store.transaction((tx) => tx.listRelations(1))).toEqual([a, b]);
    expect(await store.transaction((tx) => tx.listRelationsFrom(['s1t1', 's1t9']))).toEqual([a, b]);
    expect(await store.transaction((tx) => tx.listRelationsFrom([]))).toEqual([]);
    expect(await store.transaction((tx) => tx.listRelationsTo(['s1t3']))).toEqual([b]);
    await store.transaction((tx) => tx.updateRelation(a.id, { dismissedAt: NOW, dismissedPlanHash: 'h1', reason: 'changed' }));
    expect((await store.transaction((tx) => tx.listRelations(1)))[0]).toMatchObject({ dismissedAt: NOW, dismissedPlanHash: 'h1', reason: 'changed', evidence: ['a.ts'] });
    await store.transaction((tx) => tx.updateRelation(a.id, { dismissedAt: null, dismissedPlanHash: null, overriddenAt: NOW }));
    expect((await store.transaction((tx) => tx.listRelations(1)))[0]).toMatchObject({ dismissedAt: null, dismissedPlanHash: null, overriddenAt: NOW });
    await store.transaction((tx) => tx.deleteRelation(b.id));
    await store.transaction((tx) => tx.deleteRelationsFrom('s1t1'));
    expect(await store.transaction((tx) => tx.listRelations(1))).toEqual([]);
    expect(await store.transaction((tx) => tx.listRelations(2))).toEqual([elsewhere]);
    await store.transaction((tx) => tx.lockBoardRelations(1));
  });

  it('keeps a supersession out of the three list methods, and reads it with its own two (kind-filter parity with Postgres)', async () => {
    const waits = relation('s1t1', 's1t2');
    const supersession = relation('s1t11', 's1t13', { kind: 'superseded_by', gate: 'sign_off', source: 'agent', reason: 'replaces it' });
    await store.transaction(async (tx) => {
      expect(await tx.insertRelation(waits)).toBe(true);
      expect(await tx.insertRelation(supersession)).toBe(true);
      // The same pair and gate is allowed once per kind.
      expect(await tx.insertRelation({ ...waits, id: 'other-kind', kind: 'superseded_by' })).toBe(true);
      expect(await tx.insertRelation({ ...supersession, id: 'dup' })).toBe(false);
    });
    expect(await store.transaction((tx) => tx.listRelations(1))).toEqual([waits]);
    expect(await store.transaction((tx) => tx.listRelationsFrom(['s1t11', 's1t1']))).toEqual([waits]);
    expect(await store.transaction((tx) => tx.listRelationsTo(['s1t13', 's1t2']))).toEqual([waits]);
    expect((await store.transaction((tx) => tx.listSupersessions(['s1t11']))).map((r) => r.id)).toEqual([supersession.id]);
    expect((await store.transaction((tx) => tx.listSupersededBy(['s1t13']))).map((r) => r.id)).toEqual([supersession.id]);
    expect(await store.transaction((tx) => tx.listSupersessions([]))).toEqual([]);
    expect(await store.transaction((tx) => tx.listSupersededBy(['s1t11']))).toEqual([]);
    await store.transaction((tx) => tx.lockRelations());
  });

  it('lists a cross-board relation from the holder and to the target on any board', async () => {
    const cross = relation('s1t1', 's2t5', { boardId: 1 });
    await store.transaction((tx) => tx.insertRelation(cross));
    expect(await store.transaction((tx) => tx.listRelationsTo(['s2t5']))).toEqual([cross]);
    expect(await store.transaction((tx) => tx.listRelations(2))).toEqual([]);
  });

  it('a transaction that throws leaves no relation behind', async () => {
    await expect(
      store.transaction(async (tx) => {
        await tx.insertRelation(relation('s1t1', 's1t2'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.transaction((tx) => tx.listRelations(1))).toEqual([]);
  });
});

describe('the service and relations', () => {
  const ADMIN = 'admin@example.com';
  const DEV = 'dev@example.com';
  let store: MemoryStore;
  let globs: GlobService;
  let boardId: number;
  let runs: number;

  const create = async (patch: Record<string, unknown> = {}) =>
    unwrap(await globs.create(ADMIN, { boardId, title: 'Work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, ...patch }));
  const rows = (from?: string): Relation[] => [...store.state.relations.values()].filter((r) => from === undefined || r.from === from);
  const merge = async (id: string) => unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    const boards = new BoardService({ store, notifier });
    globs = new GlobService({ store, notifier, clock: { now: () => NOW }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('writes a person\'s needs as start relations with the glob, and an event each', async () => {
    const first = await create();
    const second = await create({ after: [first.id] });
    expect(rows(second.id)).toMatchObject([{ to: first.id, gate: 'start', until: 'merged', source: 'person', boardId }]);
    expect(store.state.events.filter((e) => e.globId === second.id && e.type === 'RelationAdded').map((e) => e.data)).toEqual([
      { to: first.id, gate: 'start', until: 'merged', source: 'person', reason: null },
    ]);
    // The glob document no longer holds the list.
    expect(second.after).toBeUndefined();
  });

  it('replaces the needs a person set, leaves the inferred ones, and bumps the version of what changes', async () => {
    const a = await create();
    const b = await create();
    const c = await create();
    const target = await create({ after: [a.id] });
    const inferred = relation(target.id, c.id, { source: 'inferred', reason: 'uses it' });
    store.state.relations.set(inferred.id, inferred);
    const swapped = unwrap(await globs.update(DEV, target.id, target.version, { after: [b.id] }));
    expect(swapped.version).toBe(target.version + 1);
    expect(rows(target.id).map((r) => [r.to, r.source])).toEqual([[c.id, 'inferred'], [b.id, 'person']]);
    expect(store.state.events.filter((e) => e.globId === target.id && e.type === 'RelationReleased').map((e) => e.data)).toEqual([{ to: a.id, gate: 'start', reason: 'removed' }]);
    // The person naming the inferred one's glob replaces it with theirs.
    const named = unwrap(await globs.update(DEV, target.id, swapped.version, { after: [b.id, c.id] }));
    expect(rows(target.id).map((r) => [r.to, r.source])).toEqual([[b.id, 'person'], [c.id, 'person']]);
    // Saying the same again changes nothing, not even the version.
    expect(unwrap(await globs.update(DEV, target.id, named.version, { after: [b.id, c.id] })).version).toBe(named.version);
  });

  it('drops a merged glob from the list, and refuses a cycle through any gate', async () => {
    const done = await create();
    await merge(done.id);
    const a = await create();
    const withDone = await create({ after: [done.id, a.id] });
    expect(rows(withDone.id).map((r) => r.to)).toEqual([a.id]);
    // A sign-off relation from a to b means b can't start after a being signed off...: a start-until-merged on a is fine, the reverse is not.
    const cycle = await globs.update(DEV, a.id, a.version, { after: [withDone.id] });
    expect(!cycle.ok && cycle.error.message).toContain('cycle');
    expect(rows(a.id)).toEqual([]);
  });

  it('a split is a scope cut: no sign-off relation and no gate between parts; needs a part names are ordinary relations', async () => {
    const original = await create({ title: 'Big', plan: 'Big plan' });
    const parts = unwrap(
      await globs.split(DEV, original.id, original.version, {
        idempotencyKey: null,
        parts: [{ title: 'One', plan: 'one' }, { title: 'Two', plan: 'two', after: [0] }, { title: 'Three', plan: 'three', after: [0, 1] }],
      }),
    );
    const [one, two, three] = parts;
    expect(rows().filter((r) => r.gate === 'start').map((r) => [r.from, r.to, r.source])).toEqual([
      [two?.id, one?.id, 'person'],
      [three?.id, one?.id, 'person'],
      [three?.id, two?.id, 'person'],
    ]);
    // The original signs off on its own.
    expect(rows(one?.id)).toEqual([]);
    expect(rows().some((r) => r.gate === 'sign_off' || r.source === 'split')).toBe(false);
    expect(one?.version).toBe(original.version + 1);
    // Two names One as a need, so it is held for it, but nothing starts it by itself.
    expect(two?.status).toBe('planning');
    expect(two).not.toHaveProperty('autoStart');
    expect(unwrap(await globs.get(DEV, two?.id ?? '')).waitingFor.map((w) => w.id)).toEqual([one?.id]);
  });

  it('release on merge reads the relations pointing at the merged glob, and a dismissed one no longer holds', async () => {
    const first = await create();
    const sub = await create({ type: 'sub', after: [first.id] });
    const other = await create();
    const rel = relation(sub.id, other.id, { source: 'inferred', dismissedAt: NOW, dismissedPlanHash: 'h' });
    store.state.relations.set(rel.id, rel);
    await merge(first.id);
    expect(await globs.releaseDependents(first.id, boardId)).toEqual([sub.id]);
    expect((await globs.peek(sub.id))?.status).toBe('implementing');
  });

  it('the single read and the board list agree on what a glob waits for and what waits for it', async () => {
    const first = await create();
    const second = await create({ after: [first.id] });
    const view = unwrap(await globs.get(DEV, second.id));
    expect(view.relations.map((r) => r.to)).toEqual([first.id]);
    expect(view.waitingFor.map((w) => w.id)).toEqual([first.id]);
    expect(unwrap(await globs.get(DEV, first.id)).waitedOnBy).toEqual([second.id]);
    const listed = unwrap(await globs.listWithArtifacts(DEV, boardId, {})).find((r) => r.glob.id === second.id);
    expect(awaitedOf(listed?.relations ?? { relations: [], states: new Map() }).map((a) => a.id)).toEqual([first.id]);
    expect(listed?.holding.map((h) => [h.to, h.toTitle, h.gate, h.until, h.state])).toEqual([[first.id, first.title, 'start', 'merged', 'planning']]);
    expect(view.holding.map((h) => h.to)).toEqual([first.id]);
  });
});

describe('until aliases', () => {
  it('accepts rolled_out for merged, keeps the others, and refuses the rest', () => {
    expect(normaliseUntil('rolled_out')).toBe('merged');
    expect(normaliseUntil('Merged')).toBe('merged');
    expect(normaliseUntil('signed_off')).toBe('signed_off');
    expect(normaliseUntil('decided')).toBe('decided');
    expect(normaliseUntil('soon')).toBeNull();
    expect(UNTIL_WORDS.merged).toBe('merged and rolled out');
  });
});

describe('the relation scan effect in the memory store', () => {
  afterEach(() => vi.useRealTimers());
  const scan = (globId: string): Effect => ({ kind: 'scan_relations', globId });
  const jobs = (store: MemoryStore) => store.transaction((tx) => tx.latestOutboxJobs(['s1t1', 's1t2'], ['scan_relations']));

  it('runs on the llm lane', () => {
    expect(laneOf('scan_relations')).toBe('llm');
  });

  it('keeps one unclaimed job per glob and pushes its runAfter to now + 30 s on every trigger', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    const store = new MemoryStore();
    await store.transaction((tx) => tx.enqueueEffects([scan('s1t1')]));
    expect((await jobs(store))[0]?.runAfter).toBe('2026-10-15T12:00:30.000Z');
    vi.setSystemTime(new Date('2026-10-15T12:00:20.000Z'));
    await store.transaction((tx) => tx.enqueueEffects([scan('s1t1'), scan('s1t1'), scan('s1t2')]));
    const after = await jobs(store);
    expect(after).toHaveLength(2);
    expect(after.find((j) => j.globId === 's1t1')?.runAfter).toBe(new Date(Date.parse('2026-10-15T12:00:20.000Z') + RELATION_SCAN_DEBOUNCE_MS).toISOString());
    expect(store.state.outbox.filter((e) => e.kind === 'scan_relations')).toHaveLength(2);
  });
});
