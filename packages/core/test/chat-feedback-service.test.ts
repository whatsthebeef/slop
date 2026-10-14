import { beforeEach, describe, expect, it } from 'vitest';
import { ChatFeedbackService } from '../src/app/chat-feedback-service.js';
import type { ChatCitation } from '../src/domain/chat.js';
import {
  CHAT_FEEDBACK_LIST_LIMIT,
  CHAT_FEEDBACK_NOTE_MAX,
  cleanNote,
} from '../src/domain/chat-feedback.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore } from '../src/testing/memory-store.js';

const T1 = '2026-10-05T12:00:00.000Z';
const T2 = '2026-10-06T12:00:00.000Z';
const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OTHER = 'other@example.com';
const OUTSIDER = 'outsider@example.com';

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const errorCode = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code);

const citation: ChatCitation = {
  n: 1,
  source: 'decision',
  sourceLabel: 'Choice',
  title: 'Use backoff',
  date: T1,
  link: null,
  globId: 's1t1',
  status: 'active',
  supersededBy: null,
};

describe('ChatFeedbackService', () => {
  let store: MemoryStore;
  let now: string;
  let service: ChatFeedbackService;
  let boardId: number;
  let chatId: number;
  let questionId: number;
  let answerId: number;

  beforeEach(async () => {
    store = new MemoryStore();
    now = T1;
    service = new ChatFeedbackService({ store, clock: { now: () => now } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OTHER, OUTSIDER])
        await tx.upsertUser({ email, name: email, active: true });
      boardId = (
        await tx.insertBoard({
          name: 'b',
          repo: null,
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [],
          sensitivePaths: [],
        })
      ).id;
      await tx.upsertMember({ boardId, email: ADMIN, role: 'admin' });
      await tx.upsertMember({ boardId, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId, email: OTHER, role: 'dev' });
      chatId = (await tx.createChat({ boardId, email: DEV, title: 'retry', createdAt: T1 })).id;
      const base = { chatId, boardId, email: DEV, createdAt: T1 };
      questionId = (
        await tx.addChatMessage({
          ...base,
          role: 'user',
          content: 'how does retry work?',
          citations: null,
        })
      ).id;
      answerId = (
        await tx.addChatMessage({
          ...base,
          role: 'assistant',
          content: 'Exponential [1]',
          citations: [citation],
          tools: ['Searched the records'],
        })
      ).id;
    });
  });

  const rate = (
    input: Parameters<ChatFeedbackService['submit']>[4],
    email = DEV,
    message = answerId,
  ) => service.submit(email, boardId, chatId, message, input);

  it('stores a 👎 with the question from the turn before, the answer, its citations and tools, the page and the note', async () => {
    const stored = unwrap(
      await rate({
        rating: 'down',
        note: '  wrong default \nsecond line',
        page: { type: 'glob', id: 's1t1' },
      }),
    );
    expect(stored).toMatchObject({
      boardId,
      chatId,
      messageId: answerId,
      email: DEV,
      rating: 'down',
      note: 'wrong default',
      question: 'how does retry work?',
      answer: 'Exponential [1]',
      citations: [citation],
      tools: ['Searched the records'],
      page: { type: 'glob', id: 's1t1' },
      createdAt: T1,
      updatedAt: T1,
    });
  });

  it('drops the note of a 👍', async () => {
    expect(unwrap(await rate({ rating: 'up', note: 'nice' })).note).toBeNull();
  });

  it("replaces the person's earlier rating of the answer, keeping when it was first given", async () => {
    const first = unwrap(await rate({ rating: 'up' }));
    now = T2;
    const second = unwrap(await rate({ rating: 'down', note: 'too vague' }));
    expect(second).toMatchObject({
      id: first.id,
      rating: 'down',
      note: 'too vague',
      createdAt: T1,
      updatedAt: T2,
    });
    expect(unwrap(await service.mine(DEV, boardId, chatId))).toHaveLength(1);
  });

  it('keeps one row per person for the same answer', async () => {
    await store.transaction((tx) =>
      tx.upsertChatFeedback({
        boardId,
        chatId,
        messageId: answerId,
        email: OTHER,
        rating: 'up',
        note: null,
        question: 'q',
        answer: 'a',
        citations: null,
        tools: null,
        page: null,
        createdAt: T1,
      }),
    );
    unwrap(await rate({ rating: 'down' }));
    expect(unwrap(await service.mine(DEV, boardId, chatId)).map((f) => f.email)).toEqual([DEV]);
  });

  it("refuses another person's conversation, a non-member, an unknown message and a question", async () => {
    expect(errorCode(await rate({ rating: 'down' }, OTHER))).toBe('not_found');
    expect(errorCode(await rate({ rating: 'down' }, OUTSIDER))).toBe('forbidden');
    expect(errorCode(await rate({ rating: 'down' }, DEV, answerId + 1000))).toBe('not_found');
    expect(errorCode(await rate({ rating: 'down' }, DEV, questionId))).toBe('invalid_input');
    expect(await store.transaction((tx) => tx.listChatFeedback(boardId, { limit: 10 }))).toEqual(
      [],
    );
  });

  it("does not rate or list a conversation from another board, nor another member's as an admin", async () => {
    const otherBoard = await store.transaction(async (tx) => {
      const board = await tx.insertBoard({
        name: 'b2',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
    // DEV is a member of both boards, but the conversation belongs to the first.
    expect(
      errorCode(await service.submit(DEV, otherBoard, chatId, answerId, { rating: 'down' })),
    ).toBe('not_found');
    // An admin of the board still cannot rate a member's conversation.
    expect(
      errorCode(await service.submit(ADMIN, boardId, chatId, answerId, { rating: 'down' })),
    ).toBe('not_found');
    expect(await store.transaction((tx) => tx.listChatFeedback(boardId, { limit: 10 }))).toEqual(
      [],
    );
  });

  it("lists nothing from another person's or another board's conversation in mine", async () => {
    unwrap(await rate({ rating: 'down' }));
    expect(unwrap(await service.mine(OTHER, boardId, chatId))).toEqual([]);
    expect(unwrap(await service.mine(ADMIN, boardId, chatId))).toEqual([]);
    const otherBoard = await store.transaction(async (tx) => {
      const board = await tx.insertBoard({
        name: 'b2',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
    expect(unwrap(await service.mine(DEV, otherBoard, chatId))).toEqual([]);
  });

  it('refuses an answer with no question before it', async () => {
    const orphan = await store.transaction(async (tx) => {
      const lone = await tx.createChat({ boardId, email: DEV, title: 'lone', createdAt: T1 });
      const reply = await tx.addChatMessage({
        chatId: lone.id,
        boardId,
        email: DEV,
        createdAt: T1,
        role: 'assistant',
        content: 'unprompted',
        citations: null,
      });
      return { chat: lone.id, message: reply.id };
    });
    expect(
      errorCode(
        await service.submit(DEV, boardId, orphan.chat, orphan.message, { rating: 'down' }),
      ),
    ).toBe('not_found');
  });

  it('keeps the feedback when the conversation is deleted', async () => {
    unwrap(await rate({ rating: 'down' }));
    await store.transaction((tx) => tx.deleteChat(chatId));
    const cases = unwrap(await service.testCases(ADMIN, boardId));
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ question: 'how does retry work?', answer: 'Exponential [1]' });
  });

  describe('testCases', () => {
    it('lists only 👎, newest first, as test cases, for admins only', async () => {
      unwrap(await rate({ rating: 'down', note: 'first' }));
      await store.transaction((tx) =>
        tx.upsertChatFeedback({
          boardId,
          chatId,
          messageId: answerId + 50,
          email: OTHER,
          rating: 'up',
          note: null,
          question: 'q',
          answer: 'a',
          citations: null,
          tools: null,
          page: null,
          createdAt: T1,
        }),
      );
      await store.transaction((tx) =>
        tx.upsertChatFeedback({
          boardId,
          chatId,
          messageId: answerId + 51,
          email: OTHER,
          rating: 'down',
          note: null,
          question: 'later',
          answer: 'a',
          citations: null,
          tools: null,
          page: null,
          createdAt: T2,
        }),
      );
      const cases = unwrap(await service.testCases(ADMIN, boardId));
      expect(cases.map((c) => c.question)).toEqual(['later', 'how does retry work?']);
      expect(cases[0]).toMatchObject({ citations: [], tools: [], page: null, note: null });
      expect(errorCode(await service.testCases(DEV, boardId))).toBe('forbidden');
      expect(errorCode(await service.testCases(OUTSIDER, boardId))).toBe('forbidden');
    });

    it('honours since and the limit', async () => {
      unwrap(await rate({ rating: 'down' }));
      await store.transaction((tx) =>
        tx.upsertChatFeedback({
          boardId,
          chatId,
          messageId: answerId + 51,
          email: OTHER,
          rating: 'down',
          note: null,
          question: 'later',
          answer: 'a',
          citations: null,
          tools: null,
          page: null,
          createdAt: T2,
        }),
      );
      expect(
        unwrap(await service.testCases(ADMIN, boardId, { since: T2 })).map((c) => c.question),
      ).toEqual(['later']);
      expect(unwrap(await service.testCases(ADMIN, boardId, { limit: 1 }))).toHaveLength(1);
    });

    it('caps the limit at CHAT_FEEDBACK_LIST_LIMIT and treats a zero limit as one', async () => {
      await store.transaction(async (tx) => {
        for (let i = 0; i < CHAT_FEEDBACK_LIST_LIMIT + 5; i++)
          await tx.upsertChatFeedback({
            boardId,
            chatId,
            messageId: 10_000 + i,
            email: OTHER,
            rating: 'down',
            note: null,
            question: `q${String(i)}`,
            answer: 'a',
            citations: null,
            tools: null,
            page: null,
            createdAt: T1,
          });
      });
      expect(unwrap(await service.testCases(ADMIN, boardId, { limit: 100_000 }))).toHaveLength(
        CHAT_FEEDBACK_LIST_LIMIT,
      );
      expect(unwrap(await service.testCases(ADMIN, boardId, { limit: 0 }))).toHaveLength(1);
    });
  });
});

describe('cleanNote', () => {
  it('trims, keeps the first line, caps the length, and is null when empty or for a 👍', () => {
    expect(cleanNote('  hi \n there', 'down')).toBe('hi');
    expect(cleanNote('x'.repeat(CHAT_FEEDBACK_NOTE_MAX + 50), 'down')).toHaveLength(
      CHAT_FEEDBACK_NOTE_MAX,
    );
    expect(cleanNote('   ', 'down')).toBeNull();
    expect(cleanNote(undefined, 'down')).toBeNull();
    expect(cleanNote('hi', 'up')).toBeNull();
  });
});
