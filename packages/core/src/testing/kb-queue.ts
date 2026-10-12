import { kbItems, kbJobHint } from '../app/kb-items.js';
import type { KbPipeline } from '../app/kb-pipeline.js';
import { claimLeaseMs, laneOf, maxAttemptsOf, outboxBackoffMs } from '../domain/events.js';
import type { OutboxState } from '../domain/events.js';
import { KB_STEP_KIND, kbStepOfKind } from '../domain/kb.js';
import type { KbItem, KbStep } from '../domain/kb.js';
import type { Clock, Notifier } from '../ports.js';
import type { KbWriteContext } from '../app/kb-items.js';
import type { MemoryOutboxJob, MemoryStore } from './memory-store.js';

/**
 * The outbox's `llm` lane for core tests: runs the KB pipeline's queued jobs in a MemoryStore with the same bookkeeping
 * as the server's `OutboxRunner` (a claim spends an attempt and sets a backoff, a throw records the error and fails the
 * job on its last attempt, a retry-later gives the attempt back and keeps its reason, and a settled job that the
 * Knowledge page should hear of publishes `board.kb`). The runner itself is tested against Postgres.
 */
export class MemoryKbQueue {
  constructor(
    private readonly store: MemoryStore,
    private readonly pipeline: Pick<KbPipeline, 'runStep'>,
    private readonly clock: Clock,
    private readonly notifier?: Notifier,
  ) {}

  /**
   * Runs the oldest due job; returns its item's ID, or null when none is due. A job dropped because its step no longer
   * applies (the item moved on) is passed over, as the old queue never offered such an item.
   */
  async processNext(): Promise<string | null> {
    for (let job = this.due(); job !== null; job = this.due()) {
      if ((await this.run(job)) !== 'dropped') return job.globId;
    }
    return null;
  }

  /** Runs the given item's due job (passing over dropped ones), if it has one; returns whether one ran. */
  async process(itemId: string): Promise<boolean> {
    for (let job = this.due(itemId); job !== null; job = this.due(itemId)) {
      if ((await this.run(job)) !== 'dropped') return true;
    }
    return false;
  }

  /** Runs due jobs until none is left (bounded, so a job that keeps asking to run at once can't loop forever). */
  async drain(limit = 50): Promise<number> {
    let ran = 0;
    while (ran < limit && (await this.processNext()) !== null) ran++;
    return ran;
  }

  /** Marks the item's newest pipeline job failed, as if its last attempt had failed with `error`. */
  fail(itemId: string, error: string): void {
    const job = this.jobOf(itemId);
    if (job === null) throw new Error(`${itemId} has no pipeline job`);
    this.set(job.id, { state: 'failed', attempts: maxAttemptsOf(laneOf(job.kind)), lastError: error });
  }

  /** The item's newest pipeline job, for assertions on the queue itself. */
  jobOf(itemId: string): MemoryOutboxJob | null {
    return this.store.state.outboxJobs.filter((j) => j.globId === itemId && kbStepOfKind(j.kind) !== null).at(-1) ?? null;
  }

  private due(itemId?: string): MemoryOutboxJob | null {
    const now = this.clock.now();
    return (
      this.store.state.outboxJobs.find(
        (j) => kbStepOfKind(j.kind) !== null && j.state === 'pending' && j.runAfter <= now && (itemId === undefined || j.globId === itemId),
      ) ?? null
    );
  }

  private set(id: number, patch: Partial<Pick<MemoryOutboxJob, 'state' | 'attempts' | 'lastError' | 'runAfter'>>): void {
    // Read the state afresh: every transaction replaces it.
    this.store.state.outboxJobs = this.store.state.outboxJobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  }

  private later(ms: number): string {
    return new Date(Date.parse(this.clock.now()) + ms).toISOString();
  }

  private async run(job: MemoryOutboxJob): Promise<OutboxState> {
    const step = kbStepOfKind(job.kind);
    if (step === null) return 'dropped';
    const attempts = job.attempts + 1;
    const lane = laneOf(job.kind);
    this.set(job.id, { attempts, runAfter: this.later(claimLeaseMs(job.attempts, lane)) });
    let state: OutboxState = 'pending';
    let lastError: string | null = null;
    let retry = false;
    try {
      const outcome = await this.pipeline.runStep(job.globId, step);
      if (typeof outcome === 'string') state = outcome;
      else {
        retry = true;
        lastError = outcome.reason ?? job.lastError;
        this.set(job.id, { attempts: job.attempts, runAfter: this.later(outcome.retryAfterMs) });
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      state = attempts >= maxAttemptsOf(lane) ? 'failed' : 'pending';
      // Retried after the lane's backoff, not the claim's lease.
      if (state === 'pending') this.set(job.id, { runAfter: this.later(outboxBackoffMs(job.attempts, lane)) });
    }
    this.set(job.id, { state, lastError });
    const hint = kbJobHint(job.effect);
    // A finished job's write already told the page, and a dropped one changed nothing.
    const news = state === 'failed' || (state === 'pending' && (!retry || lastError !== job.lastError));
    if (hint !== null && news) this.notifier?.publish(hint);
    return state;
  }
}

/**
 * Seeds a KB item as a test describes it, pipeline state included: the item is inserted as is (no jobs queued by the
 * write), and its `processing` becomes what the pipeline would have left. A waiting or failed item gets a job for its
 * step with the given attempts, error and time; its fields are made to agree with that step (an item waiting to be
 * routed has no target, one waiting for its draft or given up on has no draft). Returns the item as it reads.
 */
export const seedKbItem = async (store: MemoryStore, item: KbItem): Promise<KbItem> => {
  const step: KbStep | null =
    item.status !== 'open' || item.document !== null || item.processing === 'drafted'
      ? null
      : item.processing === 'pending' || (item.processing === 'failed' && item.target === null)
        ? 'route'
        : 'draft';
  const cleared = { draft: null, draftedAgainstVersion: null, rationale: null };
  const seeded: KbItem = step === 'route' ? { ...item, ...cleared, target: null } : step === 'draft' ? { ...item, ...cleared } : item;
  await store.transaction(async (tx) => {
    // The insert queues the item's step (`kbEffectsFor`); a repeat is dropped by the one-pending-job rule.
    await kbItems(tx, { clock: { now: () => item.createdAt } }).insertKbItem(seeded);
    if (step !== null) await tx.enqueueEffects([{ kind: KB_STEP_KIND[step], globId: item.id }]);
  });
  if (step !== null && (item.processing === 'failed' || item.processingAttempts > 0 || item.processingError !== null)) {
    const job = store.state.outboxJobs.filter((j) => j.globId === item.id && j.kind === KB_STEP_KIND[step]).at(-1);
    if (job !== undefined) {
      store.state.outboxJobs = store.state.outboxJobs.map((j) =>
        j.id === job.id
          ? {
              ...j,
              state: item.processing === 'failed' ? 'failed' : 'pending',
              attempts: item.processingAttempts,
              lastError: item.processingError,
              runAfter: item.processAfter ?? j.runAfter,
            }
          : j,
      );
    }
  }
  const read = await store.transaction((tx) => kbItems(tx).getKbItem(item.id));
  if (read === null) throw new Error(`Seeding ${item.id} failed`);
  return read;
};

/** What tests write KB items with when the time doesn't matter: a fixed clock, no live hints. */
export const TEST_KB_WRITES: KbWriteContext = { clock: { now: () => '2026-10-05T12:00:00.000Z' } };
