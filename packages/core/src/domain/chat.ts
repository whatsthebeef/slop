import type { ItemStatus, SourceType } from './search.js';

/** What the assistant says when the board's records don't answer (also when the model says so). */
export const CHAT_DONT_KNOW = "I couldn't find anything about that in the board's records.";
/** The most messages a conversation returns (and the most turns' worth kept readable). */
export const CHAT_HISTORY_LIMIT = 50;

/** What the answering model can ask to be offered under its answer; opening a glob and attaching are derived from the sources. */
export const CHAT_ACTIONS = ['create_glob', 'save'] as const;
export type ChatAction = (typeof CHAT_ACTIONS)[number];

const ACTIONS_OPEN = '<actions>';
const ACTIONS_CLOSE = '</actions>';

/** The answer without its trailing `<actions>create_glob, save</actions>` line, and the actions it named (unknown names are dropped). */
export const parseActions = (raw: string): { text: string; actions: ChatAction[] } => {
  const start = raw.lastIndexOf(ACTIONS_OPEN);
  if (start < 0) return { text: raw.trim(), actions: [] };
  const end = raw.indexOf(ACTIONS_CLOSE, start);
  const names = raw.slice(start + ACTIONS_OPEN.length, end < 0 ? undefined : end).split(/[\s,]+/);
  const actions = CHAT_ACTIONS.filter((a) => names.includes(a));
  return { text: raw.slice(0, start).trim(), actions };
};

/**
 * Wraps a streaming callback so the `<actions>` line never reaches the person: text is passed on up to the tag, and a
 * tail that could still turn into the tag is held back until the next piece shows which it is.
 */
export const withoutActionsTag = (onText: (text: string) => void): ((piece: string) => void) => {
  let seen = '';
  let sent = 0;
  return (piece) => {
    seen += piece;
    const tag = seen.indexOf(ACTIONS_OPEN);
    let safe = tag >= 0 ? tag : seen.length;
    if (tag < 0) {
      for (let keep = Math.min(ACTIONS_OPEN.length - 1, seen.length); keep > 0; keep -= 1) {
        if (ACTIONS_OPEN.startsWith(seen.slice(seen.length - keep))) {
          safe = seen.length - keep;
          break;
        }
      }
    }
    if (safe > sent) {
      onText(seen.slice(sent, safe));
      sent = safe;
    }
  };
};

/** Greetings, thanks and "what can you do?": answered as conversation, without searching the records. */
export const isSmallTalk = (question: string): boolean => {
  const q = question.trim().toLowerCase().replace(/[!?.,\s]+$/, '');
  if (q.length > 60) return false;
  return /^(hi|hello|hey|hiya|howdy|yo|good (morning|afternoon|evening)|thanks|thank you|thx|cheers|ok|okay|cool|great|nice|bye|goodbye|see you)( (there|all|team|everyone|so much|a lot|very much))?$/.test(q) ||
    /^(what can you (do|help( me)? with)|what are you|who are you|how (do|can) you help|how does this (chat )?work|help)$/.test(q);
};

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
  /** Assistant messages only: the buttons the answering model asked for (null on answers stored before it did, and on replies that call for none). */
  readonly actions?: readonly ChatAction[] | null;
  readonly createdAt: string;
}

export interface ChatMessage extends NewChatMessage {
  readonly id: number;
}
