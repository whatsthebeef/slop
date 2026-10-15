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
        for (const glob of await tx.listGlobs(board.id, { status: ['planning', 'implementing', 'pr_open', 'failed', 'in_progress'] })) {
          // A picked-up glob keeps only its investigation running (pick-up leaves it); no other run is watched there.
          if (glob.status === 'in_progress' && machine.liveInvestigation(glob) === null) continue;
          const reason = machine.runTimeoutReason(glob, board, now);
          const run = machine.currentRun(glob);
          if (reason !== null && run !== null) found.push({ id: glob.id, runId: run.id, reason });
        }
      }
      return found;
    });
    for (const { id, runId, reason } of due) {
      await this.globs.applyEvent(id, (g, ctx, facts) => machine.reportFailure(g, { reason: /^(Routine run never started|The run's session never reached slop|Auto-fix didn't respond)/.test(reason) ? reason : `Run timed out: ${reason}`, runId }, ctx, facts.relations), { relations: true });
    }
    return due.length;
  }
}
