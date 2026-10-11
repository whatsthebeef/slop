import { GlobService, ReviewFeedbackService, findingMarker } from '@slop/core';
import type { Board, Result } from '@slop/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { PrReviewComment } from '../src/codehost.js';
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

  it('recovers a glob whose merge failed when a push lands on its branch', async () => {
    const g = await current();
    await database.db
      .update(schema.globs)
      .set({
        data: {
          ...g,
          type: 'same',
          status: 'failed',
          pr: { number: 7, state: 'ready', headSha: 'a1' },
          failure: { reason: 'Merge conflict with main', at: g.updatedAt, kind: 'merge', conflict: { base: 'main', files: ['a.ts'] } },
        },
      })
      .where(eq(schema.globs.id, globId));
    await handle({
      id: id(),
      event: 'push',
      payload: {
        ref: `refs/heads/${globId}`,
        after: 'c3',
        head_commit: { message: `${globId}: Merge main` },
        repository: { full_name: REPO },
      },
    });
    const after = await current();
    expect(after.status).toBe('pr_open');
    expect(after.failure).toBeNull();
    expect(after.implementer).toBe(DEV);
    expect(after.pr?.headSha).toBe('c3');
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

  describe('feedback on the reviewer\'s inline comments (s15f43)', () => {
    const wrongHandler = (comments: PrReviewComment[] = []) =>
      githubDeliveryHandler({
        db: database.db,
        globs,
        boardOf: (boardId) => store.transaction((tx) => tx.getBoard(boardId)),
        github: { deleteBranch: () => Promise.resolve(), reviewComments: () => Promise.resolve(comments) },
        feedback: new ReviewFeedbackService({ store }),
      });
    const bodyFor = (glob: string) =>
      `**medium · convention: Use the helper**\n\nWhy.\n\n${findingMarker(glob, 3, { file: 'src/a.ts', category: 'convention', title: 'Use the helper' })}`;
    const user = (login: string, type = 'User') => ({ login, type });
    const comment = (cid: number, body: string, who = user('slop[bot]', 'Bot'), extra: object = {}) => ({
      id: cid,
      body,
      path: 'src/a.ts',
      line: 4,
      user: who,
      ...extra,
    });
    const thread = (comments: object[], extra: object = {}) => ({
      action: 'resolved',
      thread: { comments },
      pull_request: { number: 7, head: { ref: globId } },
      repository: { full_name: REPO },
      ...extra,
    });
    const stored = () => store.transaction((tx) => tx.listReviewFeedback(1, '2020-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z'));
    const clear = () => database.db.delete(schema.reviewFeedback);

    beforeEach(clear);

    it('a thread resolved after a human /wrong reply is stored as wrong, with the finding it was about', async () => {
      const feedbackHandle = wrongHandler();
      await feedbackHandle({
        id: id(),
        event: 'pull_request_review_thread',
        payload: thread([comment(501, bodyFor(globId)), comment(502, '/wrong the helper is private', user('dev'))]),
      });
      expect(await stored()).toMatchObject([
        { globId, artifactVersion: 3, verdict: 'wrong', source: 'thread', category: 'convention', severity: 'medium', title: 'Use the helper', path: 'src/a.ts', line: 4, actor: 'dev' },
      ]);
    });

    it('a plain resolve is stored as resolved, a bot reply does not make it wrong, and a redelivery adds nothing', async () => {
      const feedbackHandle = wrongHandler();
      const payload = thread([comment(511, bodyFor(globId)), comment(512, '/wrong', user('review-bot[bot]', 'Bot'))]);
      await feedbackHandle({ id: id(), event: 'pull_request_review_thread', payload });
      await feedbackHandle({ id: id(), event: 'pull_request_review_thread', payload });
      await feedbackHandle({ id: 'same-delivery', event: 'pull_request_review_thread', payload });
      expect(await feedbackHandle({ id: 'same-delivery', event: 'pull_request_review_thread', payload })).toBe(false);
      expect((await stored()).map((f) => f.verdict)).toEqual(['resolved']);
    });

    it('ignores a thread that is not slop\'s finding, one from another repo or glob, and threads that are not resolved', async () => {
      const feedbackHandle = wrongHandler();
      const send = (payload: object) => feedbackHandle({ id: id(), event: 'pull_request_review_thread', payload });
      await send(thread([comment(521, 'A human comment', user('dev')), comment(522, '/wrong', user('dev2'))]));
      await send(thread([comment(523, bodyFor(globId)), comment(524, '/wrong', user('dev'))], { repository: { full_name: 'evil/fork' } }));
      await send(thread([comment(525, bodyFor('s9t9')), comment(526, '/wrong', user('dev'))]));
      await send(thread([comment(527, bodyFor(globId)), comment(528, '/wrong', user('dev'))], { action: 'unresolved' }));
      expect(await stored()).toEqual([]);
    });

    it('a finding marker on a person\'s comment, or one naming another PR\'s glob, is not feedback', async () => {
      const feedbackHandle = wrongHandler();
      const send = (payload: object) => feedbackHandle({ id: id(), event: 'pull_request_review_thread', payload });
      // A person forged the marker (and header) on their own comment.
      await send(thread([comment(531, bodyFor(globId), user('mallory')), comment(532, '/wrong', user('dev'))]));
      // The bot's comment on this PR names a different glob of the same board.
      const otherGlobId = unwrap(
        await globs.create(DEV, {
          boardId: 1,
          title: 'Other glob',
          summary: '',
          type: 'same',
          category: 'task',
          group: null,
          environment: null,
          autoTrigger: false,
          idempotencyKey: null,
        }),
      ).id;
      await send(thread([comment(533, bodyFor(otherGlobId)), comment(534, '/wrong', user('dev'))]));
      expect(await stored()).toEqual([]);
    });

    it('a /wrong reply to a person\'s comment with a marker is not feedback', async () => {
      const forged: PrReviewComment = {
        id: 611,
        body: bodyFor(globId),
        inReplyTo: null,
        author: 'mallory',
        authorIsBot: false,
        path: 'src/a.ts',
        line: 4,
        thumbsDown: 0,
        createdAt: '2026-10-10T00:00:00.000Z',
      };
      await wrongHandler([forged])({
        id: id(),
        event: 'pull_request_review_comment',
        payload: {
          action: 'created',
          comment: comment(612, '/wrong', user('dev'), { in_reply_to_id: 611 }),
          pull_request: { number: 7, head: { ref: globId } },
          repository: { full_name: REPO },
        },
      });
      expect(await stored()).toEqual([]);
    });

    it('a /wrong reply on a finding comment is stored through the comment it replies to, once', async () => {
      const parent: PrReviewComment = {
        id: 601,
        body: bodyFor(globId),
        inReplyTo: null,
        author: 'slop[bot]',
        authorIsBot: true,
        path: 'src/a.ts',
        line: 4,
        thumbsDown: 0,
        createdAt: '2026-10-10T00:00:00.000Z',
      };
      const feedbackHandle = wrongHandler([parent]);
      const reply = (cid: number, body: string, inReplyTo = 601) => ({
        action: 'created',
        comment: comment(cid, body, user('dev'), { in_reply_to_id: inReplyTo }),
        pull_request: { number: 7, head: { ref: globId } },
        repository: { full_name: REPO },
      });
      await feedbackHandle({ id: id(), event: 'pull_request_review_comment', payload: reply(602, 'False positive, it is private') });
      await feedbackHandle({ id: id(), event: 'pull_request_review_comment', payload: reply(602, 'False positive, it is private') });
      // A reply that does not say wrong, and a reply to some other comment, are not feedback.
      await feedbackHandle({ id: id(), event: 'pull_request_review_comment', payload: reply(603, 'Thanks, fixing') });
      await feedbackHandle({ id: id(), event: 'pull_request_review_comment', payload: reply(604, '/wrong', 999) });
      expect(await stored()).toMatchObject([{ verdict: 'wrong', source: 'reply', githubCommentId: 602, actor: 'dev', globId }]);
    });
  });
});
