import { createHash } from 'node:crypto';
import type { AtfRunnerService, TestRunService } from '@slop/core';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { bearerOf, deprecationHeaders } from '../atf-auth.js';
import type { RunnerAuthenticator } from '../atf-auth.js';
import {
  ATF_TARGET_MESSAGE,
  atfDetailFields,
  hasAtfTarget,
  repoSchema,
  reportedSpecs,
} from './atf-report.js';
import type { Env } from './app.js';

export interface AtfResultsRoutesDeps {
  readonly testRuns: Pick<TestRunService, 'recordAtf'>;
  readonly runners: Pick<AtfRunnerService, 'seen'>;
  readonly authenticate: RunnerAuthenticator;
  readonly log: (task: string, message: string) => void;
}

/** Room for 1000 spec rows with long paths; a report is counts and file names, never logs. */
export const ATF_RESULTS_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * The report a runner posts: the "Slop ATF Completed" detail. `repo` may be left out because the credential already fixes
 * the board (it is ignored if sent); `at` says when the run finished, else slop notes the time it arrived.
 */
const resultsBody = atfDetailFields
  .extend({ repo: repoSchema.optional(), at: z.iso.datetime({ offset: true }).optional() })
  .refine(hasAtfTarget, ATF_TARGET_MESSAGE);

const idempotencyKey = z.string().min(1).max(200);

const unauthenticated = { code: 'unauthenticated', message: 'Unauthenticated' } as const;

/**
 * `POST /integrations/boards/:b/atf-results` (spec, ATF runners): a runner posts one run's counts and per-spec results over
 * HTTP with its own credential. The run is recorded on the credential's board only, against the runner, and only for an
 * environment the runner serves. A redelivery is recorded once: the `Idempotency-Key` header names the delivery, else
 * the runner, commit, environment and counts do. The board's integration token still works (deprecated) and records the run
 * as the legacy runner. A refused credential is a plain 401, and credentials are never logged.
 */
export const mountAtfResults = (app: Hono<Env>, deps: AtfResultsRoutesDeps): void => {
  app.post(
    '/integrations/boards/:b/atf-results',
    bodyLimit({
      maxSize: ATF_RESULTS_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ code: 'invalid_input', message: 'The report is too large' }, 413),
    }),
    async (c) => {
      const boardId = Number(c.req.param('b'));
      const bearer = bearerOf(c.req.header('authorization'));
      const runner = bearer === null ? null : await deps.authenticate(boardId, bearer, 'atf.write-results');
      if (runner === null) return c.json(unauthenticated, 401);
      for (const [name, value] of Object.entries(deprecationHeaders(runner))) c.header(name, value);
      const body = resultsBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json(
          { code: 'invalid_input', message: body.error.issues[0]?.message ?? 'Bad report' },
          422,
        );
      }
      const header = c.req.header('idempotency-key');
      const given = header === undefined ? null : idempotencyKey.safeParse(header);
      if (given !== null && !given.success) {
        return c.json(
          { code: 'invalid_input', message: 'Idempotency-Key is 1 to 200 characters' },
          422,
        );
      }
      const report = body.data;
      if (
        runner.environments !== null &&
        report.environment !== undefined &&
        !runner.environments.includes(report.environment)
      ) {
        return c.json(
          { code: 'forbidden', message: 'This runner does not serve that environment' },
          403,
        );
      }
      const owner = runner.runnerId === null ? 'legacy' : String(runner.runnerId);
      const key =
        given?.data ??
        createHash('sha256')
          .update(
            JSON.stringify([
              owner,
              report.sha ?? null,
              report.environment ?? null,
              report.branch ?? null,
              report.passed,
              report.failed,
              report.skipped ?? 0,
              report.at ?? null,
            ]),
          )
          .digest('hex');
      const recorded = await deps.testRuns.recordAtf(
        {
          repo: report.repo ?? '',
          sha: report.sha ?? null,
          environment: report.environment ?? null,
          branch: report.branch ?? null,
          passed: report.passed,
          failed: report.failed,
          skipped: report.skipped ?? 0,
          url: report.url ?? null,
          ...(report.specs !== undefined && { specs: reportedSpecs(report.specs) }),
          at: report.at === undefined ? null : new Date(report.at).toISOString(),
          eventId: `runner:${owner}:${key}`,
        },
        { boardId: runner.boardId, runnerId: runner.runnerId },
      );
      if (runner.runnerId !== null) {
        await deps.runners
          .seen(runner.boardId, runner.runnerId)
          .catch(() => deps.log('atf results', `Could not note runner ${owner} as seen`));
      }
      // A redelivery, or a run slop has no place for (an environment the board doesn't have, a commit no branch deploy put there, another board's glob, no commit): not an error for the pipeline.
      return recorded.length === 0
        ? c.json({ status: 'ignored' }, 200)
        : c.json({ status: 'recorded' }, 201);
    },
  );
};
