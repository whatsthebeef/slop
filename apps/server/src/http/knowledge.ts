import type { ArtifactService, BoardService, Catalog, FindingsService, IntakeService, KnowledgeService, LearningJobService, SubLimitService } from '@slop/core';
import type { CodeHost } from '../codehost.js';
import { repoOf } from '../codehost.js';
import { ARTIFACT_KINDS, CATEGORIES, KB_HISTORY_MAX, KNOWLEDGE_KINDS, SLOP_TYPES } from '@slop/core';
import { parseFrontmatter } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

const documentsSchema = z.object({
  documents: z
    .array(z.object({ fileName: z.string().min(1), content: z.string() }))
    .min(1)
    .max(200),
});

const version = z.number().int().positive();
/** A submitted item: the measured signal its effect check watches (`KnowledgeService.watchableSignals`); not documents. */
const watchSignal = z.string().min(1).max(200).optional();

/** How an admin approves a KB item (see `Approval` in core). */
const approvalSchema = z.discriminatedUnion('as', [
  z.object({ as: z.literal('learning'), version, statement: z.string().max(4000).optional(), watchSignal }),
  z.object({
    as: z.literal('edit'),
    version,
    watchSignal,
    target: z.object({ kind: z.enum(KNOWLEDGE_KINDS), name: z.string().min(1) }),
    content: z.string().min(1).max(500_000),
    statement: z.string().max(4000).optional(),
  }),
  z.object({
    as: z.literal('document'),
    version,
    content: z.string().min(1).max(500_000).optional(),
    // Refused rather than dropped, so a client that sends one learns that nothing is watched.
    watchSignal: z.never({ error: "A document proposal doesn't watch a signal" }).optional(),
  }),
  z.object({
    as: z.literal('draft'),
    version,
    watchSignal,
    content: z.string().min(1).max(500_000).optional(),
    section: z.string().max(400).nullable().optional(),
    statement: z.string().max(4000).optional(),
  }),
]);

/** An admin's new target for a KB item (see `TargetChange` in core). */
const targetSchema = z.object({
  version,
  target: z.object({
    kind: z.enum(KNOWLEDGE_KINDS),
    name: z.string().min(1).max(400),
    section: z.string().max(400).nullable(),
    newDocument: z
      .object({
        area: z.string().min(1).max(200),
        audience: z.array(z.string().min(1).max(100)).max(50),
        description: z.string().min(1).max(1000),
      })
      .nullable()
      .optional(),
  }),
});

const parse = async <S extends z.ZodType>(c: Context<Env>, schema: S): Promise<z.infer<S> | Response> => {
  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : c.json({ code: 'invalid_input', message: z.prettifyError(parsed.error) }, 422);
};

/** REST for the board's knowledge base and glob artifacts. */
export const mountKnowledge = (
  app: Hono<Env>,
  deps: {
    knowledge: KnowledgeService;
    artifacts: ArtifactService;
    findings: FindingsService;
    catalog: Catalog;
    intake: IntakeService;
    boards: BoardService;
    host: CodeHost;
    jobs: LearningJobService;
    /** The learned sub size limit; absent: its route isn't mounted. */
    subLimit?: SubLimitService;
    /** The server's error log (console and the `errors` table), for Run now's background run. */
    logError: (task: string, message: string) => void;
  },
) => {
  const { knowledge, artifacts, catalog } = deps;
  type Settled<T> = { ok: true; value: T } | { ok: false; error: Parameters<typeof statusOf>[0] };
  const send = <T>(c: Context<Env>, result: Settled<T>) =>
    result.ok ? c.json(result.value as object) : c.json(errorBody(result.error), statusOf(result.error));

  // Whether slop's GitHub App can reach the board's repo, with the install link if not.
  app.get('/api/boards/:b/repo-connection', async (c) => {
    const membership = await deps.boards.get(c.get('email'), Number(c.req.param('b')));
    if (!membership.ok) return send(c, membership);
    const repo = repoOf(membership.value.board);
    if (repo === null) return c.json({ repo: null, configured: deps.host.configured, connected: false, installUrl: null, appName: null });
    const connection = await deps.host.connection(repo);
    // The install link carries the board, so GitHub's redirect brings the person back to it.
    const installUrl = connection.installUrl === null ? null : `${connection.installUrl}?state=${String(membership.value.board.id)}`;
    return c.json({ repo: `${repo.owner}/${repo.name}`, ...connection, installUrl });
  });

  app.get('/api/boards/:b/kb', async (c) => {
    const boardId = Number(c.req.param('b'));
    const email = c.get('email');
    const [index, set, updates, localRun] = await Promise.all([
      knowledge.index(email, boardId),
      knowledge.agentSetIndex(email, boardId),
      knowledge.catalogUpdates(email, boardId),
      knowledge.localRun(email, boardId),
    ]);
    if (!index.ok) return send(c, index);
    if (!set.ok) return send(c, set);
    if (!updates.ok) return send(c, updates);
    if (!localRun.ok) return send(c, localRun);
    const { version, entries } = set.value;
    // `files`: the paths served (orphaned overlays aren't); `entries`: every path with how it is served.
    const files = entries.filter((e) => e.status !== 'orphaned').map((e) => e.path);
    // `catalogUpdates`: documents forked from a catalog entry that has moved on (shown, never applied).
    // `localRun`: the local-run spec, read-only here (it changes through KB items).
    return c.json({ documents: index.value, agentSet: { version, files, entries }, catalogUpdates: updates.value, localRun: localRun.value });
  });

  app.get('/api/boards/:b/kb/docs/:name', async (c) =>
    send(c, await knowledge.documents(c.get('email'), Number(c.req.param('b')), c.req.param('name'))),
  );

  app.get('/api/catalog/kb', async (c) => {
    const entries = await catalog.kbEntries();
    return c.json(
      entries.map((e) => {
        const meta = parseFrontmatter(e.content);
        return { id: e.id, version: e.version, area: meta.area, audience: meta.audience, description: meta.description };
      }),
    );
  });

  app.post('/api/boards/:b/kb/catalog-imports', async (c) => {
    const body = await parse(c, z.object({ ids: z.array(z.string().min(1)).min(1) }));
    if (body instanceof Response) return body;
    return send(c, await knowledge.importCatalogEntries(c.get('email'), Number(c.req.param('b')), body.ids));
  });

  app.post('/api/boards/:b/kb/uploads', async (c) => {
    const body = await parse(c, documentsSchema);
    if (body instanceof Response) return body;
    return send(c, await knowledge.importDocuments(c.get('email'), Number(c.req.param('b')), body.documents, 'upload'));
  });

  // One agent-set file (placeholders unfilled): the board's layer to edit, the catalog's text beside it, and the result.
  app.get('/api/boards/:b/kb/agent-set/file', async (c) =>
    send(c, await knowledge.agentSetFile(c.get('email'), Number(c.req.param('b')), c.req.query('path') ?? '')),
  );

  // Admins turn a board file that overrides a catalog file back into the catalog file plus board rules.
  app.post('/api/boards/:b/kb/agent-set/use-catalog', async (c) => {
    const body = await parse(c, z.object({ path: z.string().min(1), overlay: z.string().max(500_000).default('') }));
    if (body instanceof Response) return body;
    return send(c, await knowledge.useCatalogVersion(c.get('email'), Number(c.req.param('b')), body.path, body.overlay));
  });

  // KB items (proposals): every open one, and the newest `limit` decided and closed ones. Members
  // read them, admins decide them.
  app.get('/api/boards/:b/kb/proposals', async (c) => {
    const limit = c.req.query('limit');
    const parsed = z.coerce.number().int().min(1).max(KB_HISTORY_MAX).optional().safeParse(limit === '' ? undefined : limit);
    if (!parsed.success) return c.json({ code: 'invalid_input', message: `limit is a whole number from 1 to ${KB_HISTORY_MAX}` }, 422);
    return send(c, await knowledge.proposals(c.get('email'), Number(c.req.param('b')), parsed.data));
  });

  // The board's self-improvement jobs (weekly mining and consolidation, daily effect checks, the hourly sub limit) with their last runs;
  // admins run one now.
  app.get('/api/boards/:b/kb/jobs', async (c) => send(c, await deps.jobs.jobs(c.get('email'), Number(c.req.param('b')))));

  // The board's learned sub size limit, its bounds and its history (board settings), for members.
  const { subLimit } = deps;
  if (subLimit !== undefined) {
    app.get('/api/boards/:b/sub-limit', async (c) => send(c, await subLimit.view(c.get('email'), Number(c.req.param('b')))));
  }

  // The board's signals as measured now: what an admin can pick for a submitted item's effect check to watch.
  app.get('/api/boards/:b/kb/signals', async (c) => send(c, await knowledge.watchableSignals(c.get('email'), Number(c.req.param('b')))));

  /**
   * Starts a job's run (Run now) without waiting for it: the job can outlast a request (manifest reads on the code
   * host), and the `board.kb` hint refreshes the page when it is done. The run's errors go to the server's error log,
   * as the scheduled runs' do.
   */
  const runInBackground = async (email: string, boardId: number, job: string) => {
    const started = await deps.jobs.runNow(email, boardId, job);
    if (!started.ok) return started;
    void started.value.finished.then(
      (finished) => {
        if (finished.lastResult?.kind === 'failed') deps.logError(job, `board ${String(boardId)}: ${finished.lastResult.error}`);
      },
      (error: unknown) => {
        deps.logError(job, `board ${String(boardId)}: recording the run failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      },
    );
    return started;
  };

  // Run now answers 202 straight away.
  app.post('/api/boards/:b/kb/jobs/:job/run', async (c) => {
    const started = await runInBackground(c.get('email'), Number(c.req.param('b')), c.req.param('job'));
    return started.ok ? c.json(started.value.job, 202) : send(c, started);
  });

  app.post('/api/kb/:itemId/approve', async (c) => {
    const body = await parse(c, approvalSchema);
    if (body instanceof Response) return body;
    const email = c.get('email');
    const decided = await knowledge.approve(email, c.req.param('itemId'), body.version, body);
    // A new effect check gets its before figures now rather than at the next daily run, without holding up or failing
    // the approval, which has committed: its errors go to the error log. Not available is fine: the next run checks it.
    if (decided.ok && decided.value.effectCheck?.state === 'watching') {
      const { id, boardId } = decided.value;
      const failed = (message: string) => {
        deps.logError('effect_check', `board ${String(boardId)}: checking ${id} on approval: ${message}`);
      };
      void Promise.resolve()
        .then(() => deps.jobs.checkApproval(email, boardId, id))
        .then(
          (checked) => {
            if (checked.ok && checked.value.kind === 'failed') failed(checked.value.error);
          },
          (error: unknown) => {
            failed(error instanceof Error ? (error.stack ?? error.message) : String(error));
          },
        );
    }
    return send(c, decided);
  });

  // Admins point an item at another target; it is drafted again against it.
  app.post('/api/kb/:itemId/target', async (c) => {
    const body = await parse(c, targetSchema);
    if (body instanceof Response) return body;
    return send(c, await knowledge.changeTarget(c.get('email'), c.req.param('itemId'), body.version, body.target));
  });

  // Admins send an item the pipeline gave up on back to routing or drafting.
  app.post('/api/kb/:itemId/retry', async (c) => {
    const body = await parse(c, z.object({ version }));
    if (body instanceof Response) return body;
    return send(c, await knowledge.retryProcessing(c.get('email'), c.req.param('itemId'), body.version));
  });

  // Admins reopen an item the pipeline closed (merged, suppressed or covered); it is drafted again.
  app.post('/api/kb/:itemId/reopen', async (c) => {
    const body = await parse(c, z.object({ version }));
    if (body instanceof Response) return body;
    return send(c, await knowledge.reopen(c.get('email'), c.req.param('itemId'), body.version));
  });

  // Admins keep an item weekly consolidation flagged stale: the flag clears and stays off for 60 days.
  app.post('/api/kb/:itemId/keep', async (c) => {
    const body = await parse(c, z.object({ version }));
    if (body instanceof Response) return body;
    return send(c, await knowledge.keepStale(c.get('email'), c.req.param('itemId'), body.version));
  });

  app.post('/api/kb/:itemId/reject', async (c) => {
    const body = await parse(c, z.object({ version, reason: z.string().min(1).max(4000) }));
    if (body instanceof Response) return body;
    return send(c, await knowledge.reject(c.get('email'), c.req.param('itemId'), body.version, body.reason));
  });

  // Intake: proposes fields from free text without saving anything.
  app.post('/api/boards/:b/intake', async (c) => {
    const body = await parse(
      c,
      z.object({
        text: z.string().min(1),
        explicit: z
          .object({
            title: z.string().min(1).optional(),
            summary: z.string().optional(),
            type: z.enum(SLOP_TYPES).optional(),
            category: z.enum(CATEGORIES).optional(),
            group: z.string().min(1).optional(),
            environment: z.string().min(1).optional(),
          })
          .default({}),
      }),
    );
    if (body instanceof Response) return body;
    return send(c, await deps.intake.propose(c.get('email'), Number(c.req.param('b')), body));
  });

  app.get('/api/globs/:id/plan', async (c) => {
    const version = c.req.query('version');
    return send(c, await artifacts.plan(c.get('email'), c.req.param('id'), version === undefined ? null : Number(version)));
  });

  app.put('/api/globs/:id/plan', async (c) => {
    const body = await parse(c, z.object({ content: z.string() }));
    if (body instanceof Response) return body;
    return send(c, await artifacts.putPlan(c.get('email'), c.req.param('id'), body.content));
  });

  app.get('/api/globs/:id/artifacts', async (c) => send(c, await artifacts.list(c.get('email'), c.req.param('id'))));

  // Every version of one artifact, for the glob view's viewer (attachments pass their label).
  app.get('/api/globs/:id/artifacts/:kind', async (c) => {
    const kind = z.enum(ARTIFACT_KINDS).safeParse(c.req.param('kind'));
    if (!kind.success) return c.json({ code: 'not_found', message: 'Unknown artifact kind' }, 404);
    return send(c, await artifacts.versions(c.get('email'), c.req.param('id'), kind.data, c.req.query('label') ?? ''));
  });

  // The glob's review findings with their counts per class (members).
  app.get('/api/globs/:id/findings', async (c) => send(c, await deps.findings.forGlob(c.get('email'), c.req.param('id'))));

  app.post('/api/globs/:id/attachments', async (c) => {
    const body = await parse(
      c,
      z.object({ label: z.string().min(1), text: z.string().nullable().default(null), link: z.url({ protocol: /^https?$/ }).nullable().default(null) }),
    );
    if (body instanceof Response) return body;
    return send(c, await artifacts.attach(c.get('email'), c.req.param('id'), body));
  });
};
