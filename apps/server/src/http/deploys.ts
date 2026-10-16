import { timingSafeEqual } from 'node:crypto';
import type { BoardService, DeployService, Result, TestRunService } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { SignedLinks } from '../signed-links.js';
import type { Env } from './app.js';
import { atfDetailSchema, reportedSpecs } from './atf-report.js';
import { errorBody, statusOf } from './views.js';

export interface DeployRoutesDeps {
  readonly deploys: DeployService;
  readonly testRuns: TestRunService;
  readonly boards: BoardService;
  readonly links: SignedLinks;
  /** The keys EventBridge API destinations send (one per deploy-target stack); `/webhooks/aws` is off without any. */
  readonly awsWebhookKeys: readonly string[];
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
    // The build's phases; a failed one carries CodeBuild's reason in its context.
    'additional-information': z
      .object({
        phases: z
          .array(
            z.object({
              'phase-type': z.string().optional(),
              'phase-status': z.string().optional(),
              'phase-context': z.array(z.string()).optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  }),
});

/** What every `slop.ci` event carries, whichever kind it is. */
const slopCiBase = z.object({
  id: z.string().min(1).max(200),
  source: z.literal('slop.ci'),
  time: z.iso.datetime({ offset: true }).optional(),
});

/**
 * `slop.ci`'s old "Slop Environment Deployed": other boards' pipelines may still send it, but slop no longer tracks
 * releases, so it is acknowledged and dropped (the detail is not read).
 */
const legacyEnvironmentDeployedSchema = slopCiBase.extend({ 'detail-type': z.literal('Slop Environment Deployed') });

/**
 * `slop.ci`'s "Slop ATF Completed": a pipeline ran the acceptance tests on a glob's branch (`branch` is the glob's ID)
 * or against an environment (`environment`, at the `sha` it tested, else what it runs now).
 */
const atfCompletedSchema = slopCiBase.extend({
  'detail-type': z.literal('Slop ATF Completed'),
  detail: atfDetailSchema,
});

/**
 * Events the board's own pipelines send about themselves (`atf-report.sh` puts
 * it on the EventBridge bus; any CI may post the same envelope with the key). The `detail-type` says which; each
 * kind's detail has its own schema.
 */
const slopCiEventSchema = z.discriminatedUnion('detail-type', [legacyEnvironmentDeployedSchema, atfCompletedSchema]);

type SlopCiEvent = z.infer<typeof slopCiEventSchema>;

/** Why a build failed, from its first failed phase: e.g. "DOWNLOAD_SOURCE: Connection ... is not available". */
const failureReason = (detail: z.infer<typeof codeBuildEventSchema>['detail'], status: string): string => {
  const failed = detail['additional-information']?.phases?.find(
    (p) => p['phase-status'] !== undefined && p['phase-status'] !== 'SUCCEEDED',
  );
  const context = (failed?.['phase-context'] ?? []).filter((c) => c.trim() !== '' && c.trim() !== ':').join('; ');
  const base = `CodeBuild ${status.toLowerCase().replace('_', ' ')}`;
  if (failed === undefined) return base;
  return `${base} in ${failed['phase-type'] ?? 'a phase'}${context === '' ? '' : `: ${context}`}`.slice(0, 500);
};

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

  let legacyLogged = false;

  /** Records a `slop.ci` event; returns the boards that recorded it. */
  const recordCi = async (event: SlopCiEvent): Promise<number[]> => {
    if (event['detail-type'] === 'Slop Environment Deployed') {
      // Logged once per process: a pipeline that still sends it would otherwise fill the log.
      if (!legacyLogged) {
        legacyLogged = true;
        deps.log('webhook aws', 'ignoring "Slop Environment Deployed": slop no longer tracks release environments');
      }
      return [];
    }
    // The event's ID dedupes redeliveries (per board); its time orders deploys that arrive out of order.
    const eventId = `aws:${event.id}`;
    const at = event.time === undefined ? null : new Date(event.time).toISOString();
    const { detail } = event;
    return deps.testRuns.recordAtf({
      repo: detail.repo,
      sha: detail.sha ?? null,
      environment: detail.environment ?? null,
      branch: detail.branch ?? null,
      passed: detail.passed,
      failed: detail.failed,
      skipped: detail.skipped ?? 0,
      url: detail.url ?? null,
      ...(detail.specs !== undefined && { specs: reportedSpecs(detail.specs) }),
      at,
      eventId,
    });
  };

  app.get('/api/boards/:b/deploys', async (c) => {
    const boardId = Number(c.req.param('b'));
    const membership = await deps.boards.get(c.get('email'), boardId);
    if (!membership.ok) return send(c, membership);
    const globIds = (c.req.query('globs') ?? '').split(',').filter((id) => id !== '');
    const [{ indicators, running }, atf] = await Promise.all([
      deploys.boardState(boardId, globIds),
      deps.testRuns.boardState(boardId, globIds),
    ]);
    return c.json({
      indicators: Object.fromEntries(indicators),
      running: [...running],
      atf: Object.fromEntries(atf),
    });
  });

  // The glob's runs (with their spec rows) and each planned spec's latest result.
  app.get('/api/globs/:id/tests', async (c) => {
    const result = await deps.testRuns.forGlob(c.get('email'), c.req.param('id'));
    if (!result.ok) return c.json(errorBody(result.error), statusOf(result.error));
    return c.json({ value: result.value.runs, specs: result.value.specs });
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
    // A deploy deleted with its glob: nothing to record, so don't make the job retry.
    if (!result.ok) return c.json({ ok: true, ignored: true }, 202);
    return c.json({ ok: true }, 202);
  });

  // CodeBuild results and the pipelines' own `slop.ci` events, through an EventBridge API destination, which sends the
  // shared key as a header.
  app.post('/webhooks/aws', async (c) => {
    if (deps.awsWebhookKeys.length === 0) return c.json({ error: 'not configured' }, 404);
    const given = c.req.header('x-slop-key') ?? '';
    // Compare against every key (no early exit), so timing doesn't say which one nearly matched.
    const matches = deps.awsWebhookKeys.map((key) => sameSecret(key, given));
    if (!matches.includes(true)) return c.json({ error: 'bad key' }, 401);
    const body: unknown = await c.req.json().catch(() => null);
    const ci = slopCiEventSchema.safeParse(body);
    if (ci.success) {
      const recorded = await recordCi(ci.data);
      return recorded.length === 0 ? c.json({ ok: true, ignored: true }, 202) : c.json({ ok: true }, 202);
    }
    const event = codeBuildEventSchema.safeParse(body);
    // Other events on the bus aren't ours to handle; accept them so EventBridge doesn't retry.
    if (!event.success) return c.json({ ok: true, ignored: true }, 202);
    const status = event.data.detail['build-status'];
    const succeeded = CODEBUILD_FINAL[status];
    if (succeeded === undefined) return c.json({ ok: true, ignored: true }, 202);
    const result = await deploys.finishedByProviderRef(event.data.detail['build-id'], {
      succeeded,
      error: succeeded ? null : failureReason(event.data.detail, status),
    });
    if (!result.ok) {
      deps.log('webhook aws', result.error.message);
      return c.json({ error: result.error.message }, 500);
    }
    return c.json({ ok: true }, 202);
  });
};
