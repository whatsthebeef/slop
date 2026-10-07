import type { GlobService, Store } from '@slop/core';
import { machine } from '@slop/core';

const EVERY_MS = 5 * 60_000;

/**
 * Fails routine runs that stopped making progress or never marked their PR ready, using each
 * board's limits. The outcome is the same as the routine calling `report_failure` (rows 17, 25).
 */
export class RunWatch {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly globs: GlobService,
    private readonly log: (task: string, message: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.check().catch((e: unknown) => this.log('run-watch', String(e))), EVERY_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  async check(now = new Date().toISOString()): Promise<number> {
    const due = await this.store.transaction(async (tx) => {
      const found: { id: string; runId: string; reason: string }[] = [];
      for (const board of await tx.listAllBoards()) {
        for (const glob of await tx.listGlobs(board.id, { status: ['implementing', 'pr_open'] })) {
          const reason = machine.runTimeoutReason(glob, board, now);
          const run = machine.currentRun(glob);
          if (reason !== null && run !== null) found.push({ id: glob.id, runId: run.id, reason });
        }
      }
      return found;
    });
    for (const { id, runId, reason } of due) {
      await this.globs.applyEvent(id, (g, ctx) => machine.reportFailure(g, { reason: reason.startsWith('Routine run never started') ? reason : `Run timed out: ${reason}`, runId }, ctx));
    }
    return due.length;
  }
}
