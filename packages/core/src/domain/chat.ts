import type { ItemStatus, SourceType } from './search.js';

/** What the assistant says when the board's records don't answer (also when the model says so). */
export const CHAT_DONT_KNOW = "I don't know from the board's records.";
/** The most messages a conversation returns (and the most turns' worth kept readable). */
export const CHAT_HISTORY_LIMIT = 50;

/** A source an answer used, built from the retrieved hit and never from model text. */
export interface ChatCitation {
  /** The source's number in the prompt, the `[n]` the answer uses (the lowest, when one item has several chunks). */
  readonly n: number;
  /** `board_state` is the live snapshot of the board, not a stored record. */
  readonly source: SourceType | 'board_state';
  /** `Decision`, `Plan`, ... as search shows it. */
  readonly sourceLabel: string;
  readonly title: string;
  readonly date: string;
  readonly link: string | null;
  readonly globId: string | null;
  readonly status: ItemStatus;
  /** For a superseded decision: the newer one that replaced it. */
  readonly supersededBy: { readonly title: string; readonly date: string | null } | null;
}

/** One conversation: a person's own thread with the board's records. The list shows them newest first. */
export interface ChatThread {
  readonly id: number;
  readonly boardId: number;
  readonly email: string;
  /** The first question, shortened. */
  readonly title: string;
  readonly createdAt: string;
  /** When the last message was added. */
  readonly updatedAt: string;
}

export interface NewChatThread {
  readonly boardId: number;
  readonly email: string;
  readonly title: string;
  readonly createdAt: string;
}

export const CHAT_TITLE_MAX = 80;
/** Past conversations the list returns. */
export const CHAT_LIST_LIMIT = 50;

/** Where in the app the person is asking from; the chat scopes to it and suggests questions for it. */
export const PAGE_TYPES = ['board', 'glob', 'knowledge', 'inbox', 'signed_off', 'settings'] as const;
export type PageType = (typeof PAGE_TYPES)[number];
export interface PageContext {
  readonly type: PageType;
  /** The glob, knowledge item or inbox item the page shows. */
  readonly id?: string;
}

/**
 * Whether a question is about how things were rather than how they are: then superseded and older material matters,
 * so the search covers all time without the person ticking Include history.
 */
export const impliesHistory = (question: string): boolean =>
  /\b(originally|previously|used to|in the past|history|historical|superseded|replaced|no longer|back then|at first|earlier|before we|why did we (first|initially|change|switch|drop|stop|move)|what changed|how did .* change|last (week|month|year))\b/i.test(question);

export interface NewChatMessage {
  readonly chatId: number;
  readonly boardId: number;
  readonly email: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** Assistant messages only. */
  readonly citations: readonly ChatCitation[] | null;
  /** Assistant messages only: what the answer did, one line each (searches, live state, the stronger model). */
  readonly tools?: readonly string[] | null;
  readonly createdAt: string;
}

export interface ChatMessage extends NewChatMessage {
  readonly id: number;
}
