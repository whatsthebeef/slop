import type { LearningJobService } from '@slop/core';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Checks hourly for the self-improvement pipeline's per-board jobs that are due (mining a week after the
 * board's last run) and runs them through `LearningJobService`, which takes each job's lease so two servers
 * don't both run it. Also checks once on start, so a due run isn't left waiting an hour after a restart.
 */
export class LearningJobs {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly service: Pick<LearningJobService, 'runDue'>,
    private readonly log: (task: string, message: string) => void,
    private readonly intervalMs = HOUR_MS,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check; a check still running when the next is due is not overlapped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const { boardId, job, result } of await this.service.runDue()) {
        if (result.kind === 'failed') this.log(job, `board ${boardId}: ${result.error}`);
        else console.log(`[${job}] board ${boardId}: ${result.measured} signals measured, ${result.raised.length} raised, ${result.refreshed.length} refreshed`);
      }
    } catch (error) {
      this.log('learning jobs', error instanceof Error ? (error.stack ?? error.message) : String(error));
    } finally {
      this.running = false;
    }
  }
}
