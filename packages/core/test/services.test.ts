import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const PO = 'po@example.com';

describe('services', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let boards: BoardService;
  let globs: GlobService;
  let boardId: number;
  let runs: number;
  let withRoutine: Set<string>;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Fix login timeout',
    summary: '',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    runs = 0;
    withRoutine = new Set([DEV]);
    boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => '2026-10-05T12:00:00.000Z' },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: (email, board) => Promise.resolve(withRoutine.has(email) || withRoutine.has(`${email}#${String(board)}`)) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, PO]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardId, PO, 'po'));
  });

  it('numbers globs per board and ID letter', async () => {
    expect(unwrap(await globs.create(DEV, input())).id).toBe(`s${boardId}t1`);
    expect(unwrap(await globs.create(DEV, input())).id).toBe(`s${boardId}t2`);
    expect(unwrap(await globs.create(DEV, input({ category: 'bug' }))).id).toBe(`s${boardId}b1`);
  });

  it('returns the same glob for a repeated idempotency key', async () => {
    const first = unwrap(await globs.create(DEV, input({ idempotencyKey: 'k1' })));
    const again = unwrap(await globs.create(DEV, input({ idempotencyKey: 'k1' })));
    expect(again.id).toBe(first.id);
    expect(store.state.globs.size).toBe(1);
  });

  it('writes events and effects with the state change and publishes a hint', async () => {
    const glob = unwrap(await globs.create(DEV, input()));
    expect(store.state.events.map((e) => e.type)).toEqual(['GlobCreated']);
    // A same in Planning has no branch yet; it provisions when work starts.
    expect(store.state.outbox.map((e) => e.kind)).toEqual([]);
    expect(notifier.hints).toContainEqual({ kind: 'glob.changed', boardId, globId: glob.id, version: 1 });
  });

  it('rejects stale versions with the current glob', async () => {
    const glob = unwrap(await globs.create(DEV, input()));
    unwrap(await globs.update(DEV, glob.id, 1, { group: 'Sync' }));
    const stale = await globs.start(DEV, glob.id, 1);
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.error.code === 'version_conflict' && 'current' in stale.error) {
      expect(stale.error.current.version).toBe(2);
    }
    expect(unwrap(await globs.start(DEV, glob.id, 2)).status).toBe('implementing');
  });

  it('runs routines as the triggerer, falling back to the board default', async () => {
    const mine = unwrap(await globs.create(DEV, input({ type: 'sub' })));
    expect(mine.runs[0]?.routineOwner).toBe(DEV);
    const fallback = unwrap(await globs.create(PO, input({ type: 'sub' })));
    expect(fallback.runs[0]?.triggeredBy).toBe(PO);
    expect(fallback.runs[0]?.routineOwner).toBe(ADMIN);
  });

  it("counts a routine set up only for this board as the triggerer's own", async () => {
    withRoutine.add(`${PO}#${String(boardId)}`);
    const glob = unwrap(await globs.create(PO, input({ type: 'sub' })));
    expect(glob.runs[0]?.routineOwner).toBe(PO);
  });

  it('refuses non-members and deactivated users', async () => {
    expect((await globs.create('stranger@example.com', input())).ok).toBe(false);
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: false }));
    const result = await globs.create(DEV, input());
    expect(!result.ok && result.error.code).toBe('forbidden');
  });

  it('applies integration events against the current version', async () => {
    const glob = unwrap(await globs.create(DEV, input({ type: 'sub' })));
    const runId = glob.runs[0]?.id ?? '';
    const ready = unwrap(
      await globs.applyEvent(glob.id, (g, ctx) =>
        machine.prReadyForReview(g, { number: 1, headSha: 'abc' }, ctx),
      ),
    );
    expect(ready.status).toBe('pr_open');
    expect(runId).toBe('run-1');
  });

  it('merge (row 14) needs the current version and passed checks, then queues the squash merge', async () => {
    const glob = unwrap(await globs.create(DEV, input()));
    const picked = unwrap(await globs.pickUp(DEV, glob.id, glob.version, false));
    const ready = unwrap(
      await globs.applyEvent(picked.id, (g, ctx) => machine.prReadyForReview(g, { number: 7, headSha: 'abc' }, ctx)),
    );
    const early = await globs.merge(DEV, ready.id, ready.version);
    expect(!early.ok && early.error.code).toBe('invalid_transition');
    const passing = unwrap(
      await globs.applyEvent(ready.id, (g, ctx) => machine.checksCompleted(g, { sha: 'abc', passed: true }, ctx)),
    );
    const stale = await globs.merge(DEV, passing.id, passing.version - 1);
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
    expect(unwrap(await globs.merge(DEV, passing.id, passing.version)).status).toBe('merging');
    expect(store.state.outbox.at(-1)).toMatchObject({ kind: 'squash_merge', globId: glob.id, sha: 'abc' });
  });

  it('delete removes the glob and its events and queues the clean-up', async () => {
    const glob = unwrap(await globs.create(DEV, input()));
    unwrap(await globs.delete(PO, glob.id, 1));
    expect(store.state.globs.size).toBe(0);
    expect(store.state.events).toEqual([]);
    expect(store.state.outbox.map((e) => e.kind)).toEqual(['delete_glob_data']);
    expect(notifier.hints.at(-1)).toMatchObject({ kind: 'glob.deleted', globId: glob.id });
  });

  it('only admins manage members, and a board keeps one admin', async () => {
    expect((await boards.setMember(DEV, boardId, 'x@example.com', 'dev')).ok).toBe(false);
    const demote = await boards.setMember(ADMIN, boardId, ADMIN, 'dev');
    expect(demote.ok).toBe(false);
    expect((await boards.memberships(DEV)).map((m) => m.role)).toEqual(['dev']);
  });

  it("allows at most one subs' default environment, and only one that allows branch deploys", async () => {
    const two = await boards.updateSettings(ADMIN, boardId, 1, {
      environments: [
        { name: 'a', allowBranchDeploy: true, subDefault: true },
        { name: 'b', allowBranchDeploy: true, subDefault: true },
      ],
    });
    expect(two.ok).toBe(false);
    const locked = await boards.updateSettings(ADMIN, boardId, 1, {
      environments: [{ name: 'a', allowBranchDeploy: false, subDefault: true }],
    });
    expect(locked.ok).toBe(false);
    const board = unwrap(
      await boards.updateSettings(ADMIN, boardId, 1, {
        environments: [{ name: 'a', allowBranchDeploy: true, subDefault: true }, { name: 'b', allowBranchDeploy: true }],
      }),
    );
    expect(board.environments[0]?.subDefault).toBe(true);
  });

  it('pick-up takes an optional environment and keeps the current one when it is left out', async () => {
    unwrap(await boards.updateSettings(ADMIN, boardId, 1, { environments: [{ name: 'dev', allowBranchDeploy: true }] }));
    const glob = unwrap(await globs.create(DEV, input()));
    const picked = unwrap(await globs.pickUp(DEV, glob.id, glob.version, false, 'dev'));
    expect(picked.environment).toBe('dev');
    const again = unwrap(await globs.pickUp(DEV, picked.id, picked.version, false));
    expect(again.environment).toBe('dev');
    expect(again.version).toBe(picked.version);
  });
});
