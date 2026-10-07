import { FindingsService, GlobService } from '@slop/core';
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
      findings: new FindingsService({ store, notifier: { publish: () => undefined }, clock: { now: () => new Date().toISOString() } }),
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

  /** A `pull_request_review_comment` delivery on the glob's PR. */
  const reviewComment = (commentId: number, patch: { action?: string; login?: string; repo?: string } = {}) => ({
    id: id(),
    event: 'pull_request_review_comment',
    payload: {
      action: patch.action ?? 'created',
      comment: {
        id: commentId,
        body: '_⚠️ Potential issue_\n\n**Missing await** on `save`.\n\n<details>\n<summary>Prompt for AI Agents</summary>\nx\n</details>',
        path: 'src/save.ts',
        line: null,
        original_line: 12,
        commit_id: 'b2',
        user: { login: patch.login ?? 'coderabbitai[bot]' },
        html_url: 'https://github.com/acme/app/pull/7#discussion_r1',
      },
      pull_request: { number: 7, head: { ref: globId, sha: 'b2' } },
      repository: { full_name: patch.repo ?? REPO },
    },
  });
  const reviewSources = () => store.transaction((tx) => tx.listReviewSources(globId));

  it('queues a CodeRabbit inline comment once as a review source', async () => {
    const delivery = reviewComment(101);
    expect(await handle(delivery)).toBe(true);
    expect(await reviewSources()).toEqual([
      expect.objectContaining({
        kind: 'coderabbit_comment',
        externalId: 'coderabbit:101',
        path: 'src/save.ts',
        line: '12',
        commitSha: 'b2',
        state: 'pending',
        content: expect.stringContaining('**Missing await**') as unknown,
      }),
    ]);
    // A redelivery of the same delivery, and the same comment in a new delivery, add nothing.
    expect(await handle(delivery)).toBe(false);
    await handle(reviewComment(101));
    expect(await reviewSources()).toHaveLength(1);
  });

  it("ignores other people's comments, edits, and comments from another repo", async () => {
    await handle(reviewComment(201, { login: 'octocat' }));
    await handle(reviewComment(202, { action: 'edited' }));
    await handle(reviewComment(203, { repo: 'evil/fork' }));
    expect(await reviewSources()).toEqual([]);
  });

  it('prefers the current line to the original one, and ignores a comment on a branch with no glob (s15f8)', async () => {
    const delivery = reviewComment(301);
    const onLine = { ...delivery, payload: { ...delivery.payload, comment: { ...delivery.payload.comment, line: 30 } } };
    expect(await handle(onLine)).toBe(true);
    expect(await reviewSources()).toEqual([expect.objectContaining({ externalId: 'coderabbit:301', line: '30' })]);

    const elsewhere = reviewComment(302);
    expect(
      await handle({ ...elsewhere, payload: { ...elsewhere.payload, pull_request: { number: 8, head: { ref: 'feature/no-glob', sha: 'c3' } } } }),
    ).toBe(true);
    expect(await store.transaction((tx) => tx.listReviewSources(globId))).toHaveLength(1);
    const all = await database.db.select().from(schema.reviewSources).where(eq(schema.reviewSources.externalId, 'coderabbit:302'));
    expect(all).toEqual([]);
  });

  it('forgets a delivery whose handling failed, so a redelivery retries it', async () => {
    const delivery = { id: id(), event: 'pull_request', payload: { action: 'closed' } };
    await expect(handle(delivery)).rejects.toThrow();
    const [row] = await database.db.select().from(schema.deliveries).where(eq(schema.deliveries.id, delivery.id));
    expect(row).toBeUndefined();
  });
});
