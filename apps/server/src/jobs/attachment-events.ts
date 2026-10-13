import type { AttachmentService } from '@slop/core';
import { consumeObjectEvents } from '../sqs-object-events.js';
import type { ObjectEventQueue } from '../sqs-object-events.js';

const SWEEP_EVERY_MS = 5 * 60_000;
const RETRY_AFTER_ERROR_MS = 30_000;

/**
 * Keeps file attachments moving: consumes the bucket's object events (arrival is marked as soon as one lands) and
 * sweeps every few minutes, so an event lost to a misconfiguration only delays detection and expired links turn
 * `missing`. Without a queue only the sweep runs.
 */
export class AttachmentEventsJob {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly attachments: Pick<AttachmentService, 'objectArrived' | 'sweep'>,
    private readonly queue: ObjectEventQueue | null,
    private readonly log: (task: string, message: string) => void,
    private readonly retryMs = RETRY_AFTER_ERROR_MS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    if (this.queue !== null) void this.consume(this.queue);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep of the pending files; skipped while the last one still runs. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.attachments.sweep();
    } catch (error) {
      this.log('attachment sweep', error instanceof Error ? error.message : String(error));
    } finally {
      this.sweeping = false;
    }
  }

  /** One receive and handle round; returns how many messages were handled. */
  poll(queue: ObjectEventQueue): Promise<number> {
    return consumeObjectEvents(queue, this.attachments, this.log);
  }

  private async consume(queue: ObjectEventQueue): Promise<void> {
    while (this.running) {
      try {
        await this.poll(queue);
      } catch (error) {
        this.log('attachment events', error instanceof Error ? error.message : String(error));
        await new Promise((resolve) => setTimeout(resolve, this.retryMs));
      }
    }
  }
}
