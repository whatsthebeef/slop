import type { InboxItemView } from './api';

/** Items waiting for a person (the Inbox tab's count). */
export const newCount = (items: readonly InboxItemView[]): number =>
  items.filter((i) => i.status === 'new').length;

/** Items still being summarised or waiting for the model: the page polls while there are any. */
export const pendingCount = (items: readonly InboxItemView[]): number =>
  items.filter((i) => i.processing === 'pending' || i.processing === 'waiting').length;

/** What the list shows: everything not discarded, or only what is still new. */
export const visibleItems = (items: readonly InboxItemView[], onlyNew: boolean): InboxItemView[] =>
  items.filter((i) => i.status !== 'discarded' && (!onlyNew || i.status === 'new'));

/** The globs an item can still be attached to: open ones on the board that it isn't on yet, by ID. */
export const attachableGlobs = <G extends { readonly id: string; readonly status: string }>(
  globs: readonly G[],
  item: Pick<InboxItemView, 'attachedTo'>,
): G[] => {
  const on = new Set((item.attachedTo ?? []).map((a) => a.globId));
  return globs
    .filter((g) => g.status !== 'signed_off' && !on.has(g.id))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
};

/** The line under a card's title while there is no summary: what the item is waiting for. */
export const processingNote = (
  item: Pick<InboxItemView, 'processing' | 'lastError'>,
): string | null => {
  switch (item.processing) {
    case 'pending':
      return 'Summarising…';
    case 'waiting':
      return item.lastError ?? 'Waiting for the model…';
    case 'failed':
      return `No summary: ${item.lastError ?? 'the model could not read it'}`;
    default:
      return null;
  }
};

/** Whether an attachment link is an inbox item's page in this app (and so opens in place); anything else, `//host` included, is an ordinary link. */
export const isInboxLink = (link: string): boolean => /^\/boards\/\d+\/inbox\?item=\d+$/.test(link);

/** What intake reads (it takes at most 20000 characters): the item's title, summary and text, cut to fit. */
export const REQUEST_LIMIT = 19_000;
export const inboxRequest = (
  item: Pick<InboxItemView, 'title' | 'summary'>,
  text: string,
): string => {
  const parts = [item.title, item.summary ?? '', text].map((p) => p.trim()).filter((p) => p !== '');
  return parts.join('\n\n').slice(0, REQUEST_LIMIT);
};

/** The creation key of the glob made from an item; `again` makes a fresh one for a person who wants another. */
export const inboxCreateKey = (id: number, again: boolean): string =>
  again ? `inbox:${String(id)}:${crypto.randomUUID()}` : `inbox:${String(id)}`;
