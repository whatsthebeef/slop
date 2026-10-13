import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import { namesExclusivePath } from '../src/domain/exclusive-paths.js';
import * as machine from '../src/domain/machine.js';
import { renderMergePolicy } from '../src/domain/merge-policy.js';
import type { Board, Glob } from '../src/domain/types.js';
import type { BranchFiles } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

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


describe('recheck overlaps', () => {
  let store: MemoryStore;
  let globs: GlobService;
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
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const openGlob = async (files: readonly string[] | null) => {
    const made = unwrap(await globs.create(DEV, input({ type: 'same', plan: 'Something else entirely' })));
    const picked = unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    branches.files.set(picked.id, files);
    return picked;
  };
  const rechecks = () => store.state.outbox.filter((e) => e.kind === 'recheck_overlaps');

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    branches = new FakeBranchFiles();
    const boards = new BoardService({ store, notifier });
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

  it('drops an overlap once the other branch shows no exclusive file, keeps it while it still changes one, and a repeat changes nothing', async () => {
    const open = await openGlob([MIGRATION]);
    const mine = unwrap(await globs.create(DEV, input({ plan: 'Add a migration for the new column' })));
    expect(mine.impliedAfter?.map((i) => i.id)).toEqual([open.id]);

    expect(await globs.recheckOverlaps(boardId)).toEqual([]);
    expect((await current(mine.id)).impliedAfter?.map((i) => i.id)).toEqual([open.id]);

    branches.files.set(open.id, ['apps/web/src/a.tsx']);
    expect(await globs.recheckOverlaps(boardId)).toContain(mine.id);
    const dropped = await current(mine.id);
    expect(dropped.impliedAfter ?? []).toEqual([]);
    const events = store.state.events.filter((e) => e.globId === mine.id && e.type === 'OverlapDropped');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ with: open.id });

    expect(await globs.recheckOverlaps(boardId)).toEqual([]);
    expect(store.state.events.filter((e) => e.type === 'OverlapDropped')).toHaveLength(1);

    // It shows up again once the branch changes an exclusive path.
    branches.files.set(open.id, [MIGRATION]);
    await globs.recheckOverlaps(boardId);
    expect((await current(mine.id)).impliedAfter?.map((i) => i.id)).toEqual([open.id]);
    expect(store.state.events.some((e) => e.globId === mine.id && e.type === 'OverlapAdded')).toBe(true);
  });

  it('drops an overlap when the other glob is deleted', async () => {
    const open = await openGlob([MIGRATION]);
    const mine = unwrap(await globs.create(DEV, input({ plan: 'Add a migration for the new column' })));
    unwrap(await globs.delete(ADMIN, open.id, (await current(open.id)).version));
    await globs.recheckOverlaps(boardId);
    expect((await current(mine.id)).impliedAfter ?? []).toEqual([]);
  });

  it('keeps explicit overlaps and ones a person overrode', async () => {
    const open = await openGlob(['apps/web/src/a.tsx']);
    const mine = unwrap(await globs.create(DEV, input({ plan: 'Fix a typo', overlaps: [open.id] })));
    await globs.recheckOverlaps(boardId);
    expect((await current(mine.id)).impliedAfter).toEqual([{ id: open.id, paths: [], kind: 'overlaps', source: 'explicit' }]);
  });

  it('queues one recheck for a burst of pushes and status changes', async () => {
    const open = await openGlob([MIGRATION]);
    expect(rechecks()).toHaveLength(1);
    for (const sha of ['a1', 'b2', 'c3']) {
      unwrap(await globs.applyEvent(open.id, (g, c) => machine.commitPushed(g, { sha, runId: null }, c)));
    }
    unwrap(await globs.applyEvent(open.id, (g, c) => machine.merged(g, { sha: 'dead' }, c)));
    expect(rechecks()).toEqual([{ kind: 'recheck_overlaps', globId: `board-${String(boardId)}`, boardId }]);
  });

  it('a plan that only mentions an exclusive path in prose predicts no overlap', () => {
    const prose = '# Plan\n\n## Problem\nThe migration waits are stale (see apps/server/drizzle).\n\n## Tasks\n- [ ] T1: Recheck waits on merge.\n';
    expect(namesExclusivePath(POLICY, prose)).toBe(false);
    expect(namesExclusivePath(POLICY, `${prose}- [ ] T2: add apps/server/drizzle/0030_x.sql\n`)).toBe(true);
    expect(namesExclusivePath(POLICY, '# Plan\n\n## Files\n- `apps/server/drizzle/meta/_journal.json`\n\n## Out of scope\nnothing')).toBe(true);
    expect(namesExclusivePath(POLICY, '# Plan\n\n## Tasks\n- x\n\n## Out of scope\n- no migration here\n')).toBe(false);
  });
});
