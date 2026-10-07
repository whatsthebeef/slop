import type { Board, FindingsService, Glob, GlobService } from '@slop/core';
import { machine, parseId } from '@slop/core';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../db/schema.js';
import type { Db } from '../db/store.js';
import type { CodeHost } from '../codehost.js';
import { SUB_GATE_CHECK, repoOf } from '../codehost.js';
import { handleReviewComment } from './reviews.js';
import { agentSetTrailer } from './trailers.js';
import type { Delivery } from './webhooks.js';

const repository = z.object({ full_name: z.string() });

const pushPayload = z.object({
  ref: z.string(),
  after: z.string(),
  created: z.boolean().default(false),
  deleted: z.boolean().default(false),
  head_commit: z.object({ message: z.string() }).nullable().optional(),
  repository,
});

const pullRequestPayload = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    draft: z.boolean().default(false),
    merged: z.boolean().nullable().default(false),
    merge_commit_sha: z.string().nullable().default(null),
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
  repository,
});

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
    findings: Pick<FindingsService, 'recordCodeRabbitComment'>;
    github: Pick<CodeHost, 'deleteBranch'>;
    boardOf: (id: number) => Promise<Board | null>;
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
    findings: Pick<FindingsService, 'recordCodeRabbitComment'>;
    github: Pick<CodeHost, 'deleteBranch'>;
    boardOf: (id: number) => Promise<Board | null>;
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

  const apply = (glob: Glob, step: Parameters<GlobService['applyEvent']>[1]) =>
    deps.globs.applyEvent(glob.id, step);

  switch (delivery.event) {
    case 'push': {
      const push = pushPayload.parse(delivery.payload);
      const branch = push.ref.replace(/^refs\/heads\//, '');
      const glob = await globFor(branch, push.repository.full_name);
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
        default:
          return true;
      }
    }

    case 'check_suite':
    case 'check_run': {
      const event = checkPayload.parse(delivery.payload);
      const branch = event.check_suite?.head_branch ?? event.check_run?.check_suite.head_branch;
      const finished = event.check_run?.status === 'completed' || event.check_suite?.status === 'completed';
      if (finished && branch != null) await queueBaseChecks(branch, event.repository.full_name);
      const glob = await globFor(branch, event.repository.full_name);
      if (glob === null) return true;
      await apply(glob, (g, ctx) => machine.checksChanged(g, ctx));
      const run = event.check_run;
      if (run?.name === SUB_GATE_CHECK && run.status === 'completed') {
        const passed = run.conclusion === 'success';
        await apply(glob, (g, ctx) => machine.subGateCheckCompleted(g, { sha: run.head_sha, passed }, ctx));
      }
      return true;
    }

    case 'pull_request_review_comment':
      return handleReviewComment(deps.findings, delivery.payload, globFor);

    default:
      // Reviews and comments are stored from slice 7 (CodeRabbit results).
      return true;
  }
};
