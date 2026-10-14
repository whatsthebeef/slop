import { CHAT_HISTORY_LIMIT } from '../domain/chat.js';
import type { PageContext } from '../domain/chat.js';
import { CHAT_FEEDBACK_LIST_LIMIT, cleanNote, toTestCase } from '../domain/chat-feedback.js';
import type { ChatFeedback, ChatFeedbackRating, ChatTestCase } from '../domain/chat-feedback.js';
import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Clock, Store } from '../ports.js';
import { adminOf, memberOf } from './access.js';

export interface FeedbackInput {
  readonly rating: ChatFeedbackRating;
  readonly note?: string | null;
  readonly page?: PageContext;
}

/** 👍/👎 on chat answers (spec, Chat): members rate their own conversations; admins list the 👎 as test cases. */
export class ChatFeedbackService {
  constructor(private readonly deps: { store: Store; clock: Clock }) {}

  /** Rates an answer in the person's own conversation; rating again replaces the verdict. */
  async submit(
    email: string,
    boardId: number,
    chatId: number,
    messageId: number,
    input: FeedbackInput,
  ): Promise<Result<ChatFeedback>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const chat = await tx.getChat(chatId);
      // Someone else's conversation looks the same as none.
      if (chat?.boardId !== boardId || chat.email !== email)
        return notFound(`No conversation ${String(chatId)}`);
      const messages = await tx.listChatMessages(chatId, CHAT_HISTORY_LIMIT);
      const index = messages.findIndex((m) => m.id === messageId);
      const reply = messages[index];
      if (reply === undefined)
        return notFound(`No answer ${String(messageId)} in conversation ${String(chatId)}`);
      if (reply.role !== 'assistant') return invalidInput('Only answers can be rated');
      const asked = messages[index - 1];
      if (asked?.role !== 'user') return notFound(`No question before answer ${String(messageId)}`);
      return ok(
        await tx.upsertChatFeedback({
          boardId,
          chatId,
          messageId,
          email,
          rating: input.rating,
          note: cleanNote(input.note, input.rating),
          question: asked.content,
          answer: reply.content,
          citations: reply.citations ?? null,
          tools: reply.tools ?? null,
          page: input.page ?? null,
          createdAt: this.deps.clock.now(),
        }),
      );
    });
  }

  /** The person's own ratings in one conversation, so it can show them again when reopened. */
  async mine(
    email: string,
    boardId: number,
    chatId: number,
  ): Promise<Result<readonly ChatFeedback[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return ok(await tx.listMyChatFeedback(boardId, chatId, email));
    });
  }

  /** The board's 👎 answers, newest first: admins only, since they show other members' questions. */
  async testCases(
    email: string,
    boardId: number,
    options: { since?: string; limit?: number } = {},
  ): Promise<Result<readonly ChatTestCase[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const limit = Math.min(
        Math.max(options.limit ?? CHAT_FEEDBACK_LIST_LIMIT, 1),
        CHAT_FEEDBACK_LIST_LIMIT,
      );
      const rows = await tx.listChatFeedback(boardId, {
        rating: 'down',
        ...(options.since === undefined ? {} : { since: options.since }),
        limit,
      });
      return ok(rows.map(toTestCase));
    });
  }
}
