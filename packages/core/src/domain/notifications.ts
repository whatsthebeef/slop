import { failureSummary, isSetupFailure } from './checks.js';
import type { BaseChecks } from './types.js';

export const NOTIFICATION_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * How a notification goes away: its source clears it, a time passes, or a person dismisses it (`dismissible`: for
 * everyone; `personal`: only for that person, and it returns when its `items` grow).
 */
export type NotificationClears =
  | { readonly kind: 'condition' }
  | { readonly kind: 'until'; readonly at: string }
  | { readonly kind: 'dismissible' }
  | {
      readonly kind: 'personal';
      /** What the notification is about (e.g. the readiness items still to do). */
      readonly items: readonly string[];
      /** Per person: the items they had seen when they dismissed it. Kept in the notification, which has no table of its own for this. */
      readonly dismissed: Readonly<Record<string, readonly string[]>>;
    };

export interface NotificationAction {
  readonly label: string;
  readonly href: string;
  /** `link` (the default) opens `href`; `aws-sign-in` runs the in-app AWS sign-in from the bar. */
  readonly kind?: 'link' | 'aws-sign-in';
}

/**
 * A board-wide incident that needs a person (not per-glob status, not setup nags). One per board and source:
 * a source raising again replaces its own notification. `boardId` null is for every board.
 */
export interface BoardNotification {
  /** `<boardId or 'all'>/<source>`. */
  readonly id: string;
  readonly boardId: number | null;
  /** `main-red`, `integration:<id>`, `local-follow`. */
  readonly source: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly detail: string;
  readonly link: string | null;
  readonly action: NotificationAction | null;
  /** When the condition began; kept while the source keeps raising it. */
  readonly since: string;
  readonly clears: NotificationClears;
}

/** What a source gives when it raises one. */
export interface RaisedNotification {
  readonly boardId: number | null;
  readonly source: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly detail: string;
  readonly link?: string | null;
  readonly action?: NotificationAction | null;
  readonly clears?: NotificationClears;
}

/** The port sources use to raise and clear their notifications. */
export interface NotificationSink {
  raise(notification: RaisedNotification): Promise<void>;
  clear(boardId: number | null, source: string): Promise<void>;
}

export const notificationId = (boardId: number | null, source: string): string => `${boardId === null ? 'all' : String(boardId)}/${source}`;

const RANK: Record<NotificationSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Most severe first, then the one that began first. */
export const sortNotifications = (items: readonly BoardNotification[]): BoardNotification[] =>
  [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.since.localeCompare(b.since) || a.id.localeCompare(b.id));

export const isExpired = (n: BoardNotification, now: string): boolean => n.clears.kind === 'until' && n.clears.at <= now;

/** A notification a person may dismiss: not one whose condition still holds. */
export const isDismissible = (n: BoardNotification): boolean => n.clears.kind === 'dismissible' || n.clears.kind === 'personal';

/** Whether this person's dismissal still covers a personal notification: nothing new has joined its items since. */
export const isDismissedBy = (n: BoardNotification, email: string): boolean => {
  if (n.clears.kind !== 'personal') return false;
  const seen = n.clears.dismissed[email];
  return seen !== undefined && n.clears.items.every((i) => seen.includes(i));
};

export const MAIN_RED_SOURCE = 'main-red';

/**
 * The critical notification for a red base branch, or null when it is green or unchecked. Says what failed, the glob
 * whose merge turned it red, and that globs failing the same way are waiting.
 */
export const mainRedNotification = (boardId: number, baseBranch: string, checks: BaseChecks | null | undefined): RaisedNotification | null => {
  if (checks == null || checks.state !== 'failed') return null;
  const failure = checks.failure;
  return {
    boardId,
    source: MAIN_RED_SOURCE,
    severity: 'critical',
    title:
      failure !== undefined && isSetupFailure(failure)
        ? `CI setup failing: ${failure.step ?? failure.name}`
        : `${baseBranch} is red${checks.since === null ? '' : ` since ${checks.since} merged`}`,
    detail: `${failure === undefined ? 'Its checks fail.' : `${failureSummary(failure)}.`} Globs failing the same way are waiting for it; don't fix it in their branches.`,
    link: failure?.url ?? null,
    action: failure?.url == null ? null : { label: 'Open the run', href: failure.url },
    clears: { kind: 'condition' },
  };
};
