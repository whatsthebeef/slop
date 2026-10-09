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
    summary: '',
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

  it('holds a sub whose plan names a migration for an open glob whose branch changes the exclusive path', async () => {
    const open = await openGlob([MIGRATION, 'apps/server/src/a.ts']);
    const held = await create({ plan: 'Add a migration for the new column' });
    expect(held.status).toBe('planning');
    expect(held.waiting).not.toBeNull();
    expect(held.impliedAfter).toEqual([{ id: open.id, paths: [MIGRATION] }]);
    expect(held.runs).toEqual([]);
    expect(held.provisioning).toBe('none');
    const view = unwrap(await globs.get(DEV, held.id));
    expect(view.waitingFor.map((w) => w.why)).toEqual([`Waits for ${open.id}: both may change ${MIGRATION}`]);
    expect(view.allowedActions).toContain('start_anyway');
  });

  it('also holds when the plan names the directory, or intake guessed a file in it', async () => {
    const open = await openGlob([MIGRATION]);
    const named = await create({ plan: 'Touches apps/server/drizzle/meta only' });
    expect(named.impliedAfter?.map((i) => i.id)).toEqual([open.id]);
    const guessed = await create({ plan: 'Rename the column', files: [MIGRATION] });
    expect(guessed.impliedAfter?.map((i) => i.id)).toEqual([open.id]);
  });

  it('starts a sub whose plan does not name an exclusive path, even beside such a glob', async () => {
    await openGlob([MIGRATION]);
    const free = await create({ plan: 'Fix the login timeout' });
    expect(free.status).toBe('implementing');
    expect(free.impliedAfter).toBeUndefined();
  });

  it('never holds for a branch it cannot read, or without a policy', async () => {
    await openGlob(null);
    expect((await create({ plan: 'Add a migration' })).status).toBe('implementing');
    await store.transaction((tx) => tx.deleteKnowledge(boardId, 'merge_policy', 'merge-policy'));
    await openGlob([MIGRATION]);
    expect((await create({ plan: 'Add a migration' })).status).toBe('implementing');
  });

  it('holds a changed-to-sub same and a started same, then releases them when the other glob merges', async () => {
    const open = await openGlob([MIGRATION]);
    const same = await create({ type: 'same', plan: 'Add a migration' });
    const changed = unwrap(await globs.update(DEV, same.id, same.version, { type: 'sub' }));
    expect(changed.status).toBe('planning');
    expect(changed.waiting).not.toBeNull();
    expect(changed.impliedAfter?.[0]?.id).toBe(open.id);

    const other = await create({ type: 'same', plan: 'Another migration' });
    const started = unwrap(await globs.start(DEV, other.id, other.version));
    expect(started.status).toBe('planning');
    expect(started.waiting).not.toBeNull();
    expect(started.runs).toEqual([]);

    unwrap(await globs.applyEvent(open.id, (g, c) => machine.merged(g, { sha: 'abc1234' }, c)));
    branches.files.delete(open.id);
    // Both were waiting for the merged glob, but the first to start takes the exclusive paths: the second is held again.
    expect(await globs.releaseDependents(open.id, boardId)).toEqual([changed.id]);
    expect((await current(changed.id)).status).toBe('implementing');
    const second = await current(started.id);
    expect(second.status).toBe('planning');
    expect(second.waiting).not.toBeNull();
    expect(second.impliedAfter?.map((i) => i.id)).toEqual([open.id, changed.id]);
  });

  it('a person can start anyway; the override is kept for display and not held for again', async () => {
    const open = await openGlob([MIGRATION]);
    const held = await create({ plan: 'Add a migration' });
    const started = unwrap(await globs.startAnyway(DEV, held.id, held.version));
    expect(started.status).toBe('implementing');
    expect(started.waiting).toBeNull();
    expect(started.impliedAfter).toEqual([{ id: open.id, paths: [MIGRATION], overridden: true }]);
    const view = unwrap(await globs.get(DEV, held.id));
    expect(view.waitingFor).toEqual([]);
  });

  it('skips a hit that would make a cycle', async () => {
    const open = await openGlob([MIGRATION]);
    // The open glob already waits for the glob being created's id? A started glob waiting on the candidate: simulate with a held glob.
    const held = await create({ plan: 'Add a migration' });
    expect(held.impliedAfter?.map((i) => i.id)).toEqual([open.id]);
    // `held` now waits for `open`. Making `open` start again must not hold it for `held`.
    branches.files.set(held.id, [MIGRATION]);
    const again = unwrap(await globs.startAgain(DEV, open.id, open.version));
    expect(again.status).toBe('planning');
    const started = unwrap(await globs.update(DEV, again.id, again.version, { type: 'sub' }));
    expect(started.impliedAfter ?? []).toEqual([]);
    expect(started.status).toBe('implementing');
  });

  it('checks again on release: another glob took the exclusive paths meanwhile', async () => {
    const first = await create({ type: 'same' });
    const held = await create({ type: 'same', after: [first.id], plan: 'Add a migration' });
    expect(held.waiting == null).toBe(true);
    const waiting = unwrap(await globs.update(DEV, held.id, held.version, { type: 'sub' }));
    expect(waiting.waiting).not.toBeNull();
    // `first` merges; meanwhile a different glob has started changing the migrations.
    const rival = await openGlob([MIGRATION]);
    unwrap(await globs.applyEvent(first.id, (g, c) => machine.merged(g, { sha: 'abc1234' }, c)));
    expect(await globs.releaseDependents(first.id, boardId)).toEqual([]);
    const still = await current(waiting.id);
    expect(still.status).toBe('planning');
    expect(still.impliedAfter?.map((i) => i.id)).toEqual([rival.id]);
    expect(still.waiting).not.toBeNull();
  });

  it('predicts from the plan when two globs are released one after the other', async () => {
    // The first released glob has no files yet; its plan names a migration, so the second holds for it.
    const first = await create({ plan: 'Add a migration' });
    const second = await create({ plan: 'Add another migration' });
    expect(first.status).toBe('implementing');
    expect(second.status).toBe('planning');
    expect(second.impliedAfter?.map((i) => i.id)).toEqual([first.id]);
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
        summary: '',
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
