import type { ChatCitation, PageContext } from './chat.js';

export const CHAT_FEEDBACK_RATINGS = ['up', 'down'] as const;
export type ChatFeedbackRating = (typeof CHAT_FEEDBACK_RATINGS)[number];

/** The longest "what was wrong" note kept after a 👎. */
export const CHAT_FEEDBACK_NOTE_MAX = 200;
/** The most feedback rows one listing returns. */
export const CHAT_FEEDBACK_LIST_LIMIT = 200;

/**
 * A person's verdict on one answer, with a copy of what was asked and answered. It names the conversation and message
 * but does not depend on them: members can delete conversations, and a 👎 test case must outlive that.
 */
export interface NewChatFeedback {
  readonly boardId: number;
  readonly chatId: number;
  readonly messageId: number;
  readonly email: string;
  readonly rating: ChatFeedbackRating;
  /** Only a 👎 keeps a note. */
  readonly note: string | null;
  readonly question: string;
  readonly answer: string;
  readonly citations: readonly ChatCitation[] | null;
  /** What the answer did, one line each, as shown under it. */
  readonly tools: readonly string[] | null;
  /** Where the person was when they rated; sent by the client, so only the replay's prompt depends on it. */
  readonly page: PageContext | null;
  readonly createdAt: string;
}

export interface ChatFeedback extends NewChatFeedback {
  readonly id: number;
  /** Rating again replaces the verdict and moves this; `createdAt` stays the first rating's. */
  readonly updatedAt: string;
}

export interface ChatFeedbackFilter {
  readonly rating?: ChatFeedbackRating;
  /** Only rows first rated at or after this time (ISO). */
  readonly since?: string;
  readonly limit: number;
}

/** A 👎 answer as an admin lists it and `replayChatCases` consumes it. `answer` is the bad one. */
export interface ChatTestCase {
  readonly id: number;
  readonly boardId: number;
  readonly question: string;
  readonly answer: string;
  readonly citations: readonly ChatCitation[];
  readonly tools: readonly string[];
  readonly page: PageContext | null;
  readonly note: string | null;
  readonly email: string;
  readonly createdAt: string;
}

export const toTestCase = (feedback: ChatFeedback): ChatTestCase => ({
  id: feedback.id,
  boardId: feedback.boardId,
  question: feedback.question,
  answer: feedback.answer,
  citations: feedback.citations ?? [],
  tools: feedback.tools ?? [],
  page: feedback.page,
  note: feedback.note,
  email: feedback.email,
  createdAt: feedback.createdAt,
});

/** The note as kept: first line, trimmed, capped; empty or on a 👍 it is null. */
export const cleanNote = (
  note: string | null | undefined,
  rating: ChatFeedbackRating,
): string | null => {
  if (rating !== 'down' || note == null) return null;
  const line = note.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return line === '' ? null : line.slice(0, CHAT_FEEDBACK_NOTE_MAX);
};
