import type { ArtifactService, BoardService, Deploy, DeployService, GlobService, IntakeService, KnowledgeService, Result } from '@slop/core';
import { invalidInput, machine } from '@slop/core';
import { ARTIFACT_KINDS, CATEGORIES, LABEL_NAMES, LEARNING_TYPES, SLOP_TYPES, STATUSES } from '@slop/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import type { Env } from '../http/app.js';
import { renderAgentSetFile } from '../catalog.js';
import type { SignedLinks } from '../signed-links.js';
import { parseLabelCommand } from '../http/labels.js';
import { requestOrigin } from '../http/origin.js';
import { errorBody, globView, onBoard } from '../http/views.js';
import type { OutboxRunner } from '../jobs/outbox.js';

export interface McpDeps {
  readonly auth: Auth;
  readonly boards: BoardService;
  readonly globs: GlobService;
  readonly deploys: DeployService;
  readonly outbox: OutboxRunner;
  readonly knowledge: KnowledgeService;
  readonly artifacts: ArtifactService;
  readonly intake: IntakeService;
  readonly publicUrl: string;
  /** Public values filled into agent-set files when served (slop's URL, the Claude Code client ID). */
  readonly agentSetValues: Record<string, string>;
  readonly links: SignedLinks;
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** A deploy as agents see it: enough to tell the developer what's deploying, live or failed. */
const deployView = (d: Deploy) => ({
  environment: d.environment,
  sha: d.sha,
  state: d.state,
  trigger: d.trigger,
  requestedAt: d.requestedAt,
  finishedAt: d.finishedAt,
  error: d.error,
  url: d.url,
});

const reply = <T>(result: Result<T>, map: (value: T) => unknown = (v) => v): CallToolResult =>
  result.ok
    ? json(map(result.value))
    : { ...json(errorBody(result.error)), isError: true };

/** The private MCP tools, acting as the signed-in person with their board role. */
/** `origin` is the address the client used, so links it receives point back the same way. */
export const buildServer = (deps: McpDeps, email: string, origin: string): McpServer => {
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
      description: "A board's settings: repo, base branch, environments, time zone, and its enabled integrations (integrations.deploy: how branch deploys run, or null).",
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
        integrations: { deploy: b.deploy },
      })),
  );

  server.registerTool(
    'create_glob',
    {
      description:
        'Create a glob (a unit of work) on a board. Pass the request as `input` and slop proposes the title, summary, type, category and group (intake); explicit fields win. Returns its ID and branch once provisioned. Pass an idempotency key so a retry never creates a second glob.',
      inputSchema: {
        board: z.number().int(),
        idempotencyKey: z.string().min(1),
        input: z.string().optional().describe('The request in free text; used for intake when no title is given'),
        title: z.string().min(1).optional(),
        summary: z.string().optional().describe('What the work is and why; becomes the start of plan.md'),
        type: z.enum(SLOP_TYPES).optional().describe('sub (small, auto-merged), same (standard) or super (pairing)'),
        category: z.enum(CATEGORIES).optional(),
        group: z.string().optional(),
        environment: z
          .string()
          .min(1)
          .optional()
          .describe(
            "One of the board's environments that allows branch deploys. Without one, intake suggests an environment the request targets (\"deploy to staging\"), and a sub gets the board's default for subs",
          ),
        autoTrigger: z.boolean().optional().describe('Same only: start a routine run straight away'),
      },
    },
    async (input) => {
      let fields = {
        title: input.title ?? '',
        summary: input.summary ?? '',
        type: input.type ?? ('same' as const),
        category: input.category ?? ('task' as const),
        group: input.group ?? null,
        autoTrigger: input.autoTrigger ?? false,
      };
      // Intake suggests an environment the request names; an explicit one wins.
      let suggestedEnvironment: string | null = null;
      if (input.title === undefined) {
        if (input.input === undefined || input.input.trim() === '') {
          return { ...json({ code: 'invalid_input', message: 'Pass a title, or the request as input' }), isError: true };
        }
        const proposal = await deps.intake.propose(email, input.board, {
          text: input.input,
          explicit: {
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.category === undefined ? {} : { category: input.category }),
            ...(input.group === undefined ? {} : { group: input.group }),
            ...(input.environment === undefined ? {} : { environment: input.environment }),
          },
        });
        if (!proposal.ok) return reply(proposal);
        const { environment, ...proposed } = proposal.value;
        fields = { ...proposed, autoTrigger: input.autoTrigger ?? proposal.value.autoTrigger };
        suggestedEnvironment = environment;
      }
      const created = await globs.create(email, {
        boardId: input.board,
        ...fields,
        environment: input.environment ?? suggestedEnvironment,
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
        "Everything about a glob: status, version, fields, labels, PR, runs, flags, its artifacts (the latest version of each plan, implementation plan, postplan, local review and attachment, with version count, commitSha, createdAt and provenance; no content) and its latest deploys (environment, commit, state: waiting, running, succeeded, failed or replaced; error and log link). Routines pass their run ID, which records the run as making progress.",
      inputSchema: { id: z.string(), runId: z.string().optional() },
    },
    async ({ id, runId }) => {
      if (runId !== undefined) await globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      const view = await globs.get(email, id);
      if (!view.ok) return reply(view, () => null);
      const history = await deps.deploys.history(email, id, 5);
      return reply(view, (v) => ({
        ...globView(v.glob, v.allowedActions, v.artifacts),
        deploys: history.ok ? history.value.map(deployView) : [],
      }));
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
        'Become the glob\'s human implementer, optionally choosing its environment (one of the board\'s that allows branch deploys; leave it out to keep the current one). Refused with run_active while a routine run is active or watching, unless takeOver is set. QA and PO members can only pick up subs.',
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        takeOver: z.boolean().optional(),
        environment: z.string().min(1).optional().describe("The environment this glob's branch deploys to"),
      },
    },
    async ({ id, version, takeOver, environment }) => {
      const result = await globs.pickUp(email, id, version, takeOver ?? false, environment);
      // Run the jobs it queued (a super's provisioning) now, as the REST action does.
      if (result.ok) await deps.outbox.drain(id);
      return reply(result, (g) => globView(g));
    },
  );

  server.registerTool(
    'mark_ready',
    {
      description:
        "Mark the glob's draft PR ready for review when the work is pushed. slop does it through its GitHub App; the glob moves to pr_open when GitHub confirms. Routines pass their run ID.",
      inputSchema: { id: z.string(), runId: z.string().optional() },
    },
    async ({ id, runId }) => {
      if (runId !== undefined) await globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      const result = await globs.requestReady(email, id, runId ?? null);
      if (result.ok) await deps.outbox.drain(id);
      return reply(result, (g) => ({ id: g.id, status: g.status, pr: g.pr, note: 'The PR is being marked ready; the glob moves to pr_open when GitHub confirms.' }));
    },
  );

  server.registerTool(
    'merge',
    {
      description:
        "Merge a same or super whose PR is ready and whose required checks passed on the current head, as the glob's Merge button does: slop updates the branch, waits for checks on the new head and squash-merges through its GitHub App. The glob moves to merging, then to reviewing when the merge is observed. With continue (supers, latest postplan at the head), it is Merge and continue: the glob returns to in_progress on the same branch, and its next push opens a fresh draft PR. Pass the version you read.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        continue: z.boolean().optional().describe('Supers: Merge and continue (a checkpoint merge; the glob stays in Doing)'),
      },
    },
    async ({ id, version, continue: continueAfter }) => {
      const result = await globs.merge(email, id, version, continueAfter ?? false);
      if (!result.ok) return reply(result);
      // Run the squash_merge job now and answer with the glob as it then is, as the REST action does.
      await deps.outbox.drain(id);
      return reply(await globs.get(email, id), (v) => globView(v.glob, v.allowedActions, v.artifacts));
    },
  );

  /** Approve and reopen are sign-off decisions, made on the board, not through MCP. */
  const MCP_LABEL_COMMAND_KINDS = ['submit_items', 'tick', 'resubmit'] as const;

  server.registerTool(
    'review_label',
    {
      description:
        "Work on a merged glob's sign-off label (FR, CR or QA) and its review checklist. Reviewer: submit_items (items: one or more texts; label required → added). Developer: tick (itemId, done) while items are added, or resubmit (added → required, items and ticks kept). Approving and re-opening a review are human decisions made on the board, so this tool refuses them. Pass the version you read.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        label: z.enum(LABEL_NAMES),
        kind: z.enum(MCP_LABEL_COMMAND_KINDS),
        items: z.array(z.string()).optional().describe('submit_items: the items to add'),
        itemId: z.string().optional().describe('tick: the item'),
        done: z.boolean().optional().describe('tick: true to tick, false to untick'),
      },
    },
    async ({ id, version, label, ...input }) => {
      // Sign-off stays human (like merging): slop can't tell an agent from its developer over MCP.
      const command = parseLabelCommand(input);
      if (command === null) {
        return reply(invalidInput('submit_items needs items; tick needs itemId and done'));
      }
      return reply(await globs.reviewLabel(email, id, version, label, command), (g) => globView(g));
    },
  );

  server.registerTool(
    'report_failure',
    {
      description:
        'Report that the glob cannot be finished. Routines pass their run ID; pass the agent-set version from .claude/slop-agent-set.json.',
      inputSchema: {
        id: z.string(),
        reason: z.string().min(1),
        runId: z.string().optional(),
        agentSetVersion: z.number().int().nonnegative().optional(),
      },
    },
    async ({ id, reason, runId, agentSetVersion }) =>
      reply(await globs.reportFailure(email, id, reason, runId ?? null, agentSetVersion ?? null), (g) => globView(g)),
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
        "The board's knowledge. Without an area: the index of documents (name, area, description, and audience: the agents that must always be given it) and the approved learnings (statement, type, source globs, approvedAt). With an area or a document name: those documents in full.",
      inputSchema: { board: z.number().int(), area: z.string().optional() },
    },
    async ({ board, area }) => {
      if (area === undefined) {
        const [index, learnings] = await Promise.all([knowledge.index(email, board), knowledge.approvedLearnings(email, board)]);
        return learnings.ok ? reply(index, (documents) => ({ documents, learnings: learnings.value })) : reply(learnings);
      }
      return reply(await knowledge.documents(email, board, area), (docs) =>
        docs.map(({ name, area: a, audience, description, version, content }) => ({ name, area: a, audience, description, version, content })),
      );
    },
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
    'submit_learning',
    {
      description:
        "Submit one learning from a run (orchestrator phase 6, /finalise) as a KB item for the board's admins to review; nothing changes the knowledge base until it is approved. Returns its ID (s1k3) straight away; slop then routes it to a document or agent file, deduplicates it against other items and drafts the change in the background. Pass the agent-set version from .claude/slop-agent-set.json; routines pass their run ID. /kb-bootstrap proposes a whole new document with `document`; approving it creates or updates that document.",
      inputSchema: {
        board: z.number().int(),
        sourceGlobId: z
          .string()
          .min(1)
          .optional()
          .describe('The glob the learning came from; required unless a document is proposed'),
        type: z
          .enum(LEARNING_TYPES)
          .describe('decision, gotcha, pattern, or agent-behaviour (something an instruction would have prevented)'),
        statement: z.string().min(1).describe('The learning, as one rule or fact'),
        evidence: z.string().min(1).describe('What showed it: files, review findings, failures, a developer correction'),
        suggestedTarget: z.string().optional().describe('Where it belongs: a document, area or agent definition'),
        agentSetVersion: z.number().int().nonnegative().optional(),
        runId: z.string().optional(),
        document: z
          .object({
            name: z.string().min(1).describe('Document name, e.g. build_test_lint'),
            area: z.string().min(1).describe('Frontmatter area, e.g. build, conventions, architecture'),
            audience: z.array(z.string().min(1)).describe('Agents that must always be given it, e.g. implementer, tester'),
            description: z.string().min(1).describe('One line: what the document covers'),
            content: z.string().min(1).max(200_000).describe('The document body in Markdown (frontmatter is built from the fields above)'),
          })
          .optional()
          .describe('A whole new document to propose (/kb-bootstrap)'),
      },
    },
    async ({ board, sourceGlobId, type, statement, evidence, suggestedTarget, agentSetVersion, runId, document }) => {
      if (runId !== undefined && sourceGlobId !== undefined) {
        await deps.globs.applyEvent(sourceGlobId, (g, ctx) => machine.runProgress(g, runId, ctx));
      }
      return reply(
        await knowledge.submitLearning(email, board, {
          sourceGlobId: sourceGlobId ?? null,
          type,
          statement,
          evidence,
          suggestedTarget: suggestedTarget ?? null,
          agentSetVersion: agentSetVersion ?? null,
          document: document ?? null,
        }),
      );
    },
  );

  server.registerTool(
    'get_context',
    {
      description:
        "The glob's context bundle: its fields, plan.md (the postplan for supers) in full, Clarifications and Assumptions attachments in full, a listing of the other artifacts (kind, label, version, commitSha, size, description), and the board's repo and base branch. Pass `include` to get more in full: 'implementation_plan', 'local_review', 'attachment:<label>', or 'all'.",
      inputSchema: { id: z.string(), runId: z.string().optional(), include: z.array(z.string()).optional() },
    },
    async ({ id, runId, include }) => {
      if (runId !== undefined) await deps.globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      return reply(await artifacts.context(email, id, include ?? []));
    },
  );

  server.registerTool(
    'get_artifact',
    {
      description:
        "The latest version of one artifact of a glob in full: kind is 'implementation_plan', 'postplan', 'local_review' or 'attachment' (with its label).",
      inputSchema: { id: z.string(), kind: z.enum(ARTIFACT_KINDS), label: z.string().optional() },
    },
    async ({ id, kind, label }) => reply(await artifacts.artifact(email, id, kind, label ?? '')),
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
      inputSchema: { id: z.string(), label: z.string().min(1), text: z.string().optional(), link: z.url({ protocol: /^https?$/ }).optional() },
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
        agentSetVersion: z.number().int().nonnegative().optional(),
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
