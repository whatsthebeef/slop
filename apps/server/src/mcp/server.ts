import type { ArtifactService, BoardService, GlobService, KnowledgeService, Result } from '@slop/core';
import { machine } from '@slop/core';
import { CATEGORIES, SLOP_TYPES, STATUSES } from '@slop/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import type { Env } from '../http/app.js';
import { renderAgentSetFile } from '../catalog.js';
import type { SignedLinks } from '../signed-links.js';
import { requestOrigin } from '../http/origin.js';
import { errorBody, globView, onBoard } from '../http/views.js';
import type { OutboxRunner } from '../jobs/outbox.js';

export interface McpDeps {
  readonly auth: Auth;
  readonly boards: BoardService;
  readonly globs: GlobService;
  readonly outbox: OutboxRunner;
  readonly knowledge: KnowledgeService;
  readonly artifacts: ArtifactService;
  readonly publicUrl: string;
  /** Public values filled into agent-set files when served (slop's URL, the Claude Code client ID). */
  readonly agentSetValues: Record<string, string>;
  readonly links: SignedLinks;
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const reply = <T>(result: Result<T>, map: (value: T) => unknown = (v) => v): CallToolResult =>
  result.ok
    ? json(map(result.value))
    : { ...json(errorBody(result.error)), isError: true };

/** The private MCP tools, acting as the signed-in person with their board role. */
/** `origin` is the address the client used, so links it receives point back the same way. */
const buildServer = (deps: McpDeps, email: string, origin: string): McpServer => {
  const { boards, globs } = deps;
  const server = new McpServer({ name: 'slop', version: '0.1.0' });

  server.registerTool(
    'whoami',
    { description: 'The signed-in person, their boards and their role on each.' },
    async () => {
      const memberships = await boards.memberships(email);
      return json({ email, boards: memberships.map((m) => ({ id: m.board.id, name: m.board.name, role: m.role })) });
    },
  );

  server.registerTool(
    'get_board',
    {
      description: "A board's settings: repo, base branch, environments, time zone.",
      inputSchema: { board: z.number().int().describe('Board ID (the number in a glob ID: s1t4 is on board 1)') },
    },
    async ({ board }) =>
      reply(await boards.get(email, board), ({ board: b }) => ({
        id: b.id,
        name: b.name,
        repo: b.repo,
        baseBranch: b.baseBranch,
        timeZone: b.timeZone,
        environments: b.environments,
      })),
  );

  server.registerTool(
    'create_glob',
    {
      description:
        'Create a glob (a unit of work) on a board. Returns its ID and branch once provisioned. Pass an idempotency key so a retry never creates a second glob.',
      inputSchema: {
        board: z.number().int(),
        idempotencyKey: z.string().min(1),
        title: z.string().min(1),
        summary: z.string().optional().describe('What the work is and why; becomes the start of plan.md'),
        type: z.enum(SLOP_TYPES).optional().describe('sub (small, auto-merged), same (standard) or super (pairing)'),
        category: z.enum(CATEGORIES).optional(),
        group: z.string().optional(),
        environment: z.string().optional(),
        autoTrigger: z.boolean().optional().describe('Same only: start a routine run straight away'),
      },
    },
    async (input) => {
      const created = await globs.create(email, {
        boardId: input.board,
        title: input.title,
        summary: input.summary ?? '',
        type: input.type ?? 'same',
        category: input.category ?? 'task',
        group: input.group ?? null,
        environment: input.environment ?? null,
        autoTrigger: input.autoTrigger ?? false,
        idempotencyKey: input.idempotencyKey,
      });
      if (!created.ok) return reply(created);
      await deps.outbox.drain(created.value.id);
      return reply(await globs.get(email, created.value.id), ({ glob }) => ({
        id: glob.id,
        version: glob.version,
        branch: glob.id,
        provisioning: glob.provisioning,
        status: glob.status,
        type: glob.type,
        category: glob.category,
        group: glob.group,
        environment: glob.environment,
        summary: glob.summary,
      }));
    },
  );

  server.registerTool(
    'get_glob',
    {
      description:
        'Everything about a glob: status, version, fields, labels, PR, runs and flags. Routines pass their run ID, which records the run as making progress.',
      inputSchema: { id: z.string(), runId: z.string().optional() },
    },
    async ({ id, runId }) => {
      if (runId !== undefined) await globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      return reply(await globs.get(email, id), (v) => globView(v.glob, v.allowedActions));
    },
  );

  server.registerTool(
    'list_globs',
    {
      description: 'Glob summaries on a board, optionally filtered.',
      inputSchema: {
        board: z.number().int(),
        status: z.array(z.enum(STATUSES)).optional(),
        type: z.enum(SLOP_TYPES).optional(),
        group: z.string().optional(),
        person: z.string().optional().describe('Planner or implementer email'),
      },
    },
    async ({ board, status, type, group, person }) => {
      const result = await globs.list(email, board, {
        ...(status === undefined ? {} : { status }),
        ...(type === undefined ? {} : { type }),
        ...(group === undefined ? {} : { group }),
        ...(person === undefined ? {} : { person }),
      });
      const now = Date.now();
      return reply(result, (list) =>
        list
          .filter((g) => onBoard(g, now))
          .map((g) => ({
            id: g.id,
            title: g.title,
            status: g.status,
            type: g.type,
            category: g.category,
            group: g.group,
            planner: g.planner,
            implementer: g.implementer,
            version: g.version,
          })),
      );
    },
  );

  server.registerTool(
    'update_glob',
    {
      description: "Change a glob's title, summary, type, category, group or environment. Pass the version you read.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        title: z.string().optional(),
        summary: z.string().optional(),
        type: z.enum(SLOP_TYPES).optional(),
        category: z.enum(CATEGORIES).optional(),
        group: z.string().nullable().optional(),
        environment: z.string().nullable().optional(),
      },
    },
    async ({ id, version, ...changes }) => {
      const clean = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      return reply(await globs.update(email, id, version, clean), (g) => globView(g));
    },
  );

  server.registerTool(
    'start_glob',
    { description: "Start a same's routine run (planning → implementing).", inputSchema: { id: z.string(), version: z.number().int() } },
    async ({ id, version }) => {
      const result = await globs.start(email, id, version);
      if (result.ok) await deps.outbox.drain(id);
      return reply(result, (g) => globView(g));
    },
  );

  server.registerTool(
    'pick_up',
    {
      description:
        'Become the glob\'s human implementer. Refused with run_active while a routine run is active or watching, unless takeOver is set.',
      inputSchema: { id: z.string(), version: z.number().int(), takeOver: z.boolean().optional() },
    },
    async ({ id, version, takeOver }) => reply(await globs.pickUp(email, id, version, takeOver ?? false), (g) => globView(g)),
  );

  server.registerTool(
    'report_failure',
    {
      description: 'Report that the glob cannot be finished. Routines pass their run ID.',
      inputSchema: { id: z.string(), reason: z.string().min(1), runId: z.string().optional() },
    },
    async ({ id, reason, runId }) => reply(await globs.reportFailure(email, id, reason, runId ?? null), (g) => globView(g)),
  );

  // ---------------------------------------------------------------------------
  // Knowledge and context (slice 3)

  const { knowledge, artifacts } = deps;

  server.registerTool(
    'get_agent_set',
    {
      description:
        "The board's agent set (agent definitions, commands, hooks, settings, the .mcp.json entry and the CLAUDE.md section) with its version. With download: true, returns a link valid for 5 minutes instead of the files (sstor init fetches it with curl).",
      inputSchema: { board: z.number().int(), download: z.boolean().optional() },
    },
    async ({ board, download }) =>
      reply(await knowledge.agentSet(email, board), (set) => {
        if (download === true) {
          const path = `/downloads/agent-set/${String(board)}`;
          const { expires, signature } = deps.links.sign(path, 300);
          return {
            version: set.version,
            url: `${origin}${path}?expires=${String(expires)}&signature=${signature}`,
            expiresAt: new Date(expires * 1000).toISOString(),
          };
        }
        return {
          version: set.version,
          files: set.files.map((f) => ({ path: f.path, content: renderAgentSetFile(f.content, deps.agentSetValues) })),
        };
      }),
  );

  server.registerTool(
    'get_conventions',
    {
      description:
        "The board's knowledge. Without an area: the index of documents (name, area, description, and audience: the agents that must always be given it). With an area or a document name: those documents in full.",
      inputSchema: { board: z.number().int(), area: z.string().optional() },
    },
    async ({ board, area }) =>
      area === undefined
        ? reply(await knowledge.index(email, board), (documents) => ({ documents, learnings: [] }))
        : reply(await knowledge.documents(email, board, area), (docs) =>
            docs.map(({ name, area: a, audience, description, version, content }) => ({ name, area: a, audience, description, version, content })),
          ),
  );

  server.registerTool(
    'import_knowledge',
    {
      description:
        "Admins only: import documents into the board's knowledge base. Frontmatter (area, audience, description) is read from each document; unchanged documents are skipped.",
      inputSchema: {
        board: z.number().int(),
        documents: z.array(z.object({ fileName: z.string().min(1), content: z.string() })).min(1).max(200),
      },
    },
    async ({ board, documents }) => reply(await knowledge.importDocuments(email, board, documents, 'import')),
  );

  server.registerTool(
    'get_context',
    {
      description:
        "The glob's context bundle: its fields, plan.md (the postplan for supers), the implementation plan, attachments, and the board's repo and base branch.",
      inputSchema: { id: z.string(), runId: z.string().optional() },
    },
    async ({ id, runId }) => {
      if (runId !== undefined) await deps.globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      return reply(await artifacts.context(email, id));
    },
  );

  server.registerTool(
    'get_plan',
    {
      description: 'plan.md (or the postplan for supers) for a glob, optionally a given version, with its version history.',
      inputSchema: { id: z.string(), version: z.number().int().optional() },
    },
    async ({ id, version }) => reply(await artifacts.plan(email, id, version ?? null)),
  );

  server.registerTool(
    'attach',
    {
      description: 'Attach text or a link to a glob (clarifications, assumptions, notes) under a label.',
      inputSchema: { id: z.string(), label: z.string().min(1), text: z.string().optional(), link: z.url().optional() },
    },
    async ({ id, label, text, link }) =>
      reply(await artifacts.attach(email, id, { label, text: text ?? null, link: link ?? null }), (a) =>
        'ignored' in a ? a : { id: a.id, label: a.label, version: a.version },
      ),
  );

  server.registerTool(
    'put_artifact',
    {
      description:
        'Store an implementation plan, postplan or local review on the glob as a new version. Routines pass their run ID (results from a superseded run are ignored); pass the agent-set version from .claude/slop-agent-set.json.',
      inputSchema: {
        id: z.string(),
        kind: z.enum(['implementation_plan', 'postplan', 'local_review']),
        content: z.string().min(1),
        commitSha: z.string().optional(),
        runId: z.string().optional(),
        agentSetVersion: z.number().int().optional(),
      },
    },
    async ({ id, kind, content, commitSha, runId, agentSetVersion }) => {
      if (runId !== undefined) {
        // A routine's slop call is progress for its run (and marks a queued run active).
        await deps.globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      }
      return reply(
        await artifacts.putArtifact(email, id, kind, content, {
          commitSha: commitSha ?? null,
          runId: runId ?? null,
          agentSetVersion: agentSetVersion ?? null,
        }),
        (a) => ('ignored' in a ? a : { id: a.id, kind: a.kind, version: a.version }),
      );
    },
  );

  return server;
};

export const mountMcp = (app: Hono<Env>, deps: McpDeps) => {
  const scopes = ['openid', 'email', 'profile', 'slop/mcp'];

  // Protected-resource discovery: points MCP clients at the authorization server.
  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({
      resource: `${requestOrigin(c, deps.publicUrl)}/mcp`,
      authorization_servers: [requestOrigin(c, deps.publicUrl)],
      scopes_supported: scopes,
      bearer_methods_supported: ['header'],
    }),
  );

  // Authorization-server metadata for Cognito. Cognito's own discovery document omits
  // `code_challenge_methods_supported`, and MCP clients must refuse to proceed without it,
  // so slop publishes the metadata itself; sign-in and tokens still come from Cognito.
  const { config } = deps.auth;
  if (config.AUTH_MODE === 'cognito') {
    const domain = `https://${config.COGNITO_DOMAIN ?? ''}`;
    const pool = `https://cognito-idp.${config.COGNITO_REGION ?? ''}.amazonaws.com/${config.COGNITO_USER_POOL_ID ?? ''}`;
    const metadata = (issuer: string) => ({
      issuer,
      authorization_endpoint: `${domain}/oauth2/authorize`,
      token_endpoint: `${domain}/oauth2/token`,
      revocation_endpoint: `${domain}/oauth2/revoke`,
      userinfo_endpoint: `${domain}/oauth2/userInfo`,
      jwks_uri: `${pool}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      scopes_supported: scopes,
    });
    app.get('/.well-known/oauth-authorization-server', (c) => c.json(metadata(requestOrigin(c, deps.publicUrl))));
    app.get('/.well-known/openid-configuration', (c) => c.json(metadata(requestOrigin(c, deps.publicUrl))));
  }

  app.all('/mcp', async (c) => {
    const header = c.req.header('authorization');
    const email = header?.startsWith('Bearer ') === true ? await deps.auth.bearerEmail(header.slice(7)) : null;
    if (email === null) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${requestOrigin(c, deps.publicUrl)}/.well-known/oauth-protected-resource"`,
      });
    }
    const server = buildServer(deps, email, requestOrigin(c, deps.publicUrl));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
};
