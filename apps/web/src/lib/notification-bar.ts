import { isDismissible, sortNotifications } from '@slop/core';
import type { BoardNotification } from '@slop/core';

/** What the notification bar shows: the most severe notification in full, and the others as a count that expands. */
export interface BarView {
  readonly lead: BoardNotification;
  readonly rest: readonly BoardNotification[];
}

export const barView = (items: readonly BoardNotification[]): BarView | null => {
  const [lead, ...rest] = sortNotifications(items);
  return lead === undefined ? null : { lead, rest };
};

/** "more… (2)" for the button that expands the others. */
export const moreLabel = (count: number): string => `more… (${String(count)})`;

/** The toggle's text: "more… (2)" on the lead while collapsed, "Show less" below the last notification once expanded. */
export const toggleLabel = (expanded: boolean, restCount: number): string => (expanded ? 'Show less' : moreLabel(restCount));

/** The notifications shown, in order: the lead alone while collapsed, then all of them as one stack. */
export const shownRows = (view: BarView, expanded: boolean): readonly BoardNotification[] => (expanded ? [view.lead, ...view.rest] : [view.lead]);

/** The board page top to bottom: the notifications sit above the tabs, and the line under the tabs is always there. */
export const SHELL_ORDER = ['notifications', 'tabs', 'line', 'page'] as const;

export type BoardTab = 'board' | 'signed-off' | 'knowledge' | 'settings';

export const BOARD_TABS: readonly { readonly tab: BoardTab; readonly label: string; readonly path: string }[] = [
  { tab: 'board', label: 'Board', path: '' },
  { tab: 'signed-off', label: 'Signed off', path: '/signed-off' },
  { tab: 'knowledge', label: 'Knowledge', path: '/knowledge' },
  { tab: 'settings', label: 'Settings', path: '/settings' },
];

/** The header tab a route belongs to; the board itself is the default. */
export const activeTab = (pathname: string, boardId: number): BoardTab => {
  const rest = pathname.replace(/\/+$/, '').slice(`/boards/${String(boardId)}`.length);
  return BOARD_TABS.find((t) => t.path !== '' && (rest === t.path || rest.startsWith(`${t.path}/`)))?.tab ?? 'board';
};

/** New Glob sits beside the search box on the board view only. */
export const showBoardTools = (tab: BoardTab): boolean => tab === 'board';

/** Dismissible notifications offer a dismiss button; one whose condition holds never does. */
export const canDismiss = (n: BoardNotification): boolean => isDismissible(n);

/** An action's link: a page of this app opens in place, anything else in a new tab. */
export const linkTarget = (href: string): { readonly target?: '_blank' } => (href.startsWith('/') ? {} : { target: '_blank' });

/** Poll slowly while one is showing (hints can be lost while the tab is hidden), more slowly still otherwise. */
export const pollInterval = (active: boolean): number => (active ? 15_000 : 60_000);
