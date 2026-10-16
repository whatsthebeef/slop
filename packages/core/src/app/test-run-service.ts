import { LEGACY_RUNNER_NAME } from '../domain/atf-runners.js';
import { forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import { parseId } from '../domain/ids.js';
import { sameCommit } from '../domain/signals.js';
import { testPlanSpecs, unionSpecs } from '../domain/test-plan.js';
import type { RequestedGrep, RequestedSpec } from '../domain/test-plan.js';
import * as testRuns from '../domain/test-runs.js';
import type {
  AtfIndicator,
  GlobSpecResult,
  NewTestRun,
  OwnSpecs,
  RunnerNames,
  StoredRunSpec,
  TestRun,
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
  /** The commit it tested. An environment run without one takes the environment's latest succeeded branch deploy. */
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
 * Who posted a run, when a registered runner (or the legacy board token: `runnerId` null) did it with its own credential.
 * The run is recorded on that board only, whatever repo it names, and a branch run only for a glob of that board.
 */
export interface RunnerBinding {
  readonly boardId: number;
  readonly runnerId: number | null;
}

/**
 * Application service for acceptance test (ATF) results. Slop only observes ATF: the board's pipeline runs it and
 * reports the counts. Results live beside the glob, like deploys (no glob version bump), and never drive a transition.
 */
export class TestRunService {
  constructor(private readonly deps: TestRunServiceDeps) {}

  /**
   * Records a reported ATF run. A run on a glob's branch is that glob's (logged as `ATFCompleted` on it); otherwise it
   * is a run against a dev environment at a commit, recorded on the glob whose succeeded branch deploy put that commit there,
   * on every board on the repo with such a deploy. Returns the boards that recorded it (none: ignored or a redelivery).
   *
   * With a `binding` (a runner that proved its identity) only the bound board records it, `input.repo` is ignored, and the
   * run keeps the runner's ID; the runner's "last result" is stamped when a run was recorded.
   */
  async recordAtf(input: ReportedAtfRun, binding?: RunnerBinding): Promise<number[]> {
    const now = this.deps.clock.now();
    const finishedAt = input.at ?? now;
    const counts = { passed: input.passed, failed: input.failed, skipped: input.skipped };
    const hints: Hint[] = [];
    const recorded = await this.deps.store.transaction(async (tx) => {
      const repo = input.repo.toLowerCase();
      const runnerId = binding?.runnerId ?? null;
      const boards =
        binding === undefined
          ? (await tx.listAllBoards()).filter((b) => b.repo?.toLowerCase() === repo)
          : [await tx.getBoard(binding.boardId)].filter((b) => b !== null);
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
          runnerId,
          ...(input.specs !== undefined && { specs: input.specs }),
        };
        if (!(await tx.insertTestRun(run))) return [];
        await stampResult(tx, binding, now);
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
        if (!board.environments.some((e) => e.name === input.environment)) continue;
        const succeeded = await tx.listDeploys(board.id, { environment: input.environment, states: ['succeeded'] });
        // Without a commit, the run tested what the environment runs now.
        const sha = input.sha ?? succeeded[0]?.sha ?? null;
        if (sha === null) continue;
        // The run belongs to the glob whose branch deploy put the commit there (the newest, if it was deployed twice).
        const deploy = succeeded.find((d) => sameCommit(d.sha, sha));
        if (deploy === undefined) continue;
        const inserted = await tx.insertTestRun({
          boardId: board.id,
          kind: 'atf',
          globId: deploy.globId,
          environment: input.environment,
          sha,
          ...counts,
          url: input.url,
          finishedAt,
          eventId: input.eventId,
          runnerId,
          ...(input.specs !== undefined && { specs: await withMissing(tx, board.id, input.environment, sha, input.specs) }),
        });
        if (!inserted) continue;
        await stampResult(tx, binding, now);
        boardIds.push(board.id);
        hints.push({ kind: 'glob.deploys', boardId: board.id, globId: deploy.globId });
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
      const runs = await tx.listTestRuns(boardId, { globIds });
      if (runs.length === 0) return state;
      const deployed = await tx.listDeploys(boardId, { globIds, states: ['succeeded'] });
      // Only a branch run needs its glob (the PR head says whether the run is stale): read those in one go.
      const withBranchRuns = [...new Set(runs.flatMap((r) => (r.globId === null ? [] : [r.globId])))];
      const globs = new Map((await tx.getGlobs(withBranchRuns)).map((g) => [g.id, g]));
      // The globs' planned specs (latest test plans, read once) and the runs' per-spec rows, for the chips' own counts.
      const planned = await plannedSpecsOf(tx, globIds);
      const rows = planned.size === 0 ? [] : await tx.listTestRunSpecs(runs.map((r) => r.id));
      const names = await runnerNamesOf(tx, boardId, runs);
      for (const globId of globIds) {
        const specs = planned.get(globId);
        const own: OwnSpecs | undefined = specs === undefined ? undefined : { planned: specs, rows };
        const indicators = testRuns.atfIndicators({ id: globId, pr: globs.get(globId)?.pr ?? null }, runs, deployed, own, names);
        if (indicators.length > 0) state.set(globId, indicators);
      }
      return state;
    });
  }

  /**
   * Every ATF run the glob view lists (its branch runs and the runs against the commits its branch deploys put in an
   * environment, each with its per-spec rows) and each spec its latest test plan lists with the newest result for the glob.
   */
  async forGlob(email: string, globId: string): Promise<Result<GlobTests>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      if ((await tx.getMember(glob.boardId, email)) === null) {
        return forbidden(`You are not a member of board ${String(glob.boardId)}`);
      }
      const runs = await tx.listTestRuns(glob.boardId, { globIds: [globId] });
      const deployed = await tx.listDeploys(glob.boardId, { globIds: [globId], states: ['succeeded'] });
      const rows = await tx.listTestRunSpecs(runs.map((r) => r.id));
      const planned = (await plannedSpecsOf(tx, [globId])).get(globId) ?? [];
      const own: OwnSpecs | undefined = planned.length === 0 ? undefined : { planned, rows };
      const names = await runnerNamesOf(tx, glob.boardId, runs);
      const listed = testRuns.globTestRuns(glob, runs, deployed, own, names).map((run): GlobTests['runs'][number] => {
        const specs = runSpecRows(rows, run.id);
        return specs.length === 0 ? run : { ...run, specs };
      });
      return ok({ runs: listed, specs: testRuns.globSpecResults(glob, planned, runs, rows, deployed) });
    });
  }

  /**
   * The specs the board's ATF stage should run for `sha` in `environment`: the union of the test plans' lists of the globs
   * whose succeeded branch deploys put `sha` there. `pending`: no such deploy has succeeded (yet); `superseded`: a newer
   * deploy replaced `sha` in the environment. Callers authorise: this answers for any board.
   */
  async atfBatch(boardId: number, environment: string, sha: string): Promise<Result<AtfBatchAnswer>> {
    return this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${String(boardId)}`);
      if (!board.environments.some((e) => e.name === environment)) {
        return invalidInput(`${environment} isn't an environment of this board`);
      }
      const [latest] = await tx.listDeploys(boardId, { environment, states: ['succeeded'], limit: 1 });
      const batch = await batchOf(tx, boardId, environment, sha);
      if (batch === null) return ok({ status: 'pending' });
      if (latest !== undefined && !sameCommit(latest.sha, sha)) return ok({ status: 'superseded', latestSha: latest.sha });
      return ok({ status: 'ready', ...batch });
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

/** The specs (and greps) one deploy should run, with the globs whose test plans asked for each. */
export interface AtfBatch {
  readonly environment: string;
  readonly sha: string;
  readonly specs: readonly RequestedSpec[];
  readonly greps: readonly RequestedGrep[];
}

/** What the ATF stage is told for a deploy. */
export type AtfBatchAnswer =
  | { readonly status: 'pending' }
  | { readonly status: 'superseded'; readonly latestSha: string }
  | ({ readonly status: 'ready' } & AtfBatch);

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

/** Notes the runner's "last result" when a bound run was recorded (the legacy board token has no runner row). */
const stampResult = async (tx: Tx, binding: RunnerBinding | undefined, now: string): Promise<void> => {
  if (binding === undefined || binding.runnerId === null) return;
  await tx.updateAtfRunner(binding.boardId, binding.runnerId, { lastResultAt: now });
};

/**
 * Each runner's name, only for a board with more than one (registered runners, or sources among these runs: the legacy
 * source counts as one). A board with a single runner shows no names.
 */
const runnerNamesOf = async (tx: Tx, boardId: number, runs: readonly TestRun[]): Promise<RunnerNames | undefined> => {
  const runners = await tx.listAtfRunners(boardId, { includeRevoked: true });
  const sources = new Set(runs.map((r) => r.runnerId));
  if (sources.size < 2 && runners.filter((r) => r.revokedAt === null).length < 2) return undefined;
  const names = new Map<number | null, string>(runners.map((r) => [r.id, r.name]));
  names.set(null, LEGACY_RUNNER_NAME);
  return names;
};

/**
 * The spec list of the succeeded branch deploys of `sha` in `environment` (normally one glob's), read from the globs' latest
 * test plans; null when none has succeeded.
 */
const batchOf = async (tx: Tx, boardId: number, environment: string, sha: string): Promise<AtfBatch | null> => {
  const deployed = (await tx.listDeploys(boardId, { environment, states: ['succeeded'] })).filter((d) => sameCommit(d.sha, sha));
  if (deployed.length === 0) return null;
  const globIds = [...new Set(deployed.map((d) => d.globId))];
  const plans = await tx.latestArtifacts(globIds, ['test_plan']);
  const union = unionSpecs(
    globIds.map((globId) => {
      const plan = plans.find((a) => a.globId === globId);
      return { globId, atf: plan === undefined ? null : testPlanSpecs(plan) };
    }),
  );
  return { environment, sha: deployed[0]?.sha ?? sha, ...union };
};

/** The run's specs plus a `missing` row for every spec of the deploy's list that it didn't report. */
const withMissing = async (
  tx: Tx,
  boardId: number,
  environment: string,
  sha: string,
  reported: readonly TestRunSpec[],
): Promise<TestRunSpec[]> => {
  const batch = await batchOf(tx, boardId, environment, sha);
  return batch === null ? [...reported] : [...reported, ...testRuns.missingSpecs(batch.specs, reported)];
};
