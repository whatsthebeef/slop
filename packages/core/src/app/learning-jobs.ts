import { invalidInput, notFound, ok, runActive } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { BOARD_JOBS } from '../domain/signals.js';
import type { BoardJob, BoardJobName, BoardJobResult, BoardJobStatus } from '../domain/signals.js';
import type { Board } from '../domain/types.js';
import type { Clock, ManifestSource, Notifier, Store } from '../ports.js';
import { adminOf, memberOf } from './access.js';
import type { MiningService } from './mining-service.js';

const HOUR_MS = 60 * 60 * 1000;

/** Mining runs when this long has passed since the board's last run (checked hourly). */
export const MINING_INTERVAL_MS = 7 * 24 * HOUR_MS;
/** A board job's lease: another server doesn't start the same job meanwhile. */
export const BOARD_JOB_LEASE_MS = 30 * 60 * 1000;
/** The most merges a run reads manifests for (code-host calls), newest kept. */
export const MAX_MANIFEST_COMMITS = 50;

/** The jobs that can run so far; the others arrive with their strands (consolidation, effect check, sub limit). */
const RUNNABLE: readonly BoardJobName[] = ['mining'];

export const isBoardJobName = (value: string): value is BoardJobName => BOARD_JOBS.some((j) => j === value);

/**
 * The self-improvement pipeline's per-board jobs: weekly mining for now. Each run takes the board's
 * `board_jobs` lease, so two servers don't both run it, and records its result for the Knowledge page.
 * Admins can run one now.
 */
export class LearningJobService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      mining: MiningService;
      /** Null without a code host: the dependency signal isn't measured. */
      manifests: ManifestSource | null;
      /** Where a run that outlived its lease is reported (the server's error log). */
      log?: (task: string, message: string) => void;
    },
  ) {}

  /** Runs every board's due jobs (mining a week after its last run); returns what ran. */
  async runDue(): Promise<{ boardId: number; job: BoardJobName; result: BoardJobResult }[]> {
    const now = this.deps.clock.now();
    const boards = await this.deps.store.transaction((tx) => tx.listAllBoards());
    const ran: { boardId: number; job: BoardJobName; result: BoardJobResult }[] = [];
    for (const board of boards) {
      const last = await this.deps.store.transaction((tx) => tx.getBoardJob(board.id, 'mining'));
      if (last?.lastRunAt != null && Date.parse(now) - Date.parse(last.lastRunAt) < MINING_INTERVAL_MS) continue;
      const claimed = await this.claim(board, 'mining');
      if (claimed === null) continue;
      const finished = await this.execute(board, claimed);
      if (finished.lastResult !== null) ran.push({ boardId: board.id, job: 'mining', result: finished.lastResult });
    }
    return ran;
  }

  /**
   * An admin's Run now: takes the job's lease straight away (`run_active` when it is already running) and
   * returns the claimed job, with `finished` settling once the run has been recorded. The caller doesn't wait
   * for it: the `board.kb` hint and the Knowledge page's poll show the result.
   */
  async runNow(email: string, boardId: number, job: string): Promise<Result<{ job: BoardJob; finished: Promise<BoardJob> }>> {
    if (!isBoardJobName(job)) return notFound(`No board job ${job}`);
    if (!RUNNABLE.includes(job)) return invalidInput(`The ${job} job isn't available yet`);
    const board = await this.deps.store.transaction(async (tx): Promise<Result<Board>> => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const found = await tx.getBoard(boardId);
      return found === null ? notFound(`No board ${boardId}`) : ok(found);
    });
    if (!board.ok) return board;
    const claimed = await this.claim(board.value, job);
    if (claimed === null) return runActive(`The ${job} job is already running on board ${boardId}`);
    return ok({ job: claimed, finished: this.execute(board.value, claimed) });
  }

  /**
   * The board's jobs with their last runs, for members (the Knowledge page header). `running` is worked out
   * here, by the server's clock, so a browser with a skewed clock still sees an expired lease as not running.
   */
  async jobs(email: string, boardId: number): Promise<Result<BoardJobStatus[]>> {
    const now = Date.parse(this.deps.clock.now());
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const jobs: BoardJobStatus[] = [];
      for (const job of BOARD_JOBS) {
        const found = await tx.getBoardJob(boardId, job);
        if (found !== null) jobs.push({ ...found, running: found.runningUntil !== null && Date.parse(found.runningUntil) > now });
      }
      return ok(jobs);
    });
  }

  /** Takes a job's lease; null when another server holds it. The Knowledge page shows it running. */
  private async claim(board: Board, job: BoardJobName): Promise<BoardJob | null> {
    const claimed = await this.deps.store.transaction((tx) => tx.claimBoardJob(board.id, job, this.deps.clock.now(), BOARD_JOB_LEASE_MS));
    if (claimed !== null) this.deps.notifier.publish({ kind: 'board.kb', boardId: board.id });
    return claimed;
  }

  /** Runs a claimed job and records its result, releasing the lease. */
  private async execute(board: Board, claimed: BoardJob): Promise<BoardJob> {
    const started = this.deps.clock.now();
    const lease = claimed.runningUntil ?? started;
    let finished: BoardJob;
    try {
      const commits = await this.deps.mining.mergedCommits(board.id, started);
      const manifestChanges =
        this.deps.manifests === null ? null : await this.deps.manifests.manifestChanges(board, commits.slice(-MAX_MANIFEST_COMMITS));
      const result = await this.deps.mining.mine(board.id, started, { manifestChanges });
      finished = { ...claimed, lastRunAt: started, lastResult: result, runningUntil: null };
    } catch (error) {
      // The last run stays as it was, so the next hourly check tries again.
      finished = { ...claimed, lastResult: { kind: 'failed', error: error instanceof Error ? error.message : String(error) }, runningUntil: null };
    }
    // A run that outlived its lease leaves the record to the server that holds it now. It is logged, so
    // operators can see the lease is too short for the board.
    const recorded = await this.deps.store.transaction((tx) => tx.finishBoardJob(finished, lease));
    if (!recorded) {
      this.deps.log?.(
        claimed.job,
        `board ${String(board.id)}: the run started at ${started} outlived its lease (until ${lease}), so its result wasn't recorded`,
      );
    }
    // The Knowledge page shows the last run.
    this.deps.notifier.publish({ kind: 'board.kb', boardId: board.id });
    return finished;
  }
}
