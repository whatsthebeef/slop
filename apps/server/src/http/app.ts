import type { AttachmentService, BoardService, DecisionGlobService, Glob, GlobService, NewQuestion, PendingEffect, GroupBackfillService, GroupService, IntakeService, Result, SpendService, SplitInfo, WorkstreamsSummary } from '@slop/core';
import { AGENT_KB_APPROVALS, HUMAN_STEP_KINDS, MAX_INTAKE_QUESTIONS, MAX_QUESTION_ANSWER, MAX_QUESTION_KEY, MAX_QUESTION_NOTE, MAX_QUESTION_OPTION, MAX_QUESTION_OPTIONS, MAX_QUESTION_TEXT, QUESTION_BLOCKING, WORK_CATEGORIES, WORK_KINDS, invalidInput, CONFIDENCES, ENVIRONMENT_ROLES, LABEL_NAMES, MAX_SPLIT_PARTS, OUTCOME_REASON_MAX, REVIEW_SEVERITIES, RELATION_GATES, ROLES, SLOP_TYPES, STATUSES, bySignedOffNewest, isArchivedDecision, isMine, latestSignedOff, listOf, machine, machineSteps, needsHuman, humanSteps, openRolloutSteps, stallThresholds, whoseMove, withUnstick, compactStep, stepsForViewer, armView, armsStored } from '@slop/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import { SESSION_COOKIE, SESSION_DAYS } from '../auth.js';
import type { OutboxRunner } from '../jobs/outbox.js';
import type { MergeGate, ReadyGate } from '../ready-gate.js';
import type { HintHub } from '../notifier.js';
import type { SignedLinks } from '../signed-links.js';
import { labelCommandSchema } from './labels.js';
import { addRelationSchema, holdInputSchema, holdInputs, relationInput, relationInputs, relationListSchema, supersedeInputSchema, supersedeInputs } from './relation-schemas.js';
import { requestTiming } from '../request-metrics.js';
import { requestOrigin } from './origin.js';
import { checkSignInState, issueSignInState, safeReturnPath } from './sign-in-state.js';
import { armField, createKindFields, errorBody, globView, globViewFor, globViewOf, resolveKind, statusOf } from './views.js';

export interface AppDeps {
  readonly auth: Auth;
  readonly boards: BoardService;
  readonly globs: GlobService;
  readonly hub: HintHub;
  readonly outbox: OutboxRunner;
  /** Chooses the group of a glob created without one; absent: it gets none. */
  readonly intake?: Pick<IntakeService, 'suggestGroup'> & Partial<Pick<IntakeService, 'inferWork'>>;
  /** Proposes (and with apply, writes) groups for a board's open globs that have none; absent: its route isn't mounted. */
  readonly groupBackfill?: Pick<GroupBackfillService, 'run'>;
  /** The board's groups (list, one group's view, rename, merge); absent: their routes aren't mounted. */
  readonly groups?: Pick<GroupService, 'list' | 'view' | 'rename' | 'merge'>;
  /** Looks at a glob's pending files when it is read (the fallback for a lost storage event); absent: file attachments are off. */
  readonly attachments?: Pick<AttachmentService, 'refreshGlob'>;
  /** The board's LLM spend line; absent: its route isn't mounted. */
  readonly spend?: SpendService;
  /** Refuses Ready for review for a branch that conflicts with its base. */
  readonly readyGate?: ReadyGate;
  /** Refuses Merge on an agent-set PR whose diff is empty. */
  readonly mergeGate?: MergeGate;
  /** Signs the board sign-in `state`. */
  readonly links: SignedLinks;
  /** Reopens a decision: one the KB pipeline closed through the Knowledge page's reopen; absent: only accepted ones (row D9). */
  readonly decisions?: Pick<DecisionGlobService, 'reopen'>;
  /** Runs after a board is created (forks the catalog's agent set into it). */
  readonly onBoardCreated: (email: string, boardId: number) => Promise<void>;
  /** How long the board's event stream may sit idle before it sends a `ping` event (default 25 s; CloudFront's origin read timeout is 60 s). */
  readonly pingMs?: number;
}

export type Env = { Variables: { email: string } };

const STATE_COOKIE = 'slop_oauth_state';
// The session cookie lasts as long as the server-side session, so a browser restart keeps you signed in.
const SESSION_MAX_AGE = SESSION_DAYS * 86_400;

/** Request values go into log lines; keep them to one short printable line so they can't forge entries. */
const printable = (value: string): string => value.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);

const environmentSchema = z.object({
  name: z.string().min(1),
  allowBranchDeploy: z.boolean(),
  // false is accepted and treated as absent.
  subDefault: z
    .boolean()
    .optional()
    .transform((v) => (v === true ? (true as const) : undefined)),
  role: z.enum(ENVIRONMENT_ROLES).optional(),
  production: z
    .boolean()
    .optional()
    .transform((v) => (v === true ? (true as const) : undefined)),
});

const createBoardSchema = z.object({
  name: z.string().min(1),
  repo: z.string().nullable().default(null),
  baseBranch: z.string().min(1).default('main'),
  timeZone: z.string().default('UTC'),
  environments: z.array(environmentSchema).default([]),
});

/** The board's ATF integration setting. */
export const atfSettingSchema = z.object({
  provider: z.literal('codebuild'),
  // Slop assumes roleArn with its own credentials and puts region in URLs, so each is checked for shape here.
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d+$/),
  project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/),
  roleArn: z
    .string()
    .regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/)
    .optional(),
  mode: z.enum(['pull', 'push']),
});

const settingsSchema = z.object({
  version: z.number().int(),
  name: z.string().min(1).optional(),
  repo: z.string().nullable().optional(),
  baseBranch: z.string().min(1).optional(),
  timeZone: z.string().optional(),
  defaultRoutineOwner: z.string().nullable().optional(),
  environments: z.array(environmentSchema).optional(),
  sensitivePaths: z.array(z.string()).optional(),
  // Core checks the range (3 to 50).
  effectCheckGlobs: z.number().int().optional(),
  agentKbApproval: z.enum(AGENT_KB_APPROVALS).optional(),
  autoInvestigate: z.boolean().optional(),
  // Core checks the range (5 to 1440).
  knowledgePageIntervalMinutes: z.number().int().optional(),
  // Only the keys sent change; core checks the values.
  review: z
    .object({
      enabled: z.boolean(),
      model: z.string().nullable(),
      minSeverity: z.enum(REVIEW_SEVERITIES),
      ignoredPaths: z.array(z.string()),
      toolCap: z.number().int().nullable(),
    })
    .partial()
    .optional(),
  deploy: z
    .discriminatedUnion('provider', [
      z.object({
        provider: z.literal('codebuild'),
        region: z.string(),
        defaultProject: z.string(),
        projects: z.record(z.string(), z.string()).default({}),
      }),
      z.object({ provider: z.literal('github_actions'), workflow: z.string() }),
    ])
    .nullable()
    .optional(),
  atf: atfSettingSchema.nullable().optional(),
  readinessTicks: z
    .object({ routines: z.boolean(), routine_repo: z.boolean(), claude_app: z.boolean() })
    .partial()
    .optional(),
});

/** Who works on a glob and how, with the fix flag and work kind; the old `category` and `type` stay as aliases for one release. */
const kindFields = {
  actor: z.enum(['machine', 'human']).optional(),
  /** A machine glob's sub, same or super; a human glob's action (decisions are made by slop). */
  mode: z.enum([...SLOP_TYPES, 'decision', 'action']).optional(),
  fix: z.boolean().optional(),
  workKind: z.enum(WORK_KINDS).optional(),
};

export const createGlobSchema = z.object({
  title: z.string().min(1),
  ...kindFields,
  /** Code work: omitted means a same. An action has no type (null or omitted). Alias of `mode`. */
  type: z.enum(SLOP_TYPES).nullable().optional(),
  /** Old alias: bug is a fix, feature is R&D (stored as a task), task is maintenance, action is actor human. Nobody picks it any more. */
  category: z.enum([...WORK_CATEGORIES, 'action']).optional(),
  /** Who set `fix` and `workKind` (the form passes back intake's chips: `inferred` unless the person flipped one). Default: `person` for a value given. */
  fixSource: z.enum(['inferred', 'person']).optional(),
  workKindSource: z.enum(['inferred', 'person']).optional(),
  /** The one-line reason intake gave for the fix flag and work kind. */
  inferenceReason: z.string().max(500).nullable().optional(),
  /** Actions only: who is meant to do it. */
  assignee: z.string().trim().min(1).max(200).nullable().optional(),
  /** Omitted: slop chooses one from the title and plan. Null or empty: none. */
  group: z.string().nullable().optional(),
  environment: z.string().min(1).nullable().default(null),
  autoTrigger: z.boolean().default(false),
  /** Super only: false parks it in Planning (no branch, run or implementer) until a person picks it up to pair. */
  start: z.boolean().optional(),
  idempotencyKey: z.string().min(1).nullable().default(null),
  plan: z.string().optional(),
  /** An inbox item of the board to attach to the new glob in the same transaction. */
  inboxItem: z.number().int().positive().optional(),
  /** IDs of globs on the board this one needs: their code must be on main first, so the glob waits for them to merge. */
  needs: z.array(z.string().min(1)).max(20).optional(),
  /** Alias of `needs`. */
  after: z.array(z.string().min(1)).max(20).optional(),
  /** Relations of any gate beside `needs`/`after`: `[{to, gate?, until?, reason?}]`. */
  relations: relationListSchema.optional(),
  /** Globs (on any board the person can edit) this one holds back until it merges: a follow-up or a fix. Alias: `follows_up`. */
  holds: z.array(holdInputSchema).max(20).optional(),
  follows_up: z.array(holdInputSchema).max(20).optional(),
  /** Globs this one makes obsolete (the row lands on each: "superseded by this"). */
  supersedes: z.array(supersedeInputSchema).max(20).optional(),
  /** Files intake guessed the work changes: with the plan, they decide whether the merge policy's exclusive paths hold it. */
  files: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Questions the intake proposal raised, passed back by the form: they hold the new glob's start until a person answers. */
  questions: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(MAX_QUESTION_KEY).optional(),
        text: z.string().trim().min(1).max(MAX_QUESTION_TEXT),
        options: z.array(z.string().trim().min(1).max(MAX_QUESTION_OPTION)).max(MAX_QUESTION_OPTIONS).optional(),
        blocking: z.enum(['start', 'none']).default('start'),
      }),
    )
    .max(MAX_INTAKE_QUESTIONS)
    .optional(),
  /** What the intake proposal behind the form said, passed back so the glob's snapshot records it (the request is the text intake read). */
  intake: z
    .object({
      request: z.string().min(1).max(20000),
      categoryConfidence: z.enum(CONFIDENCES).nullable().default(null),
      reason: z.string().max(300).nullable().default(null),
      model: z.string().max(200).nullable().default(null),
      promptVersion: z.number().int().nullable().default(null),
      examples: z.array(z.string().min(1).max(40)).max(10).default([]),
      /** What intake decided the request waits for: passed back so the create-time path makes no second model call. */
      prerequisites: z.array(z.object({ id: z.string().min(1).max(40), gate: z.enum(RELATION_GATES), sentence: z.string().max(1000) })).max(20).optional(),
    })
    .optional(),
});

export const splitGlobSchema = z.object({
  version: z.number().int(),
  idempotencyKey: z.string().min(1).nullable().default(null),
  /** The group the parts share when the glob has none. */
  group: z.string().min(1).max(100).optional(),
  parts: z
    .array(
      z.object({
        title: z.string().min(1),
        plan: z.string().min(1),
        category: z.enum(WORK_CATEGORIES).optional(),
        type: z.enum(SLOP_TYPES).optional(),
        mode: z.enum(SLOP_TYPES).optional(),
        fix: z.boolean().optional(),
        workKind: z.enum(WORK_KINDS).optional(),
        after: z.array(z.number().int().min(0)).max(MAX_SPLIT_PARTS).optional(),
        attachments: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(2)
    .max(MAX_SPLIT_PARTS),
});

const updateGlobSchema = z.object({
  version: z.number().int(),
  title: z.string().min(1).optional(),
  type: z.enum(SLOP_TYPES).optional(),
  /** A machine glob's sub, same or super (alias: `type`). */
  mode: z.enum(SLOP_TYPES).optional(),
  fix: z.boolean().optional(),
  /** Board admins only. */
  workKind: z.enum(WORK_KINDS).optional(),
  category: z.enum(WORK_CATEGORIES).optional(),
  group: z.string().min(1).nullable().optional(),
  environment: z.string().min(1).nullable().optional(),
  needs: z.array(z.string().min(1)).max(20).optional(),
  after: z.array(z.string().min(1)).max(20).optional(),
  /** Relations to add or change (any gate); additive, unlike `after`, which replaces the start list. */
  relations: relationListSchema.optional(),
  /** Globs this one makes obsolete. */
  supersedes: z.array(supersedeInputSchema).max(20).optional(),
  /** A decision's scope or an action's assignee, the only attributes a client edits; core validates them. */
  attributes: z
    .union([
      z.object({ scope: z.object({ kind: z.string(), ref: z.string().nullable() }).strict() }).strict(),
      z.object({ assignee: z.string().nullable() }).strict(),
    ])
    .optional(),
});

/** A glob that came from a split says where: `split: { source, part, parts }`. */
const splitField = (split: SplitInfo | undefined) => (split === undefined ? {} : { split });

/** A fanned-out glob carries its workstreams' compact state, for the card's corner. */
const workstreamsField = (workstreams: WorkstreamsSummary | undefined) => (workstreams === undefined ? {} : { workstreams });

const versionSchema = z.object({ version: z.number().int() });

/** Glob actions carry the version read; pick-up and take-over may also choose the environment. */
const actionSchema = versionSchema.extend({
  environment: z.string().min(1).optional(),
  anyway: z.boolean().optional(),
  /** Done: what the person checked (optional). */
  note: z.string().max(OUTCOME_REASON_MAX).optional(),
  /** Dismiss: why the action is not needed (required by the action). */
  reason: z.string().max(OUTCOME_REASON_MAX).optional(),
});
type ActionBody = z.infer<typeof actionSchema>;

/** Rejected and pipeline-closed decisions are archived: they leave the board and its counts. */
const shown = (glob: Glob): boolean => !isArchivedDecision(glob);

const send = <T>(c: Context<Env>, result: Result<T>, map: (value: T) => unknown = (v) => v) =>
  result.ok ? c.json(map(result.value) as object) : c.json(errorBody(result.error), statusOf(result.error));

const parse = async <S extends z.ZodType>(c: Context<Env>, schema: S): Promise<z.infer<S> | Response> => {
  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  return parsed.success
    ? parsed.data
    : c.json({ code: 'invalid_input', message: z.prettifyError(parsed.error) }, 422);
};

export const createApp = (deps: AppDeps) => {
  const { auth, boards, globs, hub } = deps;
  const app = new Hono<Env>();
  // First, so it times (and bounds) every route registered after it, the MCP endpoint's included.
  app.use('*', requestTiming());

  // ---------------------------------------------------------------------------
  // Auth

  app.get('/auth/config', (c) => c.json({ mode: auth.config.AUTH_MODE }));

  if (auth.config.AUTH_MODE === 'dev') {
    app.post('/auth/dev-login', async (c) => {
      const body = await parse(c, z.object({ email: z.email(), name: z.string().optional(), returnTo: z.string().optional() }));
      if (body instanceof Response) return body;
      const email = body.email.toLowerCase();
      const session = await auth.createSession({ email, name: body.name ?? email });
      setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SESSION_MAX_AGE });
      return c.json({ email, returnTo: safeReturnPath(body.returnTo) });
    });
  }

  const originOf = (c: Context<Env>) => requestOrigin(c, auth.config.PUBLIC_URL, auth.config.PUBLIC_URL_ALIASES);

  if (auth.config.AUTH_MODE === 'cognito') {
    app.get('/auth/login', (c) => {
      const { state, nonce } = issueSignInState(deps.links, c.req.query('returnTo'));
      setCookie(c, STATE_COOKIE, nonce, { httpOnly: true, sameSite: 'Lax', path: '/auth', maxAge: 600 });
      return c.redirect(auth.authorizeUrl(state, auth.boardRedirectUri(originOf(c))));
    });

    app.get('/auth/callback', async (c) => {
      const cookie = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { path: '/auth' });
      const code = c.req.query('code');
      const local = originOf(c).startsWith('http://localhost');
      const cookieOptional = local && auth.config.LOCAL_SIGN_IN_WITHOUT_COOKIE;
      const check = checkSignInState(deps.links, c.req.query('state'), cookie, !cookieOptional);
      if (!check.ok || code === undefined) {
        // Which check failed, and which cookies arrived (names only), so a failed sign-in can be diagnosed.
        const cookieNames = (c.req.header('cookie') ?? '').split(';').map((p) => p.split('=')[0]?.trim()).filter(Boolean).join(',');
        const reason =
          `state ${check.ok ? 'valid' : check.reason}, state cookie ${cookie === undefined ? 'missing' : 'present'}` +
          `, code ${code === undefined ? 'missing' : 'present'}, cognito error ${printable(c.req.query('error') ?? 'none')}, host ${printable(c.req.header('host') ?? '?')}, cookies [${printable(cookieNames)}]`;
        console.warn(`[auth] board callback rejected: ${reason}`);
        // On a local dev server, show the reason on the page too; it holds no secrets (cookie names only).
        return c.text(`Sign-in failed: the request did not match. Try again.${local ? `\n\n(${reason})` : ''}`, 400);
      }
      const identity = await auth.completeSignIn(code, auth.boardRedirectUri(originOf(c)));
      if (identity === null) return c.text('Sign-in failed.', 401);
      const session = await auth.createSession(identity);
      setCookie(c, SESSION_COOKIE, session, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure: originOf(c).startsWith('https:'),
        maxAge: SESSION_MAX_AGE,
      });
      return c.redirect(check.returnTo);
    });
  }

  app.post('/auth/logout', async (c) => {
    const session = getCookie(c, SESSION_COOKIE);
    if (session !== undefined) await auth.endSession(session);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({});
  });

  // Everything under /api needs a person: a board session or a bearer token.
  app.use('/api/*', async (c: Context<Env>, next) => {
    const header = c.req.header('authorization');
    let email: string | null = null;
    if (header?.startsWith('Bearer ') === true) {
      email = await auth.bearerEmail(header.slice(7));
    } else {
      const session = getCookie(c, SESSION_COOKIE);
      if (session !== undefined) email = await auth.sessionEmail(session);
    }
    if (email === null) return c.json({ code: 'unauthenticated', message: 'Sign in first' }, 401);
    c.set('email', email);
    await next();
  });

  app.get('/api/me', async (c) => {
    const email = c.get('email');
    const memberships = await boards.memberships(email);
    // The status bar's counts per board, over your globs only (planned or implemented by you): globs
    // waiting on a person, routine runs in progress and, per sign-off label, reviews needing you
    // (required: review it; added: work through the items).
    const open = STATUSES.filter((s) => s !== 'signed_off');
    const views = await Promise.all(
      memberships.map(async (m) => {
        const listed = await globs.list(email, m.board.id, { status: open, include: 'all' });
        const list = (listed.ok ? listed.value : []).filter((g) => isMine(g, email));
        const reviews = Object.fromEntries(
          LABEL_NAMES.map((name) => [
            name,
            list.filter((g) => {
              const state = g.labels[name];
              return g.status === 'reviewing' && (state === 'required' || state === 'added');
            }).length,
          ]),
        );
        // Your turn: the due steps that are yours to do, over every open glob on the board (not only your own).
        const everyone = await globs.listWithArtifacts(email, m.board.id, { status: open, include: 'all' });
        const stored = await globs.humanStepsOf(m.board.id);
        const viewer = { email, role: m.role };
        // Stalled: nobody is moving the glob (a failed step, a quiet run, nobody on it). Derived from the glob alone here;
        // the board's list adds effects, deploys and uploads for the full picture.
        const now = new Date().toISOString();
        const thresholds = stallThresholds(m.board);
        const holdings = new Map((everyone.ok ? everyone.value : []).map((r) => [r.glob.id, r.holding]));
        const stalled = list.filter(
          (g) => whoseMove(g, humanSteps(g, { rolloutSteps: openRolloutSteps(stored.get(g.id) ?? []) }, stored.get(g.id) ?? []), machineSteps(g), holdings.get(g.id) ?? [], now, { viewer, thresholds, complete: false }).holder === 'stalled',
        ).length;
        const yourTurn = (everyone.ok ? everyone.value : []).reduce(
          (n, { glob, artifacts }) =>
            n +
            stepsForViewer(
              humanSteps(glob, { recordAtHead: machine.recordAtHead(glob, { recordSha: machine.recordShaOf(artifacts) }), rolloutSteps: openRolloutSteps(stored.get(glob.id) ?? []) }, stored.get(glob.id) ?? []).filter((s) => s.state === 'due'),
              glob,
              viewer,
            ).length,
          0,
        );
        return {
          ...m.board,
          role: m.role,
          yourTurn,
          // Your board bar: the board's place in it (null: not in it) and when you last opened it. Yours only.
          position: m.position,
          lastViewedAt: m.lastViewedAt,
          attention: list.filter(needsHuman).length,
          running: list.filter(machine.hasLiveRun).length,
          stalled,
          supers: list.filter((g) => g.type === 'super' && listOf(g.status) === 'doing').length,
          reviews,
        };
      }),
    );
    return c.json({ email, boards: views });
  });

  // ---------------------------------------------------------------------------
  // Boards and members

  app.get('/api/boards', async (c) => {
    const memberships = await boards.memberships(c.get('email'));
    return c.json(memberships.map((m) => ({ ...m.board, role: m.role })));
  });

  app.post('/api/boards', async (c) => {
    const body = await parse(c, createBoardSchema);
    if (body instanceof Response) return body;
    const created = await boards.create(c.get('email'), body);
    if (created.ok) await deps.onBoardCreated(c.get('email'), created.value.id);
    return send(c, created);
  });

  app.get('/api/boards/:b', async (c) =>
    send(c, await boards.get(c.get('email'), Number(c.req.param('b'))), (m) => ({ ...m.board, role: m.role })),
  );

  // Board sessions (your board bar). The web app records an open once per board visit; MCP reads don't count.
  // Each returns your sessions so the client can patch its /api/me cache without refetching it.
  app.post('/api/boards/:b/viewed', async (c) =>
    send(c, await boards.openBoard(c.get('email'), Number(c.req.param('b')), new Date().toISOString()), (sessions) => ({ sessions })),
  );
  app.put('/api/boards/:b/session', async (c) =>
    send(c, await boards.addSession(c.get('email'), Number(c.req.param('b'))), (sessions) => ({ sessions })),
  );
  app.delete('/api/boards/:b/session', async (c) =>
    send(c, await boards.removeSession(c.get('email'), Number(c.req.param('b'))), (sessions) => ({ sessions })),
  );

  app.patch('/api/boards/:b/settings', async (c) => {
    const body = await parse(c, settingsSchema);
    if (body instanceof Response) return body;
    const { version, ...settings } = body;
    return send(c, await boards.updateSettings(c.get('email'), Number(c.req.param('b')), version, settings));
  });

  // This month's LLM spend (every board model call, by source), for the line on the board.
  app.get('/api/boards/:b/spend', async (c) => {
    const { spend } = deps;
    if (spend === undefined) return c.json({ code: 'not_found', message: 'Spend is not tracked' }, 404);
    const boardId = Number(c.req.param('b'));
    const member = await boards.get(c.get('email'), boardId);
    if (!member.ok) return send(c, member);
    return send(c, await spend.monthToDate(boardId));
  });

  // The group backfill (admins): a dry run unless `apply` is true. `slop group-backfill` calls it.
  app.post('/api/boards/:b/groups/backfill', async (c) => {
    const { groupBackfill } = deps;
    if (groupBackfill === undefined) return c.json({ code: 'not_found', message: 'The group backfill is not available' }, 404);
    const body = await parse(c, z.object({ apply: z.boolean().default(false) }));
    if (body instanceof Response) return body;
    return send(c, await groupBackfill.run(c.get('email'), Number(c.req.param('b')), body.apply));
  });

  // Groups are derived from the globs that carry the name: no stored group. The literal `backfill` route above is registered first.
  app.get('/api/boards/:b/groups', async (c) => {
    const { groups } = deps;
    if (groups === undefined) return c.json({ code: 'not_found', message: 'Groups are not available' }, 404);
    return send(c, await groups.list(c.get('email'), Number(c.req.param('b'))));
  });

  app.get('/api/boards/:b/groups/:name', async (c) => {
    const { groups } = deps;
    if (groups === undefined) return c.json({ code: 'not_found', message: 'Groups are not available' }, 404);
    return send(c, await groups.view(c.get('email'), Number(c.req.param('b')), c.req.param('name')));
  });

  // Rename (a new name) and merge (into an existing group): the new name goes on every glob in the group, one event per glob.
  app.post('/api/boards/:b/groups/:name/rename', async (c) => {
    const { groups } = deps;
    if (groups === undefined) return c.json({ code: 'not_found', message: 'Groups are not available' }, 404);
    const body = await parse(c, z.object({ to: z.string() }));
    if (body instanceof Response) return body;
    return send(c, await groups.rename(c.get('email'), Number(c.req.param('b')), c.req.param('name'), body.to));
  });

  app.post('/api/boards/:b/groups/:name/merge', async (c) => {
    const { groups } = deps;
    if (groups === undefined) return c.json({ code: 'not_found', message: 'Groups are not available' }, 404);
    const body = await parse(c, z.object({ into: z.string() }));
    if (body instanceof Response) return body;
    return send(c, await groups.merge(c.get('email'), Number(c.req.param('b')), c.req.param('name'), body.into));
  });

  app.get('/api/boards/:b/members', async (c) =>
    send(c, await boards.members(c.get('email'), Number(c.req.param('b')))),
  );

  app.post('/api/boards/:b/members', async (c) => {
    const body = await parse(c, z.object({ email: z.email(), role: z.enum(ROLES).default('dev') }));
    if (body instanceof Response) return body;
    return send(c, await boards.setMember(c.get('email'), Number(c.req.param('b')), body.email, body.role));
  });

  app.patch('/api/boards/:b/members/:email', async (c) => {
    const body = await parse(c, z.object({ role: z.enum(ROLES) }));
    if (body instanceof Response) return body;
    return send(c, await boards.setMember(c.get('email'), Number(c.req.param('b')), c.req.param('email'), body.role));
  });

  app.delete('/api/boards/:b/members/:email', async (c) =>
    send(c, await boards.removeMember(c.get('email'), Number(c.req.param('b')), c.req.param('email'))),
  );

  // ---------------------------------------------------------------------------
  // Globs

  app.get('/api/boards/:b/globs', async (c) => {
    const email = c.get('email');
    const boardId = Number(c.req.param('b'));
    const membership = await boards.get(email, boardId);
    if (!membership.ok) return send(c, membership);
    const status = c.req.query('status');
    // The board shows open globs and only the latest signed-off ones; read those first so artifacts load for them alone.
    // Decisions share the board with work; a rejected or closed one is archived and not shown.
    const signedOff = await globs.list(email, boardId, { status: ['signed_off'], include: 'all' });
    if (!signedOff.ok) return send(c, signedOff);
    const steps = await globs.humanStepsOf(boardId);
    // A signed-off glob with an open rollout step stays on the board, whatever the cap: its Arm system label is still to act on.
    const armed = signedOff.value.filter((g) => shown(g) && (steps.get(g.id) ?? []).some(armsStored)).map((g) => g.id);
    const kept = new Set([...latestSignedOff(signedOff.value.filter(shown)).map((g) => g.id), ...armed]);
    const result = await globs.listWithArtifacts(
      email,
      boardId,
      { include: 'all', ...(status === undefined ? {} : { status: z.array(z.enum(STATUSES)).parse(status.split(',')) }) },
      (g) => shown(g) && (g.status !== 'signed_off' || kept.has(g.id)),
    );
    const splits = await globs.splitsOf(boardId);
    const workstreams = await globs.workstreamsOf(boardId);
    const oversized = await globs.oversizedOf(boardId);
    const dismissed = await globs.dismissedKeysOf(email, boardId);
    const gateCheck = await globs.gateCheckOf(boardId);
    // Open actions that run a script: whether the base branch has it (cached), so the list's Done agrees with the glob's own read.
    const scripts = await globs.scriptChecksOf(boardId);
    const now = new Date().toISOString();
    const viewer = { email, role: membership.value.role };
    const thresholds = stallThresholds(membership.value.board);
    // A picked-up learning's recommendation job reads as a machine step ("getting a recommendation").
    const recommending = result.ok ? await globs.recommendationEffectsOf(result.value.map((r) => r.glob)) : new Map<string, PendingEffect[]>();
    return send(c, result, (list) =>
      list.map(({ glob, artifacts, relations, holding, holdsBack, suggestions }) => {
        const view = globViewFor(glob, email, membership.value.role, artifacts, relations, holding, steps.get(glob.id), scripts.get(glob.id));
        // Whose move it is: the one position the card, the filters and the counts all read. Derived on every read, never stored.
        // Outbox effects, deploys and uploads aren't read here yet, so those steps are missing from the list's picture.
        const facts = machineSteps(glob, { effects: recommending.get(glob.id) ?? [] });
        const human = humanSteps(glob, { recordAtHead: machine.recordAtHead(glob, { recordSha: machine.recordShaOf(artifacts) }), rolloutSteps: openRolloutSteps(steps.get(glob.id) ?? []) }, steps.get(glob.id) ?? []);
        const move = whoseMove(glob, human, facts, holding, now, { viewer, thresholds, complete: false });
        return {
          ...view,
          // Who waits for this glob (other boards' too, redacted for a viewer outside them) and the open card suggestions: only when there are some.
          ...(holdsBack === undefined ? {} : { holdsBack }),
          ...(suggestions === undefined ? {} : { suggestions }),
          // A stalled glob also hands a step to its implementer (or planner).
          humanSteps: withUnstick(human, move, glob, { allowed: view.allowedActions ?? [], session: glob.runs.some((r) => r.state !== 'ended' && r.sessionUrl != null) }).map(compactStep),
          move,
          ...armField(armView(human, membership.value.board)),
          dismissedKeys: dismissed.get(glob.id) ?? [],
          gateCheck,
          machineSteps: facts,
          ...splitField(splits.get(glob.id)),
          ...workstreamsField(workstreams.get(glob.id)),
          ...(oversized.has(glob.id) ? { oversized: true } : {}),
        };
      }),
    );
  });

  // How many globs are signed off in all (the board's column shows the latest few).
  app.get('/api/boards/:b/signed-off/count', async (c) =>
    send(c, await globs.list(c.get('email'), Number(c.req.param('b')), { status: ['signed_off'], include: 'all' }), (list) => ({ total: list.filter(shown).length })),
  );

  app.get('/api/boards/:b/signed-off', async (c) => {
    const email = c.get('email');
    const result = await globs.list(email, Number(c.req.param('b')), { status: ['signed_off'], include: 'all' });
    const cursor = c.req.query('cursor');
    const pageSize = 50;
    return send(c, result, (list) => {
      const sorted = bySignedOffNewest(list.filter(shown));
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = sorted.slice(start, start + pageSize);
      return {
        globs: page.map((g) => globView(g)),
        next: start + pageSize < sorted.length ? String(start + pageSize) : null,
      };
    });
  });

  app.post('/api/boards/:b/globs', async (c) => {
    const body = await parse(c, createGlobSchema);
    if (body instanceof Response) return body;
    const email = c.get('email');
    const { intake, needs, group, relations, holds, follows_up: followsUp, supersedes, type, actor, mode, fix, workKind, fixSource, workKindSource, inferenceReason, category, questions, ...fields } = body;
    const boardId = Number(c.req.param('b'));
    const kind = resolveKind({ actor, mode, type, category, fix, workKind }, true);
    if (!kind.ok) return send(c, invalidInput(kind.message));
    // An action has no type; code work defaults to a same.
    const chosenType = kind.type === undefined ? (kind.category === 'action' ? null : 'same') : kind.type;
    const inferrer = deps.intake;
    const kindOf =
      fixSource !== undefined || workKindSource !== undefined || inferenceReason !== undefined
        ? // The form passes back intake's chips with who set each: kept as given, no second model call.
          {
            category: kind.category ?? 'task',
            ...(kind.fix === undefined ? {} : { fix: kind.fix, fixSource: fixSource ?? 'person' }),
            ...(kind.workKind === undefined ? {} : { workKind: kind.workKind, workKindSource: workKindSource ?? 'person' }),
            ...(inferenceReason === undefined ? {} : { inferenceReason }),
          }
        : await createKindFields(
            { type: chosenType, category: kind.category, fix: kind.fix, workKind: kind.workKind },
            inferrer?.inferWork === undefined || kind.category === 'action' ? undefined : () => inferrer.inferWork?.(boardId, { title: fields.title, plan: fields.plan ?? '' }) as ReturnType<IntakeService['inferWork']>,
          );
    let chosen: string | null = group?.trim() === '' ? null : (group ?? null);
    if (group === undefined && deps.intake !== undefined) {
      const suggested = await deps.intake.suggestGroup(email, boardId, { title: fields.title, plan: fields.plan ?? '' });
      if (suggested.ok) chosen = suggested.value;
    }
    const created = await globs.create(email, {
      ...fields,
      ...kindOf,
      type: chosenType,
      group: chosen,
      ...(needs === undefined && fields.after === undefined ? {} : { after: needs ?? fields.after ?? [] }),
      ...(relations === undefined ? {} : { relations: relationInputs(relations) }),
      ...(holds === undefined && followsUp === undefined ? {} : { holds: holdInputs([...(holds ?? []), ...(followsUp ?? [])]) }),
      ...(supersedes === undefined ? {} : { supersedes: supersedeInputs(supersedes) }),
      source: 'web',
      ...(intake === undefined ? {} : { intake: { ...intake, source: 'web' } }),
      ...(questions === undefined || questions.length === 0
        ? {}
        : { questions: questions.map((q): NewQuestion => ({ ...q, source: 'create', raisedBy: { kind: 'intake', actor: null } })) }),
      boardId,
    });
    if (!created.ok) return send(c, created);
    // Return once provisioning has been attempted.
    await deps.outbox.drain(created.value.id);
    return send(c, await globs.get(email, created.value.id), globViewOf);
  });

  app.get('/api/globs/:id', async (c) => {
    const view = await globs.get(c.get('email'), c.req.param('id'));
    if (!view.ok) return send(c, view);
    // A member's read looks at the glob's pending files (best effort); a change reaches the page by its live hint.
    await deps.attachments?.refreshGlob(view.value.glob.id).catch(() => undefined);
    const split = (await globs.splitsOf(view.value.glob.boardId)).get(view.value.glob.id);
    const workstreams = (await globs.workstreamsOf(view.value.glob.boardId)).get(view.value.glob.id);
    // The same machine steps as the board list, so the glob view's header and the card agree (e.g. a deploy still running).
    const gateCheck = await globs.gateCheckOf(view.value.glob.boardId);
    const handoffs = await globs.handoffsOf(view.value.glob.boardId, view.value.glob.id);
    const effects = (await globs.recommendationEffectsOf([view.value.glob])).get(view.value.glob.id) ?? [];
    return send(c, view, (v) => ({ ...globViewOf(v), gateCheck, machineSteps: machineSteps(v.glob, { effects }), handoffs, ...splitField(split), ...workstreamsField(workstreams) }));
  });

  app.patch('/api/globs/:id', async (c) => {
    const body = await parse(c, updateGlobSchema);
    if (body instanceof Response) return body;
    const { version, needs, relations, supersedes, mode, ...changes } = body;
    const kind = resolveKind({ mode, type: changes.type }, false);
    if (!kind.ok) return send(c, invalidInput(kind.message));
    if (kind.type !== undefined && kind.type !== null) changes.type = kind.type;
    const after = needs ?? changes.after;
    return withView(
      c,
      await globs.update(c.get('email'), c.req.param('id'), version, { ...changes, ...(after === undefined ? {} : { after }), ...(relations === undefined ? {} : { relations: relationInputs(relations) }), ...(supersedes === undefined ? {} : { supersedes: supersedeInputs(supersedes) }) }),
    );
  });

  // Split a glob in Planning into parts (the board's Split; MCP's split_glob).
  app.post('/api/globs/:id/split', async (c) => {
    const body = await parse(c, splitGlobSchema);
    if (body instanceof Response) return body;
    const email = c.get('email');
    const split = await globs.split(email, c.req.param('id'), body.version, {
      idempotencyKey: body.idempotencyKey,
      ...(body.group === undefined ? {} : { group: body.group }),
      parts: body.parts.map(({ category, type, mode, after, attachments, ...rest }) => ({
        ...rest,
        ...(category === undefined ? {} : { category }),
        ...((mode ?? type) === undefined ? {} : { type: mode ?? type }),
        ...(after === undefined ? {} : { after }),
        ...(attachments === undefined ? {} : { attachments }),
      })),
    });
    if (!split.ok) return send(c, split);
    for (const glob of split.value) await deps.outbox.drain(glob.id);
    const relations = await globs.peekRelations(split.value.map((g) => g.id));
    return send(c, split, (list) => ({ parts: list.map((glob) => globView(glob, null, null, null, null, relations.get(glob.id) ?? [])) }));
  });

  app.delete('/api/globs/:id', async (c) => {
    const body = await parse(c, versionSchema);
    if (body instanceof Response) return body;
    return send(c, await globs.delete(c.get('email'), c.req.param('id'), body.version), () => ({}));
  });

  const actions = {
    start: (email: string, id: string, b: ActionBody) => globs.start(email, id, b.version),
    'start-anyway': (email: string, id: string, b: ActionBody) => globs.startAnyway(email, id, b.version),
    investigate: (email: string, id: string, b: ActionBody) => globs.investigate(email, id, b.version),
    // Queues an independent review of the PR as it is now (any member; the version is not checked, nothing on the glob changes).
    'review-now': (email: string, id: string) => globs.reviewNow(email, id),
    retrigger: (email: string, id: string, b: ActionBody) => globs.retrigger(email, id, b.version, b.anyway === true),
    'retry-autofix': (email: string, id: string, b: ActionBody) => globs.retryAutofix(email, id, b.version),
    'resolve-conflict': (email: string, id: string, b: ActionBody) => globs.resolveConflict(email, id, b.version),
    // Decision globs (the outcome has its own route: POST /api/globs/:id/decision).
    'sign-off': (email: string, id: string, b: ActionBody) => globs.signOffDecision(email, id, b.version),
    reopen: (email: string, id: string, b: ActionBody) => (deps.decisions ?? { reopen: (e: string, i: string, v: number) => globs.reopenDecision(e, i, v) }).reopen(email, id, b.version),
    // Action globs: a person did it (optional note), or it is not needed (reason required).
    done: (email: string, id: string, b: ActionBody) => globs.completeAction(email, id, b.version, b.note),
    dismiss: (email: string, id: string, b: ActionBody) => globs.dismissAction(email, id, b.version, b.reason ?? ''),
    'pick-up': (email: string, id: string, b: ActionBody) => globs.pickUp(email, id, b.version, false, b.environment),
    'take-over': (email: string, id: string, b: ActionBody) => globs.pickUp(email, id, b.version, true, b.environment),
    'start-again': (email: string, id: string, b: ActionBody) => globs.startAgain(email, id, b.version),
    merge: async (email: string, id: string, b: ActionBody) => {
      const gate = await deps.mergeGate?.(email, id);
      return gate !== undefined && !gate.ok ? gate : globs.merge(email, id, b.version);
    },
    deescalate: (email: string, id: string, b: ActionBody) => globs.deescalate(email, id, b.version),
    'make-super': (email: string, id: string, b: ActionBody) => globs.makeSuper(email, id, b.version),
    'cancel-merge': (email: string, id: string, b: ActionBody) => globs.cancelMerge(email, id, b.version),
    'retry-merge': (email: string, id: string, b: ActionBody) => globs.retryMerge(email, id, b.version),
    // Alias for one release: `merge` already keeps a same with rollout steps open. A super's checkpoint merge (row 31) needs
    // the latest postplan at the head.
    'merge-continue': async (email: string, id: string, b: ActionBody) => {
      const gate = await deps.mergeGate?.(email, id);
      return gate !== undefined && !gate.ok ? gate : globs.merge(email, id, b.version, true);
    },
    'mark-ready': async (email: string, id: string, b: ActionBody) => {
      const gate = await deps.readyGate?.(email, id);
      return gate !== undefined && !gate.ok ? gate : globs.requestReadyFromBoard(email, id, b.version);
    },
  } as const;

  const BACKGROUND_DRAIN: ReadonlySet<keyof typeof actions> = new Set([
    'review-now',
    'start',
    'start-anyway',
    'investigate',
    'retrigger',
    'retry-autofix',
    'resolve-conflict',
    'pick-up',
    'take-over',
    'start-again',
  ]);

  app.post('/api/globs/:id/actions/:action', async (c) => {
    const action = z.enum(Object.keys(actions) as [keyof typeof actions]).safeParse(c.req.param('action'));
    if (!action.success) return c.json({ code: 'not_found', message: 'Unknown action' }, 404);
    const body = await parse(c, actionSchema);
    if (body instanceof Response) return body;
    const result = await actions[action.data](c.get('email'), c.req.param('id'), body);
    if (result.ok) {
      const drained = deps.outbox.drain(result.value.id);
      // A review takes minutes, and starting or handing over a glob provisions its branch and PR and fires a routine (GitHub
      // calls, seconds): those run in the background and the glob view answers at once, with provisioning still pending.
      // The board's live hint shows the result, and the outbox poller picks the jobs up if this drain is cut short.
      if (BACKGROUND_DRAIN.has(action.data)) void drained.catch(() => undefined);
      else await drained;
    }
    return withView(c, result);
  });

  // Sign-off labels and their review checklists (rows 21, 22, 27–30).
  app.post('/api/globs/:id/labels/:label', async (c) => {
    const label = z.enum(LABEL_NAMES).safeParse(c.req.param('label'));
    if (!label.success) return c.json({ code: 'not_found', message: 'Unknown label' }, 404);
    const body = await parse(c, z.object({ version: z.number().int(), command: labelCommandSchema }));
    if (body instanceof Response) return body;
    return withView(
      c,
      await globs.reviewLabel(c.get('email'), c.req.param('id'), body.version, label.data, body.command),
    );
  });

  // Add a relation (the Related section's "Add relation…", a decision's "Holds back…"). `to`: this glob can't pass the gate until
  // `to` reaches `until`; `holdsBack`: the other glob can't, until this one does. Answers with this glob's view.
  app.post('/api/globs/:id/relations', async (c) => {
    const body = await parse(c, addRelationSchema);
    if (body instanceof Response) return body;
    const { to, holdsBack, holdsBackGroup, supersedes, version, ...rest } = body;
    const id = c.req.param('id');
    if (supersedes !== undefined) {
      // This glob replaces `supersedes`: the row lands on that one, whose open steps are dismissed. Answers with this glob's view.
      const done = await globs.addSupersession(c.get('email'), id, supersedes, { reason: rest.reason ?? null });
      if (done.ok) void deps.outbox.drain(done.value.id).catch(() => undefined);
      return done.ok ? send(c, await globs.get(c.get('email'), id), globViewOf) : send(c, done);
    }
    if (holdsBackGroup !== undefined) {
      const held = await globs.holdGroup(c.get('email'), id, holdsBackGroup, relationInput({ ...rest, to: id }));
      if (held.ok) void deps.outbox.drain(id).catch(() => undefined);
      return held.ok ? send(c, await globs.get(c.get('email'), id), (v) => ({ ...globViewOf(v), groupHold: held.value })) : send(c, held);
    }
    const other = to ?? holdsBack ?? '';
    const added = await globs.addRelation(c.get('email'), id, version ?? null, relationInput({ ...rest, to: other }), to === undefined ? 'holds_back' : 'held_by');
    if (added.ok) void deps.outbox.drain(added.value.id).catch(() => undefined);
    return added.ok ? send(c, await globs.get(c.get('email'), id), globViewOf) : send(c, added);
  });

  // The ✕ on a Related row: the relation is not a dependency (a held glob that waited only for it then starts, a held merge goes on).
  app.post('/api/globs/:id/relations/:relationId/dismiss', async (c) => {
    const body = await parse(c, versionSchema);
    if (body instanceof Response) return body;
    const result = await globs.dismissRelation(c.get('email'), c.req.param('id'), body.version, c.req.param('relationId'));
    if (result.ok) void deps.outbox.drain(result.value.id).catch(() => undefined);
    return withView(c, result);
  });

  // Open questions (the glob view's Questions section). A person raises, answers or dismisses one; the web never passes a run ID, so
  // these are always a person's call. Answering writes the Clarifications attachment and releases what the question held.
  const raiseQuestionSchema = z.object({
    text: z.string().min(1).max(MAX_QUESTION_TEXT),
    options: z.array(z.string().min(1).max(MAX_QUESTION_OPTION)).max(MAX_QUESTION_OPTIONS).optional(),
    blocking: z.enum(QUESTION_BLOCKING).optional(),
    key: z.string().min(1).max(120).optional(),
  });
  const answerQuestionSchema = z.object({
    answer: z.string().max(MAX_QUESTION_ANSWER).optional(),
    option: z.string().min(1).optional(),
    // Accepted for the web's request shape; a question's answer does not depend on the glob's version.
    version: z.number().int().optional(),
  });
  const dismissQuestionSchema = z.object({ note: z.string().max(MAX_QUESTION_NOTE).optional(), version: z.number().int().optional() });

  app.post('/api/globs/:id/questions', async (c) => {
    const body = await parse(c, raiseQuestionSchema);
    if (body instanceof Response) return body;
    const email = c.get('email');
    const id = c.req.param('id');
    const raised = await globs.raiseQuestion(email, id, {
      text: body.text,
      ...(body.options === undefined ? {} : { options: body.options }),
      ...(body.key === undefined ? {} : { key: body.key }),
      blocking: body.blocking ?? 'none',
      source: 'other',
      raisedBy: { kind: 'person', actor: email },
    });
    if (raised.ok) void deps.outbox.drain(id).catch(() => undefined);
    return raised.ok ? send(c, await globs.get(email, id), globViewOf) : send(c, raised);
  });

  app.post('/api/globs/:id/questions/:qid/answer', async (c) => {
    const body = await parse(c, answerQuestionSchema);
    if (body instanceof Response) return body;
    const result = await globs.answerQuestion(c.get('email'), c.req.param('id'), c.req.param('qid'), { answer: body.answer ?? '', option: body.option ?? null });
    if (result.ok) void deps.outbox.drain(result.value.id).catch(() => undefined);
    return withView(c, result);
  });

  app.post('/api/globs/:id/questions/:qid/dismiss', async (c) => {
    const body = await parse(c, dismissQuestionSchema);
    if (body instanceof Response) return body;
    const result = await globs.dismissQuestion(c.get('email'), c.req.param('id'), c.req.param('qid'), { note: body.note ?? null });
    if (result.ok) void deps.outbox.drain(result.value.id).catch(() => undefined);
    return withView(c, result);
  });

  // "Got it" / ×: the viewer has read a status message (the key names the situation, so a new one shows again); DELETE is Show again.
  const dismissalBody = z.object({ key: z.string() });
  for (const [method, dismiss] of [['post', true], ['delete', false]] as const) {
    app[method]('/api/globs/:id/dismiss', async (c) => {
      const body = await parse(c, dismissalBody);
      if (body instanceof Response) return body;
      const result = await globs.setStatusDismissed(c.get('email'), c.req.param('id'), body.key, dismiss);
      return result.ok ? send(c, await globs.get(c.get('email'), result.value.globId), globViewOf) : send(c, result);
    });
  }

  app.post('/api/globs/:id/environments/:env/deployed', async (c) => {
    const email = c.get('email');
    const id = c.req.param('id');
    const marked = await globs.markEnvironmentDeployed(email, id, c.req.param('env'));
    return marked.ok ? send(c, await globs.get(email, id), globViewOf) : send(c, marked);
  });

  // Human steps (the glob view's Human steps section; MCP's add/complete/dismiss_human_step). Each answers with the glob's
  // view, steps included, so the page replaces its state. A step change leaves the glob's version alone, so it is optional.
  const stepVersion = z.number().int().optional();
  const afterStep = async (c: Context<Env>, result: Awaited<ReturnType<GlobService['addHumanStep']>>) =>
    result.ok ? send(c, await globs.get(c.get('email'), result.value.globId), globViewOf) : send(c, result);

  app.post('/api/globs/:id/human-steps', async (c) => {
    const body = await parse(
      c,
      z.object({
        version: stepVersion,
        title: z.string().min(1),
        kind: z.enum(HUMAN_STEP_KINDS).optional(),
        detail: z.string().optional(),
        why: z.string().optional(),
        permissions: z.string().optional(),
        commands: z.array(z.string()).optional(),
        verify: z.string().optional(),
        who: z.string().optional(),
        due: z.string().optional(),
        once: z.boolean().optional(),
      }),
    );
    if (body instanceof Response) return body;
    const { version, ...step } = body;
    return afterStep(c, await globs.addHumanStep(c.get('email'), c.req.param('id'), version ?? null, step, 'person'));
  });

  app.post('/api/globs/:id/human-steps/:stepId/complete', async (c) => {
    const body = await parse(c, z.object({ version: stepVersion, note: z.string().max(OUTCOME_REASON_MAX).optional() }));
    if (body instanceof Response) return body;
    return afterStep(c, await globs.completeHumanStep(c.get('email'), c.req.param('id'), c.req.param('stepId'), body.version ?? null, body.note));
  });

  app.post('/api/globs/:id/human-steps/:stepId/dismiss', async (c) => {
    const body = await parse(c, z.object({ version: stepVersion, reason: z.string().min(1) }));
    if (body instanceof Response) return body;
    return afterStep(c, await globs.dismissHumanStep(c.get('email'), c.req.param('id'), c.req.param('stepId'), body.reason, body.version ?? null));
  });

  // "It failed": a step's run failed (the note is the pasted output, masked before it is stored). A rollout step of a merged glob
  // starts the glob's next generation (a fresh branch from master, the failure as in-scope feedback; provisioning runs in the
  // background, as start-again does); any other step stays open and slop asks whether a glob fixes it.
  app.post('/api/globs/:id/steps/:stepId/fail', async (c) => {
    const body = await parse(c, z.object({ note: z.string().trim().min(1).max(100_000), version: z.number().int().nullable().optional() }));
    if (body instanceof Response) return body;
    const failed = await globs.failHumanStep(c.get('email'), c.req.param('id'), c.req.param('stepId'), body.note, body.version ?? null);
    if (failed.ok) void deps.outbox.drain(failed.value.globId).catch(() => undefined);
    return afterStep(c, failed);
  });

  // A card suggestion (a possible prerequisite, supersedes, reverse relation or a failed step): accept writes the relation (for a
  // failed step, `glob` names the fix glob to link), dismiss remembers that it was declined. Both answer with the glob's view.
  const resolveSuggestion = async (c: Context<Env>, action: 'accept' | 'dismiss', glob: string | null) => {
    const result = await globs.resolveSuggestion(c.get('email'), c.req.param('id') ?? '', c.req.param('sid') ?? '', action, { glob });
    if (result.ok) void deps.outbox.drain(result.value.id).catch(() => undefined);
    return withView(c, result);
  };
  app.post('/api/globs/:id/suggestions/:sid/accept', async (c) => {
    const body = await parse(c, z.object({ glob: z.string().min(1).nullable().optional() }));
    if (body instanceof Response) return body;
    return resolveSuggestion(c, 'accept', body.glob ?? null);
  });
  app.post('/api/globs/:id/suggestions/:sid/dismiss', async (c) => resolveSuggestion(c, 'dismiss', null));

  /** Responds with the updated glob and the actions now open to the caller. */
  const withView = async (c: Context<Env>, result: Awaited<ReturnType<GlobService['start']>>) => {
    if (!result.ok) return send(c, result);
    // The same machine steps as the glob read, so the answer shows a picked-up decision's recommendation job ("investigating")
    // at once: the live hint that follows is skipped for a version the page already has.
    const view = await globs.get(c.get('email'), result.value.id);
    if (!view.ok) return send(c, view);
    const effects = (await globs.recommendationEffectsOf([view.value.glob])).get(view.value.glob.id) ?? [];
    return send(c, view, (v) => ({ ...globViewOf(v), machineSteps: machineSteps(v.glob, { effects }) }));
  };

  // ---------------------------------------------------------------------------
  // Live updates

  app.get('/api/boards/:b/events', async (c) => {
    const boardId = Number(c.req.param('b'));
    const membership = await boards.get(c.get('email'), boardId);
    if (!membership.ok) return send(c, membership);
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let notify: (() => void) | null = null;
      const unsubscribe = hub.subscribe(boardId, (hint) => {
        queue.push(JSON.stringify(hint));
        notify?.();
      });
      // Unsubscribe once, and wake the loop so it ends now instead of when the ping timer fires.
      stream.onAbort(() => {
        unsubscribe();
        notify?.();
      });
      const open = () => !stream.aborted;
      await stream.writeSSE({ event: 'ready', data: '{}' });
      try {
        while (open()) {
          const next = queue.shift();
          if (next !== undefined) {
            await stream.writeSSE({ event: 'hint', data: next });
            continue;
          }
          // Wait for a hint, or send a `ping` event every 25 seconds. It is a named event, not an SSE comment,
          // because the browser's EventSource hides comments, so the page couldn't tell a quiet stream from a dead one.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, deps.pingMs ?? 25_000);
            notify = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          notify = null;
          if (queue.length === 0 && open()) await stream.writeSSE({ event: 'ping', data: '{}' });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
};
