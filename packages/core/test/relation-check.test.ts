import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { DependencyLearningService } from '../src/app/dependency-learning-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { RelationCheckService } from '../src/app/relation-check-service.js';
import { RelationLearningService } from '../src/app/relation-learning-service.js';
import type { Result } from '../src/domain/errors.js';
import { laneOf } from '../src/domain/events.js';
import * as machine from '../src/domain/machine.js';
import { addedSymbols, hunksOf, judgeRelation } from '../src/domain/relation-check.js';
import type { CheckFacts } from '../src/domain/relation-check.js';
import { holdingOf, startIds, unmet } from '../src/domain/relations.js';
import type { DiffSummary } from '../src/domain/sub-gate.js';
import type { Glob, Relation } from '../src/domain/types.js';
import type { ChangeSource } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { relation } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** A unified diff of one hunk: `old` lines replaced by `added` at `start` (new file when start is 0). */
const patch = (added: readonly string[], start = 1, removed = 0): string =>
  `@@ -${String(start === 0 ? 0 : start)},${String(removed)} +${String(Math.max(start, 1))},${String(added.length)} @@\n${added.map((l) => `+${l}`).join('\n')}`;
const diff = (files: Record<string, string>): DiffSummary => ({ changedLines: 10, files: Object.keys(files), patches: files });

describe('relation check (pure)', () => {
  it('reads the exported symbols a patch adds', () => {
    expect(addedSymbols('a.ts', patch(['export const holdWords = 1;', 'export async function loadAll() {}', 'export interface Thing {}', 'const hidden = 2;']))).toEqual(['holdWords', 'loadAll', 'Thing']);
    expect(addedSymbols('a.ts', patch(['export { inner as outerName, plain };']))).toEqual(['outerName', 'plain']);
    expect(addedSymbols('tool.py', patch(['def make_thing(x):', 'class Widget:', 'export const nope = 1']))).toEqual(['make_thing', 'Widget']);
    // Too short to prove a use.
    expect(addedSymbols('a.ts', patch(['export const x = 1;']))).toEqual([]);
  });

  it('reads hunks', () => {
    expect(hunksOf('@@ -10,3 +12,5 @@ fn\n+a')).toEqual([{ oldRange: { from: 10, to: 12 }, newRange: { from: 12, to: 16 }, created: false }]);
    expect(hunksOf('@@ -0,0 +1,4 @@\n+a')[0]?.created).toBe(true);
  });

  const facts = (a: Record<string, string>, b: Record<string, string>, imports: CheckFacts['imports'] = []): CheckFacts => ({ a: { id: 's1t2', diff: diff(a) }, b: { id: 's1t1', diff: diff(b) }, imports });

  it('is needed when the diff uses a symbol the other glob added, naming it', () => {
    const result = judgeRelation(facts({ 'src/b.ts': patch(['const w = holdWords(r);']) }, { 'src/a.ts': patch(['export const holdWords = (r: string) => r;']) }));
    expect(result).toEqual({ verdict: 'needed', reason: 'uses `holdWords` from s1t1 (in src/b.ts)' });
  });

  it('does not count a symbol the diff defines itself, or a definition line, as a use', () => {
    const result = judgeRelation(
      facts({ 'src/b.ts': patch(['export const holdWords = 2;']) }, { 'src/a.ts': patch(['export const holdWords = 1;']) }),
    );
    expect(result.verdict).toBe('not_needed');
  });

  it('is needed when the diff imports a file the other glob created', () => {
    const result = judgeRelation(facts({ 'src/b.ts': patch(['// nothing named']) }, { 'src/new.ts': patch(['const private1 = 1;'], 0) }, [{ from: 'src/b.ts', to: 'src/new.ts' }]));
    expect(result).toEqual({ verdict: 'needed', reason: 'imports `src/new.ts` from s1t1 (in src/b.ts)' });
    // An import of a file that already existed proves nothing.
    expect(judgeRelation(facts({ 'src/b.ts': patch(['// x']) }, { 'src/old.ts': patch(['x'], 5, 1) }, [{ from: 'src/b.ts', to: 'src/old.ts' }])).verdict).toBe('not_needed');
  });

  it('is needed when both changed the same lines, unsure when only the same files', () => {
    const same = judgeRelation(facts({ 'src/c.ts': patch(['one'], 10, 2) }, { 'src/c.ts': patch(['two', 'three'], 9, 1) }));
    expect(same).toMatchObject({ verdict: 'needed', reason: 'changes the same lines of `src/c.ts` as s1t1' });
    const apart = judgeRelation(facts({ 'src/c.ts': patch(['one'], 100, 1) }, { 'src/c.ts': patch(['two'], 5, 1) }));
    expect(apart).toMatchObject({ verdict: 'unsure', reason: 'both changed `src/c.ts` but not the same lines' });
  });

  it('is not needed when nothing overlaps, and unsure with a missing patch or an unreadable index', () => {
    expect(judgeRelation(facts({ 'src/x.ts': patch(['const a = 1;']) }, { 'src/y.ts': patch(['export const other = 1;']) }))).toEqual({ verdict: 'not_needed', reason: 'no shared files, imports or symbols' });
    const noPatch: DiffSummary = { changedLines: 3, files: ['big.bin'] };
    expect(judgeRelation({ a: { id: 'a', diff: noPatch }, b: { id: 'b', diff: diff({ 'y.ts': patch(['export const thing = 1;']) }) }, imports: [] }).verdict).toBe('unsure');
    expect(judgeRelation(facts({ 'src/x.ts': patch(['const a = 1;']) }, { 'src/y.ts': patch(['export const other = 1;']) }, null))).toMatchObject({ verdict: 'unsure', reason: 'the code index could not be read' });
  });

  it('puts the check on the llm lane', () => {
    expect(laneOf('check_relations_after_merge')).toBe('llm');
  });
});

describe('relation check (service)', () => {
  const ADMIN = 'admin@example.com';
  const START = Date.parse('2026-10-16T12:00:00.000Z');
  let store: MemoryStore;
  let globs: GlobService;
  let learning: RelationLearningService;
  let check: RelationCheckService;
  let boardId: number;
  let runs: number;
  let tick: number;
  let diffs: Map<string, DiffSummary | null>;
  let edges: { from: string; to: string }[] | null;
  let calls: LlmRequest[];
  let reply: () => Promise<string>;
  let withLlm: boolean;

  const input = (patchIn: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Work',
    plan: 'Some plan for the work, long enough to count as a plan.',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patchIn,
  });
  const create = async (): Promise<Glob> => unwrap(await globs.create(ADMIN, input()));
  const merge = async (id: string, sha: string): Promise<void> => {
    unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha }, c)));
  };
  const put = (from: string, to: string, patchIn: Partial<Relation> = {}): Relation => {
    const row = relation(from, to, { source: 'inferred', reason: `needs ${to}`, ...patchIn });
    store.state.relations.set(row.id, row);
    return row;
  };
  const stored = (id: string): Relation => {
    const found = store.state.relations.get(id);
    if (found === undefined) throw new Error(`No relation ${id}`);
    return found;
  };
  const signals = (): [string, string][] => [...store.state.relationSignals.values()].map((s) => [s.source, s.signal]);

  const changes: ChangeSource = { mergedDiff: (_board, sha) => Promise.resolve(diffs.get(sha) ?? null) };

  /** B merges first, then A, each with the given diff; one relation from A to B. */
  const pair = async (a: DiffSummary, b: DiffSummary): Promise<{ a: Glob; b: Glob; row: Relation }> => {
    const first = await create();
    const second = await create();
    const row = put(second.id, first.id);
    diffs.set('shab', b);
    diffs.set('shaa', a);
    await merge(first.id, 'shab');
    await merge(second.id, 'shaa');
    return { a: second, b: first, row };
  };

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    tick = 0;
    diffs = new Map();
    edges = [];
    calls = [];
    withLlm = true;
    reply = () => Promise.resolve('{"verdicts": []}');
    const clock = { now: () => new Date(START + ++tick * 1000).toISOString() };
    learning = new RelationLearningService({ store, notifier, clock, ids: { runId: () => `id-${++runs}` } });
    const depLearning = new DependencyLearningService({ store, notifier, clock, ids: { runId: () => `rel-${++runs}` }, relationLearning: learning });
    const boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
      dependencyLearning: depLearning,
      relationLearning: learning,
    });
    const llm: Llm = {
      complete: (request) => {
        calls.push(request);
        return reply();
      },
    };
    check = new RelationCheckService({
      store,
      clock,
      changes,
      learning,
      index: { importEdges: () => Promise.resolve(edges) },
      get llm() {
        return withLlm ? llm : undefined;
      },
    });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
  });

  it('queues the check when a glob merges', async () => {
    const g = await create();
    await merge(g.id, 'sha1');
    expect(store.state.outbox.map((e) => e.kind)).toContain('check_relations_after_merge');
  });

  it('marks a relation needed when the diff uses a symbol the other glob added, without asking the model', async () => {
    const { a, b, row } = await pair(diff({ 'src/b.ts': patch(['const w = holdWords(r);']) }), diff({ 'src/a.ts': patch(['export const holdWords = (r: string) => r;']) }));
    expect(await check.run(a.id)).toBe('done');
    expect(stored(row.id)).toMatchObject({ verdict: 'needed', verdictBy: 'git', verdictReason: `uses \`holdWords\` from ${b.id} (in src/b.ts)` });
    expect(calls).toHaveLength(0);
    expect(signals()).toEqual([['inferred', 'tp_needed']]);
    const events = [...store.state.events].filter((e) => e.type === 'RelationVerdict');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ globId: a.id, data: { to: b.id, verdict: 'needed', by: 'git' } });
    // A second pass changes nothing.
    await check.run(a.id);
    expect(signals()).toHaveLength(1);
    expect([...store.state.events].filter((e) => e.type === 'RelationVerdict')).toHaveLength(1);
  });

  it('marks a relation not needed when nothing overlaps, and counts it as a false positive', async () => {
    const { a, row } = await pair(diff({ 'docs/readme.md': patch(['text']) }), diff({ 'src/a.ts': patch(['export const holdWords = 1;']) }));
    await check.run(a.id);
    expect(stored(row.id)).toMatchObject({ verdict: 'not_needed', verdictBy: 'git', verdictReason: 'no shared files, imports or symbols' });
    expect(signals()).toEqual([['inferred', 'fp_not_needed']]);
    expect(calls).toHaveLength(0);
  });

  it('asks the model once for everything git could not settle, and stores its verdicts', async () => {
    const { a, row } = await pair(diff({ 'src/c.ts': patch(['one'], 100, 1) }), diff({ 'src/c.ts': patch(['two'], 5, 1) }));
    reply = () => Promise.resolve(JSON.stringify({ verdicts: [{ id: row.id, verdict: 'needed', reason: 'builds on the new helper in src/c.ts' }] }));
    await check.run(a.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.spend).toMatchObject({ boardId, source: 'relation_check', globId: a.id });
    expect(calls[0]?.prompt).toContain(row.id);
    expect(stored(row.id)).toMatchObject({ verdict: 'needed', verdictBy: 'model', verdictReason: 'builds on the new helper in src/c.ts' });
    expect(signals()).toEqual([['inferred', 'tp_needed']]);
    await check.run(a.id);
    expect(calls).toHaveLength(1);
  });

  it('masks secrets in what the model is shown', async () => {
    const { a, row } = await pair(diff({ 'src/c.ts': patch(['const key = "AKIAABCDEFGHIJKLMNOP";'], 100, 1) }), diff({ 'src/c.ts': patch(['two'], 5, 1) }));
    reply = () => Promise.resolve(JSON.stringify({ verdicts: [{ id: row.id, verdict: 'unsure', reason: 'cannot tell' }] }));
    await check.run(a.id);
    expect(calls[0]?.prompt).not.toContain('AKIAABCDEFGHIJKLMNOP');
    // An unsure answer is stored, and counts as neither a hit nor a miss.
    expect(stored(row.id)).toMatchObject({ verdict: 'unsure', verdictBy: 'model' });
    expect(signals()).toEqual([]);
  });

  it('stores nothing from a model that is unavailable or gives no usable answer, and keeps what git decided', async () => {
    const first = await create();
    const second = await create();
    const third = await create();
    const gitRow = put(third.id, first.id);
    const modelRow = put(third.id, second.id);
    diffs.set('sha1', diff({ 'docs/x.md': patch(['y']) }));
    diffs.set('sha2', diff({ 'src/c.ts': patch(['two'], 5, 1) }));
    diffs.set('sha3', diff({ 'src/c.ts': patch(['one'], 100, 1) }));
    await merge(first.id, 'sha1');
    await merge(second.id, 'sha2');
    await merge(third.id, 'sha3');

    reply = () => Promise.resolve('not json');
    await expect(check.run(third.id)).rejects.toThrow('no usable answer');
    expect(stored(modelRow.id).verdict).toBeUndefined();
    // Git's own verdict was stored before the model was asked.
    expect(stored(gitRow.id).verdict).toBe('not_needed');

    reply = () => Promise.resolve('{"verdicts": [{"id": "other", "verdict": "needed", "reason": "x"}]}');
    await expect(check.run(third.id)).rejects.toThrow('none of the relations');
    expect(stored(modelRow.id).verdict).toBeUndefined();

    reply = () => Promise.reject(new LlmUnavailable('Sign-in expired', 'Sign in again'));
    await expect(check.run(third.id)).rejects.toBeInstanceOf(LlmUnavailable);
    withLlm = false;
    await expect(check.run(third.id)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(stored(modelRow.id).verdict).toBeUndefined();
    expect(signals()).toEqual([['inferred', 'fp_not_needed']]);
  });

  it('skips a relation whose other glob had not merged when this one did, a dismissed one, and a glob that has not merged', async () => {
    const early = await create();
    const late = await create();
    const merged = await create();
    const open = await create();
    const notYet = put(merged.id, late.id);
    const dismissed = put(merged.id, early.id, { dismissedAt: '2026-10-16T12:00:00.000Z', source: 'person' });
    diffs.set('sha1', diff({ 'docs/x.md': patch(['y']) }));
    diffs.set('sha2', diff({ 'docs/y.md': patch(['z']) }));
    diffs.set('sha3', diff({ 'docs/z.md': patch(['z']) }));
    await merge(early.id, 'sha1');
    await merge(merged.id, 'sha3');
    await merge(late.id, 'sha2');
    expect(await check.run(merged.id)).toBe('done');
    expect(stored(notYet.id).verdict).toBeUndefined();
    expect(stored(dismissed.id).verdict).toBeUndefined();
    expect(await check.run(open.id)).toBe('dropped');
    expect(signals()).toEqual([]);
  });

  it('leaves the relation alone when a diff cannot be read', async () => {
    const { a, row } = await pair(diff({ 'a.ts': patch(['x']) }), diff({ 'b.ts': patch(['y']) }));
    diffs.set('shab', null);
    await check.run(a.id);
    expect(stored(row.id).verdict).toBeUndefined();
  });

  it('answers the red-main use test from git and the index only', async () => {
    const { a, b } = await pair(diff({ 'src/b.ts': patch(['const w = holdWords(r);']) }), diff({ 'src/a.ts': patch(['export const holdWords = (r: string) => r;']) }));
    const [ga, gb] = await store.transaction(async (tx) => [await tx.getGlob(a.id), await tx.getGlob(b.id)]);
    if (ga === null || gb === null) throw new Error('missing');
    expect(await check.uses(ga, gb)).toBe(true);
    expect(await check.uses(gb, ga)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('never lets a verdict, a weak link or a weak row hold anything', async () => {
    const { a, b, row } = await pair(diff({ 'docs/x.md': patch(['y']) }), diff({ 'src/a.ts': patch(['export const holdWords = 1;']) }));
    await check.run(a.id);
    const weak = put(a.id, b.id, { kind: 'may_relate', source: 'mention', gate: 'merge' });
    const facts = { relations: await store.transaction((tx) => tx.listRelationsFrom([a.id])), states: new Map([[b.id, 'merged' as const]]) };
    expect(facts.relations.map((r) => r.id)).toEqual([row.id]);
    expect(unmet(facts, 'merge')).toEqual([]);
    expect(startIds(facts.relations)).not.toContain(weak.id);
    // The view rows carry the verdict.
    expect(holdingOf({ relations: [stored(row.id)], states: new Map([[b.id, 'open' as const]]) }, new Map())[0]).toMatchObject({ verdict: 'not_needed', verdictBy: 'git' });
    // A weak link is read on its own and its own verdict is never judged.
    await check.run(a.id);
    expect(stored(weak.id).verdict).toBeUndefined();
  });
});
