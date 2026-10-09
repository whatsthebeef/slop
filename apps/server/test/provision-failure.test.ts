import { BoardService, GlobService, NotificationService } from '@slop/core';
import type { Board, Glob, Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

class FakeHost extends FakeCodeHost {
  failure: (Error & { status?: number }) | null = null;
  override provision = (_repo: unknown, glob: Glob) => {
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve({ branch: glob.id, pr: { number: 7, headSha: 'h1' } });
  };
}

const hostError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

describe('a glob whose branch cannot be created', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let notifications: NotificationService;
  let host: FakeHost;
  let executors: ReturnType<typeof codeHostExecutors>;

  const boardOf = (boardId: number): Promise<Board | null> =>
    store.transaction((tx) => tx.getBoard(boardId));

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('provisionfail'));
    store = new PgStore(database.db);
    const notifier = { publish: () => undefined };
    const clock = { now: () => new Date().toISOString() };
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    notifications = new NotificationService({ store, notifier, clock });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: DEV,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    host = new FakeHost();
    executors = codeHostExecutors(
      host,
      boardOf,
      new FileRoutines('/nonexistent/routines.json'),
      new BoardService({ store, notifier }),
      undefined,
      null,
      notifications,
    );
  });

  afterAll(() => drop());

  const newSub = async (title: string) =>
    unwrap(
      await globs.create(DEV, {
        boardId: 1,
        title,
        summary: '',
        type: 'sub',
        category: 'bug',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    ).id;

  const provision = async (id: string, attempt?: { final: boolean }) => {
    const glob = await globs.peek(id);
    if (glob === null) throw new Error('missing');
    const executor = executors.provision;
    if (executor === undefined) throw new Error('No provision executor');
    return executor(
      { kind: 'provision', globId: id, generation: glob.generation },
      glob,
      { globs },
      attempt,
    );
  };

  const bar = async () =>
    unwrap(await notifications.list(DEV, 1)).filter((n) => n.source === 'repo-access');

  it('a 404 is not retried: the reason goes on the glob, its run ends, and the board warns', async () => {
    host.failure = hostError(404, 'Not Found - https://docs.github.com/rest');
    const id = await newSub('Missing repo');
    expect(await provision(id)).toBe('done');
    const glob = await globs.peek(id);
    expect(glob).toMatchObject({
      status: 'failed',
      provisioning: 'failed',
      failure: { kind: 'provisioning' },
    });
    expect(glob?.failure?.reason).toContain("the slop GitHub App can't see that repo");
    expect(glob?.runs.at(-1)).toMatchObject({ state: 'ended', outcome: 'failed' });
    expect(await bar()).toMatchObject([
      { severity: 'warning', title: "slop's GitHub App can't access acme/app" },
    ]);
  });

  it('a 403 is not retried either, and says which permission is missing', async () => {
    host.failure = hostError(403, 'Resource not accessible by integration');
    const id = await newSub('No permission');
    expect(await provision(id)).toBe('done');
    expect((await globs.peek(id))?.failure?.reason).toContain('contents: write');
  });

  it('other failures retry, and the last attempt records the reason', async () => {
    host.failure = hostError(502, 'Bad Gateway');
    const id = await newSub('Flaky host');
    await expect(provision(id, { final: false })).rejects.toThrow('Bad Gateway');
    expect((await globs.peek(id))?.failure).toBeNull();
    await expect(provision(id, { final: true })).rejects.toThrow('Bad Gateway');
    expect((await globs.peek(id))?.failure?.reason).toBe(
      `Couldn't create branch ${id} on acme/app: Bad Gateway`,
    );
  });

  it('the warning clears on the next successful call for the repo', async () => {
    expect(await bar()).toHaveLength(1);
    host.failure = null;
    const id = await newSub('Works now');
    expect(await provision(id)).toBe('done');
    expect(await bar()).toHaveLength(0);
  });
});
