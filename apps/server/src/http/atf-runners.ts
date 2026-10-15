import { ATF_RUNNER_METHODS } from '@slop/core';
import type { AtfRunnerService } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface AtfRunnerRoutesDeps {
  readonly runners: Pick<AtfRunnerService, 'list' | 'create' | 'update' | 'revoke'>;
}

const claimRules = z
  .record(z.string().min(1).max(100), z.array(z.string().max(300)).max(20))
  .refine((rules) => Object.keys(rules).length <= 20, 'Too many claim rules');

/** A method's settings; unknown keys are refused so a typo can't silently leave a rule off. */
const configSchema = z.strictObject({
  issuer: z.string().max(500).optional(),
  claims: claimRules.optional(),
  roleArns: z.array(z.string().max(300)).max(20).optional(),
  accounts: z.array(z.string().max(20)).max(20).optional(),
  clientId: z.string().max(200).optional(),
});

const environments = z.array(z.string().min(1).max(100)).max(50);

const createBody = z.object({
  name: z.string().max(200),
  method: z.enum(ATF_RUNNER_METHODS),
  config: configSchema.optional(),
  environments,
});

const patchBody = z.object({
  name: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  environments: environments.optional(),
  config: configSchema.optional(),
});

/**
 * Board settings' ATF runners (spec, ATF runners), for the board's admins: list, register, change (rename, enable or
 * disable, environments, settings) and revoke. A runner's credential is never handled here: the registry holds only
 * who may present one. Revoking one runner touches no other and not the Meet notes token.
 */
export const mountAtfRunners = (app: Hono<Env>, deps: AtfRunnerRoutesDeps): void => {
  const board = (c: Context<Env>): number | null => {
    const id = Number(c.req.param('b'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const runnerId = (c: Context<Env>): number | null => {
    const id = Number(c.req.param('id'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const bad = (c: Context<Env>, message: string) => c.json({ code: 'invalid_input', message }, 422);

  app.get('/api/boards/:b/atf-runners', async (c) => {
    const boardId = board(c);
    if (boardId === null) return bad(c, 'Bad board');
    const result = await deps.runners.list(c.get('email'), boardId);
    return result.ok
      ? c.json({ value: result.value })
      : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.post('/api/boards/:b/atf-runners', async (c) => {
    const boardId = board(c);
    if (boardId === null) return bad(c, 'Bad board');
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return bad(c, body.error.issues[0]?.message ?? 'Bad runner');
    const result = await deps.runners.create(c.get('email'), boardId, body.data);
    return result.ok
      ? c.json({ value: result.value }, 201)
      : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.patch('/api/boards/:b/atf-runners/:id', async (c) => {
    const boardId = board(c);
    const id = runnerId(c);
    if (boardId === null || id === null) return bad(c, 'Bad runner');
    const body = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return bad(c, body.error.issues[0]?.message ?? 'Bad change');
    const result = await deps.runners.update(c.get('email'), boardId, id, body.data);
    return result.ok
      ? c.json({ value: result.value })
      : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.delete('/api/boards/:b/atf-runners/:id', async (c) => {
    const boardId = board(c);
    const id = runnerId(c);
    if (boardId === null || id === null) return bad(c, 'Bad runner');
    const result = await deps.runners.revoke(c.get('email'), boardId, id);
    return result.ok
      ? c.json({ value: result.value })
      : c.json(errorBody(result.error), statusOf(result.error));
  });
};
