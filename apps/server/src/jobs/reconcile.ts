import type { GlobService, Store } from '@slop/core';
import { machine, reconcileDue } from '@slop/core';

const EVERY_MS = 10 * 60_000;
/** Code host calls one sweep may queue; the rest wait for the next tick. */
const MAX_PER_SWEEP = 25;

/**
 * Catches up on webhooks slop missed (a restart, a tunnel blip): GitHub doesn't retry a failed delivery, so the code
 * host is the source of truth. On start every open PR is re-read; then every 10 minutes the ones that look stuck are.
 * Each re-read is an outbox effect (`reconcile_pr`), idempotent and generation-checked.
 */
export class ReconcileWatch {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly globs: GlobService,
    private readonly log: (task: string, message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.sweep(true);
    this.timer = setInterval(() => void this.sweep(false), EVERY_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Queues a reconcile for the globs that need one (`all`: every open PR, as on start); returns the ids queued. */
  async sweep(all: boolean): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const nowMs = this.now();
      const open = await this.store.transaction(async (tx) => {
        const found = [];
        for (const board of await tx.listAllBoards()) {
          for (const glob of await tx.listGlobs(board.id, { status: ['implementing', 'in_progress', 'pr_open', 'merging'] })) {
            if (all ? machine.isReconcilable(glob) : reconcileDue(glob, nowMs)) found.push(glob.id);
          }
        }
        return found;
      });
      const due = all ? open : open.slice(0, MAX_PER_SWEEP);
      for (const id of due) await this.globs.applyEvent(id, (g, ctx) => machine.reconcileRequested(g, ctx));
      return due;
    } catch (error) {
      this.log('reconcile', error instanceof Error ? error.message : String(error));
      return [];
    } finally {
      this.running = false;
    }
  }
}
