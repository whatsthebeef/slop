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

/** "+2 more" for the collapsed count. */
export const moreLabel = (count: number): string => `+${String(count)} more`;

/** Dismissible notifications offer a dismiss button; one whose condition holds never does. */
export const canDismiss = (n: BoardNotification): boolean => isDismissible(n);

/** An action's link: a page of this app opens in place, anything else in a new tab. */
export const linkTarget = (href: string): { readonly target?: '_blank' } => (href.startsWith('/') ? {} : { target: '_blank' });

/** Poll slowly while one is showing (hints can be lost while the tab is hidden), more slowly still otherwise. */
export const pollInterval = (active: boolean): number => (active ? 15_000 : 60_000);
