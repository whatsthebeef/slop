import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { findClash } from '../src/app/hold-service.js';
import type { Result } from '../src/domain/errors.js';
import { exclusiveFiles, namesExclusivePath } from '../src/domain/exclusive-paths.js';
import * as machine from '../src/domain/machine.js';
import { renderMergePolicy } from '../src/domain/merge-policy.js';
import type { Board, Glob } from '../src/domain/types.js';
import type { BranchFiles } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { ctx, dev, glob as fixture } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const MIGRATION = 'apps/server/drizzle/0023_x.sql';
const POLICY = { exclusivePaths: ['apps/server/drizzle/**'], sizeIgnoredPaths: ['pnpm-lock.yaml'] };

class FakeBranchFiles implements BranchFiles {
  readonly files = new Map<string, readonly string[] | null>();
  readonly reads: string[] = [];
  filesOf(_board: Board, glob: Glob): Promise<readonly string[] | null> {
    this.reads.push(glob.id);
    return Promise.resolve(this.files.get(glob.id) ?? null);
  }
}

describe('exclusive paths', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let boards: BoardService;
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
  const setPolicy = (content: string) =>
    store.transaction((tx) =>
      tx.saveKnowledge({
        boardId,
        kind: 'merge_policy',
        name: 'merge-policy',
        area: null,
        audience: [],
        description: '',
        content,
        layer: 'file',
        version: 1,
        source: 'kb:s1k1',
        updatedBy: ADMIN,
        updatedAt: '2026-10-08T12:00:00.000Z',
      }),
    );
  /** An open glob whose branch already changes `files`. */
  const openGlob = async (files: readonly string[] | null, plan = 'Something else entirely') => {
    const made = await create({ type: 'same', plan });
    const picked = unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    branches.files.set(picked.id, files);
    return picked;
  };

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    branches = new FakeBranchFiles();
    boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => '2026-10-08T12:00:00.000Z' },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
      branchFiles: branches,
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    await setPolicy(renderMergePolicy(POLICY));
  });

  it('never holds a glob for a decision glob, even one that looks like it has a branch', async () => {
    const decision = fixture({ id: 's1k1', boardId, category: 'decision', status: 'in_progress', implementer: ADMIN, provisioning: 'ok' });
    await store.transaction((tx) => tx.insertGlob(decision, null));
    branches.files.set(decision.id, [MIGRATION]);
    const started = await create({ plan: 'Add a migration for the new column' });
    expect(started.status).toBe('implementing');
    expect(started.impliedAfter ?? []).toEqual([]);
    expect(branches.reads).not.toContain(decision.id);
  });

  it('starts a sub whose plan names a migration at once and records the open glob as an overlap', async () => {
    const open = await openGlob([MIGRATION, 'apps/server/src/a.ts']);
    const started = await create({ plan: 'Add a migration for the new column' });
    expect(started.status).toBe('implementing');
    expect(started.waiting == null).toBe(true);
    expect(started.impliedAfter).toEqual([{ id: open.id, paths: [MIGRATION] }]);
    expect(started.runs).toHaveLength(1);
    const view = unwrap(await globs.get(DEV, started.id));
    expect(view.waitingFor).toEqual([]);
    expect(view.allowedActions).not.toContain('start_anyway');
  });

  it('also predicts an overlap when the plan names the directory, or intake guessed a file in it', async () => {
    const open = await openGlob([MIGRATION]);
    const named = await create({ plan: 'Touches apps/server/drizzle/meta only' });
    expect(named.impliedAfter?.map((i) => i.id)).toEqual([open.id]);
    const guessed = await create({ plan: 'Rename the column', files: [MIGRATION] });
    // The first one started at once, so it is now an open glob the second overlaps too.
    expect(guessed.impliedAfter?.map((i) => i.id)).toEqual([open.id, named.id]);
  });

  it('records nothing for a sub whose plan does not name an exclusive path, even beside such a glob', async () => {
    await openGlob([MIGRATION]);
    const free = await create({ plan: 'Fix the login timeout' });
    expect(free.status).toBe('implementing');
    expect(free.impliedAfter).toBeUndefined();
  });

  it('never predicts for a branch it cannot read, or without a policy', async () => {
    await openGlob(null);
    expect((await create({ plan: 'Add a migration' })).impliedAfter).toBeUndefined();
    await store.transaction((tx) => tx.deleteKnowledge(boardId, 'merge_policy', 'merge-policy'));
    await openGlob([MIGRATION]);
    const unpolicied = await create({ plan: 'Add a migration' });
    expect(unpolicied.status).toBe('implementing');
    expect(unpolicied.impliedAfter).toBeUndefined();
  });

  it('a started same and a changed-to-sub same start at once, with the overlap noted', async () => {
    const open = await openGlob([MIGRATION]);
    const same = await create({ type: 'same', plan: 'Add a migration' });
    const started = unwrap(await globs.start(DEV, same.id, same.version));
    expect(started.status).toBe('implementing');
    expect(started.impliedAfter?.map((i) => i.id)).toEqual([open.id]);
  });

  it('an overlap does not block while a real need does', async () => {
    const open = await openGlob([MIGRATION]);
    const first = await create({ type: 'same' });
    const both = await create({ plan: 'Add a migration', after: [first.id] });
    expect(both.status).toBe('planning');
    const view = unwrap(await globs.get(DEV, both.id));
    expect(view.waitingFor.map((w) => w.id)).toEqual([first.id]);
    unwrap(await globs.applyEvent(first.id, (g, c) => machine.merged(g, { sha: 'abc1234' }, c)));
    expect(await globs.releaseDependents(first.id, boardId)).toEqual([both.id]);
    const started = await current(both.id);
    expect(started.status).toBe('implementing');
    expect(started.impliedAfter?.map((i) => i.id)).toEqual([open.id]);
  });
});

describe('clash warning', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let boards: BoardService;
  let branches: FakeBranchFiles;
  let boardId: number;

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    branches = new FakeBranchFiles();
    boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => '2026-10-08T12:00:00.000Z' },
      ids: { runId: () => 'run-1' },
      routines: { hasRoutine: () => Promise.resolve(true) },
      branchFiles: branches,
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
        content: renderMergePolicy(POLICY),
        layer: 'file',
        version: 1,
        source: 'kb:s1k1',
        updatedBy: ADMIN,
        updatedAt: '2026-10-08T12:00:00.000Z',
      }),
    );
  });

  const started = async (plan: string) => {
    const made = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Work',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan,
      }),
    );
    return unwrap(await globs.pickUp(DEV, made.id, made.version, false));
  };

  it('starts a glob that does not name a migration, then warns once its branch touches the path another glob changes, and clears it', async () => {
    const other = await started('Add a migration');
    branches.files.set(other.id, [MIGRATION]);
    const mine = await started('Tidy the settings page');
    expect(mine.status).toBe('in_progress');

    const b = await store.transaction((tx) => tx.getBoard(boardId));
    if (b === null) throw new Error('no board');
    // Its branch changes nothing exclusive yet: no warning.
    branches.files.set(mine.id, ['apps/web/src/a.tsx']);
    expect(await findClash(store, branches, b, mine)).toBeNull();

    // Then it touches the migrations too.
    branches.files.set(mine.id, ['apps/web/src/a.tsx', 'apps/server/drizzle/0024_y.sql']);
    const clash = await findClash(store, branches, b, mine);
    expect(clash).toEqual({ with: other.id, paths: ['apps/server/drizzle/0024_y.sql'] });
    const warned = unwrap(await globs.applyEvent(mine.id, (g, c) => machine.clashChanged(g, clash, c)));
    expect(warned.clash).toEqual({ with: other.id, paths: ['apps/server/drizzle/0024_y.sql'] });
    // The same finding again is no change.
    const again = unwrap(await globs.applyEvent(mine.id, (g, c) => machine.clashChanged(g, clash, c)));
    expect(again.version).toBe(warned.version);

    // The other glob's branch no longer changes them: cleared.
    branches.files.set(other.id, []);
    expect(await findClash(store, branches, b, warned)).toBeNull();
    const cleared = unwrap(await globs.applyEvent(mine.id, (g, c) => machine.clashChanged(g, null, c)));
    expect(cleared.clash).toBeNull();
  });

  it('a push to a glob in Doing with a PR queues the check', () => {
    const doing = fixture({ status: 'in_progress', type: 'same' });
    const result = machine.commitPushed(doing, { sha: 'abc1234', runId: null }, ctx(null));
    expect(result.ok && result.value.effects.map((e) => e.kind)).toContain('check_exclusive_paths');
    const superseded = machine.commitPushed(doing, { sha: 'abc1234', runId: 'old-run' }, ctx(null));
    expect(superseded.ok && superseded.value.effects.map((e) => e.kind)).not.toContain('check_exclusive_paths');
  });
});

describe('exclusive path helpers', () => {
  it('finds files under the globs and a plan that names one', () => {
    expect(exclusiveFiles(POLICY, ['a.ts', MIGRATION, 'apps/server/drizzle/meta/_journal.json'])).toEqual([
      MIGRATION,
      'apps/server/drizzle/meta/_journal.json',
    ]);
    expect(namesExclusivePath(POLICY, 'Changes apps/server/drizzle/meta')).toBe(true);
    expect(namesExclusivePath(POLICY, 'A new Drizzle migration')).toBe(true);
    expect(namesExclusivePath(POLICY, 'Fix a typo')).toBe(false);
    expect(namesExclusivePath({}, 'A new migration')).toBe(false);
    expect(dev.role).toBe('dev');
  });
});
