import type { NotificationService, Store } from '@slop/core';
import { syncReadiness } from './http/readiness.js';
import type { ReadinessSources } from './http/readiness.js';

/**
 * Keeps each board's setup notifications true without anyone opening settings: a GitHub App that lost access or
 * routines that keep failing raise a warning on the bar, and it clears when the item passes again.
 */
export class ReadinessWatch {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly sources: ReadinessSources,
    private readonly notifications: Pick<NotificationService, 'syncReadiness'>,
    private readonly logError: (where: string, message: string) => void,
  ) {}

  async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const board of await this.store.transaction((tx) => tx.listAllBoards())) {
        try {
          await syncReadiness({ ...this.sources, notifications: this.notifications }, board);
        } catch (error) {
          this.logError('readiness', `${String(board.id)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      this.logError('readiness', error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 60_000): void {
    if (this.timer !== null) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
