import { BoardService, GlobService } from '@slop/core';
import type { Board, Result } from '@slop/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { exclusivePathExecutors } from '../src/exclusive-path-executors.js';
import { githubDeliveryHandler } from '../src/github/events.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const REPO = 'acme/app';
const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('overlap rechecks: webhooks queue one delayed job per board', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let handle: ReturnType<typeof githubDeliveryHandler>;
  let n = 0;
  const id = () => `recheck-delivery-${++n}`;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('recheck'));
    store = new PgStore(database.db);
    const notifier = { publish: () => undefined };
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => new Date().toISOString() },
      ids: { runId: () => crypto.randomUUID() },
      routines: { hasRoutine: () => Promise.resolve(true) },
      branchFiles: { filesOf: () => Promise.resolve(null) },
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
    handle = githubDeliveryHandler({ db: database.db, globs, boardOf, github: { deleteBranch: () => Promise.resolve() } });
    // The executors under test are built the way the server wires them; the code-host ones are only here to prove they coexist.
    codeHostExecutors(new FakeCodeHost(), boardOf, new FileRoutines('/nonexistent/routines.json'), new BoardService({ store, notifier }));
  });

  afterAll(() => drop());

  const rechecks = async () =>
    (await database.db.select().from(schema.outbox)).filter((r) => r.kind === 'recheck_overlaps');

  it('a burst of pushes and a merge share one pending job, a redelivery adds none, and the job runs the recheck', async () => {
    const made = unwrap(
      await globs.create(DEV, {
        boardId: 1, title: 'A same', summary: '', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null,
      }),
    );
    const picked = unwrap(await globs.pickUp(DEV, made.id, made.version, false));
    await database.db
      .update(schema.globs)
      .set({ data: { ...picked, provisioning: 'ok', pr: { number: 7, state: 'draft', headSha: 'a1' } } })
      .where(eq(schema.globs.id, made.id));
    // The pick-up already queued one (a status change); nothing has run it.
    expect(await rechecks()).toHaveLength(1);

    const push = (sha: string) => ({
      id: id(),
      event: 'push',
      payload: { ref: `refs/heads/${made.id}`, after: sha, deleted: false, created: false, repository: { full_name: REPO }, head_commit: { message: 'work' } },
    });
    for (const sha of ['b1', 'c2', 'd3']) expect(await handle(push(sha))).toBe(true);
    const merge = {
      id: id(),
      event: 'pull_request',
      payload: {
        action: 'closed',
        pull_request: { number: 7, draft: false, merged: true, merge_commit_sha: 'm1', head: { ref: made.id, sha: 'd3' } },
        repository: { full_name: REPO },
      },
    };
    expect(await handle(merge)).toBe(true);
    expect(await handle(merge)).toBe(false);

    const queued = await rechecks();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.globId).toBe('board-1');
    // Delayed, so the burst above shares it.
    expect(queued[0]?.runAfter.getTime()).toBeGreaterThan(Date.now());

    const executors = exclusivePathExecutors(store, { filesOf: () => Promise.resolve(null) }, (b) => store.transaction((tx) => tx.getBoard(b)));
    const effect = queued[0]?.effect;
    if (effect === undefined) throw new Error('no effect');
    expect(await executors.recheck_overlaps?.(effect, null, { globs })).toBe('done');
    // Run again: nothing changes.
    expect(await executors.recheck_overlaps?.(effect, null, { globs })).toBe('done');
  });
});
