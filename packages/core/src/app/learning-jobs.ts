import { invalidInput, notFound, ok, runActive } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { BOARD_JOBS } from '../domain/signals.js';
import type { BoardJob, BoardJobName, BoardJobResult, BoardJobStatus } from '../domain/signals.js';
import type { Board } from '../domain/types.js';
import type { Clock, ManifestSource, Notifier, Store } from '../ports.js';
import { adminOf, memberOf } from './access.js';
import { LlmUnavailable } from './intake-service.js';
import { MAX_CONSOLIDATION_PAIRS } from './kb-consolidation.js';
import type { KbConsolidation } from './kb-consolidation.js';
import { LLM_TIMEOUT_MS } from './kb-pipeline.js';
import type { MiningService } from './mining-service.js';
import type { EffectCheckService } from './effect-check-service.js';
import type { SubLimitService } from './sub-limit-service.js';
import type { IntakeLearningService } from './intake-learning-service.js';

const HOUR_MS = 60 * 60 * 1000;

/** Mining runs when this long has passed since the board's last run (checked hourly). */
export const MINING_INTERVAL_MS = 7 * 24 * HOUR_MS;
/** Consolidation runs when this long has passed since the board's last run, after mining when both are due. */
export const CONSOLIDATION_INTERVAL_MS = 7 * 24 * HOUR_MS;
/** Effect checks run daily: approved changes' figures are refreshed as globs merge. */
export const EFFECT_CHECK_INTERVAL_MS = 24 * HOUR_MS;
/**
 * The learned sub limit runs hourly: outcomes are recorded soon after they happen. A little under an hour, so the
 * hourly check doesn't miss every other run on a few seconds' drift.
 */
export const SUB_LIMIT_INTERVAL_MS = 55 * 60 * 1000;

/** How often each job runs, in the order a board's due jobs run. */
const INTERVALS: readonly (readonly [BoardJobName, number])[] = [
  ['mining', MINING_INTERVAL_MS],
  ['consolidation', CONSOLIDATION_INTERVAL_MS],
  ['effect_check', EFFECT_CHECK_INTERVAL_MS],
  ['sub_limit', SUB_LIMIT_INTERVAL_MS],
  ['intake_outcome', SUB_LIMIT_INTERVAL_MS],
];
/** A board job's lease: another server doesn't start the same job meanwhile. */
export const BOARD_JOB_LEASE_MS = 30 * 60 * 1000;
/**
 * Consolidation's lease covers its worst case: the candidate-pair call and every verification each running to the
 * LLM deadline, a margin for the writes, and a whole mining run (its lease): each merge and the stale pass wait on
 * mining's board lock, which a mining run started meanwhile (Run now) holds until it finishes.
 */
export const CONSOLIDATION_LEASE_MS =
  (1 + MAX_CONSOLIDATION_PAIRS) * LLM_TIMEOUT_MS + 15 * 60 * 1000 + BOARD_JOB_LEASE_MS;
const leaseOf = (job: BoardJobName): number => (job === 'consolidation' ? CONSOLIDATION_LEASE_MS : BOARD_JOB_LEASE_MS);

/** After a failed run the next try waits this long, doubling with each failure in a row up to the cap. */
export const FAILED_RETRY_MS = HOUR_MS;
export const FAILED_RETRY_MAX_MS = 24 * HOUR_MS;
/** How long after its `failures`-th failure in a row a job is tried again. */
export const failedRetryMs = (failures: number): number =>
  Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_MS * 2 ** Math.max(0, failures - 1));

/**
 * The failed runs in a row before `result`: a failure's count (1 when recorded before the backoff), carried
 * through a skip; undefined after a run that finished.
 */
const failuresOf = (result: BoardJobResult | null): number | undefined => {
  if (result?.kind === 'failed') return result.failures ?? 1;
  if (result?.kind === 'skipped') return result.failures;
  return undefined;
};

/**
 * Whether a job is due at `now`: a skipped run (its AI was unavailable) at once, so the next hourly check tries
 * again; a failed one once its backoff has passed (a failure recorded without its time, by the interval); otherwise
 * once the interval has passed since its last run.
 */
export const isJobDue = (last: BoardJob | null, interval: number, now: string): boolean => {
  const result = last?.lastResult ?? null;
  if (result?.kind === 'skipped') return true;
  if (result?.kind === 'failed' && result.at !== undefined)
    return Date.parse(now) - Date.parse(result.at) >= failedRetryMs(result.failures ?? 1);
  return last?.lastRunAt == null || Date.parse(now) - Date.parse(last.lastRunAt) >= interval;
};
/** The most merges a run reads manifests for (code-host calls), newest kept. */
export const MAX_MANIFEST_COMMITS = 50;

export const isBoardJobName = (value: string): value is BoardJobName => BOARD_JOBS.some((j) => j === value);

/**
 * The self-improvement pipeline's per-board jobs: weekly mining, then weekly consolidation, then daily effect checks, and hourly the learned sub limit. Each run takes the
 * board's `board_jobs` lease, so two servers don't both run it, and records its result for the Knowledge page.
 * Admins can run one now. While consolidation's AI is unavailable it is skipped (the last run stands), and the next
 * hourly check tries again; a failed run is tried again after a backoff (`failedRetryMs`).
 */
export class LearningJobService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      mining: MiningService;
      /** Absent: the consolidation job isn't available (no LLM). */
      consolidation?: KbConsolidation;
      /** Whether consolidation's model is known to be down (`llmHealth`): the job then waits without calls. */
      consolidationDown?: () => boolean;
      /** Absent: the effect-check job isn't available. */
      effectChecks?: EffectCheckService;
      /** Absent: the sub-limit learning isn't available. */
      subLimit?: SubLimitService;
      /** Absent: intake outcomes aren't recorded. */
      intakeLearning?: IntakeLearningService;
      /** Null without a code host: the dependency signal isn't measured. */
      manifests: ManifestSource | null;
      /** Where a run that outlived its lease is reported (the server's error log). */
      log?: (task: string, message: string) => void;
    },
  ) {}

  /** The jobs that can run: mining, consolidation when it has an LLM, and effect checks and the sub limit when wired. */
  private runnable(): BoardJobName[] {
    return [
      'mining',
      ...(this.deps.consolidation === undefined ? [] : ['consolidation' as const]),
      ...(this.deps.effectChecks === undefined ? [] : ['effect_check' as const]),
      ...(this.deps.subLimit === undefined ? [] : ['sub_limit' as const]),
      ...(this.deps.intakeLearning === undefined ? [] : ['intake_outcome' as const]),
    ];
  }

  /**
   * Runs every board's due jobs (`isJobDue`: each its interval after its last run, a week or a day for effect checks,
   * sooner after a skipped or failed one);
   * returns what ran. Mining runs first so consolidation's stale rule reads this week's below-threshold counts; the
   * items mining raises are still pending, so consolidation compares them once the pipeline has drafted them, the
   * next week. Consolidation isn't claimed while its model is down.
   */
  async runDue(): Promise<{ boardId: number; job: BoardJobName; result: BoardJobResult }[]> {
    const boards = await this.deps.store.transaction((tx) => tx.listAllBoards());
    const runnable = this.runnable();
    const ran: { boardId: number; job: BoardJobName; result: BoardJobResult }[] = [];
    for (const board of boards) {
      for (const [job, interval] of INTERVALS) {
        if (!runnable.includes(job)) continue;
        if (job === 'consolidation' && this.deps.consolidationDown?.() === true) continue;
        const now = this.deps.clock.now();
        const last = await this.deps.store.transaction((tx) => tx.getBoardJob(board.id, job));
        if (!isJobDue(last, interval, now)) continue;
        const claimed = await this.claim(board, job);
        if (claimed === null) continue;
        const finished = await this.execute(board, claimed);
        if (finished.lastResult !== null) ran.push({ boardId: board.id, job, result: finished.lastResult });
      }
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
    if (!this.runnable().includes(job)) return invalidInput(`The ${job} job isn't available yet`);
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
   * After an approval started an effect check (admins only, as Run now): its before figures come now rather than at
   * the next daily run. Only the approved item is checked, and the job isn't recorded as run, so the board's daily
   * schedule stands. The check takes the board's effect-check lock per item, so it doesn't clash with a running run.
   * Throws as the job's run would; the caller logs it.
   */
  async checkApproval(email: string, boardId: number, itemId: string): Promise<Result<BoardJobResult>> {
    const { effectChecks } = this.deps;
    if (effectChecks === undefined) return invalidInput("The effect_check job isn't available yet");
    const actor = await this.deps.store.transaction((tx) => adminOf(tx, email, boardId));
    if (!actor.ok) return actor;
    return ok(await effectChecks.check(boardId, this.deps.clock.now(), [itemId]));
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

  /** One run of a job; a job whose AI is unavailable is `skipped`. */
  private async run(board: Board, job: BoardJobName, started: string, lastRunAt: string | null): Promise<BoardJobResult> {
    if (job === 'consolidation') {
      const { consolidation } = this.deps;
      if (consolidation === undefined) throw new Error('The consolidation job has no LLM');
      if (this.deps.consolidationDown?.() === true) return { kind: 'skipped', reason: 'AI unavailable' };
      try {
        return await consolidation.consolidate(board.id);
      } catch (error) {
        if (error instanceof LlmUnavailable) return { kind: 'skipped', reason: `AI unavailable: ${error.reason}` };
        throw error;
      }
    }
    if (job === 'effect_check') {
      const { effectChecks } = this.deps;
      if (effectChecks === undefined) throw new Error('The effect-check job is not wired');
      return effectChecks.check(board.id, started);
    }
    if (job === 'sub_limit') {
      const { subLimit } = this.deps;
      if (subLimit === undefined) throw new Error('The sub-limit job is not wired');
      return subLimit.learn(board.id, started, lastRunAt);
    }
    if (job === 'intake_outcome') {
      const { intakeLearning } = this.deps;
      if (intakeLearning === undefined) throw new Error('The intake-outcome job is not wired');
      return intakeLearning.run(board.id, started);
    }
    const commits = await this.deps.mining.mergedCommits(board.id, started);
    const manifestChanges =
      this.deps.manifests === null ? null : await this.deps.manifests.manifestChanges(board, commits.slice(-MAX_MANIFEST_COMMITS));
    return this.deps.mining.mine(board.id, started, { manifestChanges });
  }

  /** Takes a job's lease; null when another server holds it. The Knowledge page shows it running. */
  private async claim(board: Board, job: BoardJobName): Promise<BoardJob | null> {
    const claimed = await this.deps.store.transaction((tx) => tx.claimBoardJob(board.id, job, this.deps.clock.now(), leaseOf(job)));
    if (claimed !== null) this.deps.notifier.publish({ kind: 'board.kb', boardId: board.id });
    return claimed;
  }

  /** Runs a claimed job and records its result, releasing the lease. */
  private async execute(board: Board, claimed: BoardJob): Promise<BoardJob> {
    const started = this.deps.clock.now();
    const lease = claimed.runningUntil ?? started;
    let finished: BoardJob;
    try {
      const result = await this.run(board, claimed.job, started, claimed.lastRunAt);
      // Skipped (the AI is down): the last run stays as it was, and the next hourly check tries again. A skip keeps
      // the failures in a row before it, so an AI that alternates between down and failing still backs off.
      const failures = result.kind === 'skipped' ? failuresOf(claimed.lastResult) : undefined;
      const lastResult = result.kind === 'skipped' && failures !== undefined ? { ...result, failures } : result;
      finished = { ...claimed, lastRunAt: result.kind === 'skipped' ? claimed.lastRunAt : started, lastResult, runningUntil: null };
    } catch (error) {
      // The last run stays as it was; the next try backs off (`isJobDue`), so a failure that persists isn't paid
      // for every hour.
      const failures = (failuresOf(claimed.lastResult) ?? 0) + 1;
      const failed: BoardJobResult = {
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
        at: this.deps.clock.now(),
        failures,
      };
      finished = { ...claimed, lastResult: failed, runningUntil: null };
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
