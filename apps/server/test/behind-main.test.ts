import { BoardService, GlobService, machine } from '@slop/core';
import type { Board, BehindBase, Effect, Glob, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { githubDeliveryHandler } from '../src/github/events.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const REPO = 'acme/app';
const DEV = 'dev@example.com';
const HEAD = 'abcdef0123456789';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** A code host whose compare of the branch with the base is scripted. */
class FakeHost extends FakeCodeHost {
  compare: { behindBy: number; files: string[] } | null = { behindBy: 0, files: [] };
  override behindBase = () => Promise.resolve(this.compare);
}

describe('the behind-main warning', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let globs: GlobService;
  let host: FakeHost;
  let executors: ReturnType<typeof codeHostExecutors>;
  let handle: ReturnType<typeof githubDeliveryHandler>;
  let n = 0;
  let globId = '';

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('behind'));
    const store = new PgStore(database.db);
    globs = new GlobService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'test',
        repo: REPO,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: DEV,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    const boardOf = (boardId: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(boardId));
    host = new FakeHost();
    const unused = () => Promise.reject(new Error('not used here'));
    handle = githubDeliveryHandler({
      db: database.db,
      globs,
      findings: { recordCodeRabbitComment: unused },
      codeReviews: { record: unused, remove: unused },
      boardOf,
      github: host,
    });
    executors = codeHostExecutors(host, boardOf, new FileRoutines('/nonexistent/routines.json'), new BoardService({ store, notifier: { publish: () => undefined } }));
    // A same starts in planning; this one is in Doing with its draft PR.
    const created = unwrap(
      await globs.create(DEV, { boardId: 1, title: 'Work', summary: '', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    );
    globId = created.id;
    await globs.applyEvent(created.id, (g, ctx) => machine.provisioned(g, { branch: g.id, pr: { number: 7, headSha: HEAD } }, ctx));
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(created.id);
      if (g === null) throw new Error('missing');
      await tx.updateGlob({ ...g, status: 'in_progress', implementer: null, version: g.version + 1 }, g.version);
    });
  });

  afterAll(() => drop());

  const current = async (): Promise<Glob> => unwrap(await globs.get(DEV, globId)).glob;
  const pending = async (kind: Effect['kind']) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter((row) => row.kind === kind && row.state === 'pending');
  const run = async (kind: Effect['kind']) => {
    const executor = executors[kind];
    if (executor === undefined) throw new Error(`No executor for ${kind}`);
    for (const row of await pending(kind)) {
      await executor(row.effect, await current(), { globs });
      await database.db.update(schema.outbox).set({ state: 'done' }).where(and(eq(schema.outbox.id, row.id), eq(schema.outbox.state, 'pending')));
    }
  };
  const delivery = (ref: string) => ({
    id: `delivery-${String(++n)}`,
    event: 'push',
    payload: { ref: `refs/heads/${ref}`, after: `sha${String(n)}`, created: false, repository: { full_name: REPO } },
  });
  const behind = async (): Promise<BehindBase | null> => (await current()).behind ?? null;

  it('records how far the branch is behind main after a push, and clears it once it is up to date', async () => {
    host.compare = { behindBy: 4, files: ['a.ts', 'b.ts'] };
    await handle(delivery(globId));
    expect(await pending('check_behind')).toHaveLength(1);
    await run('check_behind');
    expect(await behind()).toMatchObject({ base: 'main', behindBy: 4, files: ['a.ts', 'b.ts'] });

    host.compare = { behindBy: 0, files: [] };
    await handle(delivery(globId));
    await run('check_behind');
    expect(await behind()).toBeNull();
  });

  it('rereads when the base branch receives a push, and keeps what it showed when the host cannot tell', async () => {
    host.compare = { behindBy: 1, files: [] };
    await handle(delivery('main'));
    expect(await pending('check_behind')).toHaveLength(1);
    await run('check_behind');
    expect(await behind()).toMatchObject({ behindBy: 1 });

    host.compare = null;
    await handle(delivery('main'));
    await run('check_behind');
    expect(await behind()).toMatchObject({ behindBy: 1 });

    // A push to some other branch changes nothing.
    await handle(delivery('unrelated'));
    expect(await pending('check_behind')).toHaveLength(0);
  });
});
