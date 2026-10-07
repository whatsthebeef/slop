import type { KbPipeline } from '@slop/core';

const POLL_MS = 5_000;
/** While the LLM is down, how often one item is claimed to find out whether it works again. */
export const PROBE_MS = 60_000;

/**
 * Routes, deduplicates and drafts submitted KB items in the background, one step at a time: every
 * few seconds it processes items due for routing or drafting until none is left. `stop` lets the
 * item in hand finish.
 *
 * While the LLM is unavailable (expired sign-in, no model access) it claims at most one item a
 * minute: that item's call is the probe, and the first success marks the LLM ok again. Items the
 * LLM fails this way wait without losing attempts (`KbPipeline`), so pausing only saves calls.
 */
export class KbPipelineJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /**
   * When a claimed item's processing ended (ms), so a probe waits PROBE_MS from the call that found
   * the LLM down. Stamped after the call, so that item (due a minute after its own wait began) is
   * due by the next probe; a claim that found nothing due isn't a probe and doesn't count.
   */
  private lastClaim = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly pipeline: Pick<KbPipeline, 'processNext'>,
    private readonly log: (task: string, message: string) => void,
    private readonly llm: { isDown(): boolean },
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.drain(), POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Processes due items until none is left, the job is stopped, or the LLM is down (one probe a minute then). */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.mayClaim()) {
        if ((await this.pipeline.processNext()) === null) break;
        this.lastClaim = this.now();
      }
    } catch (error) {
      // A store error leaves the claimed item leased; it is retried when the lease ends.
      this.log('kb-pipeline', error instanceof Error ? (error.stack ?? error.message) : String(error));
    } finally {
      this.running = false;
    }
  }

  private mayClaim(): boolean {
    return !this.llm.isDown() || this.now() - this.lastClaim >= PROBE_MS;
  }
}
