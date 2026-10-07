import type { BoardJobResult, LearningJobService } from '@slop/core';

const HOUR_MS = 60 * 60 * 1000;

/** A finished run in one line, for the server log. */
const summary = (result: Exclude<BoardJobResult, { kind: 'failed' }>): string => {
  switch (result.kind) {
    case 'mining':
      return `${result.measured} signals measured, ${result.raised.length} raised, ${result.refreshed.length} refreshed`;
    case 'consolidation':
      return [
        result.unchanged === true
          ? `candidates unchanged, no pairs proposed (${result.alreadyChecked ?? 0} already checked)`
          : `${result.proposed} pairs proposed (${result.alreadyChecked ?? 0} already checked), ${result.verified} verified, ${result.merged.length} merged`,
        ...result.merged.map((m) => `${m.id} into ${m.into}`),
        `${result.skipped} skipped, ${result.flaggedStale} flagged stale, ${result.clearedStale} cleared`,
      ].join('; ');
    case 'effect_check':
      return [
        `${result.watching} watching`,
        ...result.decided.map((d) => `${d.id} ${d.state.replace('_', ' ')}`),
        `${result.raised.length} raised${result.raised.length === 0 ? '' : ` (${result.raised.join(', ')})`}`,
      ].join('; ');
    case 'skipped':
      return `skipped (${result.reason}); the next check tries again`;
  }
};

/**
 * Checks hourly for the self-improvement pipeline's per-board jobs that are due (mining, then consolidation, a
 * week after the board's last run of each, then effect checks, a day after theirs, sooner after a skipped or failed run: `isJobDue`) and runs them through `LearningJobService`, which takes each job's lease so two servers
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
        else console.log(`[${job}] board ${boardId}: ${summary(result)}`);
      }
    } catch (error) {
      this.log('learning jobs', error instanceof Error ? (error.stack ?? error.message) : String(error));
    } finally {
      this.running = false;
    }
  }
}
