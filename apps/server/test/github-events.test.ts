import { readFileSync } from 'node:fs';
import { CodeReviewService, FindingsService, GlobService } from '@slop/core';
import type { Board, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
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
      codeReviews: new CodeReviewService({ store, notifier: { publish: () => undefined }, clock: { now: () => new Date().toISOString() } }),
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

  it('records the agent-set version from the Slop-Agent-Set trailer on the push event', async () => {
    const push = (sha: string, message: string) =>
      handle({ id: id(), event: 'push', payload: { ref: `refs/heads/${globId}`, after: sha, head_commit: { message }, repository: { full_name: REPO } } });
    await push('c3', `${globId}: work\n\n- a change\n\nSlop-Agent-Set: 12\nSlop-Run: run-9`);
    await push('d4', `${globId}: more work`);
    const pushed = await database.db
      .select({ data: schema.events.data })
      .from(schema.events)
      .where(and(eq(schema.events.globId, globId), eq(schema.events.type, 'CommitPushed')))
      .orderBy(schema.events.id);
    expect(pushed.map((e) => e.data)).toEqual([
      { sha: 'c3', runId: 'run-9', fromSupersededRun: true, agentSetVersion: 12 },
      { sha: 'd4', runId: null, fromSupersededRun: false },
    ]);
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

  describe('CodeRabbit results stored verbatim (R3), from saved real-shape payloads', () => {
    const record = z.record(z.string(), z.unknown());
    /** A saved delivery payload, on this test's glob's branch. */
    const fixture = (name: string) =>
      record.parse(
        JSON.parse(readFileSync(new URL(`./fixtures/coderabbit/${name}.json`, import.meta.url), 'utf8').replaceAll('"ref": "s1t1"', `"ref": "${globId}"`)),
      );
    /** The payload with fields of one of its objects replaced. */
    const patched = (payload: Record<string, unknown>, key: string, patch: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
      ...payload,
      ...top,
      [key]: { ...record.parse(payload[key]), ...patch },
    });
    const storedRows = () => database.db.select().from(schema.codeReviewComments).where(eq(schema.codeReviewComments.globId, globId)).orderBy(schema.codeReviewComments.id);
    const setPr = async (number: number, prs: { number: number }[] = []) => {
      const glob = await current();
      await database.db
        .update(schema.globs)
        .set({ data: { ...glob, pr: { number, state: 'ready', headSha: 'b2' }, prs: prs.map((p) => ({ mergeSha: 'm1', mergedAt: '2026-10-01T00:00:00.000Z', ...p })) } })
        .where(eq(schema.globs.id, globId));
    };

    it('stores an inline comment verbatim and queues it once for classification; an edit updates it and a delete removes it', async () => {
      const created = fixture('review-comment-created');
      expect(await handle({ id: id(), event: 'pull_request_review_comment', payload: created })).toBe(true);
      const [row] = await storedRows();
      expect(row).toMatchObject({
        kind: 'inline',
        externalId: 'coderabbit:review_comment:2100000101',
        author: 'coderabbitai[bot]',
        prNumber: 7,
        path: 'src/save.ts',
        line: '10-12',
        commitSha: '4f1c2d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e',
        url: 'https://github.com/acme/app/pull/7#discussion_r2100000101',
      });
      expect(row?.body).toBe(record.parse(created.comment).body);
      expect(row?.body).toContain('<!-- This is an auto-generated comment by CodeRabbit -->');
      expect(await reviewSources()).toEqual([expect.objectContaining({ externalId: 'coderabbit:2100000101', line: '12' })]);

      const edited = patched(created, 'comment', { body: 'Edited: await the save.', updated_at: '2026-10-05T11:00:00Z' }, { action: 'edited' });
      await handle({ id: id(), event: 'pull_request_review_comment', payload: edited });
      expect(await storedRows()).toEqual([expect.objectContaining({ body: 'Edited: await the save.' })]);
      // Not classified twice: the edit adds no review source.
      expect(await reviewSources()).toHaveLength(1);

      await handle({ id: id(), event: 'pull_request_review_comment', payload: { ...created, action: 'deleted' } });
      expect(await storedRows()).toEqual([]);
    });

    it('stores a submitted review with its link, and the summary comment found by its PR number', async () => {
      await setPr(7001);
      const review = fixture('review-submitted');
      await handle({ id: id(), event: 'pull_request_review', payload: patched(review, 'pull_request', { number: 7001 }) });
      const summary = fixture('issue-comment-summary');
      await handle({ id: id(), event: 'issue_comment', payload: patched(summary, 'issue', { number: 7001 }) });
      expect(await storedRows()).toEqual([
        expect.objectContaining({
          kind: 'review',
          externalId: 'coderabbit:review:3300000055',
          prNumber: 7001,
          url: 'https://github.com/acme/app/pull/7#pullrequestreview-3300000055',
          body: record.parse(review.review).body,
        }),
        expect.objectContaining({
          kind: 'summary',
          externalId: 'coderabbit:issue_comment:3400000009',
          prNumber: 7001,
          body: expect.stringContaining('## Walkthrough') as unknown,
        }),
      ]);
      // A review isn't a finding source; only inline comments are.
      expect(await reviewSources()).toEqual([]);

      // CodeRabbit edits its summary in place.
      const edited = patched(patched(summary, 'issue', { number: 7001 }), 'comment', { body: `${String(record.parse(summary.comment).body)}\n\nUpdated.`, updated_at: '2026-10-05T12:00:00Z' }, { action: 'edited' });
      await handle({ id: id(), event: 'issue_comment', payload: edited });
      const rows = await storedRows();
      expect(rows).toHaveLength(2);
      expect(rows[1]?.body).toMatch(/Updated\.$/);
    });

    it("finds a super's glob by a PR it merged with Merge and continue", async () => {
      await setPr(7102, [{ number: 7101 }]);
      // Comment IDs are unique on GitHub; each test uses its own.
      const summary = patched(fixture('issue-comment-summary'), 'comment', { id: 3400007101 });
      await handle({ id: id(), event: 'issue_comment', payload: patched(summary, 'issue', { number: 7101 }) });
      expect(await storedRows()).toEqual([expect.objectContaining({ kind: 'summary', prNumber: 7101 })]);
    });

    it("ignores other authors, plain issues, other repos and unknown PRs, and a repeated delivery", async () => {
      await setPr(7201);
      const summary = patched(patched(fixture('issue-comment-summary'), 'issue', { number: 7201 }), 'comment', { id: 3400007201 });
      const human = patched(summary, 'comment', { user: { login: 'octocat' } });
      await handle({ id: id(), event: 'issue_comment', payload: human });
      await handle({ id: id(), event: 'issue_comment', payload: patched(summary, 'issue', { pull_request: undefined }) });
      await handle({ id: id(), event: 'issue_comment', payload: { ...summary, repository: { full_name: 'evil/fork' } } });
      await handle({ id: id(), event: 'issue_comment', payload: patched(summary, 'issue', { number: 9999 }) });
      const review = fixture('review-submitted');
      await handle({ id: id(), event: 'pull_request_review', payload: patched(review, 'review', { user: { login: 'octocat' } }) });
      await handle({ id: id(), event: 'pull_request_review_comment', payload: patched(fixture('review-comment-created'), 'comment', { user: { login: 'octocat' } }) });
      expect(await storedRows()).toEqual([]);

      const delivery = { id: id(), event: 'issue_comment', payload: summary };
      expect(await handle(delivery)).toBe(true);
      expect(await handle(delivery)).toBe(false);
      expect(await storedRows()).toHaveLength(1);
    });
  });

  it('forgets a delivery whose handling failed, so a redelivery retries it', async () => {
    const delivery = { id: id(), event: 'pull_request', payload: { action: 'closed' } };
    await expect(handle(delivery)).rejects.toThrow();
    const [row] = await database.db.select().from(schema.deliveries).where(eq(schema.deliveries.id, delivery.id));
    expect(row).toBeUndefined();
  });
});
