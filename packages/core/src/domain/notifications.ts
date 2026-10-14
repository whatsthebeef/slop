import { failureSummary, isSetupFailure } from './checks.js';
import type { Move } from './whose-move.js';
import type { BaseChecks, CheckFailure, Glob } from './types.js';

export const NOTIFICATION_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * Cleared by its source. A person's dismissal snoozes it for them until `key` (the condition: e.g. the failing head
 * SHA) changes; `dismissed` maps each person to the key they dismissed. Kept in the notification, like `personal`.
 */
interface ConditionClears {
  readonly kind: 'condition';
  readonly key?: string;
  readonly dismissed?: Readonly<Record<string, string>>;
}

/**
 * How a notification goes away: its source clears it, a time passes, or a person dismisses it (`dismissible`: for
 * everyone; `personal`: only for that person, and it returns when its `items` grow).
 */
export type NotificationClears =
  | ConditionClears
  | { readonly kind: 'until'; readonly at: string; readonly key?: string; readonly dismissed?: Readonly<Record<string, string>> }
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

/** Every notification can be dismissed; one whose condition still holds only snoozes for that person until its condition key changes. */
export const isDismissible = (n: BoardNotification): boolean => NOTIFICATION_SEVERITIES.includes(n.severity);

/**
 * Whether this person's dismissal still covers the notification: for a personal one, nothing new has joined its items
 * since; for a condition-held one, its condition key is the one they dismissed.
 */
export const isDismissedBy = (n: BoardNotification, email: string): boolean => {
  const clears = n.clears;
  if (clears.kind === 'personal') {
    const seen = clears.dismissed[email];
    return seen !== undefined && clears.items.every((i) => seen.includes(i));
  }
  if (clears.kind === 'condition' || clears.kind === 'until') return clears.dismissed?.[email] === (clears.key ?? '');
  return false;
};

export const MAIN_RED_SOURCE = 'main-red';

/** The failing test (or the first error) a red base shows: the first failing line, cut short. */
export const firstFailingTest = (failure: CheckFailure | undefined): string | null => {
  const line = failure?.lines.map((l) => l.trim()).find((l) => l !== '');
  if (line === undefined) return null;
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
};

/** Who is fixing a red base branch: the glob, or nobody. */
export interface MainRedFix {
  readonly glob: string | null;
}

/**
 * The critical notification for a red base branch, or null when it is green or unchecked: the one board-level message.
 * "⚠ main is red since <sha> (<glob>) · <failing test> · fixing: <glob or 'nobody yet'>", with the run and a Create fix
 * glob action when nobody is fixing it. Its condition key is the failing head and its first error, so a dismissal holds
 * until main is red on a different commit or for a different reason.
 */
export const mainRedNotification = (
  boardId: number,
  baseBranch: string,
  checks: BaseChecks | null | undefined,
  fix: MainRedFix = { glob: null },
): RaisedNotification | null => {
  if (checks == null || checks.state !== 'failed') return null;
  const failure = checks.failure;
  const setup = failure !== undefined && isSetupFailure(failure);
  const test = firstFailingTest(failure);
  // The first red commit, not the latest head: `since` names the glob that commit merged.
  const redSha = checks.redSha ?? checks.sha;
  const cause = checks.since === null ? `the cause is unclear (red since ${redSha.slice(0, 7)})` : `red since ${redSha.slice(0, 7)} (${checks.since})`;
  const title = setup
    ? `CI setup failing: ${failure.step ?? failure.name}`
    : `⚠ ${baseBranch} is ${checks.since === null ? 'red; ' : ''}${cause}${test === null ? '' : ` · ${test}`} · fixing: ${fix.glob ?? 'nobody yet'}`;
  const link = failure?.url ?? null;
  const createFix = `/boards/${String(boardId)}?${new URLSearchParams({
    newGlob: `${baseBranch} is red: ${test ?? 'checks fail'}`,
    ...(link === null ? {} : { run: link }),
  }).toString()}`;
  return {
    boardId,
    source: MAIN_RED_SOURCE,
    severity: 'critical',
    title,
    detail: `${failure === undefined ? 'Its checks fail.' : `${failureSummary(failure)}.`} Globs failing the same way are waiting for it; don't fix it in their branches.`,
    link,
    action: fix.glob === null ? { label: 'Create fix glob', href: createFix } : link === null ? null : { label: 'Open the run', href: link },
    clears: { kind: 'condition', key: `${checks.sha}:${test ?? ''}` },
  };
};

export const STALLED_SOURCE_PREFIX = 'stalled:';

export const stalledSource = (globId: string): string => `${STALLED_SOURCE_PREFIX}${globId}`;

/**
 * The warning for a stalled glob, or null while it isn't stalled. Notifications are board-wide with no recipient, so it
 * names whom it is for (the implementer, or the planner while nobody implements). One per glob: a source raising again
 * replaces its own, so it keeps its `since` and is raised once per stall; it clears when the glob stops being stalled.
 */
export const stalledNotification = (glob: Pick<Glob, 'id' | 'boardId' | 'title' | 'implementer' | 'planner'>, move: Move): RaisedNotification | null => {
  if (move.holder !== 'stalled') return null;
  return {
    boardId: glob.boardId,
    source: stalledSource(glob.id),
    severity: 'warning',
    title: `${glob.id} is stalled: ${move.reason}`,
    detail: `${glob.title}. For ${glob.implementer ?? glob.planner}: open the glob to retry, hand it to the machine or pick it up.`,
    link: `/boards/${String(glob.boardId)}`,
    action: null,
    clears: { kind: 'condition' },
  };
};
