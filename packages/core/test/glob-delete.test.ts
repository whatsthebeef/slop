import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = <T>(result: Result<T>): string | null => (result.ok ? null : result.error.code);

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const NOW = '2026-10-17T12:00:00.000Z';

describe('deleting a glob with a reason', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let boardId: number;
  let runs: number;

  const create = async (type: 'sub' | 'same') =>
    unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'Work',
        type,
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan: 'Do the work',
      }),
    );
  const exists = async (id: string) => (await globs.peek(id)) !== null;

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    const boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => NOW },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER])
        await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('deletes a planning glob and keeps who, the state and the reason in the log', async () => {
    const made = await create('same');
    unwrap(await globs.delete(DEV, made.id, made.version, 'filed by mistake'));
    expect(await exists(made.id)).toBe(false);
    const logged = store.state.events.filter((e) => e.type === 'GlobDeleted');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      globId: made.id,
      actor: DEV,
      data: { status: made.status, title: 'Work', reason: 'filed by mistake' },
    });
  });

  it('deletes an implementing glob: its run is superseded and its branch and PR are cleaned up by an effect', async () => {
    const made = await create('same');
    const picked = unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    unwrap(await globs.delete(DEV, picked.id, picked.version, 'wrong repo'));
    expect(await exists(picked.id)).toBe(false);
    expect(
      store.state.outbox.some((e) => e.kind === 'delete_glob_data' && e.globId === picked.id),
    ).toBe(true);
  });

  it('refuses a merged glob', async () => {
    const made = await create('same');
    const picked = unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    const merged = unwrap(
      await globs.applyEvent(picked.id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)),
    );
    expect(
      code(await globs.delete(DEV, merged.id, merged.version, 'oops', { refuseMerged: true })),
    ).toBe('invalid_input');
    expect(await exists(merged.id)).toBe(true);
  });

  it('refuses someone who is not on the board', async () => {
    const made = await create('same');
    expect(code(await globs.delete(OUTSIDER, made.id, made.version, 'no'))).not.toBeNull();
    expect(await exists(made.id)).toBe(true);
  });
});
