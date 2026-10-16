import { claimLeaseMs, maxAttemptsOf, outboxBackoffMs } from '@slop/core';
import type { DecisionGlobService, Effect, EffectKind, Glob, GlobService, OutboxLane, OutboxState, RetryLater } from '@slop/core';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Db } from '../db/store.js';

/**
 * What an executor did: done, or dropped because it no longer applies. Throwing means retry with backoff and spends an
 * attempt. A `RetryLater` (`{ state: 'pending', retryAfterMs, reason? }`) retries later without spending one (for "LLM
 * busy"); its reason is kept as the job's last error.
 */
export type Outcome = 'done' | 'dropped';
export type { RetryLater };

export interface ExecutorDeps {
  readonly globs: GlobService;
  /** Moves the decision globs waiting on a merged work glob to Reviewing (absent: none are moved). */
  readonly decisions?: Pick<DecisionGlobService, 'linkedMerged'>;
}

/** `final`: this attempt is the last, so a failure that is thrown will not be retried. */
export interface AttemptInfo {
  readonly final: boolean;
}

export type Executor = (effect: Effect, glob: Glob | null, deps: ExecutorDeps, attempt?: AttemptInfo) => Promise<Outcome | RetryLater>;

/** An executor that never asks for a later retry (every one today). */
export type SettledExecutor = (effect: Effect, glob: Glob | null, deps: ExecutorDeps, attempt?: AttemptInfo) => Promise<Outcome>;

const POLL_MS = 2_000;

/** Effects that run with no glob behind them, or outlive its generation: never dropped as stale. */
const NOT_GENERATION_CHECKED: readonly EffectKind[] = [
  // Deploys outlive their glob's generation, and a deleted glob's deploy must still fail so its environment's queue
  // moves on; the deploy executor handles both.
  'delete_glob_data',
  'start_deploy',
  // Reads the deploy record; a deleted glob's deploy just has nothing to attach to.
  'attach_build_log',
  // The glob may be gone (a deleted glob's files); the key is all the executor needs.
  'delete_object',
  // Board-wide effects have no glob.
  'refresh_base_checks',
  'recheck_overlaps',
  'refresh_base_branch',
  'start_atf',
  'deliver_atf_webhook',
  // The KB pipeline's jobs name a KB item; the executor re-checks the item itself.
  'kb_route',
  'kb_draft',
  'suggest_decision',
  // The rollout job reads the merge it was queued for; a backfill queues it for globs merged long ago.
  'write_rollout_steps',
  // Board-wide like the others above; the executor re-reads the board.
  'regenerate_knowledge_page',
  // Board-wide; the executor re-reads the board and its open agent-set glob.
  'commit_agent_set',
];

/**
 * Executes outbox effects with retries. Every effect is re-checked against the glob's current
 * generation first, so work queued before a re-trigger, take over or start again is dropped. One runner drains one
 * lane, so a slow lane (LLM calls) never delays the others.
 */
export class OutboxRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private wake = false;

  constructor(
    private readonly db: Db,
    private readonly deps: ExecutorDeps,
    private readonly executors: Partial<Record<EffectKind, Executor>>,
    private readonly log: (task: string, message: string) => void,
    private readonly lane: OutboxLane = 'default',
    private readonly onSettled?: (effect: Effect, state: OutboxState) => void,
  ) {}

  private get maxAttempts(): number {
    return maxAttemptsOf(this.lane);
  }

  start(): void {
    this.timer = setInterval(() => void this.drain(), POLL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs pending jobs now. Callers that need a result (create_glob) await this. */
  async drain(globId?: string): Promise<void> {
    if (this.running) {
      this.wake = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.wake = false;
        for (;;) {
          const job = await this.claim(globId);
          if (job === null) break;
          await this.execute(job);
        }
      } while (this.wokenDuringDrain());
    } finally {
      this.running = false;
    }
  }

  /** Set by drain() calls that arrive while a drain is running. */
  private wokenDuringDrain(): boolean {
    return this.wake;
  }

  private async claim(globId?: string) {
    // One runner per instance; claim by marking the attempt so a crash mid-job retries later.
    return this.db.transaction(async (t) => {
      const conditions = [eq(schema.outbox.lane, this.lane), eq(schema.outbox.state, 'pending'), lte(schema.outbox.runAfter, new Date())];
      if (globId !== undefined) conditions.push(eq(schema.outbox.globId, globId));
      const [job] = await t
        .select()
        .from(schema.outbox)
        .where(and(...conditions))
        .orderBy(asc(schema.outbox.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (job === undefined) return null;
      await t
        .update(schema.outbox)
        .set({
          attempts: sql`${schema.outbox.attempts} + 1`,
          // Held for the lane's lease: on `llm` a step can run for minutes, and a second runner must not take it meanwhile.
          runAfter: new Date(Date.now() + claimLeaseMs(job.attempts, this.lane)),
        })
        .where(eq(schema.outbox.id, job.id));
      return job;
    });
  }

  private async execute(job: typeof schema.outbox.$inferSelect): Promise<void> {
    const effect = job.effect;
    const [row] = await this.db
      .select({ data: schema.globs.data })
      .from(schema.globs)
      .where(eq(schema.globs.id, effect.globId));
    const glob = row?.data ?? null;
    const stale = !NOT_GENERATION_CHECKED.includes(effect.kind) && (glob === null || ('generation' in effect && effect.generation < glob.generation));

    let state: 'done' | 'dropped' | 'pending' | 'failed';
    let lastError: string | null = null;
    let retryAfterMs: number | null = null;
    const final = job.attempts + 1 >= this.maxAttempts;
    if (stale) {
      state = 'dropped';
    } else {
      const executor = this.executors[effect.kind];
      if (executor === undefined) {
        // Not wired up, or a kind since removed (a release-check row queued before this deploy): dropped, never a crash.
        state = 'dropped';
        lastError = `No executor for ${effect.kind} yet`;
      } else {
        try {
          const outcome = await executor(effect, glob, this.deps, { final });
          if (typeof outcome === 'string') state = outcome;
          else {
            state = 'pending';
            retryAfterMs = outcome.retryAfterMs;
            // Why it waits, or the error it had before when the executor gave no reason.
            lastError = outcome.reason ?? job.lastError;
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          state = final ? 'failed' : 'pending';
          this.log(`outbox:${effect.kind}`, `${effect.globId}: ${lastError}`);
        }
      }
    }
    // A thrown failure retries after the lane's backoff, not the claim's lease.
    const thrown = retryAfterMs === null && state === 'pending';
    await this.db
      .update(schema.outbox)
      .set(
        retryAfterMs === null
          ? { state, lastError, ...(thrown ? { runAfter: new Date(Date.now() + outboxBackoffMs(job.attempts, this.lane)) } : {}) }
          : // Claim spent an attempt and set a backoff; give the attempt back and use the executor's delay.
            { state, lastError, attempts: sql`${schema.outbox.attempts} - 1`, runAfter: new Date(Date.now() + retryAfterMs) },
      )
      .where(eq(schema.outbox.id, job.id));
    // A wait that only repeats itself (the same reason) is no news.
    if (state !== 'pending' || retryAfterMs === null || lastError !== job.lastError) this.onSettled?.(effect, state);
  }
}
