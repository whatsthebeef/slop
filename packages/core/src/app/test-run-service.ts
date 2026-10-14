import { RECENT_MERGE_DAYS, observedEnvironment } from '../domain/environments.js';
import { forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import { parseId } from '../domain/ids.js';
import { sameCommit } from '../domain/signals.js';
import { testPlanSpecs, unionSpecs } from '../domain/test-plan.js';
import * as testRuns from '../domain/test-runs.js';
import type {
  AtfBatch,
  AtfIndicator,
  EnvironmentCommit,
  GlobSpecResult,
  NewTestRun,
  OwnSpecs,
  StoredRunSpec,
  TestRunSpec,
} from '../domain/test-runs.js';
import type { Clock, Hint, Notifier, Store, Tx } from '../ports.js';

export interface TestRunServiceDeps {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly clock: Clock;
}

/** An ATF run a board's pipeline reported (through EventBridge, or posted directly with the key). */
export interface ReportedAtfRun {
  /** `owner/name`: the boards on that repo record it. */
  readonly repo: string;
  /** The commit it tested. An environment run without one takes the environment's latest succeeded deploy. */
  readonly sha: string | null;
  /** The environment it ran against. Required for an environment run; a branch run defaults to the glob's. */
  readonly environment: string | null;
  /** The branch it ran on: a glob's ID (or `refs/heads/<id>`) makes it that glob's branch run. */
  readonly branch: string | null;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly url: string | null;
  /** Per-spec results, when the reporter sent them; slop adds `missing` rows for the deploy's batch specs it didn't. */
  readonly specs?: readonly TestRunSpec[];
  /** When it finished, if the reporter said; else now. */
  readonly at: string | null;
  readonly eventId: string;
}

/**
 * Application service for acceptance test (ATF) results. Slop only observes ATF: the board's pipeline runs it and
 * reports the counts. Results live beside the glob, like deploys (no glob version bump), and never drive a transition.
 */
export class TestRunService {
  constructor(private readonly deps: TestRunServiceDeps) {}

  /**
   * Records a reported ATF run. A run on a glob's branch is that glob's (logged as `ATFCompleted` on it); otherwise it
   * is a run against a release or integration environment, recorded on every board on the repo that observes it, at
   * the commit it tested. Returns the boards that recorded it (none: ignored or a redelivery).
   */
  async recordAtf(input: ReportedAtfRun): Promise<number[]> {
    const now = this.deps.clock.now();
    const finishedAt = input.at ?? now;
    const counts = { passed: input.passed, failed: input.failed, skipped: input.skipped };
    const hints: Hint[] = [];
    const recorded = await this.deps.store.transaction(async (tx) => {
      const repo = input.repo.toLowerCase();
      const boards = (await tx.listAllBoards()).filter((b) => b.repo?.toLowerCase() === repo);
      const branch = input.branch === null ? null : testRuns.branchGlobId(input.branch);
      if (branch !== null && parseId(branch) !== null) {
        // A glob's branch: never an environment run, even when the glob is gone or on another repo's board.
        const glob = await tx.getGlob(branch);
        if (glob === null || !boards.some((b) => b.id === glob.boardId) || input.sha === null) return [];
        const run: NewTestRun = {
          boardId: glob.boardId,
          kind: 'atf',
          globId: glob.id,
          environment: input.environment ?? glob.environment,
          sha: input.sha,
          ...counts,
          url: input.url,
          finishedAt,
          eventId: input.eventId,
          ...(input.specs !== undefined && { specs: input.specs }),
        };
        if (!(await tx.insertTestRun(run))) return [];
        const event: DomainEvent = {
          type: 'ATFCompleted',
          globId: glob.id,
          actor: null,
          at: now,
          data: { sha: run.sha, environment: run.environment, ...counts, url: run.url },
        };
        await tx.appendEvents([event]);
        hints.push({ kind: 'glob.deploys', boardId: glob.boardId, globId: glob.id });
        return [glob.boardId];
      }
      if (input.environment === null) return [];
      const boardIds: number[] = [];
      for (const board of boards) {
        if (observedEnvironment(board, input.environment) === null) continue;
        // Without a commit, the run tested what the environment runs now.
        const sha = input.sha ?? (await tx.latestEnvironmentDeploy(board.id, input.environment))?.sha ?? null;
        if (sha === null) continue;
        const inserted = await tx.insertTestRun({
          boardId: board.id,
          kind: 'atf',
          globId: null,
          environment: input.environment,
          sha,
          ...counts,
          url: input.url,
          finishedAt,
          eventId: input.eventId,
          ...(input.specs !== undefined && { specs: await withMissing(tx, board.id, input.environment, sha, input.specs) }),
        });
        if (!inserted) continue;
        boardIds.push(board.id);
        hints.push({ kind: 'board.tests', boardId: board.id });
      }
      return boardIds;
    });
    for (const hint of hints) this.deps.notifier.publish(hint);
    return recorded;
  }

  /** The ATF results each of the given globs shows on its card. */
  async boardState(boardId: number, globIds: readonly string[]): Promise<Map<string, AtfIndicator[]>> {
    return this.deps.store.transaction(async (tx) => {
      const state = new Map<string, AtfIndicator[]>();
      if (globIds.length === 0) return state;
      const presences = await tx.listGlobPresence(boardId, { globIds, contained: true });
      const commits = new Map<string, EnvironmentCommit>();
      for (const p of presences) commits.set(`${p.environment}:${p.checkedSha}`, { environment: p.environment, sha: p.checkedSha });
      const runs = await tx.listTestRuns(boardId, { globIds, commits: [...commits.values()] });
      if (runs.length === 0) return state;
      // Only a branch run needs its glob (the PR head says whether the run is stale): read those in one go.
      const withBranchRuns = [...new Set(runs.flatMap((r) => (r.globId === null ? [] : [r.globId])))];
      const globs = new Map((await tx.getGlobs(withBranchRuns)).map((g) => [g.id, g]));
      // The globs' planned specs (latest test plans, read once) and the runs' per-spec rows, for the chips' own counts.
      const planned = await plannedSpecsOf(tx, globIds);
      const rows = planned.size === 0 ? [] : await tx.listTestRunSpecs(runs.map((r) => r.id));
      for (const globId of globIds) {
        const specs = planned.get(globId);
        const own: OwnSpecs | undefined = specs === undefined ? undefined : { planned: specs, rows };
        const indicators = testRuns.atfIndicators({ id: globId, pr: globs.get(globId)?.pr ?? null }, runs, presences, own);
        if (indicators.length > 0) state.set(globId, indicators);
      }
      return state;
    });
  }

  /**
   * Every ATF run the glob view lists (its branch runs and the runs against the environment commits holding it, each with
   * its per-spec rows) and each spec its latest test plan lists with the newest result for the glob.
   */
  async forGlob(email: string, globId: string): Promise<Result<GlobTests>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      if ((await tx.getMember(glob.boardId, email)) === null) {
        return forbidden(`You are not a member of board ${String(glob.boardId)}`);
      }
      const presences = await tx.listGlobPresence(glob.boardId, { globIds: [globId], contained: true });
      const commits = presences.map((p) => ({ environment: p.environment, sha: p.checkedSha }));
      const runs = await tx.listTestRuns(glob.boardId, { globIds: [globId], commits });
      const rows = await tx.listTestRunSpecs(runs.map((r) => r.id));
      const planned = (await plannedSpecsOf(tx, [globId])).get(globId) ?? [];
      const own: OwnSpecs | undefined = planned.length === 0 ? undefined : { planned, rows };
      const listed = testRuns.globTestRuns(glob, runs, presences, own).map((run): GlobTests['runs'][number] => {
        const specs = runSpecRows(rows, run.id);
        return specs.length === 0 ? run : { ...run, specs };
      });
      return ok({ runs: listed, specs: testRuns.globSpecResults(glob, planned, runs, rows, presences) });
    });
  }

  /**
   * The specs the board's ATF stage should run for `sha` in `environment` (a burst of merges deployed together runs the
   * union once). `pending`: the deploy's containment check hasn't finished (or the deploy isn't reported yet); `superseded`:
   * a newer deploy replaced `sha`. The first answer is stored per (environment, sha) and every repeat returns it.
   * Callers authorise: this answers for any board.
   */
  async atfBatch(boardId: number, environment: string, sha: string): Promise<Result<AtfBatchAnswer>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${String(boardId)}`);
      if (observedEnvironment(board, environment) === null) {
        return invalidInput(`${environment} isn't an environment this board observes`);
      }
      await tx.lockEnvironment(boardId, environment);
      const latest = await tx.latestEnvironmentDeploy(boardId, environment);
      const known = await tx.listEnvironmentDeploys(boardId, environment, 50);
      if (latest === null || !known.some((d) => sameCommit(d.sha, sha))) return ok({ status: 'pending' });
      if (!sameCommit(latest.sha, sha)) return ok({ status: 'superseded', latestSha: latest.sha });
      const stored = await tx.getAtfBatch(boardId, environment, latest.sha);
      if (stored !== null) return ok({ status: 'ready', batch: stored });
      if (latest.checkedAt === null) return ok({ status: 'pending' });
      const previous = known.find((d) => d.succeeded && d.id !== latest.id && !sameCommit(d.sha, latest.sha));
      const since = testRuns.batchWindowStart(
        (await tx.latestAtfBatch(boardId, environment))?.createdAt ?? null,
        previous?.at ?? null,
        now,
        RECENT_MERGE_DAYS,
      );
      const newlyHeld = (await tx.listBoardEvents(boardId, since, ['Deployed']))
        .filter((e) => e.at > since && e.data.observed === true && e.data.environment === environment)
        .map((e) => e.globId);
      const globIds = [...new Set(newlyHeld)];
      const plans = globIds.length === 0 ? [] : await tx.latestArtifacts(globIds, ['test_plan']);
      const union = unionSpecs(
        globIds.map((globId) => {
          const plan = plans.find((a) => a.globId === globId);
          return { globId, atf: plan === undefined ? null : testPlanSpecs(plan) };
        }),
      );
      const batch = await tx.insertAtfBatch({
        boardId,
        environment,
        sha: latest.sha,
        specs: union.specs,
        greps: union.greps,
        createdAt: now,
      });
      return ok({ status: 'ready', batch });
    });
  }
}

/** One spec row of a run, as the glob view lists it. */
export type RunSpecRow = Pick<StoredRunSpec, 'spec' | 'status' | 'tests' | 'failedTests' | 'durationMs'>;

/** The glob view's tests: its runs and each planned spec's latest result. */
export interface GlobTests {
  readonly runs: readonly (AtfIndicator & { readonly specs?: readonly RunSpecRow[] })[];
  readonly specs: readonly GlobSpecResult[];
}

/** What the ATF stage is told for a deploy. */
export type AtfBatchAnswer =
  | { readonly status: 'pending' }
  | { readonly status: 'superseded'; readonly latestSha: string }
  | { readonly status: 'ready'; readonly batch: AtfBatch };

const MAX_RUN_SPECS_LISTED = 200;
const SEVERITY = { failed: 0, missing: 1, skipped: 2, passed: 3 } as const;

/** A run's spec rows for the glob view: failures and missing first, capped. */
const runSpecRows = (rows: readonly StoredRunSpec[], runId: number): RunSpecRow[] =>
  rows
    .filter((r) => r.testRunId === runId)
    .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.spec.localeCompare(b.spec))
    .slice(0, MAX_RUN_SPECS_LISTED)
    .map(({ spec, status, tests, failedTests, durationMs }) => ({ spec, status, tests, failedTests, durationMs }));

/** Each glob's planned specs from its latest test plan (one read); globs without a list are left out. */
const plannedSpecsOf = async (tx: Tx, globIds: readonly string[]): Promise<Map<string, readonly string[]>> => {
  const planned = new Map<string, readonly string[]>();
  for (const artifact of await tx.latestArtifacts(globIds, ['test_plan'])) {
    const list = testPlanSpecs(artifact);
    if (list !== null && list.specs.length > 0) planned.set(artifact.globId, list.specs);
  }
  return planned;
};

/** The run's specs plus a `missing` row for every spec of the environment's batch at that commit that it didn't report. */
const withMissing = async (
  tx: Tx,
  boardId: number,
  environment: string,
  sha: string,
  reported: readonly TestRunSpec[],
): Promise<TestRunSpec[]> => {
  const batch = await tx.latestAtfBatch(boardId, environment);
  if (batch === null || !sameCommit(batch.sha, sha)) return [...reported];
  return [...reported, ...testRuns.missingSpecs(batch.specs, reported)];
};
