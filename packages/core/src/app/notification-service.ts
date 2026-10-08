import { forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { isDismissible, isExpired, mainRedNotification, MAIN_RED_SOURCE, notificationId, sortNotifications } from '../domain/notifications.js';
import type { BoardNotification, NotificationSink, RaisedNotification } from '../domain/notifications.js';
import type { BaseChecks } from '../domain/types.js';
import type { Clock, Notifier, Store } from '../ports.js';

export interface NotificationServiceDeps {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly clock: Clock;
}

/**
 * Board notifications: board-wide incidents that need a person, kept beside the board (no glob version) and shown in
 * the bar on every board page. Sources raise and clear through the `NotificationSink` port; people read and dismiss.
 */
export class NotificationService implements NotificationSink {
  constructor(private readonly deps: NotificationServiceDeps) {}

  /** Raises or updates the source's notification. It keeps its `since` while the source keeps raising it. */
  async raise(input: RaisedNotification): Promise<void> {
    const now = this.deps.clock.now();
    const id = notificationId(input.boardId, input.source);
    const changed = await this.deps.store.transaction(async (tx) => {
      const existing = await tx.getNotification(id);
      const next: BoardNotification = {
        id,
        boardId: input.boardId,
        source: input.source,
        severity: input.severity,
        title: input.title,
        detail: input.detail,
        link: input.link ?? null,
        action: input.action ?? null,
        since: existing?.since ?? now,
        clears: input.clears ?? { kind: 'condition' },
      };
      if (existing !== null && JSON.stringify(existing) === JSON.stringify(next)) return false;
      await tx.saveNotification(next);
      return true;
    });
    if (changed) this.hint(input.boardId);
  }

  /** The source's condition no longer holds. Nothing happens when it wasn't raised. */
  async clear(boardId: number | null, source: string): Promise<void> {
    const removed = await this.deps.store.transaction((tx) => tx.deleteNotification(notificationId(boardId, source)));
    if (removed) this.hint(boardId);
  }

  /** Raises or clears the main-red notification to match the base branch's latest check result. Idempotent. */
  async syncMainRed(boardId: number, baseBranch: string, checks: BaseChecks | null | undefined): Promise<void> {
    const raised = mainRedNotification(boardId, baseBranch, checks);
    if (raised === null) await this.clear(boardId, MAIN_RED_SOURCE);
    else await this.raise(raised);
  }

  /** The board's active notifications (its own and global), most severe first. Expired ones are dropped. */
  async list(email: string, boardId: number): Promise<Result<BoardNotification[]>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      if ((await tx.getMember(boardId, email)) === null) return forbidden(`You are not a member of board ${String(boardId)}`);
      const all = await tx.listNotifications(boardId);
      for (const expired of all.filter((n) => isExpired(n, now))) await tx.deleteNotification(expired.id);
      return ok(sortNotifications(all.filter((n) => !isExpired(n, now))));
    });
  }

  /** A person dismisses a notification; only dismissible ones (never one whose condition still holds). */
  async dismiss(email: string, boardId: number, id: string): Promise<Result<null>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<null>> => {
      if ((await tx.getMember(boardId, email)) === null) return forbidden(`You are not a member of board ${String(boardId)}`);
      const found = await tx.getNotification(id);
      if (found === null || (found.boardId !== null && found.boardId !== boardId)) return notFound(`No notification ${id}`);
      if (!isDismissible(found)) return invalidInput('This notification clears by itself when its cause is fixed');
      await tx.deleteNotification(id);
      return ok(null);
    });
    if (result.ok) this.hint(boardId);
    return result;
  }

  private hint(boardId: number | null): void {
    // Global notifications have no board to tell; open boards pick them up on their poll.
    if (boardId !== null) this.deps.notifier.publish({ kind: 'board.notifications', boardId });
  }
}
