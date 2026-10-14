import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { DependencyLearningService } from '../src/app/dependency-learning-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { PREDICT_MIN, predictedFiles, unmergedPrerequisiteIds, weightsOf } from '../src/domain/dependency-rules.js';
import type { DependencyDefaults } from '../src/domain/dependency-rules.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import { renderMergePolicy } from '../src/domain/merge-policy.js';
import type { Board, Glob, Relation } from '../src/domain/types.js';
import type { BranchFiles, Catalog } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { relation } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const MIGRATION = 'apps/server/drizzle/0023_x.sql';
const PATTERN = 'apps/server/drizzle/**';
const NOW = '2026-10-08T12:00:00.000Z';
const DEFAULTS: DependencyDefaults = { neverOverlap: ['**/pnpm-lock.yaml'], overlap: ['**/migrations/**'] };

class FakeBranchFiles implements BranchFiles {
  readonly files = new Map<string, readonly string[] | null>();
  filesOf(_board: Board, glob: Glob): Promise<readonly string[] | null> {
    return Promise.resolve(this.files.get(glob.id) ?? null);
  }
}

describe('dependency rules (pure)', () => {
  it('predicts files under a trusted pattern and leaves out never-overlap ones', () => {
    const patterns = [PATTERN, '**/pnpm-lock.yaml', '**/migrations/**'];
    const weights = weightsOf(patterns, [], DEFAULTS);
    expect(predictedFiles([MIGRATION, 'pnpm-lock.yaml', 'db/migrations/1.sql', 'src/a.ts'], patterns, weights, DEFAULTS)).toEqual([
      MIGRATION,
      'db/migrations/1.sql',
    ]);
    const weak = new Map(weights).set(PATTERN, PREDICT_MIN - 0.05);
    expect(predictedFiles([MIGRATION], patterns, weak, DEFAULTS)).toEqual([]);
  });

  it('reads unmerged prerequisites from a failure reason', () => {
    const known = new Set(['s1t1', 's1t2']);
    expect(unmergedPrerequisiteIds('Blocked on unmerged s1t1 (and s1t2)', known, 's1t9')).toEqual(['s1t1', 's1t2']);
    expect(unmergedPrerequisiteIds('s1t1 hasn\'t merged yet; this branch lacks its changes', known, 's1t9')).toEqual(['s1t1']);
    expect(unmergedPrerequisiteIds('Tests failed in s1t1', known, 's1t9')).toEqual([]);
    expect(unmergedPrerequisiteIds('Blocked on unmerged s1t9', known, 's1t9')).toEqual([]);
  });
});

describe('dependency learning', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let boards: BoardService;
  let learning: DependencyLearningService;
  let branches: FakeBranchFiles;
  let boardId: number;
  let runs: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Work',
    type: 'sub',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const create = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(DEV, input(patch)));
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const merge = async (id: string): Promise<void> => {
    unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc1234' }, c)));
    await learning.onMerged(id);
  };
  const weight = async (): Promise<number | undefined> =>
    (await store.transaction((tx) => tx.listDependencyRules(boardId))).find((r) => r.pattern === PATTERN)?.weight;
  /** An open glob (a same someone picked up) whose branch changes the migrations. */
  /** The relations that start at a glob, from the store's rows. */
  const relationsOf = (id: string) => [...store.state.relations.values()].filter((r) => r.from === id);
  /** Records an inferred need of `from` on `to`, as inference would have. */
  const inferNeed = (from: string, to: string, patch: Partial<Relation> = {}): Relation => {
    const row = relation(from, to, { source: 'inferred', reason: 'x', ...patch });
    store.state.relations.set(row.id, row);
    return row;
  };
  const openGlob = async () => {
    const made = await create({ type: 'same', plan: 'Something else entirely' });
    const picked = unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    branches.files.set(picked.id, [MIGRATION]);
    return picked;
  };
  const overlapping = async (): Promise<Glob> => create({ plan: 'Add a migration for the new column' });

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    branches = new FakeBranchFiles();
    boards = new BoardService({ store, notifier });
    const catalog: Catalog = {
      kbEntries: () => Promise.resolve([]),
      agentSet: () => Promise.resolve({ hash: '', files: [] }),
      dependencyDefaults: () => Promise.resolve(DEFAULTS),
    };
    learning = new DependencyLearningService({ store, notifier, clock: { now: () => NOW }, ids: { runId: () => `rel-${++runs}` }, catalog });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => NOW },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
      branchFiles: branches,
      dependencyLearning: learning,
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    await store.transaction((tx) =>
      tx.saveKnowledge({
        boardId,
        kind: 'merge_policy',
        name: 'merge-policy',
        area: null,
        audience: [],
        description: '',
        content: renderMergePolicy({ exclusivePaths: [PATTERN] }),
        layer: 'file',
        version: 1,
        source: 'kb:s1k1',
        updatedBy: ADMIN,
        updatedAt: NOW,
      }),
    );
  });

  it('weakens a pattern with each clean overlap until it is no longer predicted, with history', async () => {
    const open = await openGlob();
    for (let i = 0; i < 3; i++) {
      const g = await overlapping();
      expect(g.impliedAfter?.[0]?.id).toBe(open.id);
      await merge(g.id);
    }
    expect(await weight()).toBe(0.25);
    const history = await store.transaction((tx) => tx.listDependencyRuleChanges(boardId));
    expect(history.map((h) => [h.cause, h.from, h.to])).toEqual([
      ['clean_overlap', 0.5, 0.25],
      ['clean_overlap', 0.75, 0.5],
      ['clean_overlap', 1, 0.75],
    ]);
    expect(history[0]?.evidence).toContain('with no conflict or rework');
    // The pattern is no longer predicted, so nothing overlaps it.
    expect((await overlapping()).impliedAfter).toBeUndefined();
  });

  it('records an outcome once per glob and pattern, however often the merge is delivered', async () => {
    await openGlob();
    const g = await overlapping();
    await merge(g.id);
    await learning.onMerged(g.id);
    expect(await weight()).toBe(0.75);
  });

  it('keeps a pattern whose overlap conflicted, and strengthens a weakened one', async () => {
    await openGlob();
    const first = await overlapping();
    await merge(first.id);
    expect(await weight()).toBe(0.75);
    const second = await overlapping();
    await store.transaction((tx) =>
      tx.appendEvents([{ type: 'ConflictFlagged', globId: second.id, actor: null, at: NOW, data: { base: 'main', files: [MIGRATION], since: null } }]),
    );
    await merge(second.id);
    expect(await weight()).toBe(1);
    const history = await store.transaction((tx) => tx.listDependencyRuleChanges(boardId));
    expect(history[0]?.cause).toBe('conflicted_overlap');
  });

  it('never predicts a catalog never-overlap pattern, and predicts the catalog overlap one', async () => {
    const view = unwrap(await learning.view(DEV, boardId));
    const byPattern = new Map(view.rules.map((r) => [r.pattern, r]));
    expect(byPattern.get('**/pnpm-lock.yaml')).toMatchObject({ state: 'default', predicted: false, defaultWeight: 0 });
    expect(byPattern.get('**/migrations/**')).toMatchObject({ state: 'default', predicted: true });
    const open = await create({ type: 'same', plan: 'x' });
    const picked = unwrap(await globs.pickUp(DEV, open.id, open.version, false));
    branches.files.set(picked.id, ['pnpm-lock.yaml']);
    expect((await create({ plan: 'Add a migration', files: ['pnpm-lock.yaml'] })).impliedAfter).toBeUndefined();
    branches.files.set(picked.id, ['db/migrations/1.sql']);
    expect((await create({ plan: 'Add a migration' })).impliedAfter?.[0]?.paths).toEqual(['db/migrations/1.sql']);
  });

  it('a run failing for unmerged prerequisites adds a learned need that blocks starting again', async () => {
    const prerequisite = await create({ type: 'same' });
    const stuck = await create({ type: 'same' });
    const started = unwrap(await globs.start(DEV, stuck.id, stuck.version));
    expect(started.status).toBe('implementing');
    const learned = await learning.onFailed(stuck.id, `Blocked on unmerged ${prerequisite.id}`);
    expect(learned).toEqual([prerequisite.id]);
    expect(relationsOf(stuck.id)).toMatchObject([{ to: prerequisite.id, gate: 'start', until: 'merged', source: 'learned' }]);
    expect(relationsOf(stuck.id)[0]?.reason).toContain('Blocked on unmerged');
    // The version moved and the log says why.
    expect((await current(stuck.id)).version).toBeGreaterThan(started.version);
    expect(store.state.events.find((e) => e.globId === stuck.id && e.type === 'RelationAdded')?.data).toMatchObject({ to: prerequisite.id, source: 'learned' });
    const view = unwrap(await globs.get(DEV, stuck.id));
    expect(view.waitingFor.map((w) => w.id)).toEqual([prerequisite.id]);
    // Saying it twice changes nothing.
    expect(await learning.onFailed(stuck.id, `Blocked on unmerged ${prerequisite.id}`)).toEqual([]);
    const history = await store.transaction((tx) => tx.listDependencyRuleChanges(boardId));
    expect(history.map((h) => h.cause)).toEqual(['unmerged_prerequisite']);
  });

  it('upgrades an overlap to a need when the run failed for it, and strengthens its pattern', async () => {
    const open = await openGlob();
    const g = await overlapping();
    await learning.onFailed(g.id, `Blocked on unmerged ${open.id}`);
    // The predicted overlap becomes the need: its paths are the relation's evidence and the overlap entry goes.
    expect(relationsOf(g.id)).toEqual([expect.objectContaining({ to: open.id, gate: 'start', source: 'learned', evidence: [MIGRATION] })]);
    expect((await current(g.id)).impliedAfter).toEqual([]);
    expect(await weight()).toBe(1);
  });

  it('downgrades an inferred need overridden with start anyway to an overlap once the glob merges without failing for it', async () => {
    const prerequisite = await create({ type: 'same' });
    const waiter = await create({ type: 'same' });
    const need = inferNeed(waiter.id, prerequisite.id);
    unwrap(await globs.startAnyway(DEV, waiter.id, waiter.version));
    // Start now marks the inferred relation overridden: it no longer holds, and is still there to be judged.
    expect(store.state.relations.get(need.id)?.overriddenAt).not.toBeNull();
    await merge(waiter.id);
    const after = await current(waiter.id);
    expect(relationsOf(waiter.id)).toEqual([]);
    expect(after.impliedAfter).toEqual([expect.objectContaining({ id: prerequisite.id, kind: 'overlaps', source: 'learned' })]);
    expect(store.state.events.find((e) => e.globId === waiter.id && e.type === 'RelationReleased')?.data).toMatchObject({ to: prerequisite.id, gate: 'start' });
    const history = await store.transaction((tx) => tx.listDependencyRuleChanges(boardId));
    expect(history.map((h) => h.cause)).toEqual(['start_anyway_succeeded']);
  });

  it('Start now leaves a need a person set as it was, and a merge never downgrades it', async () => {
    const prerequisite = await create({ type: 'same' });
    const waiter = await create({ after: [prerequisite.id] });
    unwrap(await globs.startAnyway(DEV, waiter.id, waiter.version));
    expect(relationsOf(waiter.id)).toMatchObject([{ to: prerequisite.id, source: 'person', overriddenAt: null }]);
    await merge(waiter.id);
    expect(relationsOf(waiter.id)).toHaveLength(1);
    expect(await store.transaction((tx) => tx.listDependencyRuleChanges(boardId))).toEqual([]);
  });

  it('keeps a need whose start anyway then failed for the prerequisite', async () => {
    const prerequisite = await create({ type: 'same' });
    const waiter = await create({ type: 'same' });
    inferNeed(waiter.id, prerequisite.id);
    unwrap(await globs.startAnyway(DEV, waiter.id, waiter.version));
    await learning.onFailed(waiter.id, `Blocked on unmerged ${prerequisite.id}`);
    await merge(waiter.id);
    expect(relationsOf(waiter.id).map((r) => r.to)).toEqual([prerequisite.id]);
  });

  it('a dismissed inferred edge weakens its patterns once the glob merges; Start now alone is no dismissal', async () => {
    const other = await create({ type: 'same' });
    const made = await create({ type: 'same' });
    inferNeed(made.id, other.id, { reason: 'both touch the migrations', evidence: [MIGRATION] });
    unwrap(await globs.dismissEdge(DEV, made.id, made.version, other.id));
    await merge(made.id);
    const history = await store.transaction((tx) => tx.listDependencyRuleChanges(boardId));
    expect(history.map((h) => [h.cause, h.pattern])).toEqual([['edge_dismissed', PATTERN]]);
    expect(await weight()).toBe(0.75);
    await learning.onMerged(made.id);
    expect(await weight()).toBe(0.75);

    const prerequisite = await create({ type: 'same' });
    const waiter = await create({ type: 'same' });
    inferNeed(waiter.id, prerequisite.id);
    unwrap(await globs.startAnyway(DEV, waiter.id, waiter.version));
    await merge(waiter.id);
    const after = await store.transaction((tx) => tx.listDependencyRuleChanges(boardId));
    expect(after.map((h) => h.cause).sort()).toEqual(['edge_dismissed', 'start_anyway_succeeded']);
  });

  it('lets an admin reset what was learned, with the reset in the history', async () => {
    await openGlob();
    await merge((await overlapping()).id);
    expect(await weight()).toBe(0.75);
    expect((await learning.reset(DEV, boardId)).ok).toBe(false);
    unwrap(await learning.reset(ADMIN, boardId, PATTERN));
    expect(await weight()).toBeUndefined();
    const view = unwrap(await learning.view(DEV, boardId));
    expect(view.rules.find((r) => r.pattern === PATTERN)).toMatchObject({ state: 'default', weight: 1 });
    expect(view.history[0]).toMatchObject({ cause: 'reset', from: 0.75, to: 1, globId: null });
  });
});
