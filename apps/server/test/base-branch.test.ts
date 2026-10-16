import { BoardService, GlobService } from '@slop/core';
import type { Board, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors, queueBaseBranchRefreshes } from '../src/codehost-executors.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { githubDeliveryHandler } from '../src/github/events.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const ADMIN = 'admin@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** A host whose default branch is scripted: answers in order, then repeats the last; `down` makes it fail like an outage. */
class FakeHost extends FakeCodeHost {
  answers: (string | null)[] = ['main'];
  down = false;
  private asked = 0;
  override defaultBranch = () => {
    if (this.down) return Promise.reject(new Error('GitHub is unreachable'));
    const answer = this.answers[Math.min(this.asked++, this.answers.length - 1)] ?? null;
    return Promise.resolve(answer);
  };
}

describe('the base branch follows the repo default branch', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let boards: BoardService;
  let host: FakeHost;
  let executors: ReturnType<typeof codeHostExecutors>;
  let handle: ReturnType<typeof githubDeliveryHandler>;
  let n = 0;
  const hints: unknown[] = [];

  const boardOf = (boardId: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(boardId));
  const baseOf = async (boardId: number): Promise<string> => (await boardOf(boardId))?.baseBranch ?? '';
  const globIdOf = (boardId: number) => `board-${String(boardId)}`;

  /** Pending refresh jobs of a board. */
  const pending = (boardId: number) =>
    database.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, 'refresh_base_branch'), eq(schema.outbox.globId, globIdOf(boardId)), eq(schema.outbox.state, 'pending')));

  /** Runs and settles every pending refresh of the board as the outbox would. */
  const runPending = async (boardId: number) => {
    const executor = executors.refresh_base_branch;
    if (executor === undefined) throw new Error('No executor for refresh_base_branch');
    const globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const outcomes = [];
    for (const row of await pending(boardId)) {
      outcomes.push(await executor(row.effect, null, { globs }));
      await database.db.update(schema.outbox).set({ state: 'done' }).where(eq(schema.outbox.id, row.id));
    }
    return outcomes;
  };

  const newBoard = async (repo: string | null): Promise<Board> => unwrap(await boards.create(ADMIN, { name: `b${String(++n)}`, repo, timeZone: 'UTC', environments: [] }));

  const pushDelivery = (repo: string, defaultBranch: string | undefined, ref = 'refs/heads/some-branch') => ({
    id: `d-${String(++n)}`,
    event: 'push',
    payload: { ref, after: 'abc', repository: { full_name: repo, ...(defaultBranch === undefined ? {} : { default_branch: defaultBranch }) } },
  });

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('basebranch'));
    store = new PgStore(database.db);
    const notifier = { publish: (hint: unknown) => void hints.push(hint) };
    boards = new BoardService({ store, notifier });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: 'Admin', active: true }));
    host = new FakeHost();
    executors = codeHostExecutors(host, boardOf, new FileRoutines('/nonexistent/routines.json'), boards);
    const globs = new GlobService({
      store,
      notifier,
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    handle = githubDeliveryHandler({ db: database.db, globs, boards, boardOf, github: { deleteBranch: () => Promise.resolve() } });
  });

  afterAll(() => drop());

  it('a new board holds main, queues a read, and takes what the host answers (main, then trunk)', async () => {
    const board = await newBoard('acme/one');
    expect(board.baseBranch).toBe('main');
    expect(await pending(board.id)).toHaveLength(1);
    host.answers = ['main', 'trunk'];
    expect(await runPending(board.id)).toEqual(['done']);
    expect(await baseOf(board.id)).toBe('main');
    // The repo's default branch is renamed: the next read picks it up.
    await store.transaction((tx) => tx.enqueueEffects([{ kind: 'refresh_base_branch', globId: globIdOf(board.id), boardId: board.id }]));
    await runPending(board.id);
    expect(await baseOf(board.id)).toBe('trunk');
  });

  it('a board without a repo queues no read', async () => {
    const board = await newBoard(null);
    expect(await pending(board.id)).toHaveLength(0);
  });

  it('reading the same answer again changes nothing, not even the version', async () => {
    host.answers = ['main'];
    const board = await newBoard('acme/same');
    await runPending(board.id);
    const before = await boardOf(board.id);
    await store.transaction((tx) => tx.enqueueEffects([{ kind: 'refresh_base_branch', globId: globIdOf(board.id), boardId: board.id }]));
    await runPending(board.id);
    expect((await boardOf(board.id))?.version).toBe(before?.version);
  });

  it('a host that is down or has no answer keeps the stored value', async () => {
    host.answers = ['develop'];
    const board = await newBoard('acme/down');
    await runPending(board.id);
    expect(await baseOf(board.id)).toBe('develop');

    host.down = true;
    await store.transaction((tx) => tx.enqueueEffects([{ kind: 'refresh_base_branch', globId: globIdOf(board.id), boardId: board.id }]));
    await expect(runPending(board.id)).rejects.toThrow('unreachable');
    expect(await baseOf(board.id)).toBe('develop');

    host.down = false;
    host.answers = [null];
    await store.transaction((tx) => tx.enqueueEffects([{ kind: 'refresh_base_branch', globId: globIdOf(board.id), boardId: board.id }]));
    await runPending(board.id);
    expect(await baseOf(board.id)).toBe('develop');
  });

  it('the start-up refresh queues a read for every board with a repo, and only those', async () => {
    host.answers = ['main'];
    const withRepo = await newBoard('acme/startup');
    const without = await newBoard(null);
    await runPending(withRepo.id);
    expect(await pending(withRepo.id)).toHaveLength(0);
    expect(await queueBaseBranchRefreshes(store)).toBeGreaterThanOrEqual(1);
    expect(await pending(withRepo.id)).toHaveLength(1);
    expect(await pending(without.id)).toHaveLength(0);
    host.answers = ['renamed'];
    await runPending(withRepo.id);
    expect(await baseOf(withRepo.id)).toBe('renamed');
  });

  it('a push payload with a different default branch updates the cached base and queues one read', async () => {
    host.answers = ['main'];
    const board = await newBoard('acme/push');
    await runPending(board.id);
    expect(await handle(pushDelivery('acme/push', 'main'))).toBe(true);
    expect(await pending(board.id)).toHaveLength(0);
    const versionBefore = (await boardOf(board.id))?.version ?? 0;
    hints.length = 0;
    expect(await handle(pushDelivery('Acme/Push', 'trunk'))).toBe(true);
    expect(await baseOf(board.id)).toBe('trunk');
    expect((await boardOf(board.id))?.version).toBe(versionBefore + 1);
    expect(hints).toContainEqual({ kind: 'board.changed', boardId: board.id });
    expect(await pending(board.id)).toHaveLength(1);
    // The same payload again changes nothing and queues nothing more.
    expect(await handle(pushDelivery('acme/push', 'trunk'))).toBe(true);
    expect(await pending(board.id)).toHaveLength(1);
    // A payload without the field (an older fixture) leaves the base alone.
    expect(await handle(pushDelivery('acme/push', undefined))).toBe(true);
    expect(await baseOf(board.id)).toBe('trunk');
  });

  it('a repo change in settings queues a read', async () => {
    host.answers = ['main'];
    const board = await newBoard('acme/before');
    await runPending(board.id);
    const current = (await boardOf(board.id))?.version ?? 0;
    unwrap(await boards.updateSettings(ADMIN, board.id, current, { repo: 'acme/after' }));
    expect(await pending(board.id)).toHaveLength(1);
    host.answers = ['trunk'];
    await runPending(board.id);
    expect(await baseOf(board.id)).toBe('trunk');
  });
});
