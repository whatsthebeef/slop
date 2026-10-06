import type { ArtifactService, BoardService, Catalog, IntakeService, KnowledgeService } from '@slop/core';
import type { CodeHost } from '../codehost.js';
import { repoOf } from '../codehost.js';
import { ARTIFACT_KINDS, CATEGORIES, KB_ITEM_STATUSES, KNOWLEDGE_KINDS, SLOP_TYPES } from '@slop/core';
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

/** How an admin approves a KB item (see `Approval` in core). */
const approvalSchema = z.discriminatedUnion('as', [
  z.object({ as: z.literal('learning'), version, statement: z.string().max(4000).optional() }),
  z.object({
    as: z.literal('edit'),
    version,
    target: z.object({ kind: z.enum(KNOWLEDGE_KINDS), name: z.string().min(1) }),
    content: z.string().min(1).max(500_000),
    statement: z.string().max(4000).optional(),
  }),
  z.object({ as: z.literal('document'), version, content: z.string().min(1).max(500_000).optional() }),
]);

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
    catalog: Catalog;
    intake: IntakeService;
    boards: BoardService;
    host: CodeHost;
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
    const [index, set] = await Promise.all([knowledge.index(email, boardId), knowledge.agentSetIndex(email, boardId)]);
    if (!index.ok) return send(c, index);
    if (!set.ok) return send(c, set);
    const { version, entries } = set.value;
    // `files`: the paths served (orphaned overlays aren't); `entries`: every path with how it is served.
    const files = entries.filter((e) => e.status !== 'orphaned').map((e) => e.path);
    return c.json({ documents: index.value, agentSet: { version, files, entries } });
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

  // KB items (proposals); members read them, admins decide them.
  app.get('/api/boards/:b/kb/proposals', async (c) => {
    const status = c.req.query('status');
    const parsed = z.enum(KB_ITEM_STATUSES).optional().safeParse(status === '' ? undefined : status);
    if (!parsed.success) return c.json({ code: 'invalid_input', message: `status is one of ${KB_ITEM_STATUSES.join(', ')}` }, 422);
    return send(c, await knowledge.proposals(c.get('email'), Number(c.req.param('b')), parsed.data));
  });

  app.post('/api/kb/:itemId/approve', async (c) => {
    const body = await parse(c, approvalSchema);
    if (body instanceof Response) return body;
    return send(c, await knowledge.approve(c.get('email'), c.req.param('itemId'), body.version, body));
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

  app.post('/api/globs/:id/attachments', async (c) => {
    const body = await parse(
      c,
      z.object({ label: z.string().min(1), text: z.string().nullable().default(null), link: z.url({ protocol: /^https?$/ }).nullable().default(null) }),
    );
    if (body instanceof Response) return body;
    return send(c, await artifacts.attach(c.get('email'), c.req.param('id'), body));
  });
};
