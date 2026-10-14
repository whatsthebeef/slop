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

/** What one spec did in a run. `missing`: the batch listed it and the run reported no test for it. */
export const SPEC_STATUSES = ['passed', 'failed', 'skipped', 'missing'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/** One spec's result inside a run, as the reporter sent it (or slop derived it for a missing one). */
export interface TestRunSpec {
  /** Repo-relative path of the spec file. */
  readonly spec: string;
  readonly status: SpecStatus;
  /** Tests of the spec in the run, and how many failed. */
  readonly tests: number;
  readonly failedTests: number;
  readonly durationMs: number | null;
}

/** A stored spec row with the run it belongs to. */
export interface StoredRunSpec extends TestRunSpec {
  readonly testRunId: number;
}

/** A run to record; `specs` (per-spec rows, when the reporter sent them) are written in the same transaction. */
export type NewTestRun = Omit<TestRun, 'id'> & { readonly specs?: readonly TestRunSpec[] };

/** One spec (or grep) of a deploy's batch with the globs whose test plans asked for it. */
export interface AtfBatchSpec {
  readonly spec: string;
  readonly globIds: readonly string[];
}
export interface AtfBatchGrep {
  readonly grep: string;
  readonly globIds: readonly string[];
}

/** The union of specs one deploy (environment and commit) should run, stored on first request so a repeat call returns the same list. */
export interface AtfBatch {
  readonly id: number;
  readonly boardId: number;
  readonly environment: string;
  readonly sha: string;
  readonly specs: readonly AtfBatchSpec[];
  readonly greps: readonly AtfBatchGrep[];
  readonly createdAt: string;
}

export type NewAtfBatch = Omit<AtfBatch, 'id'>;

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
  /** What the run said about the glob's own planned specs; set only when the run reported per-spec rows for them. */
  readonly plannedSpecs?: PlannedSpecCounts;
}

/** How the run went for the specs the glob's test plan listed (`unreported`: listed, with no row in this run). */
export interface PlannedSpecCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly missing: number;
  readonly unreported: number;
}

/** The glob's planned specs and the per-spec rows of the runs that may mention them. */
export interface OwnSpecs {
  readonly planned: readonly string[];
  readonly rows: readonly StoredRunSpec[];
}

const rowsOf = (rows: readonly StoredRunSpec[]): Map<number, Map<string, StoredRunSpec>> => {
  const byRun = new Map<number, Map<string, StoredRunSpec>>();
  for (const row of rows) {
    const specs = byRun.get(row.testRunId) ?? new Map<string, StoredRunSpec>();
    specs.set(row.spec, row);
    byRun.set(row.testRunId, specs);
  }
  return byRun;
};

/** Counts of the planned specs in one run; null when the run reported none of them (counts only, or other specs). */
export const plannedSpecCounts = (planned: readonly string[], rows: ReadonlyMap<string, StoredRunSpec> | undefined): PlannedSpecCounts | null => {
  if (rows === undefined || planned.length === 0) return null;
  const counts = { total: planned.length, passed: 0, failed: 0, skipped: 0, missing: 0, unreported: 0 };
  let reported = 0;
  for (const spec of new Set(planned)) {
    const row = rows.get(spec);
    if (row === undefined) counts.unreported += 1;
    else {
      reported += 1;
      counts[row.status] += 1;
    }
  }
  counts.total = reported + counts.unreported;
  return reported === 0 ? null : counts;
};

const newestFirst = (a: TestRun, b: TestRun): number => b.finishedAt.localeCompare(a.finishedAt) || b.id - a.id;

const indicator = (run: TestRun, scope: AtfIndicator['scope'], stale: boolean, own?: PlannedSpecCounts | null): AtfIndicator => ({
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
  ...(own !== undefined && own !== null && { plannedSpecs: own }),
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
  own?: OwnSpecs,
): AtfIndicator[] => {
  const result: AtfIndicator[] = [];
  const byRun = own === undefined ? null : rowsOf(own.rows);
  const counts = (run: TestRun) => (own === undefined || byRun === null ? null : plannedSpecCounts(own.planned, byRun.get(run.id)));
  const branch = runs.filter((r) => r.globId === glob.id).sort(newestFirst)[0];
  if (branch !== undefined) {
    result.push(indicator(branch, 'branch', !sameCommit(branch.sha, glob.pr?.headSha ?? null), counts(branch)));
  }
  const seen = new Set<string>();
  for (const run of environmentRuns(glob, runs, presences)) {
    if (run.environment === null || seen.has(run.environment)) continue;
    seen.add(run.environment);
    result.push(indicator(run, 'environment', false, counts(run)));
  }
  return result;
};

/** Every run the glob view lists: all its branch runs and every run against the environment commits holding it. */
export const globTestRuns = (
  glob: Pick<Glob, 'id' | 'pr'>,
  runs: readonly TestRun[],
  presences: readonly GlobPresence[],
  own?: OwnSpecs,
): AtfIndicator[] => {
  const byRun = own === undefined ? null : rowsOf(own.rows);
  const counts = (run: TestRun) => (own === undefined || byRun === null ? null : plannedSpecCounts(own.planned, byRun.get(run.id)));
  return [
    ...runs
      .filter((r) => r.globId === glob.id)
      .sort(newestFirst)
      .map((r) => indicator(r, 'branch', !sameCommit(r.sha, glob.pr?.headSha ?? null), counts(r))),
    ...environmentRuns(glob, runs, presences).map((r) => indicator(r, 'environment', false, counts(r))),
  ];
};

/** A planned spec's latest result on a glob; `status` null while no applicable run has reported the spec. */
export interface GlobSpecResult {
  readonly spec: string;
  readonly status: SpecStatus | null;
  readonly runId?: number;
  readonly url?: string | null;
  readonly at?: string;
  readonly environment?: string | null;
  readonly sha?: string;
}

/**
 * Each planned spec's latest result for the glob, in plan order. The runs that apply are the glob's own branch runs (not
 * those of an older commit than its PR head) and the runs against the environment commits holding the glob. The newest run
 * with a row for the spec wins, whatever its status, so a `missing` row is a result. Unreported specs have status null.
 */
export const globSpecResults = (
  glob: Pick<Glob, 'id' | 'pr'>,
  planned: readonly string[],
  runs: readonly TestRun[],
  rows: readonly StoredRunSpec[],
  presences: readonly GlobPresence[],
): GlobSpecResult[] => {
  const head = glob.pr?.headSha ?? null;
  const applicable = [
    ...runs.filter((r) => r.globId === glob.id && (head === null || sameCommit(r.sha, head))),
    ...environmentRuns(glob, runs, presences),
  ].sort(newestFirst);
  const byRun = rowsOf(rows);
  return [...new Set(planned)].map((spec): GlobSpecResult => {
    for (const run of applicable) {
      const row = byRun.get(run.id)?.get(spec);
      if (row === undefined) continue;
      return { spec, status: row.status, runId: run.id, url: run.url, at: run.finishedAt, environment: run.environment, sha: run.sha };
    }
    return { spec, status: null };
  });
};

/** The `missing` rows for a deploy's batch: every listed spec the run reported no test for. */
export const missingSpecs = (batch: readonly AtfBatchSpec[], reported: readonly TestRunSpec[]): TestRunSpec[] => {
  const seen = new Set(reported.map((r) => r.spec));
  return batch
    .filter((b) => !seen.has(b.spec))
    .map((b) => ({ spec: b.spec, status: 'missing' as const, tests: 0, failedTests: 0, durationMs: null }));
};

/** How far back a deploy's spec batch looks for newly contained globs: since the last batch, else the previous deploy, else this long. */
export const batchWindowStart = (
  previousBatchAt: string | null,
  previousDeployAt: string | null,
  now: string,
  maxDays: number,
): string => {
  const floor = new Date(Date.parse(now) - maxDays * 86_400_000).toISOString();
  const since = previousBatchAt ?? previousDeployAt ?? floor;
  return since > floor ? since : floor;
};

/** A run's branch names a glob when it is the glob's ID (a full ref's `refs/heads/` prefix aside). */
export const branchGlobId = (branch: string): string => branch.replace(/^refs\/heads\//, '');
