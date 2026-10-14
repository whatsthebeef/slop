import type { Relation, ArtifactService, AttachmentService, BoardService, Deploy, IntakeRecord, DeployService, GlobService, InboxService, IntakeService, KnowledgeService, ReportService, Result, SearchService, ChatService, CodeViewService, SuggestService, NewHumanStep, StoredHumanStep } from '@slop/core';
import { cleanFileName, invalidInput, machine, notFound, startIds, resolveContentType, UPLOAD_TTL_SECONDS } from '@slop/core';
import { ARTIFACT_KINDS, WORK_CATEGORIES, ESCALATION_CRITERIA, MAX_SPLIT_PARTS, KB_ITEM_STATUSES, LABEL_NAMES, LEARNING_TYPES, MAX_QUERY_LENGTH, RISK_TIERS, SEARCH_MODES, SLOP_TYPES, SOURCE_TYPES, STATUSES, HUMAN_STEP_BLOCKS, HUMAN_STEP_KINDS } from '@slop/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import type { Env } from '../http/app.js';
import { renderAgentSetFile } from '../catalog.js';
import { MAX_CREATE_FILES, NEVER_INLINE_FILES, UPLOAD_NEXT, uploadView } from '../upload-instructions.js';
import type { SignedLinks } from '../signed-links.js';
import { parseLabelCommand } from '../http/labels.js';
import { issueUploadUrl } from '../http/artifact-upload.js';
import { requestOrigin } from '../http/origin.js';
import { addRelationSchema, relationInput, relationInputs, relationInputSchema } from '../http/relation-schemas.js';
import { isDate, parseBound, toRequest } from '../search-request.js';
import { requestMetrics } from '../request-metrics.js';
import { compactKbItem, compactSizeProposal, errorBody, globView, globViewOf, onBoard } from '../http/views.js';
import type { OutboxRunner } from '../jobs/outbox.js';
import type { MergeGate, ReadyGate } from '../ready-gate.js';

export interface McpDeps {
  readonly auth: Auth;
  readonly boards: BoardService;
  readonly globs: GlobService;
  readonly deploys: DeployService;
  readonly outbox: OutboxRunner;
  readonly knowledge: KnowledgeService;
  readonly artifacts: ArtifactService;
  readonly search: SearchService;
  /** The read-only code view of each board's repository (membership-scoped). */
  readonly code: CodeViewService;
  readonly chat: Pick<ChatService, 'answer'>;
  readonly intake: IntakeService;
  readonly inbox: InboxService;
  /** Upload links for file attachments; absent when no bucket is configured (then `files` is refused). */
  readonly attachments?: Pick<AttachmentService, 'createUpload' | 'downloadUrl'>;
  /** Refuses `mark_ready` for a branch that conflicts with its base. */
  readonly readyGate: ReadyGate;
  /** Refuses `merge` on an agent-set PR whose diff is empty. */
  readonly mergeGate?: MergeGate;
  readonly publicUrl: string;
  /** Other origins that reach this server (`PUBLIC_URL_ALIASES`); a client on one is served metadata and redirects on it. */
  readonly publicUrlAliases?: readonly string[];
  /** Public values filled into agent-set files when served (slop's URL, the Claude Code client ID). */
  readonly agentSetValues: Record<string, string>;
  readonly links: SignedLinks;
  /** Time reports (`get_report`). */
  readonly reports: Pick<ReportService, 'report'>;
  /** Suggest on decision globs (`suggest_decision`). */
  readonly suggest?: Pick<SuggestService, 'request' | 'view'>;
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** What `relations` mean, for the tools that take them. */
const RELATIONS_HELP =
  "Relations beside `needs`/`after` (which stay as the shorthand for a start relation until merged): `[{to, gate?, until?, reason?}]`. This glob can't pass `gate` until `to` reaches `until`. `gate`: `start` (the default: can't start), `merge` (can't be merged; an armed merge-when-green waits and goes on by itself) or `sign_off` (can't be signed off). `until`: `merged` (the default), `decided` (`to` is a decision glob whose outcome was accepted or rejected, not needs-work; the default when `to` is a decision) or `signed_off`. `to` must be a glob or decision on the same board, not this glob, with no cycle; at most 20 per gate. Add one only when the work really can't go ahead without it: a glob that merely touches the same files is not a relation. Give a `reason`, one line.";

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
  // Every tool is the same URL: name the request after the tool, so the timing summary tells them apart.
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...args: unknown[]) => unknown) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: unknown, cb: (...args: unknown[]) => unknown) =>
    register(name, config, (...args: unknown[]) => {
      requestMetrics.label(`mcp ${name}`);
      return cb(...args);
    });

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
        'Create a glob (a unit of work: a feature, task or bug) on a board; decision globs are created by slop from learnings, never here. Pass the request as `input` and slop proposes the title, plan, type, category and group (intake); explicit fields win. Create it as a sub unless the request says same, it clearly needs a human decision before work starts, or it is clearly a big task (an oversized flag only advises and never holds a glob; a person can cut its scope into independent globs if each could ship alone); an explicit `type` always wins. Only board admins can create a sub or a super: if the person you work for is not an admin, create a same (leave `type` unset and slop makes it a same; an explicit sub or super is refused with `forbidden`) and an admin can change its type. A running sub the agents find needs a human is escalated to a same by `escalate_to_same`. Returns its ID and branch once provisioned. Pass an idempotency key so a retry never creates a second glob.',
      inputSchema: {
        board: z.number().int(),
        idempotencyKey: z.string().min(1),
        input: z.string().optional().describe('The request in free text; used for intake when no title is given'),
        title: z.string().min(1).optional(),
        plan: z
          .string()
          .optional()
          .describe('The full spec, stored verbatim as plan.md v1; without it plan.md v1 is the write-up intake makes of the input, else the title'),
        type: z.enum(SLOP_TYPES).optional().describe('sub (small, auto-merged), same (standard) or super (pairing). Sub and super are for board admins only; everyone else creates a same'),
        category: z.enum(WORK_CATEGORIES).optional(),
        group: z.string().nullable().optional().describe('The glob\'s group; omit it to let slop choose one from the title and plan, pass null or an empty string for none'),
        environment: z
          .string()
          .min(1)
          .optional()
          .describe(
            "One of the board's environments that allows branch deploys. Without one, intake suggests an environment the request targets (\"deploy to staging\"), and a sub gets the board's default for subs",
          ),
        autoTrigger: z.boolean().optional().describe('Same only: start a routine run straight away'),
        inboxItem: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("An inbox item of the same board to attach to the new glob in the same step (it becomes `attached` and is in the glob's context from the start). Refused when it is another board's or discarded, and nothing is created"),
        files: z
          .array(
            z.object({
              fileName: z.string().min(1).max(255),
              contentType: z.string().max(200).optional(),
              label: z.string().min(1).max(200).optional(),
            }),
          )
          .max(MAX_CREATE_FILES)
          .optional()
          .describe(
            `Files (images, screenshots, PDFs, documents) the user shared or you made, to put on the new glob. Pass only each file's name and type. ${NEVER_INLINE_FILES} The reply carries an upload link and a ready curl command per file; a sub's first run waits for them (at most ${String(UPLOAD_TTL_SECONDS / 60)} minutes). A file that never arrives is noted on the glob for a person to upload. For short text notes use \`attach\` after creating the glob.`,
          ),
        start: z
          .boolean()
          .optional()
          .describe('Super only: false parks it in Planning (no branch, run or implementer) until a person picks it up to pair. Default: parked when intake chose super, else it starts in Doing with you'),
        needs: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe(
            'IDs of globs on this board whose code this glob needs (it uses what they add). It cannot start until they have merged: a sub waits in Planning, a same is refused Start until then. Alias: `after`. Add one only when the code really is missing without it; a glob that merely touches the same files is not a need.',
          ),
        after: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe(
            'Alias of `needs`: IDs of globs on this board to start after, meaning the glob waits for them to merge. A sub waits in Planning (no branch, no run) until they have all merged, then starts by itself on the new main; a same is refused Start until then. Merged ones are ignored; unknown ids and cycles are refused. Use it instead of writing "start only after sXtY" in the plan',
          ),
        relations: z.array(relationInputSchema).max(60).optional().describe(RELATIONS_HELP),
      },
    },
    async (input) => {
      if (input.files !== undefined && input.files.length > 0) {
        if (deps.attachments === undefined) return { ...json({ code: 'invalid_input', message: 'File attachments are not set up on this slop' }), isError: true };
        for (const f of input.files) {
          if (cleanFileName(f.fileName) === '' || resolveContentType(f.fileName, f.contentType) === null) {
            return { ...json({ code: 'invalid_input', message: `${f.fileName}: this file type is not accepted` }), isError: true };
          }
        }
      }
      let fields = {
        title: input.title ?? '',
        type: input.type ?? ('sub' as const),
        category: input.category ?? ('task' as const),
        group: input.group === undefined || input.group === null || input.group.trim() === '' ? null : input.group.trim(),
        autoTrigger: input.autoTrigger ?? false,
      };
      // Intake suggests an environment the request names; an explicit one wins.
      let suggestedEnvironment: string | null = null;
      // Intake's guesses: files the work changes (they can hold it for the merge policy) and globs the request waits for (only reported).
      let files: readonly string[] = [];
      let suggestedAfter: readonly string[] = [];
      // The write-up intake made from the request: plan.md v1 unless the caller gave a plan.
      let proposedPlan: string | null = null;
      // What intake saw and decided, for the glob's snapshot.
      let intakeRecord: IntakeRecord | null = null;
      if (input.title === undefined) {
        if (input.input === undefined || input.input.trim() === '') {
          return { ...json({ code: 'invalid_input', message: 'Pass a title, or the request as input' }), isError: true };
        }
        const proposal = await deps.intake.propose(email, input.board, {
          text: input.input,
          explicit: {
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.category === undefined ? {} : { category: input.category }),
            ...(input.group === undefined ? {} : { group: input.group ?? '' }),
            ...(input.environment === undefined ? {} : { environment: input.environment }),
          },
        });
        if (!proposal.ok) return reply(proposal);
        const { environment, plan, ...proposed } = proposal.value;
        fields = { ...proposed, autoTrigger: input.autoTrigger ?? proposal.value.autoTrigger };
        suggestedEnvironment = environment;
        proposedPlan = plan;
        intakeRecord = {
          request: input.input,
          source: 'mcp',
          categoryConfidence: proposal.value.categoryConfidence,
          reason: proposal.value.categoryReason,
          model: proposal.value.model,
          promptVersion: proposal.value.promptVersion,
          examples: proposal.value.examples.map((e) => e.globId),
        };
        files = proposal.value.files;
        suggestedAfter = proposal.value.suggestedAfter;
      }
      // A titled create skips intake, so choose the group alone; a model that is down leaves it empty.
      if (input.title !== undefined && input.group === undefined) {
        const suggested = await deps.intake.suggestGroup(email, input.board, { title: input.title, plan: input.plan ?? input.input ?? '' });
        if (suggested.ok) fields = { ...fields, group: suggested.value };
      }
      // A super intake chose waits in Planning for a person; one asked for by type starts in Doing as before.
      const start = input.start ?? (intakeRecord !== null && input.type === undefined && fields.type === 'super' ? false : undefined);
      const created = await globs.create(email, {
        boardId: input.board,
        ...fields,
        typeChosen: input.type !== undefined,
        ...(start === undefined ? {} : { start }),
        plan: input.plan ?? proposedPlan ?? input.input ?? '',
        planBy: 'sessionator',
        source: 'mcp',
        ...(intakeRecord === null ? {} : { intake: intakeRecord }),
        environment: input.environment ?? suggestedEnvironment,
        idempotencyKey: input.idempotencyKey,
        ...(input.inboxItem === undefined ? {} : { inboxItem: input.inboxItem }),
        ...(input.needs === undefined && input.after === undefined ? {} : { after: [...new Set([...(input.needs ?? []), ...(input.after ?? [])])] }),
        ...(input.relations === undefined ? {} : { relations: relationInputs(input.relations) }),
        relationsBy: 'agent' as const,
        ...(files.length === 0 ? {} : { files }),
      });
      if (!created.ok) return reply(created);
      // The links are minted before the outbox runs, so a sub's first run sees its pending files and waits for them.
      const uploads: ReturnType<typeof uploadView>[] = [];
      const uploadProblems: string[] = [];
      for (const f of input.files ?? []) {
        const made = await deps.attachments?.createUpload(email, created.value.id, f);
        if (made === undefined) continue;
        if (made.ok) uploads.push(uploadView(made.value));
        else uploadProblems.push(`${f.fileName}: ${made.error.message}`);
      }
      await deps.outbox.drain(created.value.id);
      return reply(await globs.get(email, created.value.id), ({ glob, relations }) => ({
        ...(uploads.length === 0 ? {} : { uploads, next: UPLOAD_NEXT }),
        ...(uploadProblems.length === 0 ? {} : { uploadProblems }),
        id: glob.id,
        version: glob.version,
        branch: glob.id,
        provisioning: glob.provisioning,
        status: glob.status,
        type: glob.type,
        category: glob.category,
        group: glob.group,
        environment: glob.environment,
        ...(startIds(relations).length === 0 ? {} : { after: startIds(relations) }),
        ...(glob.waiting == null ? {} : { waiting: true }),
        // Not applied: pass `after` to wait for them.
        ...(suggestedAfter.filter((id) => !startIds(relations).includes(id)).length === 0
          ? {}
          : { suggestedAfter: suggestedAfter.filter((id) => !startIds(relations).includes(id)) }),
      }));
    },
  );

  server.registerTool(
    'split_glob',
    {
      description:
        "Cut the scope of a glob in Planning (not started: no run, no branch) into independent globs in one step: a scope cut, for work that could each ship alone, not a way to parallelise one piece of work (parallel work happens inside the run as workstreams). Part 0 is this glob: it keeps its ID, history and decisions, gets the new title and plan, and signs off on its own like any glob. The other parts are created in its group with their own plan and copies of its link attachments (and the text attachments you list). Write `{part:N}` in a plan for part N's glob ID. Pass the version you read and an idempotency key (a retry returns the same parts). Title every part with the feature's short name from the original title, a colon, then what it delivers and changes (\"Board chat: answers get 👍/👎 buttons, stored per board\", not \"Feedback UI and submission\"); at most ~100 characters, no \"Part N\". Parts default to the glob's type and category. The parts are independent: there is no gate between them and no sign-off from the original on the others, unless you pass `after` on a part (earlier parts it needs merged before it starts), which is stored as an ordinary need (a start relation from the part to the earlier part). Name only direct prerequisites in `after`. The parts keep a \"Split from <id>\" line in their plan and a split event as provenance.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        idempotencyKey: z.string().min(1),
        parts: z
          .array(
            z.object({
              title: z.string().min(1),
              plan: z.string().min(1).describe("This part's share of plan.md (Markdown); {part:N} stands for part N's glob ID"),
              category: z.enum(WORK_CATEGORIES).optional(),
              type: z.enum(SLOP_TYPES).optional(),
              after: z.array(z.number().int().min(0)).max(MAX_SPLIT_PARTS).optional().describe('Indexes of earlier parts this part needs merged before it starts'),
              attachments: z.array(z.string().min(1)).optional().describe("Labels of the original's text attachments to copy (new parts only; link attachments are always copied)"),
            }),
          )
          .min(2)
          .max(MAX_SPLIT_PARTS),
      },
    },
    async ({ id, version, idempotencyKey, parts }) => {
      const split = await globs.split(email, id, version, {
        idempotencyKey,
        planBy: 'sessionator',
        parts: parts.map(({ attachments, after, category, type, ...rest }) => ({
          ...rest,
          ...(attachments === undefined ? {} : { attachments }),
          ...(after === undefined ? {} : { after }),
          ...(category === undefined ? {} : { category }),
          ...(type === undefined ? {} : { type }),
        })),
      });
      if (split.ok) for (const glob of split.value) await deps.outbox.drain(glob.id);
      const relations = split.ok ? await globs.peekRelations(split.value.map((g) => g.id)) : new Map<string, Relation[]>();
      return reply(split, (list) => ({
        parts: list.map((glob, index) => ({
          part: index,
          id: glob.id,
          version: glob.version,
          title: glob.title,
          type: glob.type,
          category: glob.category,
          status: glob.status,
          ...(startIds(relations.get(glob.id) ?? []).length === 0 ? {} : { after: startIds(relations.get(glob.id) ?? []) }),
          ...(glob.waiting == null ? {} : { waiting: true }),
        })),
      }));
    },
  );

  server.registerTool(
    'get_glob',
    {
      description:
        "Everything about a glob (a decision glob carries `attributes`: scope, origin, channel, outcome, and for a KB learning its kind, target, evidence count, staleness and, when the pipeline closed it, closedAs; `links` says how it relates to other learnings (duplicate_of, suppressed_by, covered_by, possibly_covered_by, contradicts, kept_apart_from), kept apart from the glob's `relations`; its proposal is plan.md): status, version, fields, labels, PR, runs, flags, its `relations` (`holding`: what holds it back now, with the gate, what it waits for and why; `holdsBack`: the globs waiting for it; `done`: relations that no longer hold, met, dismissed, overridden or deleted; each with its source: person, agent, inferred or learned; older rows may say split), its artifacts (the latest version of each plan, implementation record, local review and attachment, with version count, commitSha, createdAt and provenance; no content) and its latest deploys (environment, commit, state: waiting, running, succeeded, failed or replaced; error and log link). Routines pass their run ID, which records the run as making progress. When intake's size check flagged the glob, `oversized` is true and `sizeCheck` carries why, its evidence, `decision` (`split` once its scope was cut into independent globs) and the proposed workstreams (each with its name, goal, files, needs, a short `planSummary` and `planChars`; `get_context` has them in full). The flag is advice: it never holds the glob, which can start at once and works the workstreams inside its one run; a flagged sub is a same. `handover` is the hand-over brief (`why`: one sentence per cause, most actionable first; `next`: what to do first; `detail`: the extra lines) when the glob needs a person (a conflict, a failure, failed checks, a stalled run or open in-scope review findings), else null.",
      inputSchema: {
        id: z.string(),
        runId: z.string().optional(),
      },
    },
    async ({ id, runId }) => {
      if (runId !== undefined) await globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      const view = await globs.get(email, id);
      if (!view.ok) return reply(view, () => null);
      const history = await deps.deploys.history(email, id, 5);
      return reply(view, (v) => ({
        // The proposed workstreams are a summary here (name, goal, files, needs and a short plan share); get_context has them in full.
        ...compactSizeProposal(globViewOf(v)),
        deploys: history.ok ? history.value.map(deployView) : [],
      }));
    },
  );

  server.registerTool(
    'list_globs',
    {
      description: 'Globs on a board (ID, title, status), optionally filtered.',
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
      description:
        "Change a glob's title, type (changing it to sub or super needs a board admin; to same is open to anyone who can edit the glob), category, group, environment, `after` (the globs it waits for to merge; only before it has started; a sub changed from a same waits for them) or `relations` (added or changed, any gate; they never remove one: use dismiss_relation). Pass the version you read. The spec (plan.md) is not a field: edit it with save_plan.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        title: z.string().optional(),
        type: z.enum(SLOP_TYPES).optional(),
        category: z.enum(WORK_CATEGORIES).optional(),
        group: z.string().nullable().optional(),
        environment: z.string().nullable().optional(),
        needs: z.array(z.string().min(1)).max(20).optional().describe('IDs of globs this one needs merged before it starts (alias: `after`)'),
        after: z.array(z.string().min(1)).max(20).optional().describe('Alias of `needs`'),
        relations: z.array(relationInputSchema).max(60).optional().describe(RELATIONS_HELP),
      },
    },
    async ({ id, version, needs, relations, ...changes }) => {
      const merged = needs === undefined && changes.after === undefined ? changes : { ...changes, after: [...new Set([...(needs ?? []), ...(changes.after ?? [])])] };
      const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
      const stated = relations === undefined ? {} : { relations: relationInputs(relations), relationsBy: 'agent' as const };
      return reply(await globs.update(email, id, version, { ...clean, ...stated }), (g) => globView(g));
    },
  );

  server.registerTool(
    'add_relation',
    {
      description:
        "Add one relation to a glob. Give `to` (this glob can't pass `gate` until `to` reaches `until`; pass the version you read) or `holdsBack` (a decision glob, or any glob, holds that other glob back until this one reaches `until`; no version). " +
        RELATIONS_HELP +
        " Refused: the same glob, another board's glob, a cycle, a 21st relation for one gate, `decided` for a glob that is not a decision, and a decision glob as the one held back. A dismissed relation to the same glob and gate is replaced. Answers with the glob's view (`relations`).",
      inputSchema: {
        id: z.string(),
        version: z.number().int().optional().describe('The version you read: required with `to`'),
        to: z.string().min(1).optional().describe('The glob or decision this glob waits for'),
        holdsBack: z.string().min(1).optional().describe('A glob that waits for this one (this glob is a decision or any glob it must reach `until` first)'),
        gate: relationInputSchema.shape.gate,
        until: relationInputSchema.shape.until,
        reason: relationInputSchema.shape.reason,
      },
    },
    async ({ id, ...rest }) => {
      const parsed = addRelationSchema.safeParse(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
      if (!parsed.success) return { ...json({ code: 'invalid_input', message: parsed.error.issues.map((i) => i.message).join('; ') }), isError: true };
      const { to, holdsBack, version, ...fields } = parsed.data;
      const added = await globs.addRelation(email, id, version ?? null, relationInput({ ...fields, to: to ?? holdsBack ?? '' }), to === undefined ? 'holds_back' : 'held_by', 'agent');
      if (added.ok) await deps.outbox.drain(added.value.id);
      return added.ok ? reply(await globs.get(email, id), (v) => globViewOf(v)) : reply(added);
    },
  );

  server.registerTool(
    'dismiss_relation',
    {
      description:
        "Say a relation of this glob is not a dependency (the relation's `relationId` is in `get_glob`'s `relations.holding`). It stops holding: a glob held in Planning for it starts, a merge held for it goes on. Slop remembers a dismissal of an inferred relation until the plan changes. Pass the version you read.",
      inputSchema: { id: z.string(), version: z.number().int(), relationId: z.string().min(1) },
    },
    async ({ id, version, relationId }) => {
      const result = await globs.dismissRelation(email, id, version, relationId);
      if (result.ok) await deps.outbox.drain(result.value.id);
      return result.ok ? reply(await globs.get(email, id), (v) => globViewOf(v)) : reply(result);
    },
  );

  server.registerTool(
    'start_glob',
    {
      description:
        "Start a same's routine run (planning → implementing). Refused while the glob waits for globs named in `after` or a merge-policy hold; pass `anyway` to start it before they merge (a sub held in Planning can only be started this way). An oversized flag never holds a glob: start it as usual. Also hands a glob a person picked up, with no routine run, to a routine.",
      inputSchema: { id: z.string(), version: z.number().int(), anyway: z.boolean().optional() },
    },
    async ({ id, version, anyway }) => {
      const result = anyway === true ? await globs.startAnyway(email, id, version) : await globs.start(email, id, version);
      if (result.ok) await deps.outbox.drain(id);
      return reply(result, (g) => globView(g));
    },
  );

  server.registerTool(
    'investigate_glob',
    {
      description:
        "Investigate a sub or same in Planning: fires a routine run that does the orchestrator's Phases 1–2 only (investigator, no implementation) and pushes the investigation artifact, without a branch or commits. The glob stays in Planning. When the glob later starts, the orchestrator reuses the investigation if its plan hash matches and the base has moved little in its relevant files, otherwise it re-investigates and supersedes it. Refused with run_active while a run is live.",
      inputSchema: { id: z.string(), version: z.number().int() },
    },
    async ({ id, version }) => {
      const result = await globs.investigate(email, id, version);
      if (result.ok) await deps.outbox.drain(id);
      return reply(result, (g) => globView(g));
    },
  );

  server.registerTool(
    'review_now',
    {
      description:
        "Queue a fresh independent review of a glob that has a PR and is in Doing or Reviewing, as the glob's Review now button does. It always runs (an earlier review of the same commit doesn't stop it): an open PR is reviewed as it would land on the latest base branch, a merged one as its squash commit. The result is stored as the glob's independent_review artifact and posted on the PR (a GitHub review before merge, a PR comment after); it never blocks merging. Returns at once; the review follows in a few minutes.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const result = await globs.reviewNow(email, id);
      // Not awaited: the review is minutes of model calls.
      if (result.ok) void deps.outbox.drain(id).catch(() => undefined);
      return reply(result, (g) => globView(g));
    },
  );

  server.registerTool(
    'pick_up',
    {
      description:
        'Become the glob\'s human implementer, optionally choosing its environment (one of the board\'s that allows branch deploys; leave it out to keep the current one). A queued or standby run is superseded without a flag; an active run is refused with run_active unless takeOver is set. QA and PO members can only pick up subs.',
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        takeOver: z.boolean().optional(),
        environment: z.string().min(1).optional().describe("The environment this glob's branch deploys to"),
      },
    },
    async ({ id, version, takeOver, environment }) => {
      const result = await globs.pickUpWithWarning(email, id, version, takeOver ?? false, environment);
      // Run the jobs it queued (a super's provisioning) now, as the REST action does.
      if (result.ok) await deps.outbox.drain(id);
      // A glob still waiting for another to merge can be picked up; the warning names what its branch lacks.
      return reply(result, ({ glob, warning }) => ({ ...globView(glob), ...(warning === null ? {} : { warnings: [warning] }) }));
    },
  );

  server.registerTool(
    'mark_ready',
    {
      description:
        "Mark the glob's draft PR ready for review when the work is pushed. slop does it through its GitHub App; the glob moves to pr_open when GitHub confirms. Routines pass their run ID. Refused, with the files, while the branch conflicts with its base: merge the base, resolve, run the checks, push and call it again. A branch only behind its base is marked, with a warning to merge it.",
      inputSchema: { id: z.string(), runId: z.string().optional() },
    },
    async ({ id, runId }) => {
      if (runId !== undefined) await globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      const gate = await deps.readyGate(email, id);
      if (!gate.ok) return reply(gate);
      const result = await globs.requestReady(email, id, runId ?? null);
      if (result.ok) await deps.outbox.drain(id);
      return reply(result, (g) => ({
        id: g.id,
        status: g.status,
        pr: g.pr,
        note: 'The PR is being marked ready; the glob moves to pr_open when GitHub confirms.',
        ...(gate.value.warning !== undefined && { warning: gate.value.warning }),
      }));
    },
  );

  server.registerTool(
    'merge',
    {
      description:
        "Merge a same or super whose PR is ready, as the glob's Merge button does. With the required checks passed on the head it merges now; with them still pending it arms \"merge when checks pass\" (slop merges when they pass, and disarms if they fail or the PR conflicts). Merging: slop updates the branch, waits for checks on the new head and squash-merges through its GitHub App. The glob moves to merging, then to reviewing when the merge is observed. With continue (supers, latest implementation record at the head), it is Merge and continue: the glob returns to in_progress on the same branch, and its next push opens a fresh draft PR. Also Retry merge: on a failed glob whose merge failed without a conflict (e.g. \"GitHub hasn't decided whether the PR can merge\"), it asks slop to merge again. Pass the version you read.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        continue: z.boolean().optional().describe('Supers: Merge and continue (a checkpoint merge; the glob stays in Doing)'),
      },
    },
    async ({ id, version, continue: continueAfter }) => {
      // A failed merge (GitHub hadn't decided mergeability) is retried by the same tool: Retry merge on the board.
      const before = await globs.get(email, id);
      const retry = before.ok && before.value.glob.status === 'failed' && before.value.glob.failure?.kind === 'merge';
      const gate = retry ? undefined : await deps.mergeGate?.(email, id);
      if (gate !== undefined && !gate.ok) return reply(gate);
      const result = retry ? await globs.retryMerge(email, id, version) : await globs.merge(email, id, version, continueAfter ?? false);
      if (!result.ok) return reply(result);
      // Run the squash_merge job now and answer with the glob as it then is, as the REST action does.
      await deps.outbox.drain(id);
      return reply(await globs.get(email, id), (v) => globView(v.glob, v.allowedActions, v.artifacts));
    },
  );

  /** Approve and reopen are sign-off decisions, made on the board, not through MCP. */
  const MCP_LABEL_COMMAND_KINDS = ['submit_items', 'save_draft_item', 'remove_draft_item', 'send_items', 'tick', 'resubmit'] as const;

  server.registerTool(
    'review_label',
    {
      description:
        "Work on a merged glob's sign-off label (FR, CR or QA) and its review checklist. Reviewer: submit_items (items: one or more texts; label required → added), or keep unsent drafts with save_draft_item (text, itemId to edit a draft) and remove_draft_item (itemId), then send_items (drafts → items; required → added). Developer: tick (itemId, done) while items are added, or resubmit (added → required, items and ticks kept). Approving and re-opening a review are human decisions made on the board, so this tool refuses them. Pass the version you read.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        label: z.enum(LABEL_NAMES),
        kind: z.enum(MCP_LABEL_COMMAND_KINDS),
        items: z.array(z.string()).optional().describe('submit_items: the items to add'),
        text: z.string().optional().describe('save_draft_item: the draft text'),
        itemId: z.string().optional().describe('tick, remove_draft_item, save_draft_item (edit): the item'),
        done: z.boolean().optional().describe('tick: true to tick, false to untick'),
      },
    },
    async ({ id, version, label, ...input }) => {
      // Sign-off stays human (like merging): slop can't tell an agent from its developer over MCP.
      const command = parseLabelCommand(input);
      if (command === null) {
        return reply(invalidInput('submit_items needs items; save_draft_item needs text; remove_draft_item needs itemId; tick needs itemId and done'));
      }
      return reply(await globs.reviewLabel(email, id, version, label, command), (g) => globView(g));
    },
  );

  server.registerTool(
    'report_failure',
    {
      description:
        "Report that the glob cannot be finished. Routines pass their run ID; pass the agent-set version from .claude/slop-agent-set.json. Pass kind: 'needs_pairing' (with the decision you would have had to guess) when the work needs a person's decision, not more effort: the card then offers to pick it up as a super and slop does not retry the run.",
      inputSchema: {
        id: z.string(),
        reason: z.string().min(1),
        runId: z.string().optional(),
        agentSetVersion: z.number().int().nonnegative().optional(),
        kind: z.enum(['needs_pairing']).optional().describe('needs_pairing: a person must decide something before this can be done'),
        decision: z.string().optional().describe('needs_pairing: the decision you would have had to guess, in a sentence or two'),
      },
    },
    async ({ id, reason, runId, agentSetVersion, kind, decision }) =>
      reply(
        await globs.reportFailure(email, id, reason, runId ?? null, agentSetVersion ?? null, kind === undefined ? undefined : { kind, decision: decision ?? null }),
        (g) => globView(g),
      ),
  );

  server.registerTool(
    'escalate_to_same',
    {
      description:
        "Flag a running sub as needing a human: it becomes a same in place (same branch and PR, no auto-merge) with the reason shown on its card, and the owner is told. Only for a concrete reason: a product or design decision the plan didn't settle, a board risk area, a rewrite of existing data, auth/permissions/secrets changes, weakened or deleted tests, changed agent instructions, scope well beyond the plan, or in-scope review findings still open after the allowed rounds. Otherwise let the sub merge. Routines pass their run ID (a superseded run's call is ignored). A person can set its type back to sub.",
      inputSchema: {
        id: z.string(),
        reason: z.string().min(1).describe('What a human should check, in one or two sentences'),
        criterion: z
          .enum(ESCALATION_CRITERIA.filter((c) => c !== 'size') as unknown as [Exclude<(typeof ESCALATION_CRITERIA)[number], 'size'>, ...Exclude<(typeof ESCALATION_CRITERIA)[number], 'size'>[]])
          .optional()
          .describe('Which criterion it is for, so slop can learn from the outcome; `other` when none fits'),
        evidence: z.string().optional().describe('What showed it: files, review findings, the unsettled choice'),
        runId: z.string().optional(),
      },
    },
    async ({ id, reason, evidence, criterion, runId }) =>
      reply(
        await globs.escalateToSame(email, id, { reason, evidence: evidence ?? null, criterion: criterion ?? null, runId: runId ?? null }),
        (g) => globView(g),
      ),
  );

  // ---------------------------------------------------------------------------
  // Knowledge and context (slice 3)

  const { knowledge, artifacts } = deps;

  server.registerTool(
    'get_agent_set',
    {
      description:
        "The board's agent set (agent definitions, commands, hooks, settings, the .mcp.json entry and the CLAUDE.md section) with its version, and beside it the board's local-run spec (localRun: { build?, launch } or null; outside the version), which sstor init writes to .sstor/local-run.json. With download: true, returns a link valid for 5 minutes instead of the files (sstor init fetches it with curl).",
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
          localRun: set.localRun,
          ...(set.localRunProblem === null ? {} : { localRunProblem: set.localRunProblem }),
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
    'get_review_guide',
    {
      description:
        "The review guide for a repo: the documents with area `review_guide` on each slop board for that repo you are a member of, in full. A reviewer reads it before reviewing a PR. An empty list means the repo's boards have no review guide.",
      inputSchema: { repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe('owner/name') },
    },
    async ({ repo }) =>
      reply(await knowledge.reviewGuides(email, repo), (guides) =>
        guides.map((g) => ({
          board: g.boardId,
          boardName: g.boardName,
          documents: g.documents.map(({ name, description, version, content }) => ({ name, description, version, content })),
        })),
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
    'list_kb_items',
    {
      description:
        "Admins only: the board's knowledge-base proposals (open by default; or approved, rejected, merged, suppressed, covered). Each gives its id and version (pass both to decide_kb_item), type, statement, evidence, target (kind, name, section), draft (section, content), a preview of what approving would change, processing state and error, and the flags: contradicts, possiblyCoveredBy, staleSince and duplicateOf. Approved and rejected ones show who decided and, in outcome.via, 'agent' when an agent did. By default each item is compact: long evidence, draft and document text is clipped (with its full length alongside), the extra evidence is a count, and there is no preview. Pass `detail: 'full'` with an `id` for one item whole (the preview included); `detail: 'full'` without an id lists every item whole, previews included, which can run to 100–200 KB.",
      inputSchema: {
        board: z.number().int(),
        status: z.enum(KB_ITEM_STATUSES).optional().describe('Defaults to open'),
        detail: z.enum(['compact', 'full']).optional().describe("Defaults to compact"),
        id: z.string().optional().describe('Only this item'),
      },
    },
    async ({ board, status, detail, id }) => {
      const full = detail === 'full';
      const result = await knowledge.listItems(email, board, status, { preview: full });
      return reply(result, (items) => {
        const wanted = id === undefined ? items : items.filter((i) => i.id === id);
        return full ? wanted : wanted.map((i) => compactKbItem(i as unknown as Record<string, unknown>));
      });
    },
  );

  server.registerTool(
    'decide_kb_item',
    {
      description:
        "Admins only: approve a KB item as drafted or with an edited draft, or reject it with a reason (required), recorded as you with outcome.via 'agent'. The item is its decision glob (same ID), so approving moves that glob to Reviewing and rejecting signs it off, archived. Same checks as the Knowledge page's buttons; pass the version you read from list_kb_items. editedDraft is the full section (or value) to apply in place of the draft: it is validated and checked against the version the draft was made against, and the change is written as a new knowledge version (agent-set files bump the agent-set version). Always refused for approval, whatever the board's setting: the local-run spec, the merge policy and a whole-document proposal (a person approves them on the Knowledge page; rejecting is allowed). Agent-set files (agent, command, hook, settings, mcp, claude_md) and items with contradicts flags are refused too unless the board's agentKbApproval setting is docs_and_agent_files (an admin sets it under Knowledge in board settings); a contradicting item then needs a reason, recorded with the decision. A person can reopen any agent decision on the Knowledge page, which reverts its change.",
      inputSchema: {
        id: z.string().describe('KB item id, e.g. s1k3'),
        version: z.number().int(),
        decision: z.enum(['approve', 'reject']),
        reason: z.string().max(4000).optional().describe('Required to reject, and to approve a contradicting item (why the contradiction is intended or resolved)'),
        editedDraft: z.string().max(200_000).optional().describe('Approve only: the full section or value to apply instead of the drafted one'),
      },
    },
    async ({ id, version, decision, reason, editedDraft }) =>
      reply(await knowledge.decideByAgent(email, id, version, decision, { reason, editedDraft })),
  );

  server.registerTool(
    'suggest_decision',
    {
      description:
        "Admins and POs: ask for Suggest on a decision glob (a KB item or any decision). One on-demand model call reads the learning, its draft, the target section, the other open learnings on the same file, the changes merged since and recent outcomes, and recommends approve, approve_with_edit (with the full edited section), merge_into (another open learning, with the combined section) or reject, with reasons. Returns at once; the result follows in under a minute as the glob's `assessment` artifact labelled `suggestion` (read it with get_artifact kind assessment, label suggestion). The result here is the latest suggestion so far, whether the draft or target moved since it was made (`stale`) and whether a new one is queued. Nothing is decided: apply it with decide_kb_item or the board.",
      inputSchema: { id: z.string().describe('Decision glob ID, e.g. s1k3') },
    },
    async ({ id }) => {
      if (deps.suggest === undefined) return reply(notFound('Suggest is not available on this server'));
      const queued = await deps.suggest.request(email, id);
      if (!queued.ok) return reply(queued);
      return reply(await deps.suggest.view(email, id), (view) => ({ queued: true, ...view }));
    },
  );

  server.registerTool(
    'submit_learning',
    {
      description:
        "Submit one learning from a run (orchestrator phase 6, /finalise) as a KB item for the board's admins to review; nothing changes the knowledge base until it is approved. Returns its ID (s1k3) and `globId` (the same: the item is a decision glob in Planning, under its own ID) straight away; slop then routes it to a document or agent file, deduplicates it against other items and drafts the change in the background. Pass the agent-set version from .claude/slop-agent-set.json; routines pass their run ID. /kb-bootstrap proposes a whole new document with `document`; approving it creates or updates that document.",
      inputSchema: {
        board: z.number().int(),
        sourceGlobId: z
          .string()
          .min(1)
          .optional()
          .describe('The glob the learning came from; required unless a document is proposed'),
        type: z
          .enum(LEARNING_TYPES)
          .describe("gotcha, pattern, or agent-behaviour (something an instruction would have prevented). Choices are not learnings: record them in your implementation record's ## Decisions"),
        statement: z.string().min(1).describe('The learning, as one rule or fact'),
        evidence: z.string().min(1).describe('What showed it: files, review findings, failures, a developer correction'),
        suggestedTarget: z
          .string()
          .optional()
          .describe('Where it belongs: a document, area or agent definition, "local-run" for how sessions build and launch the local servers, or "merge-policy" for which paths clash between globs (exclusivePaths), which are left out when a sub is sized (sizeIgnoredPaths), which need a rollout after merging (rolloutPaths) and the check a sub waits for (subGateCheck)'),
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
        "The glob's context bundle: its fields (`attributes` on a decision glob), `payload` (the same text as plan.md), `scopedDecisions` (accepted decisions that govern this glob: its scope, statement and outcome), plan.md and the implementation record in full, Clarifications and Assumptions attachments in full, a listing of the other artifacts (kind, label, version, commitSha, size, description), the board's repo and base branch, `inbox` (pasted meeting notes, threads and documents a person attached to this glob, with their summary and text cut at 12000 characters; `truncated` says it was cut: search_text finds the rest), `decisions` (the choices taken on this glob, current first, each with its source link; a replaced one says what replaced it and when; the field keeps its old name), `authority` (which source wins when they disagree: merged code and the implementation record, then current choices newest first, then plan.md, then older discussion; replaced choices are history), and `related`: up to 5 cited search results for the glob's title and plan (what the board already knows, current choices first, replaced ones labelled; the glob's own items left out). `size` (when intake's size check judged the glob): `oversized` (advice, not a hold), its reasons and evidence, `decision` (`split` when its scope was cut) and the proposed workstreams (name, goal, files, plan share and `needs` as earlier workstream indexes: parallel work inside this glob's one run and PR). `size.forecast` (when made) is the predicted footprint: expected files and modules, a lines range, parts with their file sets, risk areas, confidence, the reference class of similar past globs and the calibration applied; it is a prediction to confirm or correct while investigating, not a fact. `hotspots` lists the board's conflict hotspots among the files the glob plans to change (its investigation's or plan.md's paths) or conflicted on: path, conflicts, globs, real conflicts, last conflict time and the window in days; empty when none. `handover` is the hand-over brief (why a person is needed, what to do first), null when nothing is wrong. Pass `include` to get more in full: 'local_review', 'attachment:<label>', or 'all'.",
      inputSchema: { id: z.string(), runId: z.string().optional(), include: z.array(z.string()).optional() },
    },
    async ({ id, runId, include }) => {
      if (runId !== undefined) await deps.globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      const context = await artifacts.context(email, id, include ?? []);
      if (!context.ok || deps.attachments === undefined) return reply(context);
      // A stored file comes with a fresh download link (about 15 minutes), so an agent can fetch it with curl.
      const attachments = deps.attachments;
      const files = await Promise.all(
        context.value.files.map(async (f) => {
          if (f.state !== 'stored') return f;
          const link = await attachments.downloadUrl(email, id, f.label);
          return link.ok ? { ...f, downloadUrl: link.value.url, downloadExpiresAt: link.value.expiresAt } : f;
        }),
      );
      return reply(context, (c) => ({ ...c, files }));
    },
  );

  const searchFields = {
    board: z.number().int().describe('Board ID (the number in a glob ID: s1t4 is on board 1)'),
    mode: z
      .enum(SEARCH_MODES)
      .optional()
      .describe("'current' (default) favours recent, active material; 'all_time' ranks history on relevance and authority alone"),
    from: z.string().refine(isDate, 'Use an ISO date, e.g. 2026-09-01').optional().describe('Only items dated on or after this ISO date'),
    to: z.string().refine(isDate, 'Use an ISO date, e.g. 2026-09-30').optional().describe('Only items dated on or before this ISO date'),
    glob: z.string().optional().describe('Only items linked to this glob ID'),
    group: z.string().optional().describe('Only items from globs in this group'),
  };
  const sourceTypes = z
    .array(z.enum(SOURCE_TYPES))
    .optional()
    .describe('Only these kinds of source (glob_plan, implementation_plan, local_review, kb_doc, learning, decision (a choice; the wire name is kept), ...)');

  server.registerTool(
    'search_text',
    {
      description:
        "Keyword search over the board's plans, implementation records, reviews, knowledge, learnings and choices: exact words, names, identifiers and file paths. Returns at most 10 cited chunks (source, date, title, link, glob), best first, a current choice ahead of the older ones it replaced; replaced or legacy items are labelled (`replaced by \"<title>\" on <date>`). In current mode replaced choices rank last; all_time mode shows both. The board's search index; member of the board required.",
      inputSchema: { ...searchFields, query: z.string().min(1).max(MAX_QUERY_LENGTH), sourceTypes },
    },
    async (p) => reply(await deps.search.text(email, toRequest(p))),
  );

  server.registerTool(
    'search_semantic',
    {
      description:
        "Search the board's material by meaning, for when you don't know the words used: the nearest chunks to the question, cited and labelled like search_text. Fails with llm_unavailable while the embedding model can't be reached; use search_text then.",
      inputSchema: { ...searchFields, query: z.string().min(1).max(MAX_QUERY_LENGTH), sourceTypes },
    },
    async (p) => reply(await deps.search.semantic(email, toRequest(p))),
  );

  server.registerTool(
    'ask_board',
    {
      description:
        "Ask a question about the board in plain words (e.g. \"why did we decide X?\") and get an answer written from the board's own records and slop's help, with `citations` (source, title, date, link, glob, status; a replaced choice names what replaced it; slop's own help is the source \"Slop help\"). `answered` is false when the answer cites nothing: then `answer` says what was searched, and when the model still had something to say it is returned in `uncitedAnswer`, which is NOT from the records (treat it as a general best guess, never as a board fact). Current material is preferred; pass `globId` to scope it to one glob. One-off: nothing is added to the person's chat panel. Fails with llm_unavailable while the chat model is busy or down; use search_text then. Member of the board required.",
      inputSchema: {
        board: searchFields.board,
        question: z.string().min(1).max(MAX_QUERY_LENGTH),
        globId: z.string().optional().describe('Only records linked to this glob ID'),
      },
    },
    async ({ board, question, globId }) =>
      reply(await deps.chat.answer(email, { boardId: board, question, ...(globId === undefined ? {} : { globId }) })),
  );

  server.registerTool(
    'search_changes',
    {
      description:
        "Merged changes with the reason each was made, newest first, cited. Give `query` (words from the change or its summary) or `path` (a file path the change touched); `from`/`to` limit by merge date.",
      inputSchema: {
        board: searchFields.board,
        query: z.string().min(1).max(MAX_QUERY_LENGTH).optional(),
        path: z.string().min(1).max(MAX_QUERY_LENGTH).optional(),
        from: searchFields.from,
        to: searchFields.to,
        glob: searchFields.glob,
        group: searchFields.group,
      },
    },
    async ({ query, path, ...rest }) => {
      const text = query ?? path;
      if (text === undefined) return reply(invalidInput('Give query or path'));
      return reply(await deps.search.changes(email, toRequest({ ...rest, query: text })));
    },
  );

  const codeBoard = z.number().int().describe('Board ID (the number in a glob ID: s1t4 is on board 1)');
  const codeRef = z
    .string()
    .optional()
    .describe("A branch, tag, commit or pull request ref (e.g. a glob's branch, or refs/pull/190/head); default: the board's base branch");

  server.registerTool(
    'search_code',
    {
      description:
        "Search the board's repository with a regular expression (git grep -E), on the base branch or any ref, optionally under some paths: path, line and text of each match, at most `limit` (default 50, max 200). Read-only: nothing is run. Member of the board required.",
      inputSchema: {
        board: codeBoard,
        pattern: z.string().min(1).max(200),
        ref: codeRef,
        paths: z.array(z.string()).max(20).optional().describe('Only under these files or folders (repo-relative)'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (p) => reply(await deps.code.grep(email, { ...p, consumer: 'mcp' })),
  );

  server.registerTool(
    'read_file',
    {
      description:
        "A file of the board's repository on the base branch or any ref, with line numbers by `start`/`end` (at most 2000 lines and 100,000 characters per call; `truncated` says it was cut). Read-only. Member of the board required.",
      inputSchema: {
        board: codeBoard,
        path: z.string().min(1).describe('Repo-relative file path'),
        ref: codeRef,
        start: z.number().int().min(1).optional().describe('First line (1-based)'),
        end: z.number().int().min(1).optional().describe('Last line'),
      },
    },
    async (p) => reply(await deps.code.read(email, { ...p, consumer: 'mcp' })),
  );

  server.registerTool(
    'list_dir',
    {
      description: "The files and folders directly in a directory of the board's repository ('' or omitted is the root) on the base branch or any ref. Read-only. Member of the board required.",
      inputSchema: { board: codeBoard, path: z.string().optional().describe('Repo-relative folder; empty for the root'), ref: codeRef },
    },
    async (p) => reply(await deps.code.tree(email, { ...p, consumer: 'mcp' })),
  );

  server.registerTool(
    'path_history',
    {
      description:
        "The newest commits on the base branch that changed a file or anything under a folder (sha, subject, date, the glob it came from, and that merged change's summary title and link when slop has one). Member of the board required.",
      inputSchema: { board: codeBoard, path: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
    },
    async (p) => reply(await deps.code.history(email, { ...p, consumer: 'mcp' })),
  );

  server.registerTool(
    'imports',
    {
      description:
        "The import graph of the board's base branch: the files `path` imports (direction 'imports', the default) or the files that import it ('importedBy'), each with its module. Covers relative TypeScript/JavaScript imports and Python imports that resolve inside the repository. Member of the board required.",
      inputSchema: { board: codeBoard, path: z.string().min(1), direction: z.enum(['imports', 'importedBy']).optional() },
    },
    async (p) => reply(await deps.code.imports(email, { ...p, consumer: 'mcp' })),
  );

  server.registerTool(
    'touched_modules',
    {
      description:
        "For a set of paths (e.g. the files a change touches): the modules they belong to, and for each the files outside the set that import it (importers, fanIn), on the base branch's import graph. Member of the board required.",
      inputSchema: { board: codeBoard, paths: z.array(z.string().min(1)).min(1).max(100) },
    },
    async (p) => reply(await deps.code.touchedModules(email, { ...p, consumer: 'mcp' })),
  );

  server.registerTool(
    'get_artifact',
    {
      description:
        "The latest version of one artifact of a glob in full: kind is 'implementation_plan' (the implementation record), 'local_review', 'independent_review' (the independent reviewer's findings) or 'attachment' (with its label; a stored file comes with a fresh `downloadUrl`: fetch it with curl).",
      inputSchema: { id: z.string(), kind: z.enum(ARTIFACT_KINDS), label: z.string().optional() },
    },
    async ({ id, kind, label }) => {
      const found = await artifacts.artifact(email, id, kind, label ?? '');
      if (!found.ok || found.value.file?.state !== 'stored' || deps.attachments === undefined) return reply(found);
      const link = await deps.attachments.downloadUrl(email, id, found.value.label);
      return reply(found, (a) => (link.ok ? { ...a, downloadUrl: link.value.url, downloadExpiresAt: link.value.expiresAt } : a));
    },
  );

  server.registerTool(
    'get_plan',
    {
      description: 'plan.md for a glob, optionally a given version, with its version history.',
      inputSchema: { id: z.string(), version: z.number().int().optional() },
    },
    async ({ id, version }) => reply(await artifacts.plan(email, id, version ?? null)),
  );

  server.registerTool(
    'attachment_upload_url',
    {
      description: `An upload link for a file on an existing glob: the reply has the upload url, fields and a ready curl command (fill in <path>). ${NEVER_INLINE_FILES} Slop detects the upload from storage; there is no completion call. A label that already holds a file that never arrived is filled again. Member of the board required.`,
      inputSchema: {
        id: z.string(),
        fileName: z.string().min(1).max(255),
        contentType: z.string().max(200).optional(),
        label: z.string().min(1).max(200).optional().describe('Defaults to the file name'),
      },
    },
    async ({ id, ...file }) => {
      if (deps.attachments === undefined) return { ...json({ code: 'invalid_input', message: 'File attachments are not set up on this slop' }), isError: true };
      return reply(await deps.attachments.createUpload(email, id, file), (made) => ({ uploads: [uploadView(made)], next: UPLOAD_NEXT }));
    },
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

  const stepView = (step: StoredHumanStep) => ({
    id: step.id,
    kind: step.kind,
    title: step.title,
    detail: step.detail,
    who: step.who,
    due: step.due,
    state: step.state,
    blocks: step.blocks,
    check: step.check,
    script: step.script,
    doneBy: step.doneBy,
    doneAt: step.doneAt,
    dismissedReason: step.dismissedReason,
  });

  server.registerTool(
    'add_human_step',
    {
      description:
        "Add a step only a person can do to a glob (a rollout, a setting, a manual task). A rollout step (the default kind) falls due after the merge and holds back the glob's sign-off and the globs that need it, until it is ticked or dismissed. `who`: implementer, admin, po, qa, anyone or an email. `due`: now, after_merge or after_deploy:<env>. `script`: {artifact: label} or {path: repo path}. Members only; pass the glob version you read to have it checked. Agents never run steps that change paid infrastructure or IAM: write them here for a person.",
      inputSchema: {
        id: z.string(),
        version: z.number().int().optional(),
        title: z.string().min(1).describe('Short: the action ("Roll out the host stack")'),
        kind: z.enum(HUMAN_STEP_KINDS).optional(),
        detail: z.string().optional().describe('Markdown, when the title is not enough'),
        who: z.string().optional(),
        due: z.string().optional(),
        blocks: z.array(z.enum(HUMAN_STEP_BLOCKS)).optional(),
        check: z.string().optional().describe('A capability slop can verify'),
        script: z.union([z.object({ artifact: z.string() }), z.object({ path: z.string() })]).optional(),
      },
    },
    async ({ id, version, ...step }) =>
      reply(await globs.addHumanStep(email, id, version ?? null, step as NewHumanStep, 'agent'), stepView),
  );

  server.registerTool(
    'complete_human_step',
    {
      description:
        "Tick a step on a glob as done (records who and when). When it was the last one holding back sign-off and the glob's labels are approved, the glob moves to Signed off; globs that waited for its rollout are released. Members only.",
      inputSchema: { id: z.string(), stepId: z.string(), version: z.number().int().optional() },
    },
    async ({ id, stepId, version }) => reply(await globs.completeHumanStep(email, id, stepId, version ?? null), stepView),
  );

  server.registerTool(
    'dismiss_human_step',
    {
      description: 'Dismiss a wrong step on a glob, with the reason. It stops holding anything back. Members only.',
      inputSchema: { id: z.string(), stepId: z.string(), reason: z.string().min(1), version: z.number().int().optional() },
    },
    async ({ id, stepId, reason, version }) => reply(await globs.dismissHumanStep(email, id, stepId, reason, version ?? null), stepView),
  );

  server.registerTool(
    'add_to_inbox',
    {
      description:
        "Put pasted text (meeting notes, a chat thread, a document) into a board's inbox. It is stored and searchable at once; slop then summarises it and suggests up to three globs, and a person attaches it to globs, keeps it or discards it in the board's Inbox. Pasting the same text again returns the existing item (`duplicate: true`). Member of the board required.",
      inputSchema: {
        board: z.number().int().describe('Board ID (the number in a glob ID: s1t4 is on board 1)'),
        text: z.string().min(1).max(100_000).describe('The text to file'),
        title: z.string().max(200).optional().describe('A title; slop writes one when omitted'),
        occurredAt: z.string().refine(isDate, 'Use an ISO date, e.g. 2026-09-01').optional().describe('When it happened (the meeting date); defaults to now'),
        sourceLabel: z.string().max(100).optional().describe('Where it came from, e.g. "Tuesday standup"'),
      },
    },
    async ({ board, text, title, occurredAt, sourceLabel }) =>
      reply(await deps.inbox.add(email, board, { text, title, sourceLabel, occurredAt: occurredAt === undefined ? undefined : (parseBound(occurredAt, 'from') ?? undefined) }), (r) => ({
        id: r.id,
        duplicate: !r.created,
      })),
  );

  server.registerTool(
    'save_plan',
    {
      description:
        "Save a new version of the glob's plan.md (its spec), as the editor in the glob view does. Pass the plan version you read (get_plan or get_context; 0 when none is saved yet); a stale version is refused with version_conflict.",
      inputSchema: { id: z.string(), version: z.number().int(), content: z.string().min(1) },
    },
    async ({ id, version, content }) =>
      reply(await artifacts.putPlan(email, id, content, version), (a) =>
        'ignored' in a ? a : { id: a.id, version: a.version },
      ),
  );

  server.registerTool(
    'put_artifact',
    {
      description:
        'Store the implementation record (kind implementation_plan; postplan is an alias that writes it), a local review or an investigation (the investigator\'s output ending in a fenced ```investigation JSON block; a block that does not validate is stored as text and the reply carries `validation`) as a new version. Routines pass their run ID (results from a superseded run are ignored); pass the agent-set version from .claude/slop-agent-set.json. With a local review, pass reviewStats (risk tier, review rounds run and allowed, tester FAIL → fix loops) when you know them.',
      inputSchema: {
        id: z.string(),
        kind: z.enum(['implementation_plan', 'postplan', 'local_review', 'investigation']),
        content: z.string().min(1),
        commitSha: z.string().optional(),
        runId: z.string().optional(),
        agentSetVersion: z.number().int().nonnegative().optional(),
        reviewStats: z
          .object({
            riskTier: z.enum(RISK_TIERS),
            reviewRounds: z.number().int().min(0).max(20),
            maxReviewRounds: z.number().int().min(0).max(20),
            testFailRounds: z.number().int().min(0).max(20),
          })
          .optional(),
      },
    },
    async ({ id, kind, content, commitSha, runId, agentSetVersion, reviewStats }) => {
      if (runId !== undefined) {
        // A routine's slop call is progress for its run (and marks a queued run active).
        await deps.globs.applyEvent(id, (g, ctx) => machine.runProgress(g, runId, ctx));
      }
      const stored = await artifacts.putArtifact(email, id, kind, content, {
        commitSha: commitSha ?? null,
        runId: runId ?? null,
        agentSetVersion: agentSetVersion ?? null,
        reviewStats: reviewStats ?? null,
      });
      // An investigate-only run ends with its investigation; one whose block didn't validate stays open for the fix.
      if (stored.ok && !('ignored' in stored.value) && kind === 'investigation' && runId !== undefined && stored.value.provenance.validation === undefined) {
        await globs.applyEvent(id, (g, ctx) => machine.investigationPushed(g, runId, ctx));
      }
      return reply(
        stored,
        (a) =>
          'ignored' in a
            ? a
            : { id: a.id, kind: a.kind, version: a.version, ...(a.provenance.validation === undefined ? {} : { validation: a.provenance.validation }) },
      );
    },
  );

  server.registerTool(
    'artifact_upload_url',
    {
      description:
        "A URL for uploading the implementation record (implementation_plan; postplan is an alias), a local review or an investigation from a file without putting its text in a tool call: `curl --data-binary @<file> '<url>'` (POST the file as the body; at most 1 MiB of UTF-8 text). It is single use, expires in 5 minutes and stores exactly like put_artifact with the fields given here. Prefer it to put_artifact for anything over a few KB; use `slop put-artifact --file` where the CLI is installed.",
      inputSchema: {
        id: z.string(),
        kind: z.enum(['implementation_plan', 'postplan', 'local_review', 'investigation']),
        commitSha: z.string().optional(),
        runId: z.string().optional(),
        agentSetVersion: z.number().int().nonnegative().optional(),
        reviewStats: z
          .object({
            riskTier: z.enum(RISK_TIERS),
            reviewRounds: z.number().int().min(0).max(20),
            maxReviewRounds: z.number().int().min(0).max(20),
            testFailRounds: z.number().int().min(0).max(20),
          })
          .optional(),
      },
    },
    async ({ id, kind, commitSha, runId, agentSetVersion, reviewStats }) => {
      // Only a member of the glob's board gets a link.
      const found = await globs.get(email, id);
      if (!found.ok) return reply(found);
      return json(
        issueUploadUrl(
          deps.links,
          origin,
          { id, kind, email, commitSha: commitSha ?? null, runId: runId ?? null, agentSetVersion: agentSetVersion ?? null, reviewStats: reviewStats ?? null },
          randomUUID(),
        ),
      );
    },
  );

  server.registerTool(
    'get_report',
    {
      description:
        "A board's monthly or yearly time report (% RnD vs maintenance per developer, counting only time on that board's globs), computed now from the event log: its board, period, kind, work time zone, when it was computed and the CSV (developer, period, RnD hours, maintenance hours, % RnD). A running period counts up to now. The board's admins only.",
      inputSchema: {
        board: z.number().int().describe('Board ID (the number in a glob ID: s1t4 is on board 1)'),
        period: z.string().describe('YYYY-MM for a month or YYYY for a year, in the work time zone'),
      },
    },
    async ({ board, period }) => reply(await deps.reports.report(email, board, period)),
  );

  return server;
};

export const mountMcp = (app: Hono<Env>, deps: McpDeps) => {
  const scopes = ['openid', 'email', 'profile', 'slop/mcp'];

  // Protected-resource discovery: points MCP clients at the authorization server.
  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({
      resource: `${requestOrigin(c, deps.publicUrl, deps.publicUrlAliases)}/mcp`,
      authorization_servers: [requestOrigin(c, deps.publicUrl, deps.publicUrlAliases)],
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
    app.get('/.well-known/oauth-authorization-server', (c) => c.json(metadata(requestOrigin(c, deps.publicUrl, deps.publicUrlAliases))));
    app.get('/.well-known/openid-configuration', (c) => c.json(metadata(requestOrigin(c, deps.publicUrl, deps.publicUrlAliases))));
  }

  app.all('/mcp', async (c) => {
    const header = c.req.header('authorization');
    const email = header?.startsWith('Bearer ') === true ? await deps.auth.bearerEmail(header.slice(7)) : null;
    if (email === null) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${requestOrigin(c, deps.publicUrl, deps.publicUrlAliases)}/.well-known/oauth-protected-resource"`,
      });
    }
    const server = buildServer(deps, email, requestOrigin(c, deps.publicUrl, deps.publicUrlAliases));
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
