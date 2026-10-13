import { forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { isDismissedBy, isDismissible, isExpired, mainRedNotification, MAIN_RED_SOURCE, notificationId, sortNotifications } from '../domain/notifications.js';
import type { BoardNotification, MainRedFix, NotificationClears, NotificationSink, RaisedNotification } from '../domain/notifications.js';
import { isReadinessFailingSource, readinessNotifications, READINESS_SOURCE } from '../domain/readiness.js';
import type { ReadinessItem } from '../domain/readiness.js';
import type { BaseChecks } from '../domain/types.js';
import type { Clock, Notifier, Store } from '../ports.js';

export interface NotificationServiceDeps {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly clock: Clock;
}

/** A record without one person's entry. */
const without = <T>(record: Readonly<Record<string, T>>, email: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== email));

/** A personal notification raised again keeps the dismissals people already made (they stay valid for the items they saw). */
const withDismissals = (clears: NotificationClears, existing: BoardNotification | null): NotificationClears => {
  const before = existing?.clears;
  if (clears.kind === 'personal' && before?.kind === 'personal') return { ...clears, dismissed: before.dismissed };
  // A snooze is kept across a re-raise; it stops covering the notification once the condition key differs.
  if ((clears.kind === 'condition' || clears.kind === 'until') && (before?.kind === 'condition' || before?.kind === 'until') && before.dismissed !== undefined) {
    return { ...clears, dismissed: before.dismissed };
  }
  return clears;
};

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
        clears: withDismissals(input.clears ?? { kind: 'condition' }, existing),
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
  async syncMainRed(boardId: number, baseBranch: string, checks: BaseChecks | null | undefined, fix?: MainRedFix): Promise<void> {
    const raised = mainRedNotification(boardId, baseBranch, checks, fix);
    if (raised === null) await this.clear(boardId, MAIN_RED_SOURCE);
    else await this.raise(raised);
  }

  /**
   * Makes the board's setup notifications match its readiness checklist: a warning per failing item, one info line for
   * the missing ones. What no longer holds is cleared. Idempotent.
   */
  async syncReadiness(boardId: number, boardName: string, items: readonly ReadinessItem[]): Promise<void> {
    const raised = readinessNotifications(boardId, boardName, items);
    const wanted = new Set(raised.map((n) => n.source));
    for (const n of raised) await this.raise(n);
    const existing = await this.deps.store.transaction((tx) => tx.listNotifications(boardId));
    for (const n of existing) {
      if (n.boardId === boardId && (isReadinessFailingSource(n.source) || n.source === READINESS_SOURCE) && !wanted.has(n.source)) {
        await this.clear(boardId, n.source);
      }
    }
  }

  /** The board's active notifications (its own and global), most severe first. Expired ones are dropped. */
  async list(email: string, boardId: number): Promise<Result<BoardNotification[]>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      if ((await tx.getMember(boardId, email)) === null) return forbidden(`You are not a member of board ${String(boardId)}`);
      const all = await tx.listNotifications(boardId);
      for (const expired of all.filter((n) => isExpired(n, now))) await tx.deleteNotification(expired.id);
      const live = all.filter((n) => !isExpired(n, now));
      return ok(sortNotifications(live.filter((n) => !isDismissedBy(n, email))));
    });
  }

  /** The notifications this person has dismissed and that still hold (for the bar's "dismissed (n)" control). */
  async listDismissed(email: string, boardId: number): Promise<Result<BoardNotification[]>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      if ((await tx.getMember(boardId, email)) === null) return forbidden(`You are not a member of board ${String(boardId)}`);
      const live = (await tx.listNotifications(boardId)).filter((n) => !isExpired(n, now));
      return ok(sortNotifications(live.filter((n) => isDismissedBy(n, email))));
    });
  }

  /**
   * A person dismisses a notification, for themselves only: a personal one until an item joins it, a condition-held one
   * until its condition key changes. A `dismissible` one goes away for everyone, as before.
   */
  async dismiss(email: string, boardId: number, id: string): Promise<Result<null>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<null>> => {
      if ((await tx.getMember(boardId, email)) === null) return forbidden(`You are not a member of board ${String(boardId)}`);
      const found = await tx.getNotification(id);
      if (found === null || (found.boardId !== null && found.boardId !== boardId)) return notFound(`No notification ${id}`);
      if (!isDismissible(found)) return invalidInput('This notification cannot be dismissed');
      const clears = found.clears;
      if (clears.kind === 'personal') {
        await tx.saveNotification({ ...found, clears: { ...clears, dismissed: { ...clears.dismissed, [email]: clears.items } } });
      } else if (clears.kind === 'condition' || clears.kind === 'until') {
        await tx.saveNotification({ ...found, clears: { ...clears, dismissed: { ...clears.dismissed, [email]: clears.key ?? '' } } });
      } else await tx.deleteNotification(id);
      return ok(null);
    });
    if (result.ok) this.hint(boardId);
    return result;
  }

  /** Undoes this person's dismissal: the notification shows for them again. */
  async restore(email: string, boardId: number, id: string): Promise<Result<null>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<null>> => {
      if ((await tx.getMember(boardId, email)) === null) return forbidden(`You are not a member of board ${String(boardId)}`);
      const found = await tx.getNotification(id);
      if (found === null || (found.boardId !== null && found.boardId !== boardId)) return notFound(`No notification ${id}`);
      const clears = found.clears;
      if (clears.kind === 'personal') {
        const rest = without(clears.dismissed, email);
        await tx.saveNotification({ ...found, clears: { ...clears, dismissed: rest } });
      } else if ((clears.kind === 'condition' || clears.kind === 'until') && clears.dismissed !== undefined) {
        const rest = without(clears.dismissed, email);
        await tx.saveNotification({ ...found, clears: { ...clears, dismissed: rest } });
      }
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
