import type { BoardService, GlobService, Result } from '@slop/core';
import { CATEGORIES, SLOP_TYPES, STATUSES } from '@slop/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import type { Env } from '../http/app.js';
import { errorBody, globView, onBoard } from '../http/views.js';
import type { OutboxRunner } from '../jobs/outbox.js';

export interface McpDeps {
  readonly auth: Auth;
  readonly boards: BoardService;
  readonly globs: GlobService;
  readonly outbox: OutboxRunner;
  readonly publicUrl: string;
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const reply = <T>(result: Result<T>, map: (value: T) => unknown = (v) => v): CallToolResult =>
  result.ok
    ? json(map(result.value))
    : { ...json(errorBody(result.error)), isError: true };

/** The private MCP tools, acting as the signed-in person with their board role. */
const buildServer = (deps: McpDeps, email: string): McpServer => {
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
    { description: 'Everything about a glob: status, version, fields, labels, PR, runs and flags.', inputSchema: { id: z.string() } },
    async ({ id }) => reply(await globs.get(email, id), (v) => globView(v.glob, v.allowedActions)),
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

  return server;
};

export const mountMcp = (app: Hono<Env>, deps: McpDeps) => {
  const resourceMetadataUrl = `${deps.publicUrl}/.well-known/oauth-protected-resource`;

  // Protected-resource discovery: points MCP clients at the authorization server.
  app.get('/.well-known/oauth-protected-resource', (c) => {
    const { config } = deps.auth;
    const issuer =
      config.AUTH_MODE === 'cognito'
        ? `https://cognito-idp.${config.COGNITO_REGION ?? ''}.amazonaws.com/${config.COGNITO_USER_POOL_ID ?? ''}`
        : deps.publicUrl;
    return c.json({
      resource: `${deps.publicUrl}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });
  });

  app.all('/mcp', async (c) => {
    const header = c.req.header('authorization');
    const email = header?.startsWith('Bearer ') === true ? await deps.auth.bearerEmail(header.slice(7)) : null;
    if (email === null) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
      });
    }
    const server = buildServer(deps, email);
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
