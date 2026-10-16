import type { Relation, SlopType, ArtifactService, AttachmentService, BoardService, Deploy, IntakeRecord, DeployService, GlobService, InboxService, IntakeService, KnowledgeService, ReportService, Result, SearchService, ChatService, CodeViewService, SuggestService, GroupService, NewHumanStep, NewQuestion, StoredHumanStep } from '@slop/core';
import { cleanFileName, inferenceReasonOf, invalidInput, isHumanCategory, machine, notFound, openQuestions, relationQuestion, startIds, startQuestions, resolveContentType, UPLOAD_TTL_SECONDS } from '@slop/core';
import { ARTIFACT_KINDS, CATEGORIES, MAX_RELATION_REASON, MAX_QUESTION_ANSWER, MAX_QUESTION_NOTE, MAX_QUESTION_OPTION, MAX_QUESTION_OPTIONS, MAX_QUESTION_TEXT, OUTCOME_REASON_MAX, QUESTION_BLOCKING, QUESTION_SOURCES, WORK_CATEGORIES, ESCALATION_CRITERIA, MAX_SPLIT_PARTS, KB_ITEM_STATUSES, LABEL_NAMES, LEARNING_TYPES, MAX_QUERY_LENGTH, RISK_TIERS, SEARCH_MODES, SLOP_TYPES, SOURCE_TYPES, WORK_KINDS, STATUSES, HUMAN_STEP_BLOCKS, HUMAN_STEP_KINDS } from '@slop/core';
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
import { addRelationSchema, holdInputSchema, holdInputs, relationInput, relationInputs, relationInputSchema, supersedeInputSchema, supersedeInputs } from '../http/relation-schemas.js';
import { isDate, parseBound, toRequest } from '../search-request.js';
import { requestMetrics } from '../request-metrics.js';
import type { CreateKindFields } from '../http/views.js';
import { compactKbItem, compactSizeProposal, compactSuggestions, createKindFields, errorBody, globView, globViewOf, kindView, onBoard, resolveKind } from '../http/views.js';
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
  /** A board's groups (`get_group`). */
  readonly groups?: Pick<GroupService, 'view'>;
  /** Suggest on decision globs (`suggest_decision`). */
  readonly suggest?: Pick<SuggestService, 'request' | 'view'>;
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** What `relations` mean, for the tools that take them. */
const RELATIONS_HELP =
  "Relations beside `needs`/`after` (which stay as the shorthand for a start relation until merged): `[{to, gate?, until?, reason}]`. This glob can't pass `gate` until `to` reaches `until`. `gate`: `start` (the default: can't start), `merge` (can't be merged; an armed merge-when-green waits and goes on by itself) or `sign_off` (can't be signed off). `until`: `merged` (the default) means merged AND rolled out: a merged glob with rollout steps still due keeps the relation holding until they are done (`rolled_out` is accepted as another way to write it); `decided` (`to` is a decision glob whose outcome was accepted or rejected, not needs-work; the default when `to` is a decision) or `signed_off`. `to` is a glob or decision on this board or on another board you can view (a glob that waits for another machine or another board's rollout), not this glob, with no cycle across boards; at most 20 per gate. A `to` you cannot view answers `No glob X`. `reason` is required for agents: one line saying what this glob uses from `to` or why it must wait (a person in the web is only prompted); a relation without one is refused. Add one only when the work really can't go ahead without it: a glob that merely touches the same files is not a relation. Slop also adds relations itself from what a plan or record says (source `auto`, shown as added automatically); dismiss a wrong one with `dismiss_relation`.";

/** What `holds` mean, for `create_glob`. */
const HOLDS_HELP =
  "IDs of existing globs, on any board you can edit, that this new glob holds back: pass it whenever you create a glob because of another one (a fix for a failed rollout, a continuation of a merged glob, a change on slop's side that a rollout needs). Each is `{id, gate?, until?, reason}` (gate defaults to `sign_off`: the other glob can't be signed off until this one has merged and rolled out; `until` as for relations) or a bare ID that takes the shared `reason`. The relation is written on the existing glob, pointing at the new one, as source `agent`; it needs a reason (required for agents). It is added after the create commits: the reply's `holds` says per ID whether it was written; an invalid one (unknown, not editable, a cycle) creates nothing. Alias: `follows_up`.";

/** What `supersedes` mean, for the tools that take it. */
const SUPERSEDES_HELP =
  "IDs of globs this one replaces (`[{id, reason}]` or bare IDs that take the shared `reason`; reason required for agents). The row lands on the superseded glob: its due human steps are dismissed with \"superseded by <this>\", its card says \"superseded by <this>\" and its sign-off is no longer blocked by those steps. Closing or deleting it stays a person's call. Refused for a cycle (A supersedes B while B supersedes A). Dismiss it with `dismiss_relation` on the superseded glob; steps already dismissed stay dismissed.";

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

/**
 * What a create says about relations: the start relations stored (`after`), what the glob waits for and why (`waitingFor`), the
 * ones left out because their target holds nothing any more (`ignoredAfter`), how each `holds` and `supersedes` entry went, and
 * the note when a non-admin's untyped create became a same. Each only when there is something to say.
 */
const relationReply = (
  notes: { readonly ignoredAfter: readonly { id: string; why: string }[]; readonly holds: readonly { id: string; ok: boolean; why: string }[]; readonly supersedes: readonly { id: string; ok: boolean; why: string }[]; readonly typeNote: string | null },
  relations: readonly Relation[],
  waitingFor: readonly { readonly id: string; readonly state: string; readonly why: string }[],
) => ({
  ...(startIds(relations).length === 0 ? {} : { after: startIds(relations) }),
  ...(waitingFor.length === 0 ? {} : { waitingFor }),
  ...(notes.ignoredAfter.length === 0 ? {} : { ignoredAfter: notes.ignoredAfter }),
  ...(notes.holds.length === 0 ? {} : { holds: notes.holds }),
  ...(notes.supersedes.length === 0 ? {} : { supersedes: notes.supersedes }),
  ...(notes.typeNote === null ? {} : { typeNote: notes.typeNote }),
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
      description: "A board's settings: repo, base branch, environments, time zone, and its enabled integrations (integrations.deploy: how branch deploys run, or null; integrations.atf: how the ATF stage gets its spec list after a deploy, or null).",
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
        integrations: { deploy: b.deploy, atf: b.atf },
      })),
  );

  server.registerTool(
    'create_glob',
    {
      description:
        'Create a glob (a unit of work) on a board. Say who works on it with `actor` (`machine`: agents; `human`: a person) and how with `mode` (machine: `sub`, `same` or `super`; human: `action`); decision globs are created by slop from learnings, never here. Nobody picks a category: slop infers whether the work fixes something broken (`fix`) and whether its time counts as R&D or maintenance (`workKind`), and you may pass either to override it (a person\'s choice sticks). The old `type` and `category` (feature, task, bug) are still accepted as aliases for one release: `type` is the machine mode, `bug` means `fix`, `feature` means R&D (and is stored as a task: no new glob is a feature), `task` means maintenance. For something a person must do (rotate a token, protect a branch, set up a board, any work that is about another repo or board or is optional setup: if this glob were reverted the work would still be needed), create an action glob: `actor` human (`mode` action), a `title`, an optional `plan` (default: Why / Do this / Permissions / Check it worked; in Do this give the script path and the run command) and an optional `assignee`. An action has no type, intake, branch or run; it is open until a person marks it done (`complete_action`) or dismisses it (`dismiss_action`), and `needs`/`relations` on other globs may wait for it. An action whose script another open glob writes waits for that glob: pass `needs` (or a start `relations` entry, until merged, reason "builds its script") and a line `script: <repo path>` under Do this; it cannot be marked done until that glob has merged and the script is on the base branch. Pass the request as `input` and slop proposes the title, plan, mode, fix flag, work kind and group (intake); explicit fields win. Create it as a sub unless the request says same, it clearly needs a human decision before work starts, or it is clearly a big task (an oversized flag only advises and never holds a glob; a person can cut its scope into independent globs if each could ship alone); an explicit `mode` (or `type`) always wins. A create that is checked (no `mode`) may come back held in Planning with `questions` when slop is unsure of something material (the type, the environment, the scope): relay them to the person, who answers on the card or glob view; do not answer them yourself. Only board admins can create a sub or a super: if the person you work for is not an admin, create a same (leave `type` unset and slop makes it a same; an explicit sub or super is refused with `forbidden`) and an admin can change its type. A running sub the agents find needs a human is escalated to a same by `escalate_to_same`. Prerequisites: pass `needs`/`after` (globs this one waits for until they have merged and rolled out; a glob that merged but still has rollout steps due keeps holding it) with a `reason` (required for agents: one line, applied to every id), or `relations` for other gates. A sub with unmerged prerequisites waits in Planning with no run, whatever way it was created (with or without `type`); the reply says what it waits for (`waitingFor`), what was ignored (`ignoredAfter`: already merged and rolled out, deleted) and, when you are not an admin and left `type` unset, that it became a same (`typeNote`). `holds` (alias `follows_up`) and `supersedes` cover globs created because of another one. Returns its ID and branch once provisioned, with `after` (the stored start relations), `waitingFor`, `ignoredAfter`, `holds`, `supersedes` and `typeNote` where they apply. Pass an idempotency key so a retry never creates a second glob.',
      inputSchema: {
        board: z.number().int(),
        idempotencyKey: z.string().min(1),
        input: z.string().optional().describe('The request in free text; used for intake when no title is given'),
        title: z.string().min(1).optional(),
        plan: z
          .string()
          .optional()
          .describe('The full spec, stored verbatim as plan.md v1; without it plan.md v1 is the write-up intake makes of the input, else the title'),
        actor: z.enum(['machine', 'human']).optional().describe('Who works on it: machine (agents) or human (a person: an action). Default: machine'),
        mode: z.enum([...SLOP_TYPES, 'action']).optional().describe('How: sub (small, auto-merged), same (standard) or super (pairing) for a machine; action for a human. Sub and super are for board admins only; everyone else creates a same'),
        fix: z.boolean().optional().describe('Whether the work fixes something broken (the investigator reproduces first, a regression test is expected). Omitted: slop infers it from the request and plan'),
        workKind: z.enum(WORK_KINDS).optional().describe('rnd or maintenance, for the time report. Omitted: slop infers it'),
        type: z.enum(SLOP_TYPES).optional().describe('Alias of `mode` for a machine glob'),
        category: z.enum([...WORK_CATEGORIES, 'action']).optional().describe('Old alias: bug sets `fix`, feature means R&D (stored as a task), task means maintenance; action means actor human'),
        assignee: z.string().min(1).max(200).optional().describe('Action only: the email of the person meant to do it (default: anyone on the board)'),
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
          .describe('Ignored, kept for compatibility: a super always waits in Planning (no branch, run or implementer) until a person picks it up to pair'),
        needs: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe(
            'IDs of globs on this board (or another board you can view) whose code this glob needs (it uses what they add). It cannot start until they have merged and rolled out (a merged glob with rollout steps due still holds it): a sub waits in Planning, a same is refused Start until then. Alias: `after`. Needs `reason` (required for agents). Add one only when the code really is missing without it; a glob that merely touches the same files is not a need.',
          ),
        after: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe(
            'Alias of `needs`: IDs of globs to start after, meaning the glob waits for them to merge and roll out. A sub waits in Planning (no branch, no run) until they have all merged and rolled out, then starts by itself on the new main; a same is refused Start until then. Ones already merged and rolled out are ignored (listed in `ignoredAfter`); unknown ids and cycles are refused. Needs `reason` (required for agents). Use it instead of writing "start only after sXtY" in the plan',
          ),
        reason: z.string().min(1).max(MAX_RELATION_REASON).optional().describe('One line saying why this glob waits for each id in `needs`/`after` (and the shared reason of bare IDs in `holds`/`supersedes`). Required for agents: a `needs`/`after` without it is refused'),
        holds: z.array(holdInputSchema).max(20).optional().describe(HOLDS_HELP),
        follows_up: z.array(holdInputSchema).max(20).optional().describe('Alias of `holds`'),
        supersedes: z.array(supersedeInputSchema).max(20).optional().describe(SUPERSEDES_HELP),
        relations: z.array(relationInputSchema).max(60).optional().describe(RELATIONS_HELP),
      },
    },
    async (input) => {
      const kind = resolveKind(input, true);
      if (!kind.ok) return { ...json({ code: 'invalid_input', message: kind.message }), isError: true };
      const askedType = kind.type ?? undefined;
      // What the caller says about relations, shared by both creates: always stated by an agent (a reason is required).
      const heldBy = [...(input.holds ?? []), ...(input.follows_up ?? [])];
      const reason = input.reason?.trim();
      const relationFields = {
        ...(input.needs === undefined && input.after === undefined ? {} : { after: [...new Set([...(input.needs ?? []), ...(input.after ?? [])])] }),
        ...(reason === undefined || reason === '' ? {} : { afterReason: reason }),
        ...(input.relations === undefined ? {} : { relations: relationInputs(input.relations) }),
        ...(heldBy.length === 0 ? {} : { holds: holdInputs(heldBy, reason) }),
        ...(input.supersedes === undefined || input.supersedes.length === 0 ? {} : { supersedes: supersedeInputs(input.supersedes, reason) }),
        by: 'agent' as const,
      };
      if (kind.category === 'action') {
        const refused = (message: string) => ({ ...json({ code: 'invalid_input', message }), isError: true });
        if (input.title === undefined || input.title.trim() === '') return refused('An action needs a title');
        if (askedType !== undefined) return refused('An action has no type');
        if (input.environment !== undefined || input.start !== undefined || input.autoTrigger === true) return refused('An action has no environment, start or autoTrigger: nothing runs for it');
        if ((input.files ?? []).length > 0 || input.inboxItem !== undefined) return refused('An action takes no files or inbox item: put them in the plan or attach them afterwards');
        const made = await globs.createWithNotes(email, {
          boardId: input.board,
          title: input.title,
          type: null,
          category: 'action',
          group: input.group === undefined || input.group === null || input.group.trim() === '' ? null : input.group.trim(),
          environment: null,
          autoTrigger: false,
          ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
          ...(input.plan === undefined ? {} : { plan: input.plan }),
          planBy: 'sessionator',
          source: 'mcp',
          idempotencyKey: input.idempotencyKey,
          ...relationFields,
        });
        if (!made.ok) return reply(made);
        return reply(await globs.get(email, made.value.glob.id), ({ glob, relations, waitingFor }) => ({
          ...relationReply(made.value.notes, relations, waitingFor),
          id: glob.id,
          version: glob.version,
          status: glob.status,
          type: null,
          category: glob.category,
          ...kindView(glob),
          group: glob.group,
          assignee: made.value.glob.attributes !== undefined && 'assignee' in made.value.glob.attributes ? made.value.glob.attributes.assignee : null,
        }));
      }
      if (input.files !== undefined && input.files.length > 0) {
        if (deps.attachments === undefined) return { ...json({ code: 'invalid_input', message: 'File attachments are not set up on this slop' }), isError: true };
        for (const f of input.files) {
          if (cleanFileName(f.fileName) === '' || resolveContentType(f.fileName, f.contentType) === null) {
            return { ...json({ code: 'invalid_input', message: `${f.fileName}: this file type is not accepted` }), isError: true };
          }
        }
      }
      // The kind of a titled create: what the caller said, the rest inferred from the title and plan (an intake proposal replaces it).
      const kindFields = await createKindFields({ type: askedType, category: kind.category, fix: kind.fix, workKind: kind.workKind }, input.title === undefined ? undefined : () =>
        deps.intake.inferWork(input.board, { title: input.title ?? '', plan: input.plan ?? input.input ?? '' }),
      );
      let fields: { title: string; type: SlopType; group: string | null; autoTrigger: boolean } & CreateKindFields = {
        ...kindFields,
        title: input.title ?? '',
        type: askedType ?? ('sub' as const),
        group: input.group === undefined || input.group === null || input.group.trim() === '' ? null : input.group.trim(),
        autoTrigger: input.autoTrigger ?? false,
      };
      // Intake suggests an environment the request names; an explicit one wins.
      let suggestedEnvironment: string | null = null;
      // Intake's guesses: files the work changes (they can hold it for the merge policy) and globs the request waits for (only reported).
      let files: readonly string[] = [];
      let suggestedAfter: readonly string[] = [];
      // Questions intake raised instead of guessing: they hold a new glob's start until a person answers.
      let intakeQuestions: readonly NewQuestion[] = [];
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
            ...(askedType === undefined ? {} : { type: askedType }),
            ...(kind.category === undefined || isHumanCategory(kind.category) ? {} : { category: kind.category }),
            ...(kind.fix === undefined ? {} : { fix: kind.fix }),
            ...(kind.workKind === undefined ? {} : { workKind: kind.workKind }),
            ...(input.group === undefined ? {} : { group: input.group ?? '' }),
            ...(input.environment === undefined ? {} : { environment: input.environment }),
          },
        });
        if (!proposal.ok) return reply(proposal);
        const { environment, plan, ...proposed } = proposal.value;
        fields = {
          ...proposed,
          inferenceReason: inferenceReasonOf(proposal.value),
          autoTrigger: input.autoTrigger ?? proposal.value.autoTrigger,
        };
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
          ...(proposal.value.prerequisites === undefined ? {} : { prerequisites: proposal.value.prerequisites }),
        };
        files = proposal.value.files;
        suggestedAfter = proposal.value.suggestedAfter;
        // A glob the request says to wait for is suggested, never applied: leave a notice to add the relation or not.
        const applied = new Set([
          ...(input.needs ?? []),
          ...(input.after ?? []),
          ...(proposal.value.prerequisites ?? []).map((p) => p.id),
        ]);
        intakeQuestions = [
          ...proposal.value.questions,
          ...proposal.value.suggestedAfter
            .filter((id) => !applied.has(id))
            .map((id) => relationQuestion(id, 'The request says to wait for it, but it was not added as a relation. Answering only records your choice: add the relation from the glob view if it is one.', { kind: 'intake', actor: null })),
        ];
      }
      // A titled create skips intake, so choose the group alone; a model that is down leaves it empty.
      if (input.title !== undefined && input.group === undefined) {
        const suggested = await deps.intake.suggestGroup(email, input.board, { title: input.title, plan: input.plan ?? input.input ?? '' });
        if (suggested.ok) fields = { ...fields, group: suggested.value };
      }
      const made = await globs.createWithNotes(email, {
        boardId: input.board,
        ...fields,
        typeChosen: askedType !== undefined,
        plan: input.plan ?? proposedPlan ?? input.input ?? '',
        planBy: 'sessionator',
        source: 'mcp',
        ...(intakeRecord === null ? {} : { intake: intakeRecord }),
        environment: input.environment ?? suggestedEnvironment,
        idempotencyKey: input.idempotencyKey,
        ...(input.inboxItem === undefined ? {} : { inboxItem: input.inboxItem }),
        ...relationFields,
        ...(files.length === 0 ? {} : { files }),
        ...(intakeQuestions.length === 0 ? {} : { questions: intakeQuestions }),
      });
      if (!made.ok) return reply(made);
      const created = { ok: true as const, value: made.value.glob };
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
      return reply(await globs.get(email, created.value.id), ({ glob, relations, waitingFor }) => ({
        ...(uploads.length === 0 ? {} : { uploads, next: UPLOAD_NEXT }),
        ...(uploadProblems.length === 0 ? {} : { uploadProblems }),
        id: glob.id,
        version: glob.version,
        branch: glob.id,
        provisioning: glob.provisioning,
        status: glob.status,
        type: glob.type,
        category: glob.category,
        ...kindView(glob),
        ...(glob.inferenceReason == null ? {} : { inferenceReason: glob.inferenceReason }),
        group: glob.group,
        environment: glob.environment,
        ...relationReply(made.value.notes, relations, waitingFor),
        ...(glob.waiting == null ? {} : { waiting: true }),
        // Open questions intake raised: relay them to the person. A start-blocking one holds the glob in Planning (no run) until answered.
        ...(openQuestions(glob).length === 0
          ? {}
          : {
              questions: openQuestions(glob).map((q) => ({ id: q.id, text: q.text, ...(q.options === undefined ? {} : { options: q.options }), blocking: q.blocking })),
            }),
        ...(glob.status === 'planning' && startQuestions(glob).length > 0 ? { held: true } : {}),
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
        "Cut the scope of a glob in Planning (not started: no run, no branch) into independent globs in one step: a scope cut, for work that could each ship alone, not a way to parallelise one piece of work (parallel work happens inside the run as workstreams). Part 0 is this glob: it keeps its ID, history and decisions, gets the new title and plan, and signs off on its own like any glob. The other parts are created in its group with their own plan and copies of its link attachments (and the text attachments you list). Write `{part:N}` in a plan for part N's glob ID. Pass the version you read and an idempotency key (a retry returns the same parts). Title every part with the feature's short name from the original title, a colon, then what it delivers and changes (\"Board chat: answers get 👍/👎 buttons, stored per board\", not \"Feedback UI and submission\"); at most ~100 characters, no \"Part N\". Parts default to the glob's mode, fix flag and work kind. The parts are independent: there is no gate between them and no sign-off from the original on the others, unless you pass `after` on a part (earlier parts it needs merged before it starts), which is stored as an ordinary need (a start relation from the part to the earlier part). Name only direct prerequisites in `after`. The parts keep a \"Split from <id>\" line in their plan and a split event as provenance.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        idempotencyKey: z.string().min(1),
        group: z.string().min(1).max(100).optional().describe('The group every part shares when the glob has none (default: named from its title); ignored when it has one'),
        parts: z
          .array(
            z.object({
              title: z.string().min(1),
              plan: z.string().min(1).describe("This part's share of plan.md (Markdown); {part:N} stands for part N's glob ID"),
              mode: z.enum(SLOP_TYPES).optional().describe("The part's machine mode (default: the glob's)"),
              fix: z.boolean().optional().describe("Whether the part fixes something broken (default: the glob's)"),
              workKind: z.enum(WORK_KINDS).optional().describe("rnd or maintenance (default: the glob's)"),
              category: z.enum(WORK_CATEGORIES).optional().describe('Old alias: bug is a fix, feature is R&D (stored as a task), task is maintenance'),
              type: z.enum(SLOP_TYPES).optional().describe('Alias of `mode`'),
              after: z.array(z.number().int().min(0)).max(MAX_SPLIT_PARTS).optional().describe('Indexes of earlier parts this part needs merged before it starts'),
              attachments: z.array(z.string().min(1)).optional().describe("Labels of the original's text attachments to copy (new parts only; link attachments are always copied)"),
            }),
          )
          .min(2)
          .max(MAX_SPLIT_PARTS),
      },
    },
    async ({ id, version, idempotencyKey, group, parts }) => {
      const split = await globs.split(email, id, version, {
        idempotencyKey,
        ...(group === undefined ? {} : { group }),
        planBy: 'sessionator',
        parts: parts.map(({ attachments, after, category, type, mode, fix, workKind, ...rest }) => ({
          ...rest,
          ...(attachments === undefined ? {} : { attachments }),
          ...(after === undefined ? {} : { after }),
          ...(category === undefined ? {} : { category }),
          ...((mode ?? type) === undefined ? {} : { type: mode ?? type }),
          ...(fix === undefined ? {} : { fix }),
          ...(workKind === undefined ? {} : { workKind }),
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
          ...kindView(glob),
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
        "Everything about a glob (a decision glob carries `attributes`: scope, origin, channel, outcome, and for a KB learning its kind, target, evidence count, staleness and, when the pipeline closed it, closedAs; `links` says how it relates to other learnings (duplicate_of, suppressed_by, covered_by, possibly_covered_by, contradicts, kept_apart_from), kept apart from the glob's `relations`; its proposal is plan.md): status, version, fields, labels, PR, runs, flags, its `relations` (`holding`: what holds it back now, with the gate, what it waits for and why, where `merged` means merged and rolled out; `holdsBack`: the globs waiting for it; `done`: relations that no longer hold, met, dismissed, overridden or deleted; each with its source: person, agent, auto (added by slop from the text; dismissible), inferred or learned; older rows may say split; a relation to a glob on another board carries `external` (the board's name, or `hidden: true` and the id `another board` when you cannot view it); `supersededBy` and `supersedes` when set; `waitedOnByOtherBoards`: how many relations from boards you cannot see wait for it), `suggestions` (short list of open card suggestions: id, kind, text), its artifacts (the latest version of each plan, implementation record, local review and attachment, with version count, commitSha, createdAt and provenance; no content) and its latest deploys (environment, commit, state: waiting, running, succeeded, failed or replaced; error and log link). `questions` lists the glob's questions (open ones have no `answer` or `dismissed`; a `start` or `merge` one holds the glob until a person answers it: finish and report, don't answer it yourself). Routines pass their run ID, which records the run as making progress. When intake's size check flagged the glob, `oversized` is true and `sizeCheck` carries why, its evidence, `decision` (`split` once its scope was cut into independent globs) and the proposed workstreams (each with its name, goal, files, needs, a short `planSummary` and `planChars`; `get_context` has them in full). The flag is advice: it never holds the glob, which can start at once and works the workstreams inside its one run; a flagged sub is a same. Human steps with state `due` are the checklist a person runs from master after the merge; a step the person ran on the branch or by hand is yours to update with complete_human_step (with a `note`), dismiss_human_step or add_human_step. `handover` is the hand-over brief (`why`: one sentence per cause, most actionable first; `next`: what to do first; `detail`: the extra lines) when the glob needs a person (a conflict, a failure, failed checks, a stalled run or open in-scope review findings), else null.",
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
        ...compactSuggestions(compactSizeProposal(globViewOf(v))),
        deploys: history.ok ? history.value.map(deployView) : [],
      }));
    },
  );

  server.registerTool(
    'list_globs',
    {
      description:
        'Globs on a board (ID, title, status, actor, mode, fix, workKind), optionally filtered. Without `actor` or `mode` it lists machine work; pass `actor` human, or `mode` action or decision, to list human work (an action is open while its status is planning; `type` is null for both). The old `category` (feature, task, bug, decision, action) still filters as an alias; `feature` matches only old globs, as new ones are stored as tasks.',
      inputSchema: {
        board: z.number().int(),
        status: z.array(z.enum(STATUSES)).optional(),
        type: z.enum(SLOP_TYPES).optional().describe('Alias of `mode` for machine globs'),
        actor: z.enum(['machine', 'human']).optional().describe('machine (agents) or human (actions and decisions)'),
        mode: z.enum([...SLOP_TYPES, 'decision', 'action']).optional().describe('sub, same, super, decision or action'),
        fix: z.boolean().optional().describe('Only globs that do (true) or do not (false) fix something broken'),
        workKind: z.enum(WORK_KINDS).optional().describe('Only rnd or only maintenance globs'),
        category: z.enum(CATEGORIES).optional().describe('Old alias: feature (old globs only), task, bug, decision or action'),
        group: z.string().optional(),
        person: z.string().optional().describe('Planner or implementer email'),
      },
    },
    async ({ board, status, type, actor, mode, fix, workKind, category, group, person }) => {
      const humanMode = mode === 'action' || mode === 'decision' ? mode : undefined;
      const wanted = humanMode ?? category;
      const machineMode = mode === undefined || mode === 'action' || mode === 'decision' ? type : mode;
      const result = await globs.list(email, board, {
        include: wanted === 'action' ? 'actions' : wanted === 'decision' ? 'decisions' : actor === 'human' ? 'human' : 'work',
        ...(status === undefined ? {} : { status }),
        ...(machineMode === undefined ? {} : { type: machineMode }),
        ...(group === undefined ? {} : { group }),
        ...(person === undefined ? {} : { person }),
      });
      const now = Date.now();
      return reply(result, (list) =>
        list
          .filter((g) => {
            const kind = kindView(g);
            return (
              onBoard(g, now) &&
              (category === undefined || g.category === category) &&
              (actor === undefined || kind.actor === actor) &&
              (fix === undefined || kind.fix === fix) &&
              (workKind === undefined || kind.workKind === workKind)
            );
          })
          .map((g) => ({
            id: g.id,
            title: g.title,
            status: g.status,
            type: g.type,
            category: g.category,
            ...kindView(g),
            group: g.group,
            planner: g.planner,
            implementer: g.implementer,
            version: g.version,
          })),
      );
    },
  );

  server.registerTool(
    'get_group',
    {
      description:
        "A group of a board: its globs (status, type, whose move, what holds each), progress (merged of total; decisions and deleted globs aren't counted), the relations between its globs (holding ones first; `crosses` marks one to a glob outside the group) and the open decisions that hold any of them. A group is only the name on its globs: it has no status of its own. Use list_globs with `group` for a plain list.",
      inputSchema: { board: z.number().int(), name: z.string() },
    },
    async ({ board, name }) => {
      if (deps.groups === undefined) return json({ code: 'not_found', message: 'Groups are not available' });
      return reply(await deps.groups.view(email, board, name));
    },
  );

  server.registerTool(
    'update_glob',
    {
      description:
        "Change a glob's title, `mode` (a machine glob's sub, same or super; alias `type`; changing it to sub or super needs a board admin; to same is open to anyone who can edit the glob), `fix` (whether it fixes something broken: anyone who can edit the glob may flip it; a fix is never a super), `workKind` (rnd or maintenance for the time report: board admins only), the old `category` alias, group, environment, `after` (the globs it waits for to merge and roll out; only before it has started; a sub changed from a same waits for them; needs `reason`, required for agents), `relations` (added or changed, any gate, each with a reason; they never remove one: use dismiss_relation) or `supersedes` (globs this one replaces; see the argument). Relations an agent adds are stored as source `agent`. Pass the version you read. The spec (plan.md) is not a field: edit it with save_plan.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        title: z.string().optional(),
        mode: z.enum(SLOP_TYPES).optional().describe("A machine glob's mode: sub, same or super"),
        fix: z.boolean().optional(),
        workKind: z.enum(WORK_KINDS).optional(),
        type: z.enum(SLOP_TYPES).optional().describe('Alias of `mode`'),
        category: z.enum(WORK_CATEGORIES).optional().describe('Old alias: moves a still-inferred fix flag and work kind to the category\'s meaning'),
        group: z.string().nullable().optional(),
        environment: z.string().nullable().optional(),
        needs: z.array(z.string().min(1)).max(20).optional().describe('IDs of globs this one needs merged and rolled out before it starts (alias: `after`); needs `reason`'),
        after: z.array(z.string().min(1)).max(20).optional().describe('Alias of `needs`'),
        reason: z.string().min(1).max(MAX_RELATION_REASON).optional().describe('One line saying why this glob waits for each id in `needs`/`after`, and the shared reason of bare IDs in `supersedes`. Required for agents'),
        supersedes: z.array(supersedeInputSchema).max(20).optional().describe(SUPERSEDES_HELP),
        relations: z.array(relationInputSchema).max(60).optional().describe(RELATIONS_HELP),
      },
    },
    async ({ id, version, needs, relations, mode, reason, supersedes, ...changes }) => {
      const kind = resolveKind({ mode, type: changes.type, category: changes.category }, false);
      if (!kind.ok) return { ...json({ code: 'invalid_input', message: kind.message }), isError: true };
      if (kind.type !== undefined) changes.type = kind.type ?? undefined;
      const merged = needs === undefined && changes.after === undefined ? changes : { ...changes, after: [...new Set([...(needs ?? []), ...(changes.after ?? [])])] };
      const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
      const shared = reason?.trim();
      // Every relation an agent states through this tool is source `agent` (the reason rule applies), not only `relations`.
      const stated = {
        ...(relations === undefined ? {} : { relations: relationInputs(relations) }),
        ...(shared === undefined || shared === '' ? {} : { afterReason: shared }),
        ...(supersedes === undefined || supersedes.length === 0 ? {} : { supersedes: supersedeInputs(supersedes, shared) }),
        ...(relations === undefined && merged.after === undefined && supersedes === undefined ? {} : { by: 'agent' as const }),
      };
      return reply(await globs.update(email, id, version, { ...clean, ...stated }), (g) => globView(g));
    },
  );

  server.registerTool(
    'add_relation',
    {
      description:
        "Add one relation to a glob. Give `to` (this glob can't pass `gate` until `to` reaches `until`; pass the version you read), `holdsBack` (a decision glob, or any glob, holds that other glob back until this one reaches `until`; no version: the relation is written on the other glob, which may be on another board you can edit) or `supersedes` (this glob replaces that one: the row lands on it; no version). " +
        RELATIONS_HELP +
        " Refused: the same glob, a glob you cannot view (`No glob X`), a cycle (across boards too), a missing `reason` (required for agents: the refusal names the glob and how to pass it), a 21st relation for one gate, `decided` for a glob that is not a decision, and a decision glob as the one held back. A dismissed relation to the same glob and gate is replaced. Answers with the glob's view (`relations`).",
      inputSchema: {
        id: z.string(),
        version: z.number().int().optional().describe('The version you read: required with `to`'),
        to: z.string().min(1).optional().describe('The glob or decision this glob waits for'),
        holdsBack: z.string().min(1).optional().describe('A glob that waits for this one (this glob is a decision or any glob it must reach `until` first)'),
        holdsBackGroup: z.string().min(1).optional().describe('A group whose globs all wait for this one: one relation per work glob in it (those already past the gate are left out), and a glob that joins the group later gets it too while it is open; no version'),
        supersedes: z.string().min(1).optional().describe('A glob this one replaces: its due human steps are dismissed as "superseded by" this one. Uses `reason` (required for agents); no version'),
        gate: relationInputSchema.shape.gate,
        until: relationInputSchema.shape.until,
        reason: relationInputSchema.shape.reason,
      },
    },
    async ({ id, ...rest }) => {
      const parsed = addRelationSchema.safeParse(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
      if (!parsed.success) return { ...json({ code: 'invalid_input', message: parsed.error.issues.map((i) => i.message).join('; ') }), isError: true };
      const { to, holdsBack, holdsBackGroup, supersedes, version, ...fields } = parsed.data;
      if (supersedes !== undefined) {
        const done = await globs.addSupersession(email, id, supersedes, { reason: fields.reason ?? null }, 'agent');
        if (done.ok) await deps.outbox.drain(done.value.id);
        return done.ok ? reply(await globs.get(email, id), (v) => globViewOf(v)) : reply(done);
      }
      if (holdsBackGroup !== undefined) {
        const held = await globs.holdGroup(email, id, holdsBackGroup, relationInput({ ...fields, to: id }), 'agent');
        if (held.ok) await deps.outbox.drain(id);
        return held.ok ? reply(await globs.get(email, id), (v) => ({ ...globViewOf(v), groupHold: held.value })) : reply(held);
      }
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
        "Merge a same or super whose PR is ready, as the glob's Merge button does. With the required checks passed on the head it merges now; with them still pending it arms \"merge when checks pass\" (slop merges when they pass, and disarms if they fail or the PR conflicts). Merging: slop updates the branch, waits for checks on the new head and squash-merges through its GitHub App. The glob moves to merging, then to reviewing when the merge is observed. For a same with open rollout steps, plain merge is refused and `continue: true` is Merge and continue: it merges, keeps the glob open (reviewing) and the steps fall due; the steps are the checklist a person runs from master. With continue (supers, latest implementation record at the head), it is Merge and continue: the glob returns to in_progress on the same branch, and its next push opens a fresh draft PR. Also Retry merge: on a failed glob whose merge failed without a conflict (e.g. \"GitHub hasn't decided whether the PR can merge\"), it asks slop to merge again. Pass the version you read.",
      inputSchema: {
        id: z.string(),
        version: z.number().int(),
        continue: z.boolean().optional().describe('Supers: Merge and continue (a checkpoint merge; the glob stays in Doing). A same with rollout steps: Merge and continue (the glob stays open for the steps)'),
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
    'complete_action',
    {
      description:
        "Mark an action glob done: a person did the work. Optionally note what was checked. Anyone on the board may do it; it records who and when, and globs waiting for the action are released. A repeat on a done action changes nothing. Only call it for work the person has actually done or confirmed. Pass the version you read.",
      inputSchema: { id: z.string(), version: z.number().int(), note: z.string().max(OUTCOME_REASON_MAX).optional().describe('What was checked (optional)') },
    },
    async ({ id, version, note }) => {
      const done = await globs.completeAction(email, id, version, note);
      if (done.ok) await deps.outbox.drain(id);
      return reply(done, (g) => globView(g));
    },
  );

  server.registerTool(
    'dismiss_action',
    {
      description:
        'Dismiss an action glob as not needed, with the reason. It ends the action like done does, so globs waiting for it are released: say why in the reason. Pass the version you read.',
      inputSchema: { id: z.string(), version: z.number().int(), reason: z.string().min(1).max(OUTCOME_REASON_MAX) },
    },
    async ({ id, version, reason }) => {
      const dismissed = await globs.dismissAction(email, id, version, reason);
      if (dismissed.ok) await deps.outbox.drain(id);
      return reply(dismissed, (g) => globView(g));
    },
  );

  server.registerTool(
    'escalate_to_same',
    {
      description:
        "Flag a running sub as needing a human: it becomes a same in place (same branch and PR, no auto-merge) with the reason shown on its card, and the owner is told. Only for a concrete reason: a product or design decision the plan didn't settle, a board risk area, a rewrite of existing data, auth/permissions/secrets changes, weakened or deleted tests, changed agent instructions, scope well beyond the plan, in-scope review findings still open after the allowed rounds, or work on risk paths or with rollout steps (criterion `risk_path`: a rule, not a judgement). Otherwise let the sub merge. Routines pass their run ID (a superseded run's call is ignored). A person can set its type back to sub.",
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

  server.registerTool(
    'raise_question',
    {
      description:
        "Raise an open question on a glob when you are unsure of something material and a wrong guess would be costly: scope, data loss, security or permissions, prod, cost, irreversible changes. It is raised in addition to recording the assumption, never instead. `blocking`: `merge` (default: a run finishes and opens its PR, but nothing merges, and merge-when-green waits, until a person answers or dismisses it), `start` (holds a glob that has not started in Planning; on a glob already running it is stored as a notice, `downgraded: true`), `none` (a notice only). A person answers on the card or the glob view; the answer is added to the Clarifications attachment, which `get_context` returns, together with `questions.answered`. Routines pass their run ID (a superseded run's call is ignored) and never wait for the answer. A `key` makes a repeat a no-op (the same question is returned).",
      inputSchema: {
        id: z.string(),
        text: z.string().min(1).max(MAX_QUESTION_TEXT).describe('The question, in one or two sentences, with what you assumed meanwhile'),
        options: z.array(z.string().min(1).max(MAX_QUESTION_OPTION)).max(MAX_QUESTION_OPTIONS).optional().describe('Short answers the person can pick'),
        blocking: z.enum(QUESTION_BLOCKING).optional().describe('merge (default), start or none'),
        key: z.string().min(1).max(120).optional().describe('A dedupe key: raising the same key again changes nothing'),
        source: z.enum(QUESTION_SOURCES).optional().describe('Where it comes from (default: run with a run ID, else other)'),
        runId: z.string().optional(),
      },
    },
    async ({ id, text, options, blocking, key, source, runId }) => {
      const raised = await globs.raiseQuestion(email, id, {
        text,
        ...(options === undefined ? {} : { options }),
        ...(key === undefined ? {} : { key }),
        blocking: blocking ?? 'merge',
        source: source ?? (runId === undefined ? 'other' : 'run'),
        raisedBy: runId === undefined ? { kind: 'agent', actor: email } : { kind: 'routine', actor: email, runId },
        ...(runId === undefined ? {} : { runId }),
      });
      if (raised.ok) await deps.outbox.drain(id);
      return reply(raised, (r) =>
        r.ignored !== null
          ? { ignored: true, reason: r.ignored }
          : {
              id: r.glob.id,
              version: r.glob.version,
              question: r.question === null ? null : { id: r.question.id, text: r.question.text, blocking: r.question.blocking, ...(r.question.options === undefined ? {} : { options: r.question.options }) },
              ...(r.downgraded ? { downgraded: true, note: 'The glob has started, so a start question is a notice' } : {}),
            },
      );
    },
  );

  server.registerTool(
    'answer_question',
    {
      description:
        "Answer an open question on a glob with what the person said: free text, an option, or both. The question and answer are added to the glob's Clarifications attachment (a new version) and whatever the question held is released: a held glob starts (a sub gets its run), a held merge resumes. Routines must never call this: a run answering its own question would clear a hold meant for a person (a call that passes one of the glob's run IDs is refused with `forbidden`). Only relay an answer a person gave you.",
      inputSchema: {
        id: z.string(),
        questionId: z.string().min(1),
        answer: z.string().max(MAX_QUESTION_ANSWER).describe("The person's answer (may be empty when `option` is given)"),
        option: z.string().min(1).optional().describe("One of the question's options"),
        runId: z.string().optional(),
      },
    },
    async ({ id, questionId, answer, option, runId }) => {
      const answered = await globs.answerQuestion(email, id, questionId, { answer, option: option ?? null, runId: runId ?? null });
      if (answered.ok) await deps.outbox.drain(id);
      return reply(answered, (g) => globView(g));
    },
  );

  server.registerTool(
    'dismiss_question',
    {
      description:
        'Dismiss an open question on a glob: go ahead as it is. The hold clears and the dismissal (with the optional note) is added to the Clarifications attachment. Routines must never call this (a call that passes one of the glob\'s run IDs is refused with `forbidden`); only relay a dismissal a person gave you.',
      inputSchema: { id: z.string(), questionId: z.string().min(1), note: z.string().max(MAX_QUESTION_NOTE).optional(), runId: z.string().optional() },
    },
    async ({ id, questionId, note, runId }) => {
      const dismissed = await globs.dismissQuestion(email, id, questionId, { note: note ?? null, runId: runId ?? null });
      if (dismissed.ok) await deps.outbox.drain(id);
      return reply(dismissed, (g) => globView(g));
    },
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
        "Admins only: approve a KB item as drafted or with an edited draft, or reject it with a reason (required), recorded as you with outcome.via 'agent'. The item is its decision glob (same ID), so approving moves that glob to Reviewing and rejecting signs it off, archived. Same checks as the Knowledge page's buttons; pass the version you read from list_kb_items. editedDraft is the full section (or value) to apply in place of the draft: it is validated and checked against the version the draft was made against, and the change is written as a new knowledge version (agent-set files bump the agent-set version). Always refused for approval, whatever the board's setting: the local-run spec, the merge policy and a whole-document proposal (a person approves them on the Knowledge page; rejecting is allowed). Agent-set files (agent, command, hook, settings, mcp, claude_md) and items with contradicts flags are refused too unless the board's agentKbApproval setting is docs_and_agent_files (an admin sets it under Automation in Settings); a contradicting item then needs a reason, recorded with the decision. A person can reopen any agent decision on the Knowledge page, which reverts its change.",
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
          .describe("gotcha, pattern, agent-behaviour (something an instruction would have prevented), or fact (how the system is now after this glob: a new component, a moved responsibility, a new data flow or table, a new external service, a changed deploy or ops procedure; name the files and commit as evidence). Choices are not learnings: record them in your implementation record's ## Decisions"),
        statement: z.string().min(1).describe('The learning, as one rule or fact'),
        evidence: z.string().min(1).describe('What showed it: files, review findings, failures, a developer correction'),
        suggestedTarget: z
          .string()
          .optional()
          .describe('Where it belongs: a document, area or agent definition, "local-run" for how sessions build and launch the local servers, or "merge-policy" for which paths clash between globs (exclusivePaths), which are left out when a sub is sized (sizeIgnoredPaths), which need a rollout after merging (rolloutPaths) which a sub may never touch (riskPaths: they always make it a same) and the check a sub waits for (subGateCheck)'),
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
        "The glob's context bundle: its fields (`attributes` on a decision glob), `payload` (the same text as plan.md), `scopedDecisions` (accepted decisions that govern this glob: its scope, statement and outcome), plan.md, the test plan (`testPlan`: version, full text, the parsed `atfSpecs` block and any `validation` note; null before one is saved) and the implementation record in full, Clarifications and Assumptions attachments in full, a listing of the other artifacts (kind, label, version, commitSha, size, description), the board's repo and base branch, `inbox` (pasted meeting notes, threads and documents a person attached to this glob, with their summary and text cut at 12000 characters; `truncated` says it was cut: search_text finds the rest), `decisions` (the choices taken on this glob, current first, each with its source link; a replaced one says what replaced it and when; the field keeps its old name), `authority` (which source wins when they disagree: merged code and the implementation record, then current choices newest first, then plan.md, then older discussion; replaced choices are history), and `related`: up to 5 cited search results for the glob's title and plan (what the board already knows, current choices first, replaced ones labelled; the glob's own items left out). `size` (when intake's size check judged the glob): `oversized` (advice, not a hold), its reasons and evidence, `decision` (`split` when its scope was cut) and the proposed workstreams (name, goal, files, plan share and `needs` as earlier workstream indexes: parallel work inside this glob's one run and PR). `size.forecast` (when made) is the predicted footprint: expected files and modules, a lines range, parts with their file sets, risk areas, confidence, the reference class of similar past globs and the calibration applied; it is a prediction to confirm or correct while investigating, not a fact. `hotspots` lists the board's conflict hotspots among the files the glob plans to change (its investigation's or plan.md's paths) or conflicted on: path, conflicts, globs, real conflicts, last conflict time and the window in days; empty when none. `group` (only when the glob's group has other open or merged-in-the-last-14-days globs, or open decisions): the group's name and progress, the other globs (ID, title, status, one line of plan; `more` counts those beyond 12) and the open decisions (those holding a glob of the group, and the group's own) with the group's globs each holds back, so you know what the neighbours do without reading their plans; `get_group` has the full view. `questions`: `{open, answered}`, the glob's questions (answered ones, and dismissed ones, are also in the Clarifications attachment). `handover` is the hand-over brief (why a person is needed, what to do first), null when nothing is wrong. Pass `include` to get more in full: 'local_review', 'attachment:<label>', or 'all'.",
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
        "The latest version of one artifact of a glob in full: kind is 'implementation_plan' (the implementation record), 'test_plan', 'local_review', 'independent_review' (the independent reviewer's findings) or 'attachment' (with its label; a stored file comes with a fresh `downloadUrl`: fetch it with curl).",
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
    'get_test_plan',
    {
      description:
        "The glob's test plan (the matrix of ATF specs that prove the change and the ```atf-specs block of specs to run after the merge), optionally a given version, with its version history. `current` is null before one is saved; its provenance carries the parsed `atfSpecs` and a `validation` note when the text has problems.",
      inputSchema: { id: z.string(), version: z.number().int().optional() },
    },
    async ({ id, version }) => reply(await artifacts.testPlan(email, id, version ?? null)),
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
    why: step.why,
    permissions: step.permissions,
    commands: step.commands,
    verify: step.verify,
    doneBy: step.doneBy,
    doneAt: step.doneAt,
    dismissedReason: step.dismissedReason,
    dueSince: step.dueSince,
  });

  server.registerTool(
    'add_human_step',
    {
      description:
        "Add a step only a person can do to a glob (a rollout, a setting, a manual task). A rollout step (the default kind) falls due after the merge and holds back the glob's sign-off and the globs that need it, until it is ticked or dismissed. `who`: implementer, admin, po, qa, anyone or an email. `due`: now, after_merge, once or after_deploy:<env> (falls due once a deploy of the glob's merge to <env> is recorded or mark_environment_deployed is called, and holds nothing back unless `blocks` says so; <env> must be one of the board's environments from get_board, or the step is refused). `once` (or `once: true`) is a one-shot command inside the change that takes effect by being run, not by deploying (an IAM grant, an account setting): it has no environment, falls due as soon as its `script` path is on the glob's branch (at once when it has none), stays done once done, is never reopened when a later step fails, and holds back sign-off like an after-merge step. `script`: {artifact: label} or {path: repo path} (slop shows its run command itself). `why`, `permissions`, `commands` and `verify` are plain-text fields the glob view lays out; `detail` holds anything else. Members only; pass the glob version you read to have it checked. Agents never run steps that change paid infrastructure or IAM: write them here for a person.",
      inputSchema: {
        id: z.string(),
        version: z.number().int().optional(),
        title: z.string().min(1).describe('Short: the action ("Roll out the host stack")'),
        kind: z.enum(HUMAN_STEP_KINDS).optional(),
        detail: z
          .string()
          .optional()
          .describe('Plain text, for anything the fields below do not cover'),
        why: z.string().optional().describe('One sentence: why the step is needed'),
        permissions: z.string().optional().describe('The access a person needs, plain text'),
        commands: z
          .array(z.string())
          .optional()
          .describe(
            'The command lines a person runs, in order, one per entry, no backticks or Markdown; never repeat the script path here',
          ),
        verify: z.string().optional().describe('How to tell it worked, one line'),
        who: z.string().optional(),
        due: z.string().optional(),
        once: z.boolean().optional().describe('A one-shot command inside the change: no environment, due when its script is on the branch, never reopened'),
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
      inputSchema: {
        id: z.string(),
        stepId: z.string(),
        version: z.number().int().optional(),
        note: z.string().max(OUTCOME_REASON_MAX).optional().describe('What was done, e.g. a step run on the branch or by hand (credentials are masked)'),
      },
    },
    async ({ id, stepId, version, note }) => reply(await globs.completeHumanStep(email, id, stepId, version ?? null, note), stepView),
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
    'fail_human_step',
    {
      description:
        "Report that a step's run failed (a rollout that did not provision, a command that errored). Pass the failure output as `note`; strip credentials, tokens and keys first: slop masks what it recognises and cannot unmask. A rollout step of a merged glob (in Reviewing) starts the glob's next generation: a new run on a fresh branch from master, with the masked note as an attachment `Rollout step failed (generation N)` read as in-scope feedback; a done step is reopened and falls due again after the next merge. Any other step stays open and keeps holding what it holds; slop writes a suggestion on the glob, \"this step failed: is there a fix glob?\", with one click to link a glob. When you create a glob to fix it, pass `holds: [{id: <this glob>, reason}]` on `create_glob`, which also closes the suggestion. Members only; pass the glob version you read to have it checked.",
      inputSchema: { id: z.string(), stepId: z.string(), note: z.string().min(1).max(100_000), version: z.number().int().optional() },
    },
    async ({ id, stepId, note, version }) => {
      const result = await globs.failHumanStep(email, id, stepId, note, version ?? null);
      // A next generation provisions and starts its routine in the background, as the REST route does.
      if (result.ok) void deps.outbox.drain(id).catch(() => undefined);
      return reply(result, stepView);
    },
  );

  server.registerTool(
    'mark_environment_deployed',
    {
      description:
        "Say that an environment now runs a glob's merge, for boards that report no deploys: the glob's open `after_deploy:<env>` steps for it fall due (once; a rollback later doesn't undo it). Logged on the glob as EnvironmentMarkedDeployed, not Deployed; it changes no status and not the glob's version. `environment` must be one the board lists. Members only.",
      inputSchema: { id: z.string(), environment: z.string().min(1) },
    },
    async ({ id, environment }) => reply(await globs.markEnvironmentDeployed(email, id, environment)),
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
    'save_test_plan',
    {
      description:
        "Save a new version of the glob's test plan, as the Test plan tab in the glob view does: a Markdown matrix (Name | Status new/existing/adjusted | Location | Description) and one fenced ```atf-specs block (`specs:` list of repo-relative paths, optional `grep:`). Pass the test plan version you read (get_test_plan or get_context; 0 when none is saved yet); a stale version is refused with version_conflict. A text with problems is stored anyway and the reply carries `validation`. Routines use put_artifact(kind: test_plan) with their run ID instead.",
      inputSchema: { id: z.string(), version: z.number().int(), content: z.string().min(1) },
    },
    async ({ id, version, content }) =>
      reply(await artifacts.putTestPlan(email, id, content, version), (a) =>
        'ignored' in a ? a : { id: a.id, version: a.version, ...(a.provenance.validation === undefined ? {} : { validation: a.provenance.validation }) },
      ),
  );

  server.registerTool(
    'put_artifact',
    {
      description:
        'Store the implementation record (kind implementation_plan; postplan is an alias that writes it), a local review, a test plan (kind test_plan: the matrix and the ```atf-specs block; text with problems is stored and the reply carries `validation`) or an investigation (the investigator\'s output ending in a fenced ```investigation JSON block; a block that does not validate is stored as text and the reply carries `validation`; the same holds for a record with its fenced ```workstreams block) as a new version. Routines pass their run ID (results from a superseded run are ignored); pass the agent-set version from .claude/slop-agent-set.json. With a local review, pass reviewStats (risk tier, review rounds run and allowed, tester FAIL → fix loops) when you know them.',
      inputSchema: {
        id: z.string(),
        kind: z.enum(['implementation_plan', 'postplan', 'local_review', 'investigation', 'test_plan']),
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
        await globs.applyEvent(id, (g, ctx, facts) => machine.investigationPushed(g, runId, ctx, facts.relations), { relations: true });
        // A Start that waited for this investigation fires its run now.
        await deps.outbox.drain(id);
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
        "A URL for uploading the implementation record (implementation_plan; postplan is an alias), a local review, a test plan or an investigation from a file without putting its text in a tool call: `curl --data-binary @<file> '<url>'` (POST the file as the body; at most 1 MiB of UTF-8 text). It is single use, expires in 5 minutes and stores exactly like put_artifact with the fields given here. Prefer it to put_artifact for anything over a few KB; use `slop put-artifact --file` where the CLI is installed.",
      inputSchema: {
        id: z.string(),
        kind: z.enum(['implementation_plan', 'postplan', 'local_review', 'investigation', 'test_plan']),
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
