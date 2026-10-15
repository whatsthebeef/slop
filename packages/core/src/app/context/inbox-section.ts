import { INBOX_CONTEXT_CHARS, inboxLink, inboxTitle } from '../../domain/inbox.js';
import type { Tx } from '../../ports.js';

export interface InboxContextItem {
  readonly id: number;
  readonly title: string;
  readonly sourceLabel: string;
  readonly occurredAt: string;
  readonly summary: string | null;
  readonly url: string;
  readonly text: string;
  readonly truncated: boolean;
}

/** The inbox items attached to a glob, with their text up to `INBOX_CONTEXT_CHARS`. */
export const inboxSection = async (tx: Tx, globId: string): Promise<InboxContextItem[]> =>
  (await tx.listInboxForGlob(globId)).map((i) => ({
    id: i.id,
    title: inboxTitle(i),
    sourceLabel: i.sourceLabel,
    occurredAt: i.occurredAt,
    summary: i.summary,
    url: inboxLink(i.boardId, i.id),
    text: i.text.slice(0, INBOX_CONTEXT_CHARS),
    truncated: i.text.length > INBOX_CONTEXT_CHARS,
  }));
