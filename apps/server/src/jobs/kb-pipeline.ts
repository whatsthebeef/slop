import type { KbPipeline } from '@slop/core';

const POLL_MS = 5_000;

/**
 * Routes and deduplicates submitted KB items in the background, one at a time: every few seconds
 * it processes pending items until none is due. `stop` lets the item in hand finish.
 */
export class KbPipelineJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly pipeline: KbPipeline,
    private readonly log: (task: string, message: string) => void,
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

  /** Processes due items until none is left or the job is stopped. */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && (await this.pipeline.processNext()) !== null) {
        // One item at a time; the loop condition does the work.
      }
    } catch (error) {
      // A store error leaves the claimed item leased; it is retried when the lease ends.
      this.log('kb-pipeline', error instanceof Error ? (error.stack ?? error.message) : String(error));
    } finally {
      this.running = false;
    }
  }
}
