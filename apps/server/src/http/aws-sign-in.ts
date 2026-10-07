import { forbidden } from '@slop/core';
import type { BoardService, Result } from '@slop/core';
import type { Hono } from 'hono';
import type { AwsSignIn } from '../aws-sso-signin.js';
import type { Env } from './app.js';
import { isAnyBoardAdmin } from './health.js';
import { errorBody, statusOf } from './views.js';

/**
 * Re-signs the server's AWS SSO profile in from the board. Mounted only on a local server with an
 * SSO profile (main.ts decides), so elsewhere these paths are plain 404s. The status carries the
 * code to enter and the link to open, never the device code or the client secret.
 */
export const mountAwsSignIn = (
  app: Hono<Env>,
  deps: { readonly boards: BoardService; readonly signIn: AwsSignIn },
): void => {
  const allowed = async (email: string): Promise<Result<true>> =>
    (await isAnyBoardAdmin(deps.boards, email))
      ? { ok: true, value: true }
      : forbidden('Only a board admin can sign in to AWS');

  app.post('/api/aws-sign-in', async (c) => {
    const access = await allowed(c.get('email'));
    if (!access.ok) return c.json(errorBody(access.error), statusOf(access.error));
    return c.json(await deps.signIn.start());
  });

  app.get('/api/aws-sign-in', async (c) => {
    const access = await allowed(c.get('email'));
    if (!access.ok) return c.json(errorBody(access.error), statusOf(access.error));
    return c.json(deps.signIn.status());
  });
};
