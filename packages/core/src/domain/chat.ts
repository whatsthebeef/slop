import type { ItemStatus, SourceType } from './search.js';

/** What the assistant says when the board's records don't answer (also when the model says so). */
export const CHAT_DONT_KNOW = "I don't know from the board's records.";
/** The most messages a conversation returns (and the most turns' worth kept readable). */
export const CHAT_HISTORY_LIMIT = 50;

/** A source an answer used, built from the retrieved hit and never from model text. */
export interface ChatCitation {
  /** The source's number in the prompt, the `[n]` the answer uses (the lowest, when one item has several chunks). */
  readonly n: number;
  readonly source: SourceType;
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

export interface NewChatMessage {
  readonly boardId: number;
  readonly email: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** Assistant messages only. */
  readonly citations: readonly ChatCitation[] | null;
  readonly createdAt: string;
}

export interface ChatMessage extends NewChatMessage {
  readonly id: number;
}
