import type { BoardService, GlobService, Result } from '@slop/core';
import { CATEGORIES, LABEL_NAMES, ROLES, SLOP_TYPES, STATUSES } from '@slop/core';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import { SESSION_COOKIE } from '../auth.js';
import type { OutboxRunner } from '../jobs/outbox.js';
import type { HintHub } from '../notifier.js';
import { errorBody, globView, globViewFor, onBoard, statusOf } from './views.js';

export interface AppDeps {
  readonly auth: Auth;
  readonly boards: BoardService;
  readonly globs: GlobService;
  readonly hub: HintHub;
  readonly outbox: OutboxRunner;
}

export type Env = { Variables: { email: string } };

const STATE_COOKIE = 'slop_oauth_state';

const environmentSchema = z.object({ name: z.string().min(1), allowBranchDeploy: z.boolean() });

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
});

const updateGlobSchema = z.object({
  version: z.number().int(),
  title: z.string().min(1).optional(),
  summary: z.string().optional(),
  type: z.enum(SLOP_TYPES).optional(),
  category: z.enum(CATEGORIES).optional(),
  group: z.string().min(1).nullable().optional(),
  environment: z.string().min(1).nullable().optional(),
});

const versionSchema = z.object({ version: z.number().int() });

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
      const body = await parse(c, z.object({ email: z.email(), name: z.string().optional() }));
      if (body instanceof Response) return body;
      const email = body.email.toLowerCase();
      const session = await auth.createSession({ email, name: body.name ?? email });
      setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: 'Lax', path: '/' });
      return c.json({ email });
    });
  }

  if (auth.config.AUTH_MODE === 'cognito') {
    app.get('/auth/login', (c) => {
      const state = randomBytes(16).toString('base64url');
      setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: 'Lax', path: '/auth', maxAge: 600 });
      return c.redirect(auth.authorizeUrl(state));
    });

    app.get('/auth/callback', async (c) => {
      const expected = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { path: '/auth' });
      const code = c.req.query('code');
      if (expected === undefined || c.req.query('state') !== expected || code === undefined) {
        return c.text('Sign-in failed: the request did not match. Try again.', 400);
      }
      const identity = await auth.completeSignIn(code);
      if (identity === null) return c.text('Sign-in failed.', 401);
      const session = await auth.createSession(identity);
      setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: 'Lax', path: '/', secure: auth.config.PUBLIC_URL.startsWith('https:') });
      return c.redirect('/');
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
    return c.json({ email, boards: memberships.map((m) => ({ ...m.board, role: m.role })) });
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
    return send(c, await boards.create(c.get('email'), body));
  });

  app.get('/api/boards/:b', async (c) =>
    send(c, await boards.get(c.get('email'), Number(c.req.param('b'))), (m) => ({ ...m.board, role: m.role })),
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
    const result = await globs.list(email, boardId, {
      ...(status === undefined ? {} : { status: z.array(z.enum(STATUSES)).parse(status.split(',')) }),
    });
    const now = Date.now();
    return send(c, result, (list) =>
      list.filter((g) => onBoard(g, now)).map((g) => globViewFor(g, email, membership.value.role)),
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
    const created = await globs.create(email, { ...body, boardId: Number(c.req.param('b')) });
    if (!created.ok) return send(c, created);
    // Return once provisioning has been attempted.
    await deps.outbox.drain(created.value.id);
    return send(c, await globs.get(email, created.value.id), (v) => globView(v.glob, v.allowedActions));
  });

  app.get('/api/globs/:id', async (c) =>
    send(c, await globs.get(c.get('email'), c.req.param('id')), (v) => globView(v.glob, v.allowedActions)),
  );

  app.patch('/api/globs/:id', async (c) => {
    const body = await parse(c, updateGlobSchema);
    if (body instanceof Response) return body;
    const { version, ...changes } = body;
    return withView(c, await globs.update(c.get('email'), c.req.param('id'), version, changes));
  });

  app.delete('/api/globs/:id', async (c) => {
    const body = await parse(c, versionSchema);
    if (body instanceof Response) return body;
    return send(c, await globs.delete(c.get('email'), c.req.param('id'), body.version), () => ({}));
  });

  const actions = {
    start: (email: string, id: string, v: number) => globs.start(email, id, v),
    retrigger: (email: string, id: string, v: number) => globs.retrigger(email, id, v),
    'pick-up': (email: string, id: string, v: number) => globs.pickUp(email, id, v, false),
    'take-over': (email: string, id: string, v: number) => globs.pickUp(email, id, v, true),
    'start-again': (email: string, id: string, v: number) => globs.startAgain(email, id, v),
    merge: (email: string, id: string, v: number) => globs.merge(email, id, v),
  } as const;

  app.post('/api/globs/:id/actions/:action', async (c) => {
    const action = z.enum(Object.keys(actions) as [keyof typeof actions]).safeParse(c.req.param('action'));
    if (!action.success) return c.json({ code: 'not_found', message: 'Unknown action' }, 404);
    const body = await parse(c, versionSchema);
    if (body instanceof Response) return body;
    const result = await actions[action.data](c.get('email'), c.req.param('id'), body.version);
    if (result.ok) await deps.outbox.drain(result.value.id);
    return withView(c, result);
  });

  app.put('/api/globs/:id/labels/:label', async (c) => {
    const label = z.enum(LABEL_NAMES).safeParse(c.req.param('label'));
    if (!label.success) return c.json({ code: 'not_found', message: 'Unknown label' }, 404);
    const body = await parse(c, z.object({ version: z.number().int(), state: z.enum(['required', 'added']) }));
    if (body instanceof Response) return body;
    return withView(c, await globs.setLabel(c.get('email'), c.req.param('id'), body.version, label.data, body.state));
  });

  /** Responds with the updated glob and the actions now open to the caller. */
  const withView = async (c: Context<Env>, result: Awaited<ReturnType<GlobService['start']>>) => {
    if (!result.ok) return send(c, result);
    return send(c, await globs.get(c.get('email'), result.value.id), (v) => globView(v.glob, v.allowedActions));
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
