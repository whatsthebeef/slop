import { awsSignInApplies, forbidden, needingAttention } from '@slop/core';
import type { BoardService, Result } from '@slop/core';
import type { Hono } from 'hono';
import type { AwsSignIn } from '../aws-sso.js';
import type { IntegrationRegistry } from '../integration-health.js';
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

interface Deps {
  readonly llm: LlmHealth;
  readonly boards: BoardService;
  /** The health of every integration (GitHub App, routines, tunnel, Bedrock); the board's banner reads it. */
  readonly integrations?: IntegrationRegistry;
  /** The in-app AWS sign-in; null unless the server runs with an SSO profile (local development). */
  readonly signIn?: AwsSignIn | null;
}

/** Whether slop's integrations are usable, for a member of any board; an admin of any board can start the AWS sign-in. */
export const mountHealth = (app: Hono<Env>, deps: Deps): void => {
  const roles = async (email: string) => (await deps.boards.memberships(email)).map((m) => m.role);

  app.get('/api/health', async (c) => {
    const memberRoles = await roles(c.get('email'));
    const access: Result<true> =
      memberRoles.length === 0 ? forbidden('Only board members can see the AI status') : { ok: true, value: true };
    if (!access.ok) return c.json(errorBody(access.error), statusOf(access.error));
    const body: Record<string, unknown> = { llm: view(deps.llm.state()) };
    if (deps.integrations !== undefined) {
      const signIn = deps.signIn ?? null;
      body.integrations = needingAttention(deps.integrations.list()).map((status) => ({
        ...status,
        signIn: awsSignInApplies(status, signIn !== null),
      }));
      body.awsSignIn = signIn === null ? null : { canStart: memberRoles.includes('admin'), ...signIn.status() };
    }
    return c.json(body);
  });

  app.post('/api/aws-sign-in', async (c) => {
    const signIn = deps.signIn ?? null;
    if (signIn === null) return c.json({ code: 'not_found', message: 'This server has no AWS SSO profile to sign in to' }, 404);
    if (!(await roles(c.get('email'))).includes('admin')) {
      const denied = forbidden('Only a board admin can start the AWS sign-in');
      if (!denied.ok) return c.json(errorBody(denied.error), statusOf(denied.error));
    }
    return c.json(await signIn.start());
  });
};
