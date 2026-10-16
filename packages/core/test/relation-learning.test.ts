import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { DependencyInferenceService } from '../src/app/dependency-inference-service.js';
import { DependencyLearningService } from '../src/app/dependency-learning-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Llm } from '../src/app/intake-service.js';
import { RelationLearningService } from '../src/app/relation-learning-service.js';
import { hash } from '../src/app/text-hash.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import {
  MAX_PIN_HISTORY,
  RELATION_LEARNING_DEFAULTS,
  isRelationFalseNegative,
  isRelationFalsePositive,
  normaliseSource,
  pinned,
  postureOf,
  precisionRecall,
  unpinned,
  validatePins,
} from '../src/domain/relation-learning.js';
import type { RelationLearningSource, RelationSignal, RelationSignalKind, RelationSignalSource } from '../src/domain/relation-learning.js';
import { startIds, unmet, wouldCycle } from '../src/domain/relations.js';
import type { Glob, Relation } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { relation } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const NOW = '2026-10-16T12:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * DAY).toISOString();

let counter = 0;
const signal = (source: RelationSignalSource, kind: RelationSignalKind, patch: Partial<RelationSignal> = {}): RelationSignal => {
  counter += 1;
  return { id: `sig-${counter}`, boardId: 1, from: 'a', to: 'b', relationId: null, source, signal: kind, at: NOW, evidence: '', key: `k${counter}`, ...patch };
};
const many = (n: number, source: RelationSignalSource, kind: RelationSignalKind, patch: Partial<RelationSignal> = {}): RelationSignal[] =>
  Array.from({ length: n }, () => signal(source, kind, patch));

describe('relation learning (pure)', () => {
  it('classifies the signals', () => {
    expect(['fp_override', 'fp_dismissed', 'fp_not_needed'].every((k) => isRelationFalsePositive(k as RelationSignalKind))).toBe(true);
    expect(['fn_person_added', 'fn_conflict', 'fn_red_main', 'fn_failed_run'].every((k) => isRelationFalseNegative(k as RelationSignalKind))).toBe(true);
    expect(isRelationFalsePositive('tp_needed')).toBe(false);
    expect(isRelationFalseNegative('tp_promoted')).toBe(false);
  });

  it('reads auto as mention', () => {
    expect(normaliseSource('auto')).toBe('mention');
    expect(normaliseSource('mention')).toBe('mention');
    expect(normaliseSource('inferred')).toBe('inferred');
  });

  it('computes precision per source over the window, with counts', () => {
    const signals = [
      ...many(3, 'mention', 'tp_needed'),
      ...many(1, 'mention', 'fp_override'),
      ...many(1, 'mention', 'fp_dismissed'),
      ...many(2, 'inferred', 'tp_promoted'),
      // Older than the 90-day window: not counted.
      ...many(4, 'mention', 'fp_not_needed', { at: daysAgo(91) }),
    ];
    const stats = precisionRecall(signals, NOW, 90);
    expect(stats.mention).toMatchObject({ tp: 3, fp: 2, precision: 0.6, precisionSamples: 5 });
    expect(stats.mention.counts).toMatchObject({ tp_needed: 3, fp_override: 1, fp_dismissed: 1, fp_not_needed: 0 });
    expect(stats.inferred).toMatchObject({ tp: 2, fp: 0, precision: 1 });
    expect(stats.person.precision).toBeNull();
    // A shorter window drops the 91-day-old ones either way and a longer one takes them in.
    expect(precisionRecall(signals, NOW, 120).mention).toMatchObject({ fp: 6, precisionSamples: 9 });
    expect(precisionRecall(signals, NOW, 7).mention.precisionSamples).toBe(5);
  });

  it('credits false negatives to inferred and agent only, and a mention is never blamed', () => {
    const signals = [...many(3, 'inferred', 'tp_needed'), ...many(1, 'agent', 'tp_needed'), ...many(1, 'none', 'fn_conflict'), ...many(1, 'person', 'fn_person_added'), ...many(1, 'learned', 'fn_failed_run')];
    const stats = precisionRecall(signals, NOW);
    expect(stats.inferred).toMatchObject({ fn: 3, recall: 0.5, recallSamples: 6 });
    expect(stats.agent).toMatchObject({ fn: 3, recall: 0.25, recallSamples: 4 });
    expect(stats.mention).toMatchObject({ fn: 0, recall: null });
    expect(stats.person.recall).toBeNull();
    expect(stats.learned.recall).toBeNull();
  });

  it('keeps the default posture below the sample minimum, with "not enough data"', () => {
    const stats = precisionRecall(many(4, 'mention', 'fp_override'), NOW);
    const posture = postureOf('mention', stats.mention);
    expect(posture).toMatchObject({ posture: 'gate', pinned: false, measured: false });
    expect(posture.why).toContain('not enough data');
    expect(postureOf('mention', precisionRecall([], NOW).mention).posture).toBe('gate');
  });

  it('makes a source below the precision threshold weak once it has the minimum samples', () => {
    const weak = precisionRecall([...many(1, 'mention', 'tp_needed'), ...many(4, 'mention', 'fp_override')], NOW);
    expect(postureOf('mention', weak.mention)).toMatchObject({ posture: 'weak', measured: true });
    const fine = precisionRecall([...many(3, 'mention', 'tp_needed'), ...many(2, 'mention', 'fp_override')], NOW);
    expect(postureOf('mention', fine.mention)).toMatchObject({ posture: 'gate', measured: true });
    // Exactly the threshold is not below it.
    const edge = precisionRecall([...many(5, 'inferred', 'tp_needed'), ...many(5, 'inferred', 'fp_override')], NOW);
    expect(postureOf('inferred', edge.inferred).posture).toBe('gate');
  });

  it('never weakens a person, an agent, a learned or a split relation', () => {
    const stats = precisionRecall([...many(9, 'person', 'fp_override'), ...many(9, 'agent', 'fp_override'), ...many(9, 'learned', 'fp_dismissed')], NOW);
    for (const source of ['person', 'agent', 'learned', 'split'] as const) expect(postureOf(source, stats[source]).posture).toBe('gate');
  });

  it('gets bolder when inference recall is below the threshold over enough samples', () => {
    const missed = precisionRecall([...many(2, 'inferred', 'tp_needed'), ...many(5, 'none', 'fn_conflict')], NOW);
    expect(postureOf('inferred', missed.inferred).bold).toBe(true);
    const few = precisionRecall([...many(1, 'inferred', 'tp_needed'), ...many(2, 'none', 'fn_conflict')], NOW);
    expect(postureOf('inferred', few.inferred).bold).toBe(false);
    const good = precisionRecall([...many(8, 'inferred', 'tp_needed'), ...many(1, 'none', 'fn_conflict')], NOW);
    expect(postureOf('inferred', good.inferred).bold).toBe(false);
  });

  it('lets an admin pin a posture and the thresholds over what was learned', () => {
    const stats = precisionRecall([...many(1, 'mention', 'tp_needed'), ...many(4, 'mention', 'fp_override'), ...many(5, 'inferred', 'tp_needed')], NOW);
    expect(postureOf('mention', stats.mention, { postures: { mention: 'gate' } })).toMatchObject({ posture: 'gate', pinned: true });
    expect(postureOf('inferred', stats.inferred, { postures: { inferred: 'weak' } })).toMatchObject({ posture: 'weak', pinned: true });
    // Precision 0.2: a lower threshold keeps it a gate; a higher minimum sample count keeps it at the default.
    expect(postureOf('mention', stats.mention, { precisionThreshold: 0.1 }).posture).toBe('gate');
    expect(postureOf('mention', stats.mention, { minSamples: 6 }).posture).toBe('gate');
    expect(postureOf('mention', stats.mention, { precisionThreshold: 0.9 }).posture).toBe('weak');
    // A pin of the window changes what counts.
    const old = precisionRecall(many(5, 'mention', 'fp_override', { at: daysAgo(30) }), NOW, 7);
    expect(postureOf('mention', old.mention).posture).toBe('gate');
  });

  it('validates pins', () => {
    expect(validatePins({ precisionThreshold: 0.4, windowDays: 30, minSamples: 8, postures: { auto: 'weak' } })).toEqual({
      ok: true,
      value: { precisionThreshold: 0.4, windowDays: 30, minSamples: 8, postures: { mention: 'weak' } },
    });
    for (const bad of [{ precisionThreshold: 0 }, { precisionThreshold: 1.5 }, { windowDays: 3 }, { windowDays: 30.5 }, { minSamples: 0 }, { postures: { person: 'weak' } }, { postures: { mention: 'maybe' } }, { nonsense: 1 }, null, []]) {
      expect(validatePins(bad).ok).toBe(false);
    }
    expect(RELATION_LEARNING_DEFAULTS).toMatchObject({ windowDays: 90, precisionThreshold: 0.5, recallThreshold: 0.5, minSamples: 5 });
  });

  it('keeps at most 50 history lines and resets one pin or all', () => {
    let settings = pinned({}, { precisionThreshold: 0.3, postures: { mention: 'weak', inferred: 'gate' } }, { at: NOW, by: ADMIN, what: 'x' });
    for (let i = 0; i < 60; i++) settings = pinned(settings, { minSamples: 6 }, { at: NOW, by: ADMIN, what: `change ${i}` });
    expect(settings.history).toHaveLength(MAX_PIN_HISTORY);
    expect(settings.history?.at(-1)?.what).toBe('change 59');
    expect(settings).toMatchObject({ precisionThreshold: 0.3, minSamples: 6, postures: { mention: 'weak', inferred: 'gate' } });
    const noMention = unpinned(settings, 'mention', { at: NOW, by: ADMIN, what: 'reset mention' });
    expect(noMention.postures).toEqual({ inferred: 'gate' });
    expect(noMention.precisionThreshold).toBe(0.3);
    const noThreshold = unpinned(settings, 'precisionThreshold', { at: NOW, by: ADMIN, what: 'r' });
    expect(noThreshold.precisionThreshold).toBeUndefined();
    expect(noThreshold.postures).toEqual({ mention: 'weak', inferred: 'gate' });
    const none = unpinned(settings, undefined, { at: NOW, by: ADMIN, what: 'all' });
    expect(Object.keys(none)).toEqual(['history']);
    expect(none.history).toHaveLength(MAX_PIN_HISTORY);
    expect(none.history?.at(-1)?.what).toBe('all');
  });
});

describe('relation learning (service)', () => {
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let learning: RelationLearningService;
  let depLearning: DependencyLearningService;
  let boardId: number;
  let runs: number;
  let usesAnswer: boolean;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Work',
    plan: 'Some plan for the work, long enough to count as a plan.',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const create = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(ADMIN, input(patch)));
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const signals = (): RelationSignal[] => [...store.state.relationSignals.values()];
  const kinds = (): [string, string][] => signals().map((s) => [s.source, s.signal]);
  const rows = (from: string): Relation[] => [...store.state.relations.values()].filter((r) => r.from === from);
  /** Stores a relation of any kind, as a creation path would have. */
  const put = (from: string, to: string, patch: Partial<Relation> = {}): Relation => {
    const row = relation(from, to, { source: 'inferred', reason: 'x', ...patch });
    store.state.relations.set(row.id, row);
    return row;
  };
  const seed = (n: number, source: RelationLearningSource, kind: RelationSignalKind): void => {
    for (const s of many(n, source, kind, { boardId })) store.state.relationSignals.set(`${boardId}:${s.key}`, s);
  };
  const merge = async (id: string): Promise<void> => {
    unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc1234' }, c)));
  };
  const planHashOf = async (id: string): Promise<string> => hash((await store.transaction((tx) => tx.artifactVersions(id, 'plan', ''))).at(-1)?.content ?? '');
  const automatic = async (from: string, to: string, gate: 'start' | 'merge' = 'start') =>
    globs.applyAutomatic(from, await planHashOf(from), [{ to, gate, until: 'merged', reason: `Needs ${to}`, sentence: `Needs ${to}` }], null);

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    usesAnswer = false;
    const clock = { now: () => NOW };
    learning = new RelationLearningService({ store, notifier, clock, ids: { runId: () => `id-${++runs}` }, uses: () => Promise.resolve(usesAnswer) });
    depLearning = new DependencyLearningService({ store, notifier, clock, ids: { runId: () => `rel-${++runs}` }, relationLearning: learning });
    boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
      dependencyLearning: depLearning,
      relationLearning: learning,
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  describe('false positives', () => {
    it('counts Start now on a relation that still held as an override of its source, once', async () => {
      const prerequisite = await create();
      const waiter = await create();
      put(waiter.id, prerequisite.id, { source: 'inferred' });
      unwrap(await globs.startAnyway(DEV, waiter.id, waiter.version));
      expect(kinds()).toEqual([['inferred', 'fp_override']]);
      expect(signals()[0]).toMatchObject({ from: waiter.id, to: prerequisite.id, boardId });
      // The old name of a mention counts as a mention.
      const other = await create();
      const second = await create();
      put(second.id, other.id, { source: 'auto' });
      unwrap(await globs.startAnyway(DEV, second.id, second.version));
      expect(kinds()).toEqual([
        ['inferred', 'fp_override'],
        ['mention', 'fp_override'],
      ]);
    });

    it('counts a dismissal before the other glob was met, and not one after', async () => {
      const prerequisite = await create();
      const waiter = await create();
      const row = put(waiter.id, prerequisite.id, { source: 'mention' });
      unwrap(await globs.dismissRelation(DEV, waiter.id, null, row.id));
      expect(kinds()).toEqual([['mention', 'fp_dismissed']]);
      expect(signals()[0]?.key).toBe(`dismissed:${row.id}`);

      const merged = await create();
      const holder = await create();
      const metRow = put(holder.id, merged.id, { source: 'inferred' });
      await merge(merged.id);
      unwrap(await globs.dismissRelation(DEV, holder.id, null, metRow.id));
      expect(signals()).toHaveLength(1);
    });

    it('counts a failed run that confirms an existing relation as true, once per relation', async () => {
      const prerequisite = await create();
      const waiter = await create();
      put(waiter.id, prerequisite.id, { source: 'inferred' });
      await depLearning.onFailed(waiter.id, `Blocked on unmerged ${prerequisite.id}`);
      await depLearning.onFailed(waiter.id, `Blocked on unmerged ${prerequisite.id}`);
      expect(kinds()).toEqual([['inferred', 'tp_needed']]);
    });
  });

  describe('false negatives', () => {
    it('counts a person-added relation after creation, and not one slop had already made', async () => {
      const a = await create();
      const b = await create();
      unwrap(await globs.addRelation(DEV, b.id, null, { to: a.id }, 'held_by', 'person'));
      expect(kinds()).toEqual([['person', 'fn_person_added']]);
      expect(signals()[0]).toMatchObject({ from: b.id, to: a.id, signal: 'fn_person_added' });

      // An inferred relation to the same glob was there: the person confirmed it, slop missed nothing.
      const c = await create();
      const d = await create();
      put(d.id, c.id, { source: 'inferred' });
      unwrap(await globs.addRelation(DEV, d.id, null, { to: c.id }, 'held_by', 'person'));
      expect(signals()).toHaveLength(1);
      // The relations a glob is created with are the person's plan, not a correction of slop.
      const e = await create({ after: [a.id] });
      expect(e.id).toBeDefined();
      expect(signals()).toHaveLength(1);
    });

    it('does not count a relation an agent adds, nor a person adding a weak pair that already exists', async () => {
      const a = await create();
      const b = await create();
      unwrap(await globs.addRelation(DEV, b.id, null, { to: a.id, reason: 'uses its helper' }, 'held_by', 'agent'));
      expect(signals()).toEqual([]);
      const c = await create();
      const d = await create();
      put(d.id, c.id, { source: 'mention', kind: 'may_relate' });
      unwrap(await globs.addRelation(DEV, d.id, null, { to: c.id }, 'held_by', 'person'));
      expect(signals()).toEqual([]);
      // The gate replaces the weak link for the pair.
      expect(rows(d.id).map((r) => r.kind ?? 'waits')).toEqual(['waits']);
    });

    it('counts a conflict caused by a glob it had no relation with, once, and not when a relation joined them', async () => {
      const culprit = await create();
      const hit = await create();
      const other = await create();
      await store.transaction((tx) =>
        tx.appendEvents([
          { type: 'ConflictFlagged', globId: hit.id, actor: null, at: NOW, data: { base: 'main', files: ['a.ts'], since: culprit.id } },
          { type: 'ConflictFlagged', globId: other.id, actor: null, at: NOW, data: { base: 'main', files: ['a.ts'], since: culprit.id } },
        ]),
      );
      put(other.id, culprit.id, { source: 'person' });
      await merge(hit.id);
      await learning.onMerged(hit.id);
      await merge(other.id);
      await learning.onMerged(other.id);
      await learning.onMerged(hit.id);
      expect(kinds()).toEqual([['none', 'fn_conflict']]);
      expect(signals()[0]).toMatchObject({ from: hit.id, to: culprit.id });
    });

    it('counts a red main caused by two globs with no relation, when the culprit uses what the other added', async () => {
      const other = await create();
      const culprit = await create();
      await merge(other.id);
      await merge(culprit.id);
      await store.transaction((tx) => tx.setBaseChecks(boardId, { sha: 'x', state: 'failed', since: culprit.id, checkedAt: NOW }));
      usesAnswer = true;
      // The base turning red is seen after the merge: that path finds the culprit from the board's checks.
      await learning.onBaseRed(boardId);
      await learning.onMerged(culprit.id);
      expect(kinds()).toEqual([['none', 'fn_red_main']]);
      expect(signals()[0]).toMatchObject({ from: culprit.id, to: other.id });
    });

    it('blames no one for a red main when the culprit does not use the other glob, or they were related', async () => {
      const other = await create();
      const culprit = await create();
      await merge(other.id);
      await merge(culprit.id);
      await store.transaction((tx) => tx.setBaseChecks(boardId, { sha: 'x', state: 'failed', since: culprit.id, checkedAt: NOW }));
      usesAnswer = false;
      await learning.onMerged(culprit.id);
      expect(signals()).toEqual([]);
      usesAnswer = true;
      put(culprit.id, other.id, { source: 'inferred', kind: 'may_relate' });
      await learning.onMerged(culprit.id);
      expect(signals()).toEqual([]);
    });

    it('counts a failed run for a prerequisite that had no relation as a missed dependency, and a weak link as confirmed', async () => {
      const prerequisite = await create();
      const waiter = await create();
      await depLearning.onFailed(waiter.id, `Blocked on unmerged ${prerequisite.id}`);
      expect(kinds()).toEqual([['learned', 'fn_failed_run']]);

      const second = await create();
      const holder = await create();
      const weak = put(holder.id, second.id, { source: 'mention', kind: 'may_relate' });
      await depLearning.onFailed(holder.id, `Blocked on unmerged ${second.id}`);
      expect(kinds()).toEqual([
        ['learned', 'fn_failed_run'],
        ['mention', 'tp_needed'],
      ]);
      expect(store.state.relations.has(weak.id)).toBe(false);
      expect(rows(holder.id).map((r) => [r.source, r.kind ?? 'waits'])).toEqual([['learned', 'waits']]);
    });
  });

  describe('view and pins', () => {
    it('shows each source with its counts, window and posture, to members only', async () => {
      seed(1, 'mention', 'tp_needed');
      seed(4, 'mention', 'fp_override');
      const view = unwrap(await learning.view(DEV, boardId));
      expect(view.thresholds).toEqual({ windowDays: 90, precision: 0.5, recall: 0.5, minSamples: 5 });
      const mention = view.sources.find((s) => s.source === 'mention');
      expect(mention).toMatchObject({ tp: 1, fp: 4, precision: 0.2, posture: { posture: 'weak' } });
      expect(view.sources.map((s) => s.source)).toEqual(['mention', 'inferred', 'agent', 'person', 'learned', 'split']);
      expect((await learning.view('stranger@example.com', boardId)).ok).toBe(false);
    });

    it('lets admins pin and reset, with history; others cannot', async () => {
      expect((await learning.pin(DEV, boardId, { postures: { mention: 'weak' } })).ok).toBe(false);
      const pinnedView = unwrap(await learning.pin(ADMIN, boardId, { postures: { mention: 'weak' }, minSamples: 8 }));
      expect(pinnedView.thresholds.minSamples).toBe(8);
      expect(pinnedView.sources.find((s) => s.source === 'mention')?.posture).toMatchObject({ posture: 'weak', pinned: true });
      expect(pinnedView.pins.history).toHaveLength(1);
      expect((await learning.pin(ADMIN, boardId, { postures: { person: 'weak' } })).ok).toBe(false);
      const reset = unwrap(await learning.resetPins(ADMIN, boardId, 'mention'));
      expect(reset.sources.find((s) => s.source === 'mention')?.posture.pinned).toBe(false);
      expect(reset.pins.minSamples).toBe(8);
      expect(reset.pins.history).toHaveLength(2);
      expect((await learning.resetPins(DEV, boardId)).ok).toBe(false);
      expect(Object.keys(unwrap(await learning.resetPins(ADMIN, boardId)).pins)).toEqual(['history']);
    });
  });

  describe('weak links', () => {
    it('below the sample minimum nothing changes: a mention still gates', async () => {
      seed(4, 'mention', 'fp_override');
      const prerequisite = await create();
      const waiter = await create();
      const result = await automatic(waiter.id, prerequisite.id);
      expect(result.added).toEqual([prerequisite.id]);
      expect(rows(waiter.id).map((r) => r.kind ?? 'waits')).toEqual(['waits']);
    });

    it('a mention source below the precision threshold creates a weak link that holds nothing', async () => {
      seed(1, 'mention', 'tp_needed');
      seed(4, 'mention', 'fp_dismissed');
      const prerequisite = await create();
      const waiter = await create();
      const result = await automatic(waiter.id, prerequisite.id);
      expect(result.added).toEqual([prerequisite.id]);
      const [row] = rows(waiter.id);
      expect(row).toMatchObject({ kind: 'may_relate', source: 'mention', gate: 'start', to: prerequisite.id, reason: `Needs ${prerequisite.id}` });
      // The same reason and gate as a gate would have had, but it is on none of the lists the gate code reads.
      expect(await store.transaction((tx) => tx.listRelations(boardId))).toEqual([]);
      expect(await store.transaction((tx) => tx.listRelationsFrom([waiter.id]))).toEqual([]);
      expect(await store.transaction((tx) => tx.listRelationsTo([prerequisite.id]))).toEqual([]);
      expect(await store.transaction((tx) => tx.listSupersessions([waiter.id]))).toEqual([]);
      expect(await store.transaction((tx) => tx.listWeakRelationsFrom([waiter.id]))).toHaveLength(1);
      expect(store.state.events.find((e) => e.globId === waiter.id && e.type === 'RelationAdded')?.data).toMatchObject({ weak: true, source: 'mention' });
      // Nothing holds the waiter: it starts, and its view shows nothing it waits for.
      expect(unwrap(await globs.get(DEV, waiter.id)).waitingFor).toEqual([]);
      const started = unwrap(await globs.start(DEV, waiter.id, (await current(waiter.id)).version));
      expect(started.status).not.toBe('planning');
      // A second pass for the same pair is "already related", not a second row.
      const again = await automatic(waiter.id, prerequisite.id);
      expect(again).toMatchObject({ added: [], skipped: [{ to: prerequisite.id, why: 'already related' }] });
    });

    it('weak rows never reach the gate code: no unmet, no start id, no cycle', async () => {
      const a = await create();
      const b = await create();
      const weak = put(a.id, b.id, { kind: 'may_relate' });
      const waits = await store.transaction((tx) => tx.listRelationsFrom([a.id]));
      expect(startIds(waits)).toEqual([]);
      expect(unmet({ relations: waits, states: new Map([[b.id, 'open' as const]]) }, 'start')).toEqual([]);
      expect(wouldCycle(waits, { from: b.id, to: a.id, gate: 'start', until: 'merged' })).toBe(false);
      // A gate the other way round is no cycle with a weak link, and the weak link is still there.
      unwrap(await globs.addRelation(DEV, b.id, null, { to: a.id }, 'held_by', 'person'));
      expect(store.state.relations.get(weak.id)).toBeDefined();
      // A weak row does not count toward the per-gate limit either.
      for (let i = 0; i < 20; i++) put(a.id, `s9t${i}`, { kind: 'may_relate' });
      const c = await create();
      unwrap(await globs.addRelation(DEV, a.id, null, { to: c.id }, 'held_by', 'person'));
    });

    it('a pinned gate keeps a weak-looking source gating, and a pinned weak makes a fresh board weak', async () => {
      seed(1, 'mention', 'tp_needed');
      seed(4, 'mention', 'fp_dismissed');
      unwrap(await learning.pin(ADMIN, boardId, { postures: { mention: 'gate' } }));
      const prerequisite = await create();
      const waiter = await create();
      await automatic(waiter.id, prerequisite.id);
      expect(rows(waiter.id).map((r) => r.kind ?? 'waits')).toEqual(['waits']);

      store.state.relationSignals.clear();
      unwrap(await learning.resetPins(ADMIN, boardId));
      unwrap(await learning.pin(ADMIN, boardId, { postures: { mention: 'weak' } }));
      const other = await create();
      const second = await create();
      await automatic(second.id, other.id);
      expect(rows(second.id).map((r) => r.kind)).toEqual(['may_relate']);
    });

    it('promotes a weak link to a gate, records tp_promoted once and holds the glob', async () => {
      const prerequisite = await create();
      const waiter = await create();
      const weak = put(waiter.id, prerequisite.id, { source: 'mention', kind: 'may_relate' });
      const promoted = unwrap(await globs.promoteRelation(DEV, waiter.id, null, weak.id));
      expect(store.state.relations.get(weak.id)).toMatchObject({ kind: 'waits', source: 'mention' });
      expect(kinds()).toEqual([['mention', 'tp_promoted']]);
      expect(await store.transaction((tx) => tx.listRelationsFrom([waiter.id]))).toHaveLength(1);
      expect(unwrap(await globs.get(DEV, waiter.id)).waitingFor.map((w) => w.id)).toEqual([prerequisite.id]);
      expect(promoted.id).toBe(waiter.id);
      // Promoting again finds no weak link.
      expect((await globs.promoteRelation(DEV, waiter.id, null, weak.id)).ok).toBe(false);
      expect(signals()).toHaveLength(1);
      expect(store.state.events.some((e) => e.globId === waiter.id && e.type === 'RelationAdded' && e.data['note'] === 'promoted from a weak link')).toBe(true);
    });

    it('refuses to promote a link that would cycle, one that holds nothing, a dismissed one, or on a started glob', async () => {
      const a = await create();
      const b = await create();
      put(b.id, a.id, { source: 'person' });
      const cyc = put(a.id, b.id, { kind: 'may_relate' });
      expect((await globs.promoteRelation(DEV, a.id, null, cyc.id)).ok).toBe(false);

      const merged = await create();
      const c = await create();
      const met = put(c.id, merged.id, { kind: 'may_relate' });
      await merge(merged.id);
      expect((await globs.promoteRelation(DEV, c.id, null, met.id)).ok).toBe(false);

      const d = await create();
      const e = await create();
      const gone = put(e.id, d.id, { kind: 'may_relate', dismissedAt: NOW });
      expect((await globs.promoteRelation(DEV, e.id, null, gone.id)).ok).toBe(false);

      const f = await create();
      const g = await create();
      const late = put(g.id, f.id, { kind: 'may_relate' });
      unwrap(await globs.start(DEV, g.id, (await current(g.id)).version));
      expect((await globs.promoteRelation(DEV, g.id, null, late.id)).ok).toBe(false);
      expect(signals()).toEqual([]);
    });

    it('promotion is refused when a gate to the same glob already exists', async () => {
      const a = await create();
      const b = await create();
      put(b.id, a.id, { source: 'person' });
      const weak = put(b.id, a.id, { kind: 'may_relate', id: 'weak-b-a' });
      expect((await globs.promoteRelation(DEV, b.id, null, weak.id)).ok).toBe(false);
    });

    it('a weak link can be dismissed without counting as a false positive', async () => {
      const a = await create();
      const b = await create();
      const weak = put(b.id, a.id, { source: 'mention', kind: 'may_relate' });
      unwrap(await globs.dismissRelation(DEV, b.id, null, weak.id));
      expect(store.state.relations.get(weak.id)?.dismissedAt).not.toBeNull();
      expect(signals()).toEqual([]);
    });
  });

  describe('signals', () => {
    it('are recorded once per key', async () => {
      const row = put('s1t1', 's1t2', { source: 'inferred' });
      const rowTwo = relation('s1t1', 's1t2');
      await store.transaction(async (tx) => {
        expect(await learning.record(tx, { boardId, from: 'a', to: 'b', relationId: row.id, source: 'inferred', signal: 'tp_needed', evidence: 'x', key: 'same' })).toBe(true);
        expect(await learning.record(tx, { boardId, from: 'a', to: 'b', relationId: rowTwo.id, source: 'inferred', signal: 'tp_needed', evidence: 'x', key: 'same' })).toBe(false);
        // The same key on another board is another signal.
        expect(await learning.record(tx, { boardId: boardId + 1, from: 'a', to: 'b', relationId: null, source: 'inferred', signal: 'tp_needed', evidence: 'x', key: 'same' })).toBe(true);
      });
      expect(await store.transaction((tx) => tx.listRelationSignals(boardId))).toHaveLength(1);
    });

    it('a failing recorder never fails the transition it rides on', async () => {
      const prerequisite = await create();
      const waiter = await create();
      put(waiter.id, prerequisite.id, { source: 'inferred' });
      const broken = new RelationLearningService({
        store,
        notifier: new RecordingNotifier(),
        clock: { now: () => NOW },
        ids: { runId: () => 'x' },
      });
      broken.overridden = () => Promise.reject(new Error('boom'));
      const logged: string[] = [];
      const guarded = new GlobService({
        store,
        notifier: new RecordingNotifier(),
        clock: { now: () => NOW },
        ids: { runId: () => `g-${++runs}` },
        routines: { hasRoutine: () => Promise.resolve(true) },
        relationLearning: broken,
        log: (task, message) => logged.push(`${task}: ${message}`),
      });
      const started = unwrap(await guarded.startAnyway(DEV, waiter.id, waiter.version));
      expect(started.status).not.toBe('planning');
      expect(logged).toEqual(['relation learning: boom']);
    });
  });
});

describe('relation learning (inference)', () => {
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let learning: RelationLearningService;
  let inference: DependencyInferenceService;
  let boardId: number;
  let runs: number;
  let bold: boolean;
  let answer: string;

  const PLAN = 'Add the humanSteps() helper and show it in the glob view, with tests for each kind of step it lists.';
  const llm: Llm = { complete: () => Promise.resolve(answer) };
  const create = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> =>
    unwrap(await globs.create(ADMIN, { boardId, title: 'Work', plan: PLAN, type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, ...patch }));
  const rows = (from: string): Relation[] => [...store.state.relations.values()].filter((r) => r.from === from);
  const seed = (n: number, source: RelationLearningSource, kind: RelationSignalKind): void => {
    for (const s of many(n, source, kind, { boardId })) store.state.relationSignals.set(`${boardId}:${s.key}`, s);
  };
  const investigate = (id: string, files: string[]) =>
    store.transaction((tx) =>
      tx.insertArtifact({
        globId: id,
        kind: 'investigation',
        label: '',
        content: `# Investigation\n\n\`\`\`investigation\n${JSON.stringify({
          files: files.map((path) => ({ path, change: 'modify' })),
          modules: ['core'],
          expectedLines: { min: 1, max: 5 },
          parts: [],
          riskTier: 'low',
          riskAreas: [],
          needsHuman: { needed: false, reason: null },
          confidence: 'high',
          planHash: 'p',
          baseCommit: 'c',
        })}\n\`\`\``,
        link: null,
        commitSha: null,
        provenance: { by: 'human', actor: DEV, runId: null, agentSetVersion: null },
        createdAt: '2026-10-05T12:02:00.000Z',
      }),
    );

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    bold = false;
    answer = '{"edges": []}';
    const clock = { now: () => NOW };
    learning = new RelationLearningService({ store, notifier, clock, ids: { runId: () => `id-${++runs}` } });
    inference = new DependencyInferenceService({
      store,
      llm,
      apply: (id, found, planHash) => globs.applyInferred(id, found, planHash),
      release: (id) => globs.release(id),
      bold: () => Promise.resolve(bold),
    });
    boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
      inference: { infer: (i) => inference.infer(i) },
      relationLearning: learning,
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  const need = (id: string): string =>
    JSON.stringify({ edges: [{ id, kind: 'needs', reason: 'uses humanSteps() from it', files: ['a.ts'], symbol: 'humanSteps', addedBy: id, confidence: 0.9 }] });

  it('writes a gate while inference is precise enough and a weak link once it is not', async () => {
    const provider = await create();
    answer = need(provider.id);
    const first = await create();
    expect(rows(first.id).map((r) => r.kind ?? 'waits')).toEqual(['waits']);

    seed(1, 'inferred', 'tp_needed');
    seed(4, 'inferred', 'fp_override');
    const second = await create();
    expect(rows(second.id)).toMatchObject([{ kind: 'may_relate', source: 'inferred', to: provider.id, reason: 'uses humanSteps() from it' }]);
    expect(unwrapGet(await globs.get(DEV, second.id)).waitingFor).toEqual([]);
    // Re-inferring keeps the one weak link and does not write a second row.
    await inference.refresh(second.id);
    expect(rows(second.id)).toHaveLength(1);
    // Inference no longer proposing it removes the weak link.
    answer = '{"edges": []}';
    await inference.refresh(second.id);
    expect(rows(second.id)).toEqual([]);
  });

  it('proposes globs that touch the same modules when inference is bold, as weak links', async () => {
    const same = await create();
    const elsewhere = await create();
    await investigate(same.id, ['packages/core/src/a.ts']);
    await investigate(elsewhere.id, ['apps/web/src/b.tsx']);
    const mine = await create();
    await investigate(mine.id, ['packages/core/src/c.ts']);
    await inference.refresh(mine.id);
    expect(rows(mine.id)).toEqual([]);

    bold = true;
    await inference.refresh(mine.id);
    expect(rows(mine.id)).toMatchObject([{ to: same.id, kind: 'may_relate', source: 'inferred', evidence: ['packages/core/src/a.ts'] }]);
    expect(rows(mine.id)[0]?.reason).toContain('packages/core');
    // A pinned gate (or a measured, precise source) lets a bold proposal gate.
    unwrap(await learning.pin(ADMIN, boardId, { postures: { inferred: 'gate' } }));
    const other = await create();
    await investigate(other.id, ['packages/core/src/d.ts']);
    await inference.refresh(other.id);
    expect(rows(other.id).map((r) => [r.to, r.kind ?? 'waits']).sort()).toEqual([[mine.id, 'waits'], [same.id, 'waits']].sort());
  });
});

const unwrapGet = <T>(result: Result<T>): T => unwrap(result);
