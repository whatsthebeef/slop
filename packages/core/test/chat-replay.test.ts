import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/app/chat-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { SearchService } from '../src/app/search-service.js';
import { CHAT_DONT_KNOW } from '../src/domain/chat.js';
import type { ChatTestCase } from '../src/domain/chat-feedback.js';
import type { NewKnowledgeItem } from '../src/domain/search.js';
import { FakeEmbedder, vectorOf } from '../src/testing/fake-embedder.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { replayChatCases, replayFailures } from '../src/testing/chat-replay.js';

const NOW = '2026-10-05T12:00:00.000Z';
const DEV = 'dev@example.com';

class FakeLlm implements Llm {
  requests: LlmRequest[] = [];
  next = CHAT_DONT_KNOW;
  complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    return Promise.resolve(this.next);
  }
}

const setup = async () => {
  const store = new MemoryStore();
  const llm = new FakeLlm();
  const clock = { now: () => NOW };
  const chat = new ChatService({
    store,
    clock,
    search: new SearchService({ store, clock, embedder: new FakeEmbedder() }),
    llm,
  });
  const boardId = await store.transaction(async (tx) => {
    await tx.upsertUser({ email: DEV, name: DEV, active: true });
    const board = await tx.insertBoard({
      name: 'b',
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
  const seed = (text: string) =>
    store.transaction(async (tx) => {
      const item: NewKnowledgeItem = {
        boardId,
        sourceType: 'decision',
        externalRef: 'use-backoff',
        title: 'Use backoff',
        occurredAt: NOW,
        authority: 'decision',
        status: 'active',
        supersededBy: null,
        globIds: [],
        globGroup: null,
        externalUrl: '/boards/1/globs/use-backoff',
        contentHash: 'h',
        state: 'ready',
      };
      await tx.replaceItem(item, [{ position: 0, header: '[Use backoff]', text }]);
      const pending = await tx.chunksToEmbed(1000);
      await tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: vectorOf(c.text) })));
    });
  const testCase: ChatTestCase = {
    id: 1,
    boardId,
    question: 'retry backoff',
    answer: 'bad',
    citations: [],
    tools: [],
    page: { type: 'knowledge' },
    note: null,
    email: DEV,
    createdAt: NOW,
  };
  return { chat, llm, seed, store, testCase };
};

describe('replayChatCases', () => {
  it('fails a case the chat still cannot answer, and passes it once the records answer', async () => {
    const { chat, llm, seed, testCase } = await setup();
    const before = await replayChatCases(chat, DEV, [testCase]);
    expect(before[0]).toMatchObject({ answered: false, problem: 'The chat still gives no answer' });
    expect(replayFailures(before)).toHaveLength(1);

    await seed('We decided retry backoff is exponential');
    llm.next = 'Exponential [1]';
    const after = await replayChatCases(chat, DEV, [testCase]);
    expect(after[0]).toMatchObject({
      answered: true,
      changed: true,
      problem: null,
      answer: 'Exponential [1]',
    });
    expect(after[0]?.citations).toHaveLength(1);
    expect(replayFailures(after)).toEqual([]);
  });

  it("passes the case's page on to the question", async () => {
    const { chat, llm, seed, testCase } = await setup();
    await seed('We decided retry backoff is exponential');
    await replayChatCases(chat, DEV, [testCase]);
    expect(
      llm.requests.some((r) => r.prompt.includes('The person is viewing the knowledge page.')),
    ).toBe(true);
  });

  it('stores no conversation or message for the member it replays as', async () => {
    const { chat, llm, seed, store, testCase } = await setup();
    await seed('We decided retry backoff is exponential');
    llm.next = 'Exponential [1]';
    await replayChatCases(chat, DEV, [testCase, testCase]);
    expect(await store.transaction((tx) => tx.listChats(testCase.boardId, DEV, 10))).toEqual([]);
  });

  it('uses a custom check, and reports an error from the chat as the problem', async () => {
    const { chat, testCase } = await setup();
    const custom = await replayChatCases(chat, DEV, [testCase], { check: () => null });
    expect(custom[0]?.problem).toBeNull();
    const outsider = await replayChatCases(chat, 'nobody@example.com', [testCase]);
    expect(outsider[0]?.problem).toMatch(/^forbidden:/);
  });
});
