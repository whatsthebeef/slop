import { beforeEach, describe, expect, it } from 'vitest';
import { ChatService } from '../src/app/chat-service.js';
import type { NewLearning } from '../src/app/knowledge-service.js';
import { LlmBusy, LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { SearchService } from '../src/app/search-service.js';
import { CHAT_DONT_KNOW, impliesHistory } from '../src/domain/chat.js';
import type { PageContext } from '../src/domain/chat.js';
import type { Result } from '../src/domain/errors.js';
import type { AuthorityTier, ItemStatus, NewKnowledgeItem, SourceType } from '../src/domain/search.js';
import { FakeEmbedder, vectorOf } from '../src/testing/fake-embedder.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { glob as makeGlob } from './fixtures.js';

const NOW = '2026-10-05T12:00:00.000Z';
const DEV = 'dev@example.com';
const OTHER = 'other@example.com';
const OUTSIDER = 'outsider@example.com';

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const errorCode = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code);

/** A model that answers with what the test queued, and records what it was asked. */
class FakeLlm implements Llm {
  requests: LlmRequest[] = [];
  next: string | Error = 'unset';
  /** Pieces `stream` hands over before it resolves; left empty, the whole answer comes as one. */
  pieces: string[] = [];
  stream?: Llm['stream'];
  complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next);
  }
}

/** A model that streams its answer in the pieces the test queued. */
class StreamingLlm extends FakeLlm {
  override stream = async (request: LlmRequest, onText: (text: string) => void): Promise<string> => {
    const whole = await this.complete(request);
    for (const piece of this.pieces.length > 0 ? this.pieces : [whole]) onText(piece);
    return whole;
  };
}

describe('ChatService', () => {
  let store: MemoryStore;
  let llm: FakeLlm;
  let chat: ChatService;
  let boardId: number;

  const seed = async (ref: string, text: string, extra: { title?: string; sourceType?: SourceType; status?: ItemStatus; supersededBy?: number | null; date?: string; globIds?: string[]; authority?: AuthorityTier } = {}) => {
    const item: NewKnowledgeItem = {
      boardId,
      sourceType: extra.sourceType ?? 'decision',
      externalRef: ref,
      title: extra.title ?? ref,
      occurredAt: extra.date ?? NOW,
      authority: extra.authority ?? 'decision',
      status: extra.status ?? 'active',
      supersededBy: extra.supersededBy ?? null,
      globIds: extra.globIds ?? [],
      globGroup: null,
      externalUrl: `/boards/1/globs/${ref}`,
      contentHash: ref,
      state: 'ready',
    };
    await store.transaction(async (tx) => {
      await tx.replaceItem(item, [{ position: 0, header: `[${item.title}]`, text }]);
      const pending = await tx.chunksToEmbed(1000);
      await tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: vectorOf(c.text) })));
    });
  };

  const ask = (question = 'retry backoff', extra: { history?: boolean; globId?: string; chatId?: number; page?: PageContext; thinkHarder?: boolean; signal?: AbortSignal } = {}, email = DEV, onText?: (text: string) => void) =>
    chat.ask(email, { boardId, question, ...extra }, onText);

  beforeEach(async () => {
    store = new MemoryStore();
    llm = new FakeLlm();
    const embedder = new FakeEmbedder();
    chat = new ChatService({ store, clock: { now: () => NOW }, search: new SearchService({ store, clock: { now: () => NOW }, embedder }), llm });
    await store.transaction(async (tx) => {
      for (const email of [DEV, OTHER, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
      boardId = (await tx.insertBoard({ name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] })).id;
      await tx.upsertMember({ boardId, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId, email: OTHER, role: 'dev' });
    });
  });

  it('cites the sources the model used, built from the retrieved results', async () => {
    await seed('use-backoff', 'We decided retry backoff is exponential', { title: 'Use backoff' });
    await seed('noise', 'retry backoff appears here too', { title: 'Noise', sourceType: 'glob_plan' });
    // Which number the decision got is read from the prompt the model saw.
    unwrap(await ask());
    const n = Number(/\[(\d)\] Decision: Use backoff/.exec(llm.requests[0]?.prompt ?? '')?.[1]);
    expect(n).toBeGreaterThan(0);
    llm.next = `Exponential [${n}]`;
    const answered = unwrap(await ask());
    expect(answered.answered).toBe(true);
    expect(answered.reply.content).toBe(`Exponential [${n}]`);
    expect(answered.reply.citations).toEqual([
      expect.objectContaining({ source: 'decision', sourceLabel: 'Decision', title: 'Use backoff', link: '/boards/1/globs/use-backoff', status: 'active', supersededBy: null }),
    ]);
  });

  it('numbers citations by their [n] in the prompt, one per item', async () => {
    await seed('a', 'retry backoff alpha', { title: 'Alpha' });
    await seed('b', 'retry backoff beta', { title: 'Beta' });
    unwrap(await ask());
    const num = (title: string) => Number(new RegExp(`\\[(\\d+)\\] Decision: ${title}`).exec(llm.requests[0]?.prompt ?? '')?.[1]);
    const [na, nb] = [num('Alpha'), num('Beta')];
    llm.next = `x [${nb}] [5] [${na}]`;
    const cites = unwrap(await ask()).reply.citations ?? [];
    expect(cites.map((c) => [c.n, c.title])).toEqual([na, nb].sort().map((n) => [n, n === na ? 'Alpha' : 'Beta']));
    // Two chunks of one item are one citation, numbered by the first.
    await store.transaction(async (tx) => {
      await tx.replaceItem(
        { boardId, sourceType: 'decision', externalRef: 'multi', title: 'Multi', occurredAt: NOW, authority: 'decision', status: 'active', supersededBy: null, globIds: [], globGroup: null, externalUrl: null, contentHash: 'multi', state: 'ready' },
        [{ position: 0, header: '[Multi]', text: 'zzquux first chunk' }, { position: 1, header: '[Multi]', text: 'zzquux second chunk' }],
      );
    });
    llm.next = 'x [2] [1]';
    const multi = unwrap(await ask('zzquux')).reply.citations ?? [];
    expect(multi.map((c) => [c.n, c.title])).toEqual([[1, 'Multi']]);
  });

  it('drops a source number the model invented, and knows nothing when none is left', async () => {
    await seed('a', 'retry backoff is exponential');
    llm.next = 'Made up [9]';
    const reply = unwrap(await ask()).reply;
    expect(reply.content).toBe(CHAT_DONT_KNOW);
    expect(reply.citations).toEqual([]);
    llm.next = 'Real [1] and made up [7]';
    const mixed = unwrap(await ask()).reply;
    expect(mixed.citations).toHaveLength(1);
  });

  it('says it does not know, without calling the model, when nothing is retrieved', async () => {
    await seed('a', 'unrelated words only');
    const result = unwrap(await ask('zebra quantum'));
    expect(llm.requests).toHaveLength(0);
    expect(result.answered).toBe(false);
    expect(result.reply).toMatchObject({ role: 'assistant', content: CHAT_DONT_KNOW, citations: [] });
  });

  it('treats an unusable answer, or one that uses no source, as not knowing', async () => {
    await seed('a', 'retry backoff is exponential');
    llm.next = 'sure, it is exponential';
    expect(unwrap(await ask()).reply.content).toBe(CHAT_DONT_KNOW);
    llm.next = 'I cannot tell';
    const none = unwrap(await ask()).reply;
    expect(none).toMatchObject({ content: CHAT_DONT_KNOW, citations: [] });
  });

  it('labels a superseded decision with the newer one, and shows the current one first', async () => {
    await seed('new', 'retry backoff is now jittered', { title: 'Jittered backoff', date: '2026-10-01T00:00:00.000Z' });
    const newer = await store.transaction((tx) => tx.getItemByRef(boardId, 'new'));
    await seed('old', 'retry backoff is fixed', { title: 'Fixed backoff', date: '2026-08-01T00:00:00.000Z' });
    const older = await store.transaction((tx) => tx.getItemByRef(boardId, 'old'));
    await store.transaction((tx) => tx.setItemSupersession(older?.id ?? 0, 'superseded', newer?.id ?? 0));
    llm.next = 'Old [1], new [2]';
    // The superseded decision's chunk must come with its label; the current one is listed first.
    const result = unwrap(await ask());
    const prompt = llm.requests[0]?.prompt ?? '';
    expect(prompt.indexOf('Jittered backoff')).toBeLessThan(prompt.indexOf('Fixed backoff'));
    expect(prompt).toContain('superseded by "Jittered backoff"');
    const [current, superseded] = result.reply.citations ?? [];
    expect(current).toMatchObject({ title: 'Jittered backoff', status: 'active', supersededBy: null });
    expect(superseded).toMatchObject({ title: 'Fixed backoff', status: 'superseded', supersededBy: { title: 'Jittered backoff' } });
    expect(llm.requests[0]?.system).toMatch(/prefer current decisions/i);
  });

  it('refuses a person who is not on the board, for every method', async () => {
    await seed('a', 'retry backoff');
    expect(errorCode(await ask('retry backoff', {}, OUTSIDER))).toBe('forbidden');
    expect(errorCode(await chat.chats(OUTSIDER, boardId))).toBe('forbidden');
    expect(errorCode(await chat.history(OUTSIDER, boardId, 1))).toBe('forbidden');
    expect(errorCode(await chat.remove(OUTSIDER, boardId, 1))).toBe('forbidden');
    expect(errorCode(await chat.answer(OUTSIDER, { boardId, question: 'retry backoff' }))).toBe('forbidden');
    expect(llm.requests).toHaveLength(0);
  });

  it('answers llm_unavailable and stores nothing when the model is unavailable or busy', async () => {
    await seed('a', 'retry backoff');
    llm.next = new LlmUnavailable('AWS sign-in expired', 'Run `aws sso login`');
    const down = await ask();
    expect(down).toMatchObject({ ok: false, error: { code: 'llm_unavailable', reason: 'AWS sign-in expired', fix: 'Run `aws sso login`' } });
    llm.next = new LlmBusy();
    expect(await ask()).toMatchObject({ ok: false, error: { code: 'llm_unavailable', reason: 'Bedrock is busy' } });
    llm.next = new Error('timeout');
    expect(errorCode(await ask())).toBe('llm_unavailable');
    expect(unwrap(await chat.chats(DEV, boardId))).toEqual([]);
  });

  it('keeps each person\'s conversations to themselves, and removes only the one named', async () => {
    await seed('a', 'retry backoff');
    llm.next = 'Yes [1]';
    const first = unwrap(await ask('retry backoff'));
    await ask('retry backoff again', {}, OTHER);
    const mine = unwrap(await chat.history(DEV, boardId, first.chat.id));
    expect(mine.map((m) => [m.role, m.content])).toEqual([['user', 'retry backoff'], ['assistant', 'Yes [1]']]);
    expect(mine[1]?.citations).toHaveLength(1);
    expect(mine[1]?.tools?.[0]).toMatch(/^Searched the board's records \(current\)/);
    const theirs = unwrap(await chat.chats(OTHER, boardId));
    expect(theirs.map((c) => c.title)).toEqual(['retry backoff again']);
    // Someone else's conversation looks like none.
    expect(errorCode(await chat.history(DEV, boardId, theirs[0]?.id ?? 0))).toBe('not_found');
    expect(errorCode(await chat.remove(DEV, boardId, theirs[0]?.id ?? 0))).toBe('not_found');
    expect(errorCode(await ask('retry backoff', { chatId: theirs[0]?.id ?? 0 }))).toBe('not_found');
    unwrap(await chat.remove(DEV, boardId, first.chat.id));
    expect(unwrap(await chat.chats(DEV, boardId))).toEqual([]);
    expect(unwrap(await chat.chats(OTHER, boardId))).toHaveLength(1);
  });

  it('starts a conversation per question without a chat id, lists them newest first, and adds to one with its id', async () => {
    await seed('a', 'retry backoff');
    llm.next = 'Yes [1]';
    let now = NOW;
    chat = new ChatService({ store, clock: { now: () => now }, search: new SearchService({ store, clock: { now: () => now }, embedder: new FakeEmbedder() }), llm });
    const one = unwrap(await ask('retry backoff one'));
    now = '2026-10-05T13:00:00.000Z';
    const two = unwrap(await ask('retry backoff two'));
    expect(one.chat.id).not.toBe(two.chat.id);
    expect(unwrap(await chat.chats(DEV, boardId)).map((c) => c.title)).toEqual(['retry backoff two', 'retry backoff one']);
    now = '2026-10-05T14:00:00.000Z';
    const again = unwrap(await ask('retry backoff three', { chatId: one.chat.id }));
    expect(again.chat.id).toBe(one.chat.id);
    expect(unwrap(await chat.chats(DEV, boardId)).map((c) => c.title)).toEqual(['retry backoff one', 'retry backoff two']);
    expect(unwrap(await chat.history(DEV, boardId, one.chat.id))).toHaveLength(4);
    expect(llm.requests.at(-1)?.prompt).toContain('Asker: retry backoff one');
  });

  it('sends recent turns for follow-ups, but retrieves on the current question', async () => {
    await seed('a', 'retry backoff');
    llm.next = 'Yes [1]';
    const first = unwrap(await ask('retry backoff'));
    await ask('retry backoff', { chatId: first.chat.id });
    expect(llm.requests[1]?.prompt).toContain('Earlier in this conversation');
    expect(llm.requests[1]?.prompt).toContain('Asker: retry backoff');
    expect(llm.requests[0]?.prompt).not.toContain('Earlier in this conversation');
  });

  it('searches all of history only when asked to, and honours the glob scope', async () => {
    // Old but authoritative against new but chatty: recency decides in current mode, authority in all_time.
    await seed('old', 'retry backoff', { title: 'Old', date: '2024-01-01T00:00:00.000Z', globIds: ['s1t1'] });
    await seed('new', 'retry backoff', { title: 'New', date: '2026-10-01T00:00:00.000Z', globIds: ['s1t2'], sourceType: 'local_review', authority: 'discussion' });
    llm.next = 'x [1]';
    await ask();
    await ask('retry backoff', { history: true });
    const oldFirst = (i: number) => {
      const p = llm.requests[i]?.prompt ?? '';
      return p.indexOf('Old') < p.indexOf('New');
    };
    expect(oldFirst(0)).toBe(false);
    expect(oldFirst(1)).toBe(true);
    await ask('retry backoff', { globId: 's1t1' });
    const scoped = llm.requests[2]?.prompt ?? '';
    expect(scoped).toContain('Old');
    expect(scoped).not.toContain('New');
  });

  it('stores no conversation for a one-off answer', async () => {
    await seed('a', 'retry backoff');
    llm.next = 'Yes [1]';
    const one = unwrap(await chat.answer(DEV, { boardId, question: 'retry backoff' }));
    expect(one).toMatchObject({ answer: 'Yes [1]', answered: true });
    expect(one.citations).toHaveLength(1);
    expect(unwrap(await chat.chats(DEV, boardId))).toEqual([]);
  });

  it('rejects an empty or over-long question', async () => {
    expect(errorCode(await ask('   '))).toBe('invalid_input');
    expect(errorCode(await ask('x'.repeat(2001)))).toBe('invalid_input');
  });

  it('streams the answer as the model writes it, and stores the final one', async () => {
    await seed('a', 'retry backoff');
    const streaming = new StreamingLlm();
    streaming.next = 'Yes [1]';
    streaming.pieces = ['Yes ', '[1]'];
    chat = new ChatService({ store, clock: { now: () => NOW }, search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }), llm: streaming });
    const seen: string[] = [];
    const reply = unwrap(await ask('retry backoff', {}, DEV, (t) => seen.push(t)));
    expect(seen).toEqual(['Yes ', '[1]']);
    expect(reply.reply.content).toBe('Yes [1]');
    // An adapter that can't stream still gives the listener the whole answer once.
    llm.next = 'Yes [1]';
    const plain: string[] = [];
    chat = new ChatService({ store, clock: { now: () => NOW }, search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }), llm });
    await ask('retry backoff', {}, DEV, (t) => plain.push(t));
    expect(plain).toEqual(['Yes [1]']);
  });

  it('stores nothing when the person stops the answer', async () => {
    await seed('a', 'retry backoff');
    const stop = new AbortController();
    llm.next = 'Yes [1]';
    chat = new ChatService({ store, clock: { now: () => NOW }, search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }), llm });
    const pending = ask('retry backoff', { signal: stop.signal }, DEV, () => stop.abort());
    expect(errorCode(await pending)).toBe('invalid_input');
    expect(unwrap(await chat.chats(DEV, boardId))).toEqual([]);
  });

  it('answers one question with the stronger model when asked to think harder, and says so', async () => {
    await seed('a', 'retry backoff');
    const deep = new FakeLlm();
    deep.next = 'Deeper [1]';
    llm.next = 'Usual [1]';
    chat = new ChatService({ store, clock: { now: () => NOW }, search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }), llm, deepLlm: deep });
    const usual = unwrap(await ask());
    expect(usual.reply.content).toBe('Usual [1]');
    const harder = unwrap(await ask('retry backoff', { thinkHarder: true }));
    expect(harder.reply.content).toBe('Deeper [1]');
    expect(harder.reply.tools).toContain('Thought harder (stronger model)');
    expect(llm.requests).toHaveLength(1);
    // Without a stronger model the usual one answers.
    chat = new ChatService({ store, clock: { now: () => NOW }, search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }), llm });
    expect(unwrap(await ask('retry backoff', { thinkHarder: true })).reply.content).toBe('Usual [1]');
  });

  it('searches all time when the question is about the past, unless history is set', async () => {
    expect(impliesHistory('Why did we originally pick polling?')).toBe(true);
    expect(impliesHistory('What changed in the chat?')).toBe(true);
    expect(impliesHistory('What is in Doing?')).toBe(false);
    await seed('a', 'retry backoff');
    llm.next = 'Yes [1]';
    const past = unwrap(await ask('retry backoff previously'));
    expect(past.reply.tools?.[0]).toContain('all time');
    const forced = unwrap(await ask('retry backoff previously', { history: false }));
    expect(forced.reply.tools?.[0]).toContain('(current');
  });

  it('tells the model which page the person is on', async () => {
    await seed('a', 'retry backoff');
    await store.transaction((tx) => tx.insertGlob(makeGlob({ boardId, id: 's1t1', title: 'Add exports', status: 'failed' }), null));
    llm.next = 'Yes [1]';
    await ask('retry backoff', { page: { type: 'glob', id: 's1t1' } });
    expect(llm.requests[0]?.prompt).toContain('The person is viewing glob s1t1 "Add exports"');
    await ask('retry backoff', { page: { type: 'knowledge', id: 's1k3' } });
    expect(llm.requests[1]?.prompt).toContain('viewing the knowledge page (s1k3)');
    await ask('retry backoff', { page: { type: 'board' } });
    expect(llm.requests[2]?.prompt).not.toContain('The person is viewing');
  });

  describe('save to knowledge', () => {
    const learnings: { email: string; board: number; learning: NewLearning }[] = [];
    beforeEach(() => {
      learnings.length = 0;
      chat = new ChatService({
        store,
        clock: { now: () => NOW },
        search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }),
        llm,
        submitLearning: (email, board, learning) => {
          learnings.push({ email, board, learning });
          return Promise.resolve({ ok: true, value: { id: 's1k1' } });
        },
      });
    });

    it('sends the answer to the proposal queue with its question and sources, citing the first glob', async () => {
      await seed('a', 'retry backoff', { title: 'Use backoff', globIds: ['s1t1'] });
      llm.next = 'Exponential [1]';
      const { chat: thread, reply } = unwrap(await ask());
      const saved = unwrap(await chat.saveToKnowledge(DEV, boardId, thread.id, reply.id));
      expect(saved).toEqual({ id: 's1k1' });
      expect(learnings).toHaveLength(1);
      expect(learnings[0]?.learning).toMatchObject({ sourceGlobId: expect.stringMatching(/^s1t1$|^$/) as string, type: 'decision', statement: 'Exponential [1]' });
      expect(learnings[0]?.learning.evidence).toContain('"retry backoff"');
      expect(learnings[0]?.learning.evidence).toContain('[1] Decision: Use backoff');
    });

    it('needs a glob, an answer that is not "don\'t know", and the person\'s own conversation', async () => {
      await seed('a', 'retry backoff', { title: 'Use backoff' });
      llm.next = 'Exponential [1]';
      const { chat: thread, reply } = unwrap(await ask());
      expect(errorCode(await chat.saveToKnowledge(DEV, boardId, thread.id, reply.id))).toBe('invalid_input');
      expect(unwrap(await chat.saveToKnowledge(DEV, boardId, thread.id, reply.id, 's1t9'))).toEqual({ id: 's1k1' });
      expect(learnings[0]?.learning.sourceGlobId).toBe('s1t9');
      expect(errorCode(await chat.saveToKnowledge(OTHER, boardId, thread.id, reply.id, 's1t9'))).toBe('not_found');
      expect(errorCode(await chat.saveToKnowledge(DEV, boardId, thread.id, 999, 's1t9'))).toBe('not_found');
      const none = unwrap(await ask('zebra quantum'));
      expect(errorCode(await chat.saveToKnowledge(DEV, boardId, none.chat.id, none.reply.id, 's1t9'))).toBe('invalid_input');
      expect(learnings).toHaveLength(1);
    });
  });

  describe('rewrite, board state and logging', () => {
    let rewriter: FakeLlm;
    let warnings: string[];
    beforeEach(() => {
      rewriter = new FakeLlm();
      warnings = [];
      chat = new ChatService({
        store,
        clock: { now: () => NOW },
        search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }),
        llm,
        rewriteLlm: rewriter,
        warn: (m) => warnings.push(m),
      });
    });
    const addGlob = (patch: Parameters<typeof makeGlob>[0] = {}) =>
      store.transaction((tx) => tx.insertGlob(makeGlob({ boardId, ...patch }), null));

    it('searches with the rewritten query, while the answer prompt keeps the original words', async () => {
      await seed('n', 'notifications are raised by sources', { title: 'Notifications' });
      rewriter.next = JSON.stringify({ query: 'notifications' });
      llm.next = 'Sources raise them [1]';
      const reply = unwrap(await ask('awhy did we do notifcations like that?'));
      expect(reply.answered).toBe(true);
      expect(llm.requests[0]?.prompt).toContain('Question: awhy did we do notifcations like that?');
      expect(rewriter.requests[0]?.prompt).toContain('awhy did we do notifcations like that?');
    });

    it('falls back to the original question when the rewrite fails or is unreadable', async () => {
      await seed('a', 'retry backoff is exponential');
      llm.next = 'Yes [1]';
      rewriter.next = new Error('timeout');
      expect(unwrap(await ask('retry backoff')).answered).toBe(true);
      rewriter.next = 'not json';
      expect(unwrap(await ask('retry backoff')).answered).toBe(true);
      rewriter.next = new LlmUnavailable('down', 'fix');
      expect(unwrap(await ask('retry backoff')).answered).toBe(true);
    });

    it('answers what is in Doing from the board state, cited and capped', async () => {
      await addGlob({ id: 's1t1', title: 'Add exports', status: 'in_progress' });
      await addGlob({ id: 's1t2', title: 'Old work', status: 'signed_off' });
      rewriter.next = JSON.stringify({ query: 'doing' });
      llm.next = 's1t1 is in Doing [1]';
      const reply = unwrap(await ask('what are we working on'));
      const prompt = llm.requests[0]?.prompt ?? '';
      expect(prompt).toContain('[1] Board state (now)');
      expect(prompt).toContain('s1t1 "Add exports"');
      expect(prompt).not.toContain('s1t2');
      expect(reply.answered).toBe(true);
      expect(reply.reply.citations).toEqual([expect.objectContaining({ source: 'board_state', title: 'Board state (now)', link: `/boards/${boardId}` })]);
    });

    it('caps the board state', async () => {
      for (let i = 0; i < 80; i++) await addGlob({ id: `s1t${i + 1}`, title: `Glob number ${i} ${'x'.repeat(60)}`, status: 'in_progress' });
      llm.next = 'many [1]';
      unwrap(await ask('what is open'));
      const prompt = llm.requests[0]?.prompt ?? '';
      const block = prompt.slice(prompt.indexOf('[1] Board state (now)'), prompt.indexOf('Question:'));
      expect(block.length).toBeLessThan(4200);
      expect(block).toMatch(/more open globs not shown/);
    });

    it('logs an unreadable reply and still says it does not know', async () => {
      await seed('a', 'retry backoff is exponential');
      llm.next = 'sure, exponential, I think';
      expect(unwrap(await ask()).reply.content).toBe(CHAT_DONT_KNOW);
      llm.next = 'Something';
      expect(unwrap(await ask()).reply.content).toBe(CHAT_DONT_KNOW);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(`board ${boardId}`);
      expect(warnings[0]).toContain('sure, exponential');
      llm.next = CHAT_DONT_KNOW;
      await ask();
      expect(warnings).toHaveLength(2);
    });
  });
});
