import type { GlobPresence } from './environments.js';
import { sameCommit } from './signals.js';
import type { Glob } from './types.js';

/**
 * Acceptance test (ATF) results. Slop doesn't start ATF; the board's pipeline does and reports each run's counts. A
 * branch run belongs to the glob named by the branch. A run against a release or integration environment belongs to
 * the commit that environment ran, so every glob that commit contains shows it, with no per-glob rows. Results are a
 * flag only: a failure never blocks PR creation, approval, sign-off or a production deploy, and nothing here drives a
 * transition. Every rule here is pure.
 */

export const TEST_RUN_KINDS = ['atf'] as const;
export type TestRunKind = (typeof TEST_RUN_KINDS)[number];

/** One reported test run. */
export interface TestRun {
  readonly id: number;
  readonly boardId: number;
  readonly kind: TestRunKind;
  /** The glob named by the run's branch; null for a run against a release or integration environment. */
  readonly globId: string | null;
  /** The environment it ran against (a branch run's may be null). */
  readonly environment: string | null;
  /** The commit it tested. */
  readonly sha: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** A link to the run's report or build. */
  readonly url: string | null;
  readonly finishedAt: string;
  /** The reporter's event ID: a redelivered event is recorded once per board. */
  readonly eventId: string;
}

export type NewTestRun = Omit<TestRun, 'id'>;

/** An environment's commit, for finding the runs against it. */
export interface EnvironmentCommit {
  readonly environment: string;
  readonly sha: string;
}

/** Any failing test fails the run. */
export const testRunFailed = (run: Pick<TestRun, 'failed'>): boolean => run.failed > 0;

/** What a glob shows for one ATF run. */
export interface AtfIndicator {
  /** The run's own ID (unique on the board). */
  readonly id: number;
  /** `branch`: the glob's own branch; `environment`: the commit a release or integration environment runs. */
  readonly scope: 'branch' | 'environment';
  readonly environment: string | null;
  readonly sha: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly url: string | null;
  readonly at: string;
  readonly failing: boolean;
  /** A branch run of a commit that is no longer the PR's head: shown, but it says nothing about the head. */
  readonly stale?: true;
}

const newestFirst = (a: TestRun, b: TestRun): number => b.finishedAt.localeCompare(a.finishedAt) || b.id - a.id;

const indicator = (run: TestRun, scope: AtfIndicator['scope'], stale: boolean): AtfIndicator => ({
  id: run.id,
  scope,
  environment: run.environment,
  sha: run.sha,
  passed: run.passed,
  failed: run.failed,
  skipped: run.skipped,
  url: run.url,
  at: run.finishedAt,
  failing: testRunFailed(run),
  ...(stale && { stale: true as const }),
});

/** The runs against the environment commits that hold the glob (its contained presences), newest first. */
const environmentRuns = (glob: Pick<Glob, 'id'>, runs: readonly TestRun[], presences: readonly GlobPresence[]): TestRun[] => {
  const held = presences.filter((p) => p.globId === glob.id && p.contained);
  return runs
    .filter(
      (r) =>
        r.globId === null &&
        held.some((p) => p.environment === r.environment && sameCommit(p.checkedSha, r.sha)),
    )
    .sort(newestFirst);
};

/**
 * What a glob's card shows: its latest branch run (stale when it tested an older commit than the PR's head), and for
 * each environment holding it, the latest run against the commit that environment was checked at. A run against an
 * environment's older commit shows on no glob once a newer deploy's check has replaced the presence; a run reported
 * before its deploy's check shows once the check stores presence at that commit.
 */
export const atfIndicators = (
  glob: Pick<Glob, 'id' | 'pr'>,
  runs: readonly TestRun[],
  presences: readonly GlobPresence[],
): AtfIndicator[] => {
  const result: AtfIndicator[] = [];
  const branch = runs.filter((r) => r.globId === glob.id).sort(newestFirst)[0];
  if (branch !== undefined) result.push(indicator(branch, 'branch', !sameCommit(branch.sha, glob.pr?.headSha ?? null)));
  const seen = new Set<string>();
  for (const run of environmentRuns(glob, runs, presences)) {
    if (run.environment === null || seen.has(run.environment)) continue;
    seen.add(run.environment);
    result.push(indicator(run, 'environment', false));
  }
  return result;
};

/** Every run the glob view lists: all its branch runs and every run against the environment commits holding it. */
export const globTestRuns = (
  glob: Pick<Glob, 'id' | 'pr'>,
  runs: readonly TestRun[],
  presences: readonly GlobPresence[],
): AtfIndicator[] => [
  ...runs
    .filter((r) => r.globId === glob.id)
    .sort(newestFirst)
    .map((r) => indicator(r, 'branch', !sameCommit(r.sha, glob.pr?.headSha ?? null))),
  ...environmentRuns(glob, runs, presences).map((r) => indicator(r, 'environment', false)),
];

/** A run's branch names a glob when it is the glob's ID (a full ref's `refs/heads/` prefix aside). */
export const branchGlobId = (branch: string): string => branch.replace(/^refs\/heads\//, '');
