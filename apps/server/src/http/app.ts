import type { BoardService, GlobService, Result, SizeCheckService, SplitInfo } from '@slop/core';
import { AGENT_KB_APPROVALS, CATEGORIES, CONFIDENCES, ENVIRONMENT_ROLES, LABEL_NAMES, MAX_SPLIT_PARTS, ROLES, SLOP_TYPES, STATUSES, isMine, listOf, machine, needsHuman } from '@slop/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import { SESSION_COOKIE, SESSION_DAYS } from '../auth.js';
import type { OutboxRunner } from '../jobs/outbox.js';
import type { ReadyGate } from '../ready-gate.js';
import type { HintHub } from '../notifier.js';
import type { SignedLinks } from '../signed-links.js';
import { labelCommandSchema } from './labels.js';
import { requestOrigin } from './origin.js';
import { checkSignInState, issueSignInState, safeReturnPath } from './sign-in-state.js';
import { errorBody, globView, globViewFor, globViewOf, onBoard, statusOf } from './views.js';

export interface AppDeps {
  readonly auth: Auth;
  readonly boards: BoardService;
  readonly globs: GlobService;
  readonly hub: HintHub;
  readonly outbox: OutboxRunner;
  /** Keep whole on a flagged glob; absent: its route isn't mounted. */
  readonly sizeCheck?: SizeCheckService;
  /** Refuses Ready for review for a branch that conflicts with its base. */
  readonly readyGate?: ReadyGate;
  /** Signs the board sign-in `state`. */
  readonly links: SignedLinks;
  /** Runs after a board is created (forks the catalog's agent set into it). */
  readonly onBoardCreated: (email: string, boardId: number) => Promise<void>;
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
  readinessTicks: z
    .object({ routines: z.boolean(), routine_repo: z.boolean(), claude_app: z.boolean() })
    .partial()
    .optional(),
});

export const createGlobSchema = z.object({
  title: z.string().min(1),
  summary: z.string().default(''),
  type: z.enum(SLOP_TYPES).default('same'),
  category: z.enum(CATEGORIES).default('task'),
  group: z.string().min(1).nullable().default(null),
  environment: z.string().min(1).nullable().default(null),
  autoTrigger: z.boolean().default(false),
  idempotencyKey: z.string().min(1).nullable().default(null),
  plan: z.string().optional(),
  /** IDs of globs on the board to start after. */
  after: z.array(z.string().min(1)).max(20).optional(),
  /** Files intake guessed the work changes: with the plan, they decide whether the merge policy's exclusive paths hold it. */
  files: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** What the intake proposal behind the form said, passed back so the glob's snapshot records it (the request is the text intake read). */
  intake: z
    .object({
      request: z.string().min(1).max(20000),
      categoryConfidence: z.enum(CONFIDENCES).nullable().default(null),
      reason: z.string().max(300).nullable().default(null),
      model: z.string().max(200).nullable().default(null),
      promptVersion: z.number().int().nullable().default(null),
      examples: z.array(z.string().min(1).max(40)).max(10).default([]),
    })
    .optional(),
});

export const splitGlobSchema = z.object({
  version: z.number().int(),
  idempotencyKey: z.string().min(1).nullable().default(null),
  parts: z
    .array(
      z.object({
        title: z.string().min(1),
        summary: z.string().default(''),
        plan: z.string().min(1),
        category: z.enum(CATEGORIES).optional(),
        type: z.enum(SLOP_TYPES).optional(),
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
  summary: z.string().optional(),
  type: z.enum(SLOP_TYPES).optional(),
  category: z.enum(CATEGORIES).optional(),
  group: z.string().min(1).nullable().optional(),
  environment: z.string().min(1).nullable().optional(),
  after: z.array(z.string().min(1)).max(20).optional(),
});

/** A glob that came from a split says where: `split: { source, part, parts }`. */
const splitField = (split: SplitInfo | undefined) => (split === undefined ? {} : { split });

const versionSchema = z.object({ version: z.number().int() });

/** Glob actions carry the version read; pick-up and take-over may also choose the environment. */
const actionSchema = versionSchema.extend({ environment: z.string().min(1).optional() });
type ActionBody = z.infer<typeof actionSchema>;

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

  const originOf = (c: Context<Env>) => requestOrigin(c, auth.config.PUBLIC_URL);

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
        const listed = await globs.list(email, m.board.id, { status: open });
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
        return {
          ...m.board,
          role: m.role,
          // Your board bar: the board's place in it (null: not in it) and when you last opened it. Yours only.
          position: m.position,
          lastViewedAt: m.lastViewedAt,
          attention: list.filter(needsHuman).length,
          running: list.filter(machine.hasLiveRun).length,
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
    const now = Date.now();
    const result = await globs.listWithArtifacts(
      email,
      boardId,
      { ...(status === undefined ? {} : { status: z.array(z.enum(STATUSES)).parse(status.split(',')) }) },
      (g) => onBoard(g, now),
    );
    const splits = await globs.splitsOf(boardId);
    const oversized = await globs.oversizedOf(boardId);
    return send(c, result, (list) =>
      list.map(({ glob, artifacts, dependencies }) => ({
        ...globViewFor(glob, email, membership.value.role, artifacts, dependencies),
        ...splitField(splits.get(glob.id)),
        ...(oversized.has(glob.id) ? { oversized: true } : {}),
      })),
    );
  });

  app.get('/api/boards/:b/signed-off', async (c) => {
    const email = c.get('email');
    const result = await globs.list(email, Number(c.req.param('b')), { status: ['signed_off'] });
    const cursor = c.req.query('cursor');
    const pageSize = 50;
    return send(c, result, (list) => {
      const sorted = [...list].sort((a, b) => (b.signedOffAt ?? '').localeCompare(a.signedOffAt ?? ''));
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
    const { intake, ...fields } = body;
    const created = await globs.create(email, {
      ...fields,
      source: 'web',
      ...(intake === undefined ? {} : { intake: { ...intake, source: 'web' } }),
      plan: body.plan ?? body.summary,
      boardId: Number(c.req.param('b')),
    });
    if (!created.ok) return send(c, created);
    // Return once provisioning has been attempted.
    await deps.outbox.drain(created.value.id);
    return send(c, await globs.get(email, created.value.id), globViewOf);
  });

  app.get('/api/globs/:id', async (c) => {
    const view = await globs.get(c.get('email'), c.req.param('id'));
    if (!view.ok) return send(c, view);
    const split = (await globs.splitsOf(view.value.glob.boardId)).get(view.value.glob.id);
    return send(c, view, (v) => ({ ...globViewOf(v), ...splitField(split) }));
  });

  app.patch('/api/globs/:id', async (c) => {
    const body = await parse(c, updateGlobSchema);
    if (body instanceof Response) return body;
    const { version, ...changes } = body;
    return withView(c, await globs.update(c.get('email'), c.req.param('id'), version, changes));
  });

  // Split a glob in Planning into parts (the board's Split; MCP's split_glob).
  app.post('/api/globs/:id/split', async (c) => {
    const body = await parse(c, splitGlobSchema);
    if (body instanceof Response) return body;
    const email = c.get('email');
    const split = await globs.split(email, c.req.param('id'), body.version, {
      idempotencyKey: body.idempotencyKey,
      parts: body.parts.map(({ category, type, after, attachments, ...rest }) => ({
        ...rest,
        ...(category === undefined ? {} : { category }),
        ...(type === undefined ? {} : { type }),
        ...(after === undefined ? {} : { after }),
        ...(attachments === undefined ? {} : { attachments }),
      })),
    });
    if (!split.ok) return send(c, split);
    for (const glob of split.value) await deps.outbox.drain(glob.id);
    return send(c, split, (list) => ({ parts: list.map((glob) => globView(glob)) }));
  });

  // Keep whole: a person decides a flagged glob stays one glob; a glob held for the flag then starts.
  const { sizeCheck } = deps;
  if (sizeCheck !== undefined) {
    app.post('/api/globs/:id/keep-whole', async (c) => {
      const email = c.get('email');
      const id = c.req.param('id');
      const kept = await sizeCheck.keepWhole(email, id);
      if (!kept.ok) return send(c, kept);
      const released = await globs.release(id);
      if (!released.ok) return send(c, released);
      await deps.outbox.drain(id);
      return send(c, await globs.get(email, id), globViewOf);
    });
  }

  app.delete('/api/globs/:id', async (c) => {
    const body = await parse(c, versionSchema);
    if (body instanceof Response) return body;
    return send(c, await globs.delete(c.get('email'), c.req.param('id'), body.version), () => ({}));
  });

  const actions = {
    start: (email: string, id: string, b: ActionBody) => globs.start(email, id, b.version),
    'start-anyway': (email: string, id: string, b: ActionBody) => globs.startAnyway(email, id, b.version),
    retrigger: (email: string, id: string, b: ActionBody) => globs.retrigger(email, id, b.version),
    'retry-autofix': (email: string, id: string, b: ActionBody) => globs.retryAutofix(email, id, b.version),
    'resolve-conflict': (email: string, id: string, b: ActionBody) => globs.resolveConflict(email, id, b.version),
    'pick-up': (email: string, id: string, b: ActionBody) => globs.pickUp(email, id, b.version, false, b.environment),
    'take-over': (email: string, id: string, b: ActionBody) => globs.pickUp(email, id, b.version, true, b.environment),
    'start-again': (email: string, id: string, b: ActionBody) => globs.startAgain(email, id, b.version),
    merge: (email: string, id: string, b: ActionBody) => globs.merge(email, id, b.version),
    // Supers: row 31, and the board's Ready for review (both need the latest postplan at the head).
    'merge-continue': (email: string, id: string, b: ActionBody) => globs.merge(email, id, b.version, true),
    'mark-ready': async (email: string, id: string, b: ActionBody) => {
      const gate = await deps.readyGate?.(email, id);
      return gate !== undefined && !gate.ok ? gate : globs.requestReadyFromBoard(email, id, b.version);
    },
  } as const;

  app.post('/api/globs/:id/actions/:action', async (c) => {
    const action = z.enum(Object.keys(actions) as [keyof typeof actions]).safeParse(c.req.param('action'));
    if (!action.success) return c.json({ code: 'not_found', message: 'Unknown action' }, 404);
    const body = await parse(c, actionSchema);
    if (body instanceof Response) return body;
    const result = await actions[action.data](c.get('email'), c.req.param('id'), body);
    if (result.ok) await deps.outbox.drain(result.value.id);
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

  /** Responds with the updated glob and the actions now open to the caller. */
  const withView = async (c: Context<Env>, result: Awaited<ReturnType<GlobService['start']>>) => {
    if (!result.ok) return send(c, result);
    return send(c, await globs.get(c.get('email'), result.value.id), globViewOf);
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
      stream.onAbort(unsubscribe);
      const open = () => !stream.aborted;
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (open()) {
        const next = queue.shift();
        if (next !== undefined) {
          await stream.writeSSE({ event: 'hint', data: next });
          continue;
        }
        // Wait for a hint, or send a keep-alive comment every 25 seconds.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25_000);
          notify = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        notify = null;
        if (queue.length === 0 && open()) await stream.write(': keep-alive\n\n');
      }
      unsubscribe();
    });
  });

  return app;
};
