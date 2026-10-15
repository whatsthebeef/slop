import type { GlobPresence } from './environments.js';
import { LEGACY_RUNNER_NAME } from './atf-runners.js';
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
  /** The registered runner that posted it; null for a run from the legacy board token or EventBridge. */
  readonly runnerId: number | null;
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
export type NewTestRun = Omit<TestRun, 'id' | 'runnerId'> & { readonly runnerId?: number | null; readonly specs?: readonly TestRunSpec[] };

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
  /** Which runner produced the run; set only when the board has more than one (`Legacy runner` for an unregistered source). */
  readonly runnerName?: string;
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

/** How runners' rows for one spec rank when they disagree: a failure from any runner wins, then a pass, a skip, and `missing` last. */
const SPEC_RANK: Record<SpecStatus, number> = { failed: 0, passed: 1, skipped: 2, missing: 3 };

/**
 * Counts of the planned specs across runs that each may have reported rows (one run's map, or the latest run of each
 * runner). A spec counts once, as its best-ranked row; `missing` counts only when no run has a row of another status for
 * it, so one runner's missing row never hides another runner's result. Null when none of the runs reported any of them.
 */
export const aggregateSpecCounts = (
  planned: readonly string[],
  runRows: readonly (ReadonlyMap<string, StoredRunSpec> | undefined)[],
): PlannedSpecCounts | null => {
  if (planned.length === 0 || runRows.every((rows) => rows === undefined)) return null;
  const counts = { total: planned.length, passed: 0, failed: 0, skipped: 0, missing: 0, unreported: 0 };
  let reported = 0;
  for (const spec of new Set(planned)) {
    let best: SpecStatus | null = null;
    for (const rows of runRows) {
      const status = rows?.get(spec)?.status;
      if (status !== undefined && (best === null || SPEC_RANK[status] < SPEC_RANK[best])) best = status;
    }
    if (best === null) counts.unreported += 1;
    else {
      reported += 1;
      counts[best] += 1;
    }
  }
  counts.total = reported + counts.unreported;
  return reported === 0 ? null : counts;
};

/** Counts of the planned specs in one run; null when the run reported none of them (counts only, or other specs). */
export const plannedSpecCounts = (planned: readonly string[], rows: ReadonlyMap<string, StoredRunSpec> | undefined): PlannedSpecCounts | null =>
  aggregateSpecCounts(planned, [rows]);

const newestFirst = (a: TestRun, b: TestRun): number => b.finishedAt.localeCompare(a.finishedAt) || b.id - a.id;

/** Runner names by ID (null: the legacy source) for a board with more than one runner; absent, runs show no runner. */
export type RunnerNames = ReadonlyMap<number | null, string>;

const runnerKey = (run: Pick<TestRun, 'runnerId'>): string => (run.runnerId === null ? 'legacy' : String(run.runnerId));

const indicator = (
  run: TestRun,
  scope: AtfIndicator['scope'],
  stale: boolean,
  own?: PlannedSpecCounts | null,
  names?: RunnerNames,
): AtfIndicator => ({
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
  ...(names !== undefined && { runnerName: names.get(run.runnerId) ?? LEGACY_RUNNER_NAME }),
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

/** The newest run of each runner, newest first (`sorted` is newest first). */
const latestPerRunner = (sorted: readonly TestRun[]): TestRun[] => {
  const seen = new Set<string>();
  return sorted.filter((r) => {
    const key = runnerKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * What a glob's card shows: the latest branch run of each runner (stale when it tested an older commit than the PR's
 * head), and for each environment holding it, the latest run of each runner against the commit that environment was
 * checked at. A run against an environment's older commit shows on no glob once a newer deploy's check has replaced the
 * presence; a run reported before its deploy's check shows once the check stores presence at that commit.
 *
 * Runners at the same commit are one result: the planned-spec counts of every indicator in a group (the current branch
 * runs, or one environment's runs) combine the runners' rows, so a failure from any runner makes the chip red and a spec
 * is missing only when no runner reported it. `names` (a board with several runners) labels each indicator's runner.
 */
export const atfIndicators = (
  glob: Pick<Glob, 'id' | 'pr'>,
  runs: readonly TestRun[],
  presences: readonly GlobPresence[],
  own?: OwnSpecs,
  names?: RunnerNames,
): AtfIndicator[] => {
  const result: AtfIndicator[] = [];
  const byRun = own === undefined ? null : rowsOf(own.rows);
  const combined = (group: readonly TestRun[]) =>
    own === undefined || byRun === null ? null : aggregateSpecCounts(own.planned, group.map((r) => byRun.get(r.id)));
  const head = glob.pr?.headSha ?? null;
  const branchRuns = latestPerRunner(runs.filter((r) => r.globId === glob.id).sort(newestFirst));
  const currentCounts = combined(branchRuns.filter((r) => sameCommit(r.sha, head)));
  for (const run of branchRuns) {
    const stale = !sameCommit(run.sha, head);
    result.push(indicator(run, 'branch', stale, stale ? combined([run]) : currentCounts, names));
  }
  const byEnvironment = new Map<string, TestRun[]>();
  for (const run of environmentRuns(glob, runs, presences)) {
    if (run.environment === null) continue;
    const group = byEnvironment.get(run.environment) ?? [];
    if (group.some((r) => runnerKey(r) === runnerKey(run))) continue;
    group.push(run);
    byEnvironment.set(run.environment, group);
  }
  for (const group of byEnvironment.values()) {
    const counts = combined(group);
    for (const run of group) result.push(indicator(run, 'environment', false, counts, names));
  }
  return result;
};

/** Every run the glob view lists: all its branch runs and every run against the environment commits holding it. */
export const globTestRuns = (
  glob: Pick<Glob, 'id' | 'pr'>,
  runs: readonly TestRun[],
  presences: readonly GlobPresence[],
  own?: OwnSpecs,
  names?: RunnerNames,
): AtfIndicator[] => {
  const byRun = own === undefined ? null : rowsOf(own.rows);
  const counts = (run: TestRun) => (own === undefined || byRun === null ? null : plannedSpecCounts(own.planned, byRun.get(run.id)));
  return [
    ...runs
      .filter((r) => r.globId === glob.id)
      .sort(newestFirst)
      .map((r) => indicator(r, 'branch', !sameCommit(r.sha, glob.pr?.headSha ?? null), counts(r), names)),
    ...environmentRuns(glob, runs, presences).map((r) => indicator(r, 'environment', false, counts(r), names)),
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
 * those of an older commit than its PR head) and the runs against the environment commits holding the glob. Each runner's
 * newest run with a row for the spec speaks for that runner, whatever its status, so a `missing` row is a result. When
 * runners disagree a failure wins, then a pass, a skip, and `missing` only when no runner has another row; of equal rows the
 * newest wins. Unreported specs have status null.
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
    const spoken = new Set<string>();
    let best: { readonly run: TestRun; readonly status: SpecStatus } | null = null;
    for (const run of applicable) {
      const key = runnerKey(run);
      if (spoken.has(key)) continue;
      const row = byRun.get(run.id)?.get(spec);
      if (row === undefined) continue;
      spoken.add(key);
      if (best === null || SPEC_RANK[row.status] < SPEC_RANK[best.status]) best = { run, status: row.status };
    }
    if (best === null) return { spec, status: null };
    const { run, status } = best;
    return { spec, status, runId: run.id, url: run.url, at: run.finishedAt, environment: run.environment, sha: run.sha };
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
