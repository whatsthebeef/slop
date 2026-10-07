import type { BoardService } from '@slop/core';
import type { Hono } from 'hono';
import type { LlmHealth, LlmHealthState } from '../llm-health.js';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

/** Only the state and its plain-language reason and fix: never the profile, region or model IDs as fields. */
const view = (h: LlmHealthState) =>
  h.state === 'down'
    ? { state: h.state, reason: h.reason, fix: h.fix, since: h.since }
    : h.state === 'ok'
      ? { state: h.state, since: h.since }
      : { state: h.state };

/** Whether slop's LLM is usable (the worst model's state), for a member of any board. */
export const mountHealth = (app: Hono<Env>, deps: { readonly llm: LlmHealth; readonly boards: BoardService }): void => {
  app.get('/api/health', async (c) => {
    if ((await deps.boards.memberships(c.get('email'))).length === 0) {
      const error = { code: 'forbidden', message: 'Only board members can see the AI status' } as const;
      return c.json(errorBody(error), statusOf(error));
    }
    return c.json({ llm: view(deps.llm.state()) });
  });
};
