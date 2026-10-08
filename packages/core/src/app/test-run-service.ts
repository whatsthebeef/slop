import { observedEnvironment } from '../domain/environments.js';
import { forbidden, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import { parseId } from '../domain/ids.js';
import * as testRuns from '../domain/test-runs.js';
import type { AtfIndicator, EnvironmentCommit, NewTestRun } from '../domain/test-runs.js';
import type { Clock, Hint, Notifier, Store } from '../ports.js';

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
      const withBranchRuns = new Set(runs.flatMap((r) => (r.globId === null ? [] : [r.globId])));
      for (const globId of globIds) {
        // Only a branch run needs the glob (its PR head says whether the run is stale).
        const glob = withBranchRuns.has(globId) ? await tx.getGlob(globId) : null;
        const indicators = testRuns.atfIndicators({ id: globId, pr: glob?.pr ?? null }, runs, presences);
        if (indicators.length > 0) state.set(globId, indicators);
      }
      return state;
    });
  }

  /** Every ATF run the glob view lists: its branch runs and the runs against the environment commits holding it. */
  async forGlob(email: string, globId: string): Promise<Result<AtfIndicator[]>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      if ((await tx.getMember(glob.boardId, email)) === null) {
        return forbidden(`You are not a member of board ${String(glob.boardId)}`);
      }
      const presences = await tx.listGlobPresence(glob.boardId, { globIds: [globId], contained: true });
      const commits = presences.map((p) => ({ environment: p.environment, sha: p.checkedSha }));
      const runs = await tx.listTestRuns(glob.boardId, { globIds: [globId], commits });
      return ok(testRuns.globTestRuns(glob, runs, presences));
    });
  }
}
