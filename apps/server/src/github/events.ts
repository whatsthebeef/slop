import type { Board, Glob, GlobService, ReviewFeedbackService } from '@slop/core';
import { isWrongReply, machine, parseId, subGateCheckOf } from '@slop/core';
import { FAILED_CONCLUSIONS } from './merge-state.js';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../db/schema.js';
import type { Db } from '../db/store.js';
import type { CodeHost } from '../codehost.js';
import { repoOf } from '../codehost.js';
import { agentSetTrailer } from './trailers.js';
import type { Delivery } from './webhooks.js';

const repository = z.object({ full_name: z.string() });

const pushPayload = z.object({
  ref: z.string(),
  after: z.string(),
  created: z.boolean().default(false),
  deleted: z.boolean().default(false),
  head_commit: z.object({ message: z.string() }).nullable().optional(),
  repository: repository.extend({ default_branch: z.string().min(1).optional() }),
});

const pullRequestPayload = z.object({
  action: z.string(),
  /** On `dequeued`: why the merge queue removed the PR (`MERGE_CONFLICT`, `CI_FAILURE`, ...); every payload field here is a hint. */
  reason: z.string().nullish(),
  pull_request: z.object({
    number: z.number(),
    draft: z.boolean().default(false),
    merged: z.boolean().nullable().default(false),
    merge_commit_sha: z.string().nullable().default(null),
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
  repository,
});

/** A merge group (the merge queue's temporary commit for one or more PRs): `checks_requested` when it is built, `destroyed` when it goes. */
const mergeGroupPayload = z.object({
  action: z.string(),
  reason: z.string().nullish(),
  merge_group: z
    .object({
      head_sha: z.string().nullish(),
      head_ref: z.string().nullish(),
      base_ref: z.string().nullish(),
    })
    .optional(),
  repository,
});

/** The merge queue's refs: `gh-readonly-queue/<base branch>/pr-<number>-<sha>`. */
const QUEUE_REF = /^(?:refs\/heads\/)?gh-readonly-queue\/(.+)\/pr-(\d+)-[0-9a-f]+$/;

const checkPayload = z.object({
  check_suite: z.object({ head_branch: z.string().nullable(), status: z.string().nullable().optional() }).optional(),
  check_run: z
    .object({
      name: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      check_suite: z.object({ head_branch: z.string().nullable() }),
    })
    .optional(),
  repository,
});

const reviewComment = z.object({
  id: z.number(),
  body: z.string(),
  path: z.string(),
  line: z.number().nullable().optional(),
  original_line: z.number().nullable().optional(),
  in_reply_to_id: z.number().nullable().optional(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
});
const prRef = z.object({ number: z.number(), head: z.object({ ref: z.string() }) });

const reviewThreadPayload = z.object({
  action: z.string(),
  thread: z.object({ comments: z.array(reviewComment) }),
  pull_request: prRef,
  repository,
});

const reviewCommentPayload = z.object({
  action: z.string(),
  comment: reviewComment,
  pull_request: prRef,
  repository,
});

const SLOP_RUN = /^Slop-Run:\s*(\S+)\s*$/m;

/**
 * Turns verified GitHub deliveries into glob events. Each delivery is recorded once (duplicates
 * are ignored), the glob is found by its branch name, and only events from the repo of the
 * glob's own board count. Incoming events apply against the glob's current version.
 */
export const githubDeliveryHandler =
  (deps: {
    db: Db;
    globs: GlobService;
    github: Pick<CodeHost, 'deleteBranch'> & Partial<Pick<CodeHost, 'reviewComments'>>;
    boardOf: (id: number) => Promise<Board | null>;
    /** The base branch of a board received a push (the code view fetches it). */
    onBasePush?: (boardId: number) => void;
    /** Absent: review comments' feedback isn't recorded. */
    feedback?: Pick<ReviewFeedbackService, 'record'>;
    /** The board's merge policy's `subGateCheck` (absent or undefined: the default). */
    subGateCheck?: (boardId: number) => Promise<string | undefined>;
  }) =>
  async (delivery: Delivery): Promise<boolean> => {
    const inserted = await deps.db
      .insert(schema.deliveries)
      .values({ id: delivery.id, source: 'github', event: delivery.event })
      .onConflictDoNothing()
      .returning({ id: schema.deliveries.id });
    if (inserted.length === 0) return false;
    try {
      return await handle(deps, delivery);
    } catch (error) {
      // Forget the delivery so a redelivery from the app settings retries it.
      await deps.db.delete(schema.deliveries).where(eq(schema.deliveries.id, delivery.id));
      throw error;
    }
  };

const handle = async (
  deps: {
    db: Db;
    globs: GlobService;
    github: Pick<CodeHost, 'deleteBranch'> & Partial<Pick<CodeHost, 'reviewComments'>>;
    boardOf: (id: number) => Promise<Board | null>;
    onBasePush?: (boardId: number) => void;
    feedback?: Pick<ReviewFeedbackService, 'record'>;
    subGateCheck?: (boardId: number) => Promise<string | undefined>;
  },
  delivery: Delivery,
): Promise<boolean> => {
  /** The glob named by a branch, if the event came from its board's repo. */
  const globFor = async (branch: string | null | undefined, repo: string): Promise<Glob | null> => {
    if (branch == null || parseId(branch) === null) return null;
    const [row] = await deps.db
      .select({ data: schema.globs.data })
      .from(schema.globs)
      .where(eq(schema.globs.id, branch));
    if (row === undefined) return null;
    const board = await deps.boardOf(row.data.boardId);
    return board?.repo?.toLowerCase() === repo.toLowerCase() ? row.data : null;
  };

  /**
   * A check finished on a board's base branch: read the head's result (the base may have turned red or green). One
   * pending read per board is enough; it looks at the branch's head when it runs.
   */
  const queueBaseChecks = async (branch: string, repo: string): Promise<void> => {
    const rows = await deps.db.select().from(schema.boards).where(eq(schema.boards.baseBranch, branch));
    for (const board of rows.filter((b) => b.repo?.toLowerCase() === repo.toLowerCase())) {
      const globId = `board-${String(board.id)}`;
      const [pending] = await deps.db
        .select({ id: schema.outbox.id })
        .from(schema.outbox)
        .where(sql`${schema.outbox.kind} = 'refresh_base_checks' and ${schema.outbox.globId} = ${globId} and ${schema.outbox.state} = 'pending' and ${schema.outbox.attempts} = 0`)
        .limit(1);
      if (pending !== undefined) continue;
      await deps.db.insert(schema.outbox).values({
        kind: 'refresh_base_checks',
        globId,
        effect: { kind: 'refresh_base_checks', globId, boardId: board.id },
      });
      await deps.db.execute(sql`select pg_notify('slop_outbox', '')`);
    }
  };

  /**
   * A push payload names the repo's default branch. When it differs from a board's cached base, take it now (the push
   * itself may be to the new default) and queue a read from the host, which confirms it. One pending read per board.
   */
  const syncBaseBranch = async (repo: string, defaultBranch: string | undefined): Promise<void> => {
    if (defaultBranch === undefined) return;
    const rows = await deps.db.select().from(schema.boards).where(sql`lower(${schema.boards.repo}) = ${repo.toLowerCase()}`);
    for (const board of rows.filter((b) => b.baseBranch !== defaultBranch)) {
      await deps.db.update(schema.boards).set({ baseBranch: defaultBranch }).where(eq(schema.boards.id, board.id));
      const globId = `board-${String(board.id)}`;
      const [pending] = await deps.db
        .select({ id: schema.outbox.id })
        .from(schema.outbox)
        .where(sql`${schema.outbox.kind} = 'refresh_base_branch' and ${schema.outbox.globId} = ${globId} and ${schema.outbox.state} = 'pending' and ${schema.outbox.attempts} = 0`)
        .limit(1);
      if (pending !== undefined) continue;
      await deps.db.insert(schema.outbox).values({
        kind: 'refresh_base_branch',
        globId,
        effect: { kind: 'refresh_base_branch', globId, boardId: board.id },
      });
      await deps.db.execute(sql`select pg_notify('slop_outbox', '')`);
    }
  };

  /** The base branch received a push: every glob in Doing on that board rereads how far its branch is behind it. */
  const queueBehind = async (branch: string, repo: string): Promise<void> => {
    const rows = await deps.db.select().from(schema.boards).where(eq(schema.boards.baseBranch, branch));
    for (const board of rows.filter((b) => b.repo?.toLowerCase() === repo.toLowerCase())) {
      deps.onBasePush?.(board.id);
      for (const glob of await deps.globs.peekAll(board.id, { status: ['in_progress'] })) {
        await deps.globs.applyEvent(glob.id, (g, ctx) => machine.behindCheckRequested(g, ctx));
      }
    }
  };

  const apply = (glob: Glob, step: Parameters<GlobService['applyEvent']>[1]) =>
    deps.globs.applyEvent(glob.id, step);

  /**
   * The merge queue changed on a board's base branch. A merge group's ref names only its last PR, so every queued glob of
   * the boards on that branch re-reads its own entry (the queue is small); the read, not the webhook, decides.
   */
  const refreshQueued = async (baseBranch: string, repo: string, hint: machine.MergeQueueHint): Promise<void> => {
    const rows = await deps.db.select().from(schema.boards).where(eq(schema.boards.baseBranch, baseBranch));
    for (const board of rows.filter((b) => b.repo?.toLowerCase() === repo.toLowerCase())) {
      for (const glob of await deps.globs.peekAll(board.id, { status: ['merging'] })) {
        if (glob.mergeQueue == null) continue;
        await apply(glob, (g, ctx) => machine.mergeQueueEvent(g, hint, ctx));
      }
    }
  };

  switch (delivery.event) {
    case 'push': {
      const push = pushPayload.parse(delivery.payload);
      const branch = push.ref.replace(/^refs\/heads\//, '');
      await syncBaseBranch(push.repository.full_name, push.repository.default_branch);
      const glob = await globFor(branch, push.repository.full_name);
      if (glob === null && !push.deleted) await queueBehind(branch, push.repository.full_name);
      if (glob === null || push.deleted) return true;
      if ((glob.status === 'reviewing' || glob.status === 'signed_off') && push.created) {
        // A late push recreated a merged glob's branch: remove it again.
        const board = await deps.boardOf(glob.boardId);
        const repo = board === null ? null : repoOf(board);
        if (repo !== null) await deps.github.deleteBranch(repo, branch);
        return true;
      }
      const runId = SLOP_RUN.exec(push.head_commit?.message ?? '')?.[1] ?? null;
      await apply(glob, (g, ctx) =>
        machine.commitPushed(
          g,
          { sha: push.after, runId, message: push.head_commit?.message ?? null, agentSetVersion: agentSetTrailer(push.head_commit?.message) },
          ctx,
        ),
      );
      return true;
    }

    case 'pull_request': {
      const event = pullRequestPayload.parse(delivery.payload);
      const pr = event.pull_request;
      const glob = await globFor(pr.head.ref, event.repository.full_name);
      if (glob === null) return true;
      switch (event.action) {
        case 'opened':
        case 'reopened':
          if (glob.pr?.number !== pr.number) {
            await apply(glob, (g, ctx) =>
              machine.prOpened(g, { number: pr.number, headSha: pr.head.sha }, ctx),
            );
          }
          if (!pr.draft) {
            await apply(glob, (g, ctx) =>
              machine.prReadyForReview(g, { number: pr.number, headSha: pr.head.sha }, ctx),
            );
          }
          return true;
        case 'ready_for_review':
          await apply(glob, (g, ctx) =>
            machine.prReadyForReview(g, { number: pr.number, headSha: pr.head.sha }, ctx),
          );
          return true;
        case 'closed':
          if (pr.merged === true) {
            await apply(glob, (g, ctx) =>
              machine.merged(g, { sha: pr.merge_commit_sha ?? pr.head.sha, number: pr.number }, ctx),
            );
          } else {
            await apply(glob, (g, ctx) => machine.prClosed(g, ctx));
          }
          return true;
        case 'enqueued':
        case 'dequeued':
          await apply(glob, (g, ctx) =>
            machine.mergeQueueEvent(g, { kind: event.action === 'enqueued' ? 'enqueued' : 'dequeued', ...(event.reason == null ? {} : { reason: event.reason }) }, ctx),
          );
          return true;
        default:
          return true;
      }
    }

    case 'merge_group': {
      const event = mergeGroupPayload.parse(delivery.payload);
      const base = event.merge_group?.base_ref?.replace(/^refs\/heads\//, '');
      if (base == null || base === '') return true;
      await refreshQueued(base, event.repository.full_name, {
        kind: 'group',
        ...(event.merge_group?.head_sha == null ? {} : { groupSha: event.merge_group.head_sha }),
        // Only `merged` says something about every glob (the merge is in flight). Other group reasons describe the group,
        // not each PR in it; `pull_request.dequeued` carries a PR's own reason.
        ...(event.reason?.toLowerCase() === 'merged' ? { reason: event.reason } : {}),
      });
      return true;
    }

    case 'check_suite':
    case 'check_run': {
      const event = checkPayload.parse(delivery.payload);
      const branch = event.check_suite?.head_branch ?? event.check_run?.check_suite.head_branch;
      const finished = event.check_run?.status === 'completed' || event.check_suite?.status === 'completed';
      // A check on a merge group's ref belongs to no glob's branch: it tells the queued globs to re-read their entries.
      const queueRef = branch == null ? null : QUEUE_REF.exec(branch);
      const queueBase = queueRef?.[1];
      if (queueBase != null) {
        const run = event.check_run;
        if (finished) {
          const failed = run?.status === 'completed' && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion);
          // The ref names the group's last PR; only that PR's glob records the failure.
          const prNumber = Number(queueRef?.[2]);
          await refreshQueued(
            queueBase,
            event.repository.full_name,
            failed ? { kind: 'checks_failed', groupSha: run.head_sha, prNumber } : { kind: 'group' },
          );
        }
        return true;
      }
      if (finished && branch != null) await queueBaseChecks(branch, event.repository.full_name);
      const glob = await globFor(branch, event.repository.full_name);
      if (glob === null) return true;
      await apply(glob, (g, ctx) => machine.checksChanged(g, ctx));
      const run = event.check_run;
      // The name alone isn't enough: `checks` also runs on the base branch's pushes, but the machine ignores a sha that isn't the PR's head.
      if (run?.status === 'completed' && run.name === subGateCheckOf({ subGateCheck: await deps.subGateCheck?.(glob.boardId) })) {
        const passed = run.conclusion === 'success';
        await apply(glob, (g, ctx) => machine.subGateCheckCompleted(g, { sha: run.head_sha, passed }, ctx));
      }
      return true;
    }

    case 'pull_request_review_thread': {
      const { feedback } = deps;
      const event = reviewThreadPayload.parse(delivery.payload);
      if (feedback === undefined || event.action !== 'resolved') return true;
      const glob = await globFor(event.pull_request.head.ref, event.repository.full_name);
      const [root, ...replies] = event.thread.comments;
      if (glob === null || root === undefined) return true;
      // GitHub has no "wrong" reason on resolving, so a person's `/wrong` reply in the thread says it; a plain resolve is neutral.
      const wrong = replies.find((r) => r.user?.type !== 'Bot' && isWrongReply(r.body));
      await feedback.record({
        boardId: glob.boardId,
        prGlobId: glob.id,
        rootIsBot: root.user?.type === 'Bot',
        body: root.body,
        path: root.path,
        line: root.line ?? root.original_line ?? null,
        verdict: wrong === undefined ? 'resolved' : 'wrong',
        source: 'thread',
        githubCommentId: root.id,
        actor: (wrong ?? root).user?.login ?? null,
        actorIsBot: wrong === undefined ? false : wrong.user?.type === 'Bot',
        at: new Date().toISOString(),
      });
      return true;
    }

    case 'pull_request_review_comment': {
      const { feedback } = deps;
      const event = reviewCommentPayload.parse(delivery.payload);
      const reply = event.comment;
      if (feedback === undefined || event.action !== 'created' || reply.in_reply_to_id == null || !isWrongReply(reply.body)) return true;
      const glob = await globFor(event.pull_request.head.ref, event.repository.full_name);
      const board = glob === null ? null : await deps.boardOf(glob.boardId);
      const repo = board === null ? null : repoOf(board);
      if (glob === null || repo === null || deps.github.reviewComments === undefined) return true;
      // The delivery doesn't carry the comment replied to, which holds the finding's marker.
      const parent = (await deps.github.reviewComments(repo, event.pull_request.number)).find((c) => c.id === reply.in_reply_to_id);
      if (parent === undefined) return true;
      await feedback.record({
        boardId: glob.boardId,
        prGlobId: glob.id,
        rootIsBot: parent.authorIsBot,
        body: parent.body,
        path: parent.path,
        line: parent.line,
        verdict: 'wrong',
        source: 'reply',
        githubCommentId: reply.id,
        actor: reply.user?.login ?? null,
        actorIsBot: reply.user?.type === 'Bot',
        at: new Date().toISOString(),
      });
      return true;
    }

    default:
      return true;
  }
};
