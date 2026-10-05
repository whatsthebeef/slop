import { timingSafeEqual } from 'node:crypto';
import type { BoardService, DeployService, Result } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { SignedLinks } from '../signed-links.js';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface DeployRoutesDeps {
  readonly deploys: DeployService;
  readonly boards: BoardService;
  readonly links: SignedLinks;
  /** The shared key EventBridge's API destination sends; `/webhooks/aws` is off without one. */
  readonly awsWebhookKey: string | undefined;
  readonly log: (task: string, message: string) => void;
}

/** The path a deploy's signed callback is posted to; the signature covers it. */
export const callbackPath = (deployId: string): string => `/webhooks/deploy/${encodeURIComponent(deployId)}`;

const callbackSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  message: z.string().max(2000).optional(),
});

/** CodeBuild's build state change, as EventBridge delivers it. */
const codeBuildEventSchema = z.object({
  source: z.literal('aws.codebuild'),
  'detail-type': z.literal('CodeBuild Build State Change'),
  detail: z.object({
    'build-status': z.string(),
    'build-id': z.string(),
    'project-name': z.string().optional(),
  }),
});

/** CodeBuild's final states; anything else (IN_PROGRESS) is not a result yet. */
const CODEBUILD_FINAL: Record<string, boolean> = {
  SUCCEEDED: true,
  FAILED: false,
  FAULT: false,
  STOPPED: false,
  TIMED_OUT: false,
};

const send = <T>(c: Context<Env>, result: Result<T>) =>
  result.ok ? c.json({ value: result.value }) : c.json(errorBody(result.error), statusOf(result.error));

const sameSecret = (expected: string, given: string): boolean => {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Deploy routes: the board's deploy state and a glob's history and Deploy now (signed-in members),
 * and how results come back (a signed per-deploy callback, and CodeBuild events from EventBridge).
 */
export const mountDeploys = (app: Hono<Env>, deps: DeployRoutesDeps): void => {
  const { deploys } = deps;

  app.get('/api/boards/:b/deploys', async (c) => {
    const boardId = Number(c.req.param('b'));
    const membership = await deps.boards.get(c.get('email'), boardId);
    if (!membership.ok) return send(c, membership);
    const globIds = (c.req.query('globs') ?? '').split(',').filter((id) => id !== '');
    const { indicators, running } = await deploys.boardState(boardId, globIds);
    return c.json({ indicators: Object.fromEntries(indicators), running: [...running] });
  });

  app.get('/api/globs/:id/deploys', async (c) =>
    send(c, await deploys.history(c.get('email'), c.req.param('id'))),
  );

  app.post('/api/globs/:id/deploy-now', async (c) =>
    send(c, await deploys.deployNow(c.get('email'), c.req.param('id'))),
  );

  // The deploy job's own report: `.sstor/deploy.sh` posts it to the signed URL it was given.
  app.post('/webhooks/deploy/:id', async (c) => {
    const id = c.req.param('id');
    const expires = Number(c.req.query('expires'));
    const signature = c.req.query('sig') ?? '';
    if (!deps.links.verify(callbackPath(id), expires, signature)) return c.json({ error: 'bad signature' }, 401);
    const body = callbackSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'expected {"status": "succeeded" | "failed", "message"?: string}' }, 400);
    const result = await deploys.finished(id, {
      succeeded: body.data.status === 'succeeded',
      error: body.data.status === 'failed' ? (body.data.message ?? 'The deploy script failed') : null,
    });
    if (!result.ok) return c.json({ error: result.error.message }, 404);
    return c.json({ ok: true }, 202);
  });

  // CodeBuild results through an EventBridge API destination, which sends the shared key as a header.
  app.post('/webhooks/aws', async (c) => {
    if (deps.awsWebhookKey === undefined || deps.awsWebhookKey === '') return c.json({ error: 'not configured' }, 404);
    if (!sameSecret(deps.awsWebhookKey, c.req.header('x-slop-key') ?? '')) return c.json({ error: 'bad key' }, 401);
    const event = codeBuildEventSchema.safeParse(await c.req.json().catch(() => null));
    // Other events on the bus aren't ours to handle; accept them so EventBridge doesn't retry.
    if (!event.success) return c.json({ ok: true, ignored: true }, 202);
    const status = event.data.detail['build-status'];
    const succeeded = CODEBUILD_FINAL[status];
    if (succeeded === undefined) return c.json({ ok: true, ignored: true }, 202);
    const result = await deploys.finishedByProviderRef(event.data.detail['build-id'], {
      succeeded,
      error: succeeded ? null : `CodeBuild ${status.toLowerCase().replace('_', ' ')}`,
    });
    if (!result.ok) {
      deps.log('webhook aws', result.error.message);
      return c.json({ error: result.error.message }, 500);
    }
    return c.json({ ok: true }, 202);
  });
};
