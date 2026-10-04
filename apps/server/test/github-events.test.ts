import { GlobService } from '@slop/core';
import type { Board, Result } from '@slop/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { githubDeliveryHandler } from '../src/github/events.js';
import { createTestDatabase } from './support/database.js';

const REPO = 'acme/app';
const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('GitHub webhook deliveries', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let handle: ReturnType<typeof githubDeliveryHandler>;
  let deletedBranches: string[];
  let n = 0;
  const id = () => `delivery-${++n}`;

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('github'));
    store = new PgStore(database.db);
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
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
    });
    const boardOf = (boardId: number): Promise<Board | null> => store.transaction((tx) => tx.getBoard(boardId));
    deletedBranches = [];
    handle = githubDeliveryHandler({
      db: database.db,
      globs,
      boardOf,
      github: {
        deleteBranch: (_repo, branch) => {
          deletedBranches.push(branch);
          return Promise.resolve();
        },
      },
    });
  });

  afterAll(() => drop());

  /** A same that has been picked up and provisioned with draft PR #7. */
  let globId: string;
  beforeEach(async () => {
    const created = unwrap(
      await globs.create(DEV, {
        boardId: 1,
        title: 'Webhook glob',
        summary: '',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    const picked = unwrap(await globs.pickUp(DEV, created.id, created.version, false));
    globId = picked.id;
    await database.db
      .update(schema.globs)
      .set({ data: { ...picked, provisioning: 'ok', pr: { number: 7, state: 'draft', headSha: 'a1' } } })
      .where(eq(schema.globs.id, globId));
  });

  const current = async () => unwrap(await globs.get(DEV, globId)).glob;
  const pr = (action: string, extra: object = {}) => ({
    action,
    pull_request: { number: 7, draft: false, merged: false, merge_commit_sha: null, head: { ref: globId, sha: 'b2' }, ...extra },
    repository: { full_name: REPO },
  });

  it('records pushes as the new head, with the run ID from the commit trailer', async () => {
    await handle({
      id: id(),
      event: 'push',
      payload: {
        ref: `refs/heads/${globId}`,
        after: 'b2',
        head_commit: { message: `${globId}: work\n\nSlop-Run: run-9` },
        repository: { full_name: REPO },
      },
    });
    expect((await current()).pr?.headSha).toBe('b2');
  });

  it('moves the glob through ready for review and merge', async () => {
    await handle({ id: id(), event: 'pull_request', payload: pr('ready_for_review') });
    expect((await current()).status).toBe('pr_open');
    await handle({ id: id(), event: 'pull_request', payload: pr('closed', { merged: true, merge_commit_sha: 'm3' }) });
    const glob = await current();
    expect(glob.status).toBe('reviewing');
    expect(glob.labels).toEqual({ FR: 'required', CR: 'required', QA: 'required' });
  });

  it('ignores a repeated delivery', async () => {
    const delivery = { id: id(), event: 'pull_request', payload: pr('ready_for_review') };
    expect(await handle(delivery)).toBe(true);
    const version = (await current()).version;
    expect(await handle(delivery)).toBe(false);
    expect((await current()).version).toBe(version);
  });

  it('ignores events from a repo other than its board repo', async () => {
    await handle({ id: id(), event: 'pull_request', payload: { ...pr('ready_for_review'), repository: { full_name: 'evil/fork' } } });
    expect((await current()).status).toBe('in_progress');
  });

  it('deletes the branch of a merged glob when a late push recreates it', async () => {
    await handle({ id: id(), event: 'pull_request', payload: pr('closed', { merged: true, merge_commit_sha: 'm3' }) });
    await handle({
      id: id(),
      event: 'push',
      payload: { ref: `refs/heads/${globId}`, after: 'c4', created: true, repository: { full_name: REPO } },
    });
    expect(deletedBranches).toContain(globId);
  });

  it('forgets a delivery whose handling failed, so a redelivery retries it', async () => {
    const delivery = { id: id(), event: 'pull_request', payload: { action: 'closed' } };
    await expect(handle(delivery)).rejects.toThrow();
    const [row] = await database.db.select().from(schema.deliveries).where(eq(schema.deliveries.id, delivery.id));
    expect(row).toBeUndefined();
  });
});
