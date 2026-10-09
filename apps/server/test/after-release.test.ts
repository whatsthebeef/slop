import { BoardService, CodeReviewService, FindingsService, GlobService } from '@slop/core';
import type { Board, Effect, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHostExecutors } from '../src/codehost-executors.js';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { githubDeliveryHandler } from '../src/github/events.js';
import { globViewFor, globViewOf } from '../src/http/views.js';
import { FileRoutines } from '../src/routines.js';
import { createTestDatabase } from './support/database.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const REPO = 'acme/app';
const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('start after: a merged webhook releases a waiting sub through the outbox', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let handle: ReturnType<typeof githubDeliveryHandler>;
  let executors: ReturnType<typeof codeHostExecutors>;
  let n = 0;
  const id = () => `after-delivery-${++n}`;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('after'));
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
    handle = githubDeliveryHandler({
      db: database.db,
      globs,
      findings: new FindingsService({ store, notifier, clock }),
      codeReviews: new CodeReviewService({ store, notifier, clock }),
      boardOf,
      github: { deleteBranch: () => Promise.resolve() },
    });
    executors = codeHostExecutors(new FakeCodeHost(), boardOf, new FileRoutines('/nonexistent/routines.json'), new BoardService({ store, notifier }));
  });

  afterAll(() => drop());

  const create = async (type: 'same' | 'sub', after?: string[]) =>
    unwrap(
      await globs.create(DEV, {
        boardId: 1,
        title: `A ${type}`,
        summary: '',
        type,
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        ...(after === undefined ? {} : { after }),
      }),
    );
  const current = async (globId: string) => unwrap(await globs.get(DEV, globId)).glob;
  const rows = async (globId: string, kind: Effect['kind']) =>
    (await database.db.select().from(schema.outbox).where(eq(schema.outbox.globId, globId))).filter((r) => r.kind === kind);
  const pending = async (globId: string, kind: Effect['kind']) => (await rows(globId, kind)).filter((r) => r.state === 'pending');
  /** Runs the pending effects of `kind` as the outbox would, marking each done. */
  const run = async (globId: string, kind: Effect['kind']) => {
    const executor = executors[kind];
    if (executor === undefined) throw new Error(`No executor for ${kind}`);
    const outcomes = [];
    for (const row of await pending(globId, kind)) {
      outcomes.push(await executor(row.effect, await current(globId), { globs }));
      await database.db
        .update(schema.outbox)
        .set({ state: 'done' })
        .where(and(eq(schema.outbox.id, row.id), eq(schema.outbox.state, 'pending')));
    }
    return outcomes;
  };
  const prMerged = (globId: string) => ({
    action: 'closed',
    pull_request: { number: 7, draft: false, merged: true, merge_commit_sha: 'm1', head: { ref: globId, sha: 'b2' } },
    repository: { full_name: REPO },
  });

  it('holds the sub, then a Merged webhook for the awaited glob starts it, once', async () => {
    const awaited = await create('same');
    const picked = unwrap(await globs.pickUp(DEV, awaited.id, awaited.version, false));
    await database.db
      .update(schema.globs)
      .set({ data: { ...picked, provisioning: 'ok', pr: { number: 7, state: 'draft', headSha: 'a1' } } })
      .where(eq(schema.globs.id, awaited.id));

    const waiting = await create('sub', [awaited.id]);
    expect(waiting.status).toBe('planning');
    expect(await rows(waiting.id, 'provision')).toEqual([]);
    expect(await rows(waiting.id, 'fire_routine')).toEqual([]);
    const view = globViewOf(unwrap(await globs.get(DEV, waiting.id)));
    expect(view.waitingFor.map((w) => w.id)).toEqual([awaited.id]);
    expect(globViewOf(unwrap(await globs.get(DEV, awaited.id))).waitedOnBy).toEqual([waiting.id]);

    const delivery = { id: id(), event: 'pull_request', payload: prMerged(awaited.id) };
    expect(await handle(delivery)).toBe(true);
    expect((await current(awaited.id)).status).toBe('reviewing');
    expect(await pending(awaited.id, 'release_waiting')).toHaveLength(1);
    // Nothing has started before the outbox runs.
    expect((await current(waiting.id)).status).toBe('planning');

    expect(await run(awaited.id, 'release_waiting')).toEqual(['done']);
    const released = await current(waiting.id);
    expect(released.status).toBe('implementing');
    expect(released.waiting).toBeNull();
    expect(released.runs).toHaveLength(1);
    expect(await pending(waiting.id, 'provision')).toHaveLength(1);
    expect(await pending(waiting.id, 'fire_routine')).toHaveLength(1);
    const version = released.version;

    // The same delivery again, and the effect run again, start nothing more.
    expect(await handle(delivery)).toBe(false);
    expect(await executors.release_waiting?.({ kind: 'release_waiting', globId: awaited.id, generation: 1 }, await current(awaited.id), { globs })).toBe('done');
    const after = await current(waiting.id);
    expect(after.version).toBe(version);
    expect(after.runs).toHaveLength(1);
    expect(await rows(waiting.id, 'provision')).toHaveLength(1);
    expect(await rows(waiting.id, 'fire_routine')).toHaveLength(1);
  });

  it('drops release_waiting for a glob that has not merged', async () => {
    const open = await create('same');
    const effect: Effect = { kind: 'release_waiting', globId: open.id, generation: 1 };
    expect(await executors.release_waiting?.(effect, open, { globs })).toBe('dropped');
    expect(await executors.release_waiting?.(effect, null, { globs })).toBe('dropped');
  });

  it('the board list and the single read agree: a same held only by `after` offers Start anyway', async () => {
    const first = await create('same');
    const second = await create('same', [first.id]);
    const listed = unwrap(await globs.listWithArtifacts(DEV, 1, {}));
    const row = listed.find((r) => r.glob.id === second.id);
    expect(row).toBeDefined();
    const fromList = globViewFor(second, DEV, 'dev', row?.artifacts ?? [], row?.dependencies).allowedActions;
    expect(fromList).toContain('start_anyway');
    expect(fromList).not.toContain('start');
    expect(fromList).toEqual(unwrap(await globs.get(DEV, second.id)).allowedActions);
  });

  it('refuses an unknown id through the service, and shows what a sub waits for in its view', async () => {
    const refused = await globs.create(DEV, {
      boardId: 1,
      title: 'x',
      summary: '',
      type: 'sub',
      category: 'task',
      group: null,
      environment: null,
      autoTrigger: false,
      idempotencyKey: null,
      after: ['s1t999'],
    });
    expect(!refused.ok && refused.error.code).toBe('invalid_input');
    const first = await create('same');
    const second = await create('sub', [first.id]);
    const view = globViewOf(unwrap(await globs.get(DEV, second.id)));
    expect(view.allowedActions).toContain('start_anyway');
    expect(view.waitedOnBy).toEqual([]);
    expect(view.waitingFor[0]?.why).toContain(`Waits for ${first.id} to merge`);
  });
});
