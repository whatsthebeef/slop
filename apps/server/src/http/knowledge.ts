import type { ArtifactService, Catalog, KnowledgeService } from '@slop/core';
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

const parse = async <S extends z.ZodType>(c: Context<Env>, schema: S): Promise<z.infer<S> | Response> => {
  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : c.json({ code: 'invalid_input', message: z.prettifyError(parsed.error) }, 422);
};

/** REST for the board's knowledge base and glob artifacts. */
export const mountKnowledge = (
  app: Hono<Env>,
  deps: { knowledge: KnowledgeService; artifacts: ArtifactService; catalog: Catalog },
) => {
  const { knowledge, artifacts, catalog } = deps;
  type Settled<T> = { ok: true; value: T } | { ok: false; error: Parameters<typeof statusOf>[0] };
  const send = <T>(c: Context<Env>, result: Settled<T>) =>
    result.ok ? c.json(result.value as object) : c.json(errorBody(result.error), statusOf(result.error));

  app.get('/api/boards/:b/kb', async (c) => {
    const boardId = Number(c.req.param('b'));
    const email = c.get('email');
    const [index, set] = await Promise.all([knowledge.index(email, boardId), knowledge.agentSet(email, boardId)]);
    if (!index.ok) return send(c, index);
    if (!set.ok) return send(c, set);
    return c.json({ documents: index.value, agentSet: { version: set.value.version, files: set.value.files.map((f) => f.path) } });
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

  app.post('/api/boards/:b/kb/agent-set/fork', async (c) =>
    send(c, await knowledge.forkAgentSet(c.get('email'), Number(c.req.param('b')))),
  );

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

  app.post('/api/globs/:id/attachments', async (c) => {
    const body = await parse(
      c,
      z.object({ label: z.string().min(1), text: z.string().nullable().default(null), link: z.url().nullable().default(null) }),
    );
    if (body instanceof Response) return body;
    return send(c, await artifacts.attach(c.get('email'), c.req.param('id'), body));
  });
};
