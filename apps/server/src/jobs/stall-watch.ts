import type { Board, GlobService, NotificationService, Store } from '@slop/core';
import { humanSteps, machineSteps, stalledNotification, STALLED_SOURCE_PREFIX, stallThresholds, whoseMove } from '@slop/core';

const EVERY_MS = 2 * 60_000;

/**
 * Raises a warning for each glob nobody is moving (a failed step, a quiet run, nobody on it) and clears it when the glob
 * moves again. A notification keeps its `since` while it is raised again, so a stall is raised once however many checks see it.
 * Like the board list, it reads the glob alone: effects, deploys and uploads aren't part of its picture.
 */
export class StallWatch {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly globs: GlobService,
    private readonly notifications: Pick<NotificationService, 'raise' | 'clear'>,
    private readonly log: (task: string, message: string) => void,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.check().catch((e: unknown) => this.log('stall-watch', String(e))), EVERY_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every board; returns how many globs are stalled. */
  async check(now = new Date().toISOString()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let stalled = 0;
      for (const board of await this.store.transaction((tx) => tx.listAllBoards())) {
        try {
          stalled += await this.checkBoard(board, now);
        } catch (error) {
          this.log('stall-watch', `${String(board.id)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return stalled;
    } finally {
      this.running = false;
    }
  }

  private async checkBoard(board: Board, now: string): Promise<number> {
    const list = await this.store.transaction((tx) => tx.listGlobs(board.id, {}));
    const stored = await this.globs.humanStepsOf(board.id);
    // A Reviewing glob held only by an unmet sign-off relation is waiting, not stalled: whoseMove needs its holdings to see that.
    const holdings = await this.globs.holdingsOf(board.id, list);
    const thresholds = stallThresholds(board);
    const wanted = new Set<string>();
    for (const glob of list) {
      const move = whoseMove(glob, humanSteps(glob, {}, stored.get(glob.id) ?? []), machineSteps(glob), holdings.get(glob.id) ?? [], now, { thresholds });
      const raised = stalledNotification(glob, move);
      if (raised === null) continue;
      wanted.add(raised.source);
      await this.notifications.raise(raised);
    }
    // What no longer stalls (or no longer exists) is cleared.
    const existing = await this.store.transaction((tx) => tx.listNotifications(board.id));
    for (const n of existing) {
      if (n.boardId === board.id && n.source.startsWith(STALLED_SOURCE_PREFIX) && !wanted.has(n.source)) await this.notifications.clear(board.id, n.source);
    }
    return wanted.size;
  }
}
