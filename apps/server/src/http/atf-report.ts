import type { TestRunSpec } from '@slop/core';
import { z } from 'zod';

/**
 * What a pipeline reports about an ATF run, shared by the two doors that take it: the `slop.ci` "Slop ATF Completed"
 * event on `POST /webhooks/aws` (EventBridge) and a runner's own `POST /integrations/boards/:b/atf-results`.
 */

/** A commit on the code host, full or abbreviated. */
export const shaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/i)
  .transform((sha) => sha.toLowerCase());

/** A link slop shows on the board: https only, so a reporter can't plant a script URL. */
export const linkSchema = z.url({ protocol: /^https$/ }).max(2000);

/** A test count from the pipeline's report. */
const countSchema = z.number().int().min(0).max(10_000_000);

/** One spec's result in a run's report (`atf-report.sh` groups the JUnit test cases by file); `missing` is a planned spec the script found no test for (slop adds any the script didn't). */
const runSpecSchema = z.object({
  file: z.string().min(1).max(300),
  status: z.enum(['passed', 'failed', 'skipped', 'missing']),
  tests: countSchema.optional(),
  failed: countSchema.optional(),
  durationMs: countSchema.optional(),
});

/** Most per-spec rows kept from one report; the rest are dropped, and the counts are always kept. */
const MAX_REPORTED_SPECS = 1000;

/** The repo as `owner/name`. */
export const repoSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);

/** The fields of an ATF report; the doors differ in whether `repo` is needed and which refinements apply. */
export const atfDetailFields = z.object({
  repo: repoSchema,
  sha: shaSchema.optional(),
  environment: z.string().min(1).max(100).optional(),
  branch: z.string().min(1).max(255).optional(),
  passed: countSchema,
  failed: countSchema,
  skipped: countSchema.optional(),
  url: linkSchema.optional(),
  // Malformed per-spec rows lose only the rows: the counts above are still recorded.
  specs: z.array(runSpecSchema).optional().catch(undefined),
});

type AtfTarget = {
  readonly environment?: string | undefined;
  readonly branch?: string | undefined;
};

/** A run is against an environment or on a glob's branch (or both). */
export const hasAtfTarget = (d: AtfTarget): boolean =>
  d.environment !== undefined || d.branch !== undefined;
export const ATF_TARGET_MESSAGE = 'needs an environment or a branch';

/** The detail of "Slop ATF Completed". */
export const atfDetailSchema = atfDetailFields.refine(hasAtfTarget, ATF_TARGET_MESSAGE);

/** The report's spec rows as the service takes them: the first row of a repeated file wins, tests default to 0. */
export const reportedSpecs = (specs: readonly z.infer<typeof runSpecSchema>[]): TestRunSpec[] => {
  const seen = new Set<string>();
  const rows: TestRunSpec[] = [];
  for (const s of specs.slice(0, MAX_REPORTED_SPECS)) {
    if (seen.has(s.file)) continue;
    seen.add(s.file);
    rows.push({
      spec: s.file,
      status: s.status,
      tests: s.tests ?? 0,
      failedTests: s.failed ?? 0,
      durationMs: s.durationMs ?? null,
    });
  }
  return rows;
};
