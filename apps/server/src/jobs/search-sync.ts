import type { Hint } from '@slop/core';

/** How often the sync looks for boards whose material changed (and so the longest a change waits to be indexed). */
export const DEBOUNCE_MS = 10_000;
/** A full re-sync of every board even when no change was seen: the safety net under the dirty flags. */
export const SAFETY_SYNC_MS = 15 * 60_000;

/** The hints that mean a board's searchable material changed. */
export const marksBoardDirty = (hint: Hint): boolean =>
  hint.kind === 'glob.artifacts' ||
  hint.kind === 'glob.reviews' ||
  hint.kind === 'glob.changed' ||
  hint.kind === 'glob.deleted' ||
  hint.kind === 'board.kb';

/**
 * Keeps a board-derived store in step with the board's material: a full sync on start (the backfill; idempotent, so a
 * restart only reads), a re-sync of each board a hint marked dirty (debounced), and a full sync every 15 minutes. The
 * indexer re-chunks only what changed, so a sync that finds nothing writes nothing. One sync runs at a time.
 */
export class SearchSync {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly dirty = new Set<number>();
  private lastFull = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly indexer: { syncBoard(boardId: number): Promise<unknown>; syncAll(): Promise<void> },
    private readonly log: (task: string, message: string) => void,
    private readonly now: () => number = Date.now,
    /** Named in the error log (the decision pipeline's sync is another instance). */
    private readonly task = 'search',
  ) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), DEBOUNCE_MS);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read through a method: `stop` can run during an await, which narrowing across them can't see. */
  private halted(): boolean {
    return this.stopped;
  }

  /** Remembers that a board's material changed; the next tick syncs it. */
  mark(boardId: number): void {
    this.dirty.add(boardId);
  }

  /** One round: the full sync when it is due, else each dirty board. */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (this.now() - this.lastFull >= SAFETY_SYNC_MS) {
        this.dirty.clear();
        // Stamped first: a failing sync is retried at the next full round, not on every tick.
        this.lastFull = this.now();
        await this.indexer.syncAll();
        return;
      }
      for (const boardId of [...this.dirty]) {
        this.dirty.delete(boardId);
        if (this.halted()) return;
        await this.indexer.syncBoard(boardId);
      }
    } catch (error) {
      this.log(this.task, error instanceof Error ? (error.stack ?? error.message) : String(error));
    } finally {
      this.running = false;
    }
  }
}
