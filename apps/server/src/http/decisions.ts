import type { DecisionService } from '@slop/core';
import type { Context, Hono } from 'hono';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface DecisionRoutesDeps {
  readonly decisions: Pick<DecisionService, 'forGlob' | 'confirm' | 'undo'>;
}

/** The decisions taken on a glob, and a member's confirm or undo of a replacement (members only, checked by the service). */
export const mountDecisions = (app: Hono<Env>, deps: DecisionRoutesDeps): void => {
  const send = <T extends object>(c: Context<Env>, result: { ok: true; value: T } | { ok: false; error: Parameters<typeof statusOf>[0] }) =>
    result.ok ? c.json(result.value) : c.json(errorBody(result.error), statusOf(result.error));
  const ids = (c: Context<Env>) => ({ board: Number(c.req.param('b')), decision: Number(c.req.param('id')) });

  app.get('/api/boards/:b/globs/:g/decisions', async (c) => {
    const board = Number(c.req.param('b'));
    if (!Number.isSafeInteger(board)) return c.json({ code: 'invalid_input', message: 'Bad board' }, 422);
    const result = await deps.decisions.forGlob(c.get('email'), board, c.req.param('g'));
    return result.ok ? c.json({ decisions: result.value }) : c.json(errorBody(result.error), statusOf(result.error));
  });

  app.post('/api/boards/:b/decisions/:id/confirm', async (c) => {
    const { board, decision } = ids(c);
    if (!Number.isSafeInteger(board) || !Number.isSafeInteger(decision)) return c.json({ code: 'invalid_input', message: 'Bad decision' }, 422);
    return send(c, await deps.decisions.confirm(c.get('email'), decision, board));
  });

  app.post('/api/boards/:b/decisions/:id/undo', async (c) => {
    const { board, decision } = ids(c);
    if (!Number.isSafeInteger(board) || !Number.isSafeInteger(decision)) return c.json({ code: 'invalid_input', message: 'Bad decision' }, 422);
    return send(c, await deps.decisions.undo(c.get('email'), decision, board));
  });
};
