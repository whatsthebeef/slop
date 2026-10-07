import { forbidden } from '@slop/core';
import type { BoardService, IntegrationHealthSource, Result } from '@slop/core';
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

/** The credential is the server's, so any board's admin may re-sign it in. */
export const isAnyBoardAdmin = async (boards: BoardService, email: string): Promise<boolean> =>
  (await boards.memberships(email)).some((m) => m.role === 'admin');

/**
 * Whether slop's integrations work (the Bedrock model, GitHub App, routines, webhook tunnel), for a
 * member of any board. `llm` is kept for older clients; `integrations` is the banner's source.
 */
export const mountHealth = (
  app: Hono<Env>,
  deps: {
    readonly llm: LlmHealth;
    readonly boards: BoardService;
    readonly integrations: IntegrationHealthSource;
    /** Whether this server offers the in-app AWS sign-in (local dev with an SSO profile). */
    readonly awsSignInAvailable: boolean;
  },
): void => {
  app.get('/api/health', async (c) => {
    const memberships = await deps.boards.memberships(c.get('email'));
    const access: Result<true> =
      memberships.length === 0 ? forbidden('Only board members can see the AI status') : { ok: true, value: true };
    if (!access.ok) return c.json(errorBody(access.error), statusOf(access.error));
    return c.json({
      llm: view(deps.llm.state()),
      integrations: deps.integrations.report().map(({ id, state, reason, fix, since, action }) => ({
        id,
        state,
        reason,
        fix,
        since,
        ...(action === undefined ? {} : { action }),
      })),
      awsSignIn: {
        available: deps.awsSignInAvailable,
        canStart: deps.awsSignInAvailable && memberships.some((m) => m.role === 'admin'),
      },
    });
  });
};
