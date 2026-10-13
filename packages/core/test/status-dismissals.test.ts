import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob as fixture } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const FAILURE = 'failure:2026-10-08T10:00:00.000Z';

describe('status dismissals', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let boardId: number;
  let id: string;

  const keys = async (email: string) => unwrap(await globs.get(email, id)).dismissedKeys;

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => '2026-10-08T12:00:00.000Z' },
      ids: { runId: () => 'run-1' },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    id = `s${String(boardId)}t1`;
    await store.transaction((tx) => tx.insertGlob(fixture({ id, boardId }), null));
  });

  it('dismisses for that person only', async () => {
    unwrap(await globs.setStatusDismissed(DEV, id, FAILURE, true));
    expect(await keys(DEV)).toEqual([FAILURE]);
    expect(await keys(ADMIN)).toEqual([]);
  });

  it('is idempotent, and a new situation (another key) is not dismissed', async () => {
    unwrap(await globs.setStatusDismissed(DEV, id, FAILURE, true));
    unwrap(await globs.setStatusDismissed(DEV, id, FAILURE, true));
    expect(await keys(DEV)).toEqual([FAILURE]);
    expect(await keys(DEV)).not.toContain('failure:2026-10-08T11:00:00.000Z');
  });

  it('undoes a dismissal ("Show again")', async () => {
    unwrap(await globs.setStatusDismissed(DEV, id, FAILURE, true));
    unwrap(await globs.setStatusDismissed(DEV, id, FAILURE, false));
    expect(await keys(DEV)).toEqual([]);
  });

  it('serves the board list the viewer\'s keys by glob', async () => {
    unwrap(await globs.setStatusDismissed(DEV, id, FAILURE, true));
    expect([...(await globs.dismissedKeysOf(DEV, boardId))]).toEqual([[id, [FAILURE]]]);
    expect((await globs.dismissedKeysOf(ADMIN, boardId)).size).toBe(0);
  });

  it('leaves the glob\'s version alone', async () => {
    const before = unwrap(await globs.get(DEV, id)).glob.version;
    unwrap(await globs.setStatusDismissed(DEV, id, FAILURE, true));
    expect(unwrap(await globs.get(DEV, id)).glob.version).toBe(before);
  });

  it('refuses a non-member, an unknown glob and a malformed key', async () => {
    expect((await globs.setStatusDismissed(OUTSIDER, id, FAILURE, true)).ok).toBe(false);
    expect((await globs.setStatusDismissed(DEV, 'nope', FAILURE, true)).ok).toBe(false);
    for (const key of ['', 'has space', 'x'.repeat(201)])
      expect((await globs.setStatusDismissed(DEV, id, key, true)).ok).toBe(false);
  });

  it('goes with the glob when it is deleted', async () => {
    unwrap(await globs.setStatusDismissed(DEV, id, FAILURE, true));
    await store.transaction((tx) => tx.deleteGlob(id));
    expect((await globs.dismissedKeysOf(DEV, boardId)).size).toBe(0);
    expect(store.state.statusDismissals.size).toBe(0);
  });
});
