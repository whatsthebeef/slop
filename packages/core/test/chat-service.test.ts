import { beforeEach, describe, expect, it } from 'vitest';
import { ChatService } from '../src/app/chat-service.js';
import type { NewLearning } from '../src/app/knowledge-service.js';
import { LlmBusy, LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { BoardService } from '../src/app/board-service.js';
import { CodeViewService } from '../src/app/code-view.js';
import type { CodeView } from '../src/app/code-view.js';
import { SearchIndexer } from '../src/app/search-indexer.js';
import { SearchService } from '../src/app/search-service.js';
import { CHAT_CODE_MAX_CALLS, CHAT_DONT_KNOW, CHAT_NO_CODE, impliesHistory, isSmallTalk, parseActions, parseCodeCall, withoutCodeRequests } from '../src/domain/chat.js';
import type { PageContext } from '../src/domain/chat.js';
import type { Result } from '../src/domain/errors.js';
import type { AuthorityTier, ItemStatus, NewKnowledgeItem, SourceType } from '../src/domain/search.js';
import { FakeEmbedder, vectorOf } from '../src/testing/fake-embedder.js';
import { windowOf } from '../src/domain/code-view.js';
import type { CodeLineRange } from '../src/domain/code-view.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
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
    const n = Number(/\[(\d)\] Choice: Use backoff/.exec(llm.requests[0]?.prompt ?? '')?.[1]);
    expect(n).toBeGreaterThan(0);
    llm.next = `Exponential [${n}]`;
    const answered = unwrap(await ask());
    expect(answered.answered).toBe(true);
    expect(answered.reply.content).toBe(`Exponential [${n}]`);
    expect(answered.reply.citations).toEqual([
      expect.objectContaining({ source: 'decision', sourceLabel: 'Choice', title: 'Use backoff', link: '/boards/1/globs/use-backoff', status: 'active', supersededBy: null }),
    ]);
  });

  it('answers a greeting like a person, without searching, sources or actions', async () => {
    await seed('a', 'retry backoff is exponential');
    llm.next = 'Hello! Ask me about this board.';
    const result = unwrap(await ask('hello'));
    expect(result.reply).toMatchObject({ content: 'Hello! Ask me about this board.', citations: [], tools: [], actions: [] });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.prompt).not.toContain('[1]');
    llm.next = 'I can answer questions about this board.';
    expect(unwrap(await ask('What can you do?')).reply.content).toBe('I can answer questions about this board.');
  });

  it('keeps the model\'s actions line out of the stream and on the stored answer, but only for a cited answer', async () => {
    await seed('a', 'retry backoff is exponential');
    const streaming = new StreamingLlm();
    chat = new ChatService({ store, clock: { now: () => NOW }, search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }), llm: streaming });
    streaming.next = 'Use backoff [1]\n<actions>create_glob, save, bogus</actions>';
    streaming.pieces = ['Use backoff [1]\n<act', 'ions>create_glob, save, bogus</actions>'];
    const seen: string[] = [];
    const reply = unwrap(await ask('retry backoff', {}, DEV, (t) => seen.push(t))).reply;
    expect(seen.join('')).toBe('Use backoff [1]\n');
    expect(reply).toMatchObject({ content: 'Use backoff [1]', actions: ['create_glob', 'save'] });
    streaming.next = `${CHAT_DONT_KNOW}\n<actions>create_glob</actions>`;
    streaming.pieces = [];
    expect(unwrap(await ask()).reply).toMatchObject({ actions: ['create_glob'], miss: true });
    expect(unwrap(await ask()).reply.content).toContain('I couldn\'t find an answer to that');
  });

  it('numbers citations by their [n] in the prompt, one per item', async () => {
    await seed('a', 'retry backoff alpha', { title: 'Alpha' });
    await seed('b', 'retry backoff beta', { title: 'Beta' });
    unwrap(await ask());
    const num = (title: string) => Number(new RegExp(`\\[(\\d+)\\] Choice: ${title}`).exec(llm.requests[0]?.prompt ?? '')?.[1]);
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

  it('drops a source number the model invented: a reply left with no citation is shown as not from the records', async () => {
    await seed('a', 'retry backoff is exponential');
    llm.next = 'Made up [9]';
    const reply = unwrap(await ask()).reply;
    expect(reply).toMatchObject({ content: 'Made up [9]', citations: [], uncited: true, actions: [] });
    llm.next = 'Real [1] and made up [7]';
    const mixed = unwrap(await ask()).reply;
    expect(mixed.citations).toHaveLength(1);
  });

  it('says it does not know, without calling the model, when nothing is retrieved', async () => {
    await seed('a', 'unrelated words only');
    const result = unwrap(await ask('zebra quantum'));
    expect(llm.requests).toHaveLength(0);
    expect(result.answered).toBe(false);
    expect(result.reply).toMatchObject({ role: 'assistant', citations: [], miss: true });
    expect(result.reply.content).toContain('"zebra quantum" (0 found)');
    expect(result.reply.content).toContain("slop's help (0 found)");
  });

  it('keeps an answer that uses no source, flagged as not from the records, with no buttons', async () => {
    await seed('a', 'retry backoff is exponential');
    llm.next = 'sure, it is exponential';
    const result = unwrap(await ask());
    expect(result.answered).toBe(false);
    expect(result.reply).toMatchObject({ content: 'sure, it is exponential', citations: [], uncited: true, actions: [] });
    expect(result.reply.miss).toBeUndefined();
    llm.next = 'I cannot tell\n<actions>create_glob, save</actions>';
    expect(unwrap(await ask()).reply).toMatchObject({ content: 'I cannot tell', uncited: true, actions: [] });
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
    expect(prompt).toContain('replaced by "Jittered backoff"');
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
    expect(deep.requests[0]?.spend).toEqual({ boardId, source: 'chat' });
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

  describe('slop help and misses', () => {
    const help = [{ ref: 'docs/guide.md#watch-signals', title: 'Slop guide: Watch signals', text: 'Watch signals tell a decision glob to keep watching something after it merges. Use them when a choice can only be judged later.', url: 'https://github.com/whatsthebeef/slop/blob/main/docs/guide.md' }];
    const indexHelp = () => new SearchIndexer({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder(), changes: { mergedDiff: () => Promise.resolve(null) }, llm, help }).syncBoard(boardId);

    it('answers a how-to question from slop help, cited as Slop help, even when the board has other records', async () => {
      await seed('d1', 'unrelated retry decision', { title: 'Retry' });
      await indexHelp();
      // Which number the help source got is read from the prompt the model saw.
      llm.next = 'unset';
      unwrap(await ask('Should I use watch signals?'));
      const n = Number(/\[(\d)\] Slop help: Slop guide: Watch signals/.exec(llm.requests[0]?.prompt ?? '')?.[1]);
      expect(n).toBeGreaterThan(0);
      llm.next = `Use them when a choice can only be judged later [${n}].`;
      const result = unwrap(await ask('Should I use watch signals?'));
      expect(result.answered).toBe(true);
      expect(result.reply.tools).toContain("Searched slop's help: 1 found");
      expect(result.reply.citations).toEqual([
        expect.objectContaining({ source: 'slop_help', sourceLabel: 'Slop help', title: 'Slop guide: Watch signals', link: 'https://github.com/whatsthebeef/slop/blob/main/docs/guide.md' }),
      ]);
    });

    it('still finds slop help when the question is scoped to a glob', async () => {
      await indexHelp();
      llm.next = 'x';
      unwrap(await ask('watch signals', { globId: 's1t1' }));
      expect(llm.requests[0]?.prompt).toContain('Slop help: Slop guide: Watch signals');
    });

    it('returns uncited text apart from the records for a one-off answer', async () => {
      await seed('a', 'retry backoff is exponential');
      llm.next = 'Probably exponential';
      const one = unwrap(await chat.answer(DEV, { boardId, question: 'retry backoff' }));
      expect(one).toMatchObject({ answered: false, uncitedAnswer: 'Probably exponential', citations: [] });
      expect(one.answer).toContain('I couldn\'t find an answer to that');
      llm.next = 'Yes [1]';
      expect(unwrap(await chat.answer(DEV, { boardId, question: 'retry backoff' })).uncitedAnswer).toBeUndefined();
    });

    it('names what was searched on a miss and offers Think harder and Create a glob, not Look at the code without a repo', async () => {
      const deep = new FakeLlm();
      chat = new ChatService({ store, clock: { now: () => NOW }, search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }), llm, deepLlm: deep });
      await seed('a', 'retry backoff is exponential');
      llm.next = CHAT_DONT_KNOW;
      const missed = unwrap(await ask());
      expect(missed.answered).toBe(false);
      expect(missed.reply).toMatchObject({ miss: true, citations: [], actions: ['think_harder', 'create_glob'] });
      expect(missed.reply.content).toContain('"retry backoff" (1 found)');
      expect(missed.reply.content).toContain("slop's help (0 found)");
      expect(missed.reply.content).toContain('no code I can read');
      // Once the stronger model has been tried, it is not offered again.
      deep.next = CHAT_DONT_KNOW;
      expect(unwrap(await ask('retry backoff', { thinkHarder: true })).reply.actions).toEqual(['create_glob']);
    });

    it('does not let the model ask for the miss buttons', () => {
      expect(parseActions('x [1]\n<actions>think_harder, look_at_code, create_glob</actions>').actions).toEqual(['create_glob']);
    });

    it('does not save a miss or text that is not from the records', async () => {
      chat = new ChatService({ store, clock: { now: () => NOW }, search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }), llm, submitLearning: () => Promise.resolve({ ok: true, value: { id: 's1k1' } }) });
      await seed('a', 'retry backoff is exponential');
      llm.next = 'Maybe exponential';
      const uncited = unwrap(await ask());
      expect(errorCode(await chat.saveToKnowledge(DEV, boardId, uncited.chat.id, uncited.reply.id, 's1t9'))).toBe('invalid_input');
      llm.next = CHAT_DONT_KNOW;
      const miss = unwrap(await ask());
      expect(errorCode(await chat.saveToKnowledge(DEV, boardId, miss.chat.id, miss.reply.id, 's1t9'))).toBe('invalid_input');
    });
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
      expect(learnings[0]?.learning).toMatchObject({ sourceGlobId: expect.stringMatching(/^s1t1$|^$/) as string, type: 'pattern', statement: 'Exponential [1]' });
      expect(learnings[0]?.learning.evidence).toContain('"retry backoff"');
      expect(learnings[0]?.learning.evidence).toContain('[1] Choice: Use backoff');
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
      // The rewrite goes to the board's ledger as search, the answer as chat.
      expect(rewriter.requests[0]?.spend).toEqual({ boardId, source: 'search' });
      expect(llm.requests[0]?.spend).toEqual({ boardId, source: 'chat' });
    });

    it('treats a message the rewrite calls small talk as conversation, with no search', async () => {
      await seed('n', 'notifications are raised by sources', { title: 'Notifications' });
      rewriter.next = JSON.stringify({ query: 'thanks a lot, that helps', smallTalk: true });
      llm.next = 'Glad it helped!';
      const reply = unwrap(await ask('thanks a lot, that helps')).reply;
      expect(reply).toMatchObject({ content: 'Glad it helped!', citations: [], actions: [] });
      expect(llm.requests[0]?.system).not.toContain('numbered sources');
      expect(llm.requests[0]?.spend).toEqual({ boardId, source: 'chat' });
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

    it('logs a reply that uses no source, and keeps it as not from the records', async () => {
      await seed('a', 'retry backoff is exponential');
      llm.next = 'sure, exponential, I think';
      expect(unwrap(await ask()).reply).toMatchObject({ content: 'sure, exponential, I think', uncited: true });
      llm.next = 'Something';
      expect(unwrap(await ask()).reply).toMatchObject({ content: 'Something', uncited: true });
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(`board ${boardId}`);
      expect(warnings[0]).toContain('sure, exponential');
      llm.next = CHAT_DONT_KNOW;
      await ask();
      expect(warnings).toHaveLength(2);
    });
  });
});

describe('small talk and the actions line', () => {
  it('spots greetings and questions about the chat, and leaves real questions alone', () => {
    for (const q of ['hello', 'Hi!', 'thanks', 'Thank you so much', 'what can you do?', 'Good morning']) expect(isSmallTalk(q)).toBe(true);
    for (const q of ['why did we choose backoff?', 'hello, why did s1t2 fail?', 'what changed this week']) expect(isSmallTalk(q)).toBe(false);
  });

  it('parses the trailing actions line', () => {
    expect(parseActions('Answer [1]\n<actions>save</actions>')).toEqual({ text: 'Answer [1]', actions: ['save'] });
    expect(parseActions('Answer [1]')).toEqual({ text: 'Answer [1]', actions: [] });
    expect(parseActions('Answer\n<actions>create_glob,  nope')).toEqual({ text: 'Answer', actions: ['create_glob'] });
  });
});

/** Answers each model turn from a script: a string, or a function of the request (to wait or to look at the prompt). */
class ScriptedLlm implements Llm {
  requests: LlmRequest[] = [];
  constructor(private readonly turns: (string | ((request: LlmRequest) => Promise<string>))[]) {}
  complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    const turn = this.turns[this.requests.length - 1] ?? 'unscripted';
    return typeof turn === 'string' ? Promise.resolve(turn) : turn(request);
  }
}

class FakeCodeView implements CodeView {
  calls: string[] = [];
  tree(_b: number, ref: string | null, path: string) {
    this.calls.push(`tree ${String(ref)} ${path}`);
    return Promise.resolve([{ name: 'main.ts', path: 'main.ts', type: 'file' as const, size: 9 }]);
  }
  read(_b: number, ref: string | null, path: string, range?: CodeLineRange) {
    this.calls.push(`read ${String(ref)} ${path}`);
    return Promise.resolve(windowOf(path, Array.from({ length: 80 }, (_, i) => `line ${String(i + 1)}`).join('\n'), range));
  }
  grep(_b: number, ref: string | null, pattern: string) {
    this.calls.push(`grep ${String(ref)} ${pattern}`);
    return Promise.resolve({ hits: [{ path: 'src/main.ts', line: 42, text: 'export const x = 1' }], truncated: false });
  }
  history() {
    return Promise.resolve([]);
  }
  imports() {
    return Promise.resolve([]);
  }
  importedBy() {
    return Promise.resolve([]);
  }
  touchedModules() {
    return Promise.resolve([]);
  }
}

describe('ChatService reading the code', () => {
  let store: MemoryStore;
  let view: FakeCodeView;
  let boards: BoardService;
  let repoBoard: number;
  let bareBoard: number;
  const usage: string[] = [];

  const serviceWith = (llm: Llm, extra: { code?: boolean; llmTimeoutMs?: number } = {}) =>
    new ChatService({
      store,
      clock: { now: () => NOW },
      search: new SearchService({ store, clock: { now: () => NOW }, embedder: new FakeEmbedder() }),
      llm,
      ...(extra.code === false ? {} : { code: new CodeViewService({ boards, view, usage: { record: (_b, consumer, op) => Promise.resolve(void usage.push(`${consumer}:${op}`)) } }) }),
      ...(extra.llmTimeoutMs === undefined ? {} : { llmTimeoutMs: extra.llmTimeoutMs }),
    });

  beforeEach(async () => {
    store = new MemoryStore();
    view = new FakeCodeView();
    usage.length = 0;
    boards = new BoardService({ store, notifier: new RecordingNotifier() });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: true }));
    const made = unwrap(await boards.create(DEV, { name: 'demo', repo: 'acme/app', baseBranch: 'main', timeZone: 'UTC', environments: [] }));
    repoBoard = made.id;
    bareBoard = unwrap(await boards.create(DEV, { name: 'bare', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
  });

  /** A record on a board, so the model is called even when the question needs the code and the code can't be read. */
  const seedRecord = (board: number) =>
    store.transaction(async (tx) => {
      await tx.replaceItem(
        { boardId: board, sourceType: 'decision', externalRef: 'd1', title: 'Retry', occurredAt: NOW, authority: 'decision', status: 'active', supersededBy: null, globIds: [], globGroup: null, externalUrl: null, contentHash: 'd1', state: 'ready' },
        [{ position: 0, header: '[Retry]', text: 'retry helper decision' }],
      );
    });

  const ask = (service: ChatService, board = repoBoard, onText?: (text: string) => void) =>
    service.ask(DEV, { boardId: board, question: 'where is the retry helper implemented?' }, onText);

  it('looks at the code, shows each call as a step and cites the file and line range it read', async () => {
    const llm = new ScriptedLlm([
      '{"tool": "grep", "pattern": "retry"}',
      '{"tool": "read", "path": "src/main.ts", "start": 10, "end": 20}',
      (request) => Promise.resolve(/\[1\] src\/main\.ts:10-20/.test(request.prompt) ? 'It lives in src/main.ts [1]' : 'no read seen'),
    ]);
    const streamed: string[] = [];
    const answer = unwrap(await ask(serviceWith(llm), repoBoard, (t) => streamed.push(t)));
    expect(answer.reply.content).toBe('It lives in src/main.ts [1]');
    expect(answer.reply.tools).toEqual(["Searched the board's records (current): 0 found", 'Searched the code for retry: 1 hits', 'Read src/main.ts:10-20']);
    expect(answer.reply.citations).toEqual([expect.objectContaining({ n: 1, source: 'code', sourceLabel: 'Code', title: 'src/main.ts:10-20', link: null })]);
    // Base branch only, counted as chat; the requests that were code looks never reach the stream.
    expect(view.calls).toEqual(['grep null retry', 'read null src/main.ts']);
    expect(usage).toEqual(['chat:search_code', 'chat:read_file']);
    expect(streamed.join('')).toBe('It lives in src/main.ts [1]');
    // Every turn of the loop goes to the board's ledger as chat.
    expect(llm.requests.map((r) => r.spend)).toEqual([1, 2, 3].map(() => ({ boardId: repoBoard, source: 'chat' })));
  });

  it('stops at the cap: the last turn may not look, and a model that still asks gets no answer', async () => {
    const llm = new ScriptedLlm(Array.from({ length: CHAT_CODE_MAX_CALLS + 3 }, () => '{"tool": "tree", "path": ""}'));
    const answer = unwrap(await ask(serviceWith(llm)));
    expect(view.calls).toHaveLength(CHAT_CODE_MAX_CALLS);
    expect(llm.requests).toHaveLength(CHAT_CODE_MAX_CALLS + 1);
    expect(llm.requests[CHAT_CODE_MAX_CALLS]?.prompt).toContain('You may not look at the code any more');
    expect(answer.reply).toMatchObject({ miss: true, citations: [] });
    expect(answer.reply.content).toContain('I also looked at the code.');
  });

  it('offers Look at the code on a miss for a board with a repo, and tells the model to use it once asked', async () => {
    await seedRecord(repoBoard);
    const miss = unwrap(await ask(serviceWith(new ScriptedLlm([CHAT_DONT_KNOW]))));
    expect(miss.reply).toMatchObject({ miss: true, actions: ['look_at_code', 'create_glob'] });
    expect(miss.reply.content).toContain("I didn't look at the code.");
    const again = new ScriptedLlm([CHAT_DONT_KNOW]);
    const asked = unwrap(await serviceWith(again).ask(DEV, { boardId: repoBoard, question: 'where is the retry helper implemented?', lookAtCode: true }));
    expect(again.requests[0]?.system).toContain('The person asked you to look at the code');
    expect(asked.reply.actions).toEqual(['create_glob']);
  });

  it('answers without looking when the model chooses to', async () => {
    const llm = new ScriptedLlm([CHAT_DONT_KNOW]);
    unwrap(await ask(serviceWith(llm)));
    expect(view.calls).toEqual([]);
    expect(llm.requests).toHaveLength(1);
  });

  it('is told a request could not be made and still counts it against the cap', async () => {
    const llm = new ScriptedLlm(['{"tool": "read", "path": "../etc/passwd"}', (r) => Promise.resolve(r.prompt.includes('could not be made') ? CHAT_DONT_KNOW : 'told nothing')]);
    unwrap(await ask(serviceWith(llm)));
    expect(view.calls).toEqual([]);
    expect(llm.requests).toHaveLength(2);
  });

  it('ends at the deadline for the whole loop, not for each call', async () => {
    const slow = (reply: string) => (request: LlmRequest) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(reply), 40);
        request.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    // Each call alone fits in 70 ms; three do not.
    const llm = new ScriptedLlm([slow('{"tool": "tree", "path": ""}'), slow('{"tool": "tree", "path": ""}'), slow('too late [1]')]);
    const result = await ask(serviceWith(llm, { llmTimeoutMs: 70 }));
    expect(errorCode(result)).toBe('llm_unavailable');
    // The first look ran; the second call was cut by the loop's remaining time, not by its own 70 ms.
    expect(view.calls).toHaveLength(1);
  });

  it('stops when the person stops the answer', async () => {
    const stop = new AbortController();
    const llm = new ScriptedLlm(['{"tool": "tree", "path": ""}', () => { stop.abort(); return Promise.reject(new Error('aborted')); }]);
    const result = await serviceWith(llm).ask(DEV, { boardId: repoBoard, question: 'where is the retry helper implemented?', signal: stop.signal });
    expect(errorCode(result)).toBe('invalid_input');
  });

  it('answers as before when the service has no code view, and says it could not read the code when the question needed it', async () => {
    await seedRecord(repoBoard);
    const llm = new ScriptedLlm([CHAT_NO_CODE]);
    const answer = unwrap(await ask(serviceWith(llm, { code: false })));
    expect(llm.requests[0]?.system).not.toContain('"tool"');
    expect(answer.reply).toMatchObject({ content: CHAT_NO_CODE, citations: [] });
    expect(answer.reply.tools).toContain("Couldn't read the code");
  });

  it('does not offer the loop for a board without a repository', async () => {
    await seedRecord(bareBoard);
    const llm = new ScriptedLlm([CHAT_NO_CODE]);
    unwrap(await ask(serviceWith(llm), bareBoard));
    expect(llm.requests[0]?.system).not.toContain('"tool"');
    expect(view.calls).toEqual([]);
  });

  it('tells the model when a code look fails, so it can say it could not read the code', async () => {
    view.read = () => Promise.reject(new Error('clone gone'));
    const llm = new ScriptedLlm(['{"tool": "read", "path": "src/main.ts"}', (r) => Promise.resolve(r.prompt.includes('the code could not be read') ? CHAT_NO_CODE : 'unaware')]);
    expect(unwrap(await ask(serviceWith(llm))).reply.content).toBe(CHAT_NO_CODE);
  });

  it('parses code requests and holds back their stream', () => {
    expect(parseCodeCall('Plain answer')).toBeNull();
    expect(parseCodeCall('{"tool": "nope"}')).toHaveProperty('problem');
    expect(parseCodeCall('{"tool": "grep", "pattern": "-e"}')).toHaveProperty('problem');
    expect(parseCodeCall('{"tool": "read", "path": "a.ts", "start": 3, "end": 9}')).toEqual({ tool: 'read', path: 'a.ts', start: 3, end: 9 });
    expect(parseCodeCall('{"tool": "imports", "path": "a.ts", "direction": "importedBy"}')).toEqual({ tool: 'imports', path: 'a.ts', direction: 'importedBy' });
    const out: string[] = [];
    const request = withoutCodeRequests((t) => out.push(t));
    request('  {"tool"');
    request(': "tree"}');
    expect(out).toEqual([]);
    const answer = withoutCodeRequests((t) => out.push(t));
    answer(' ');
    answer('It is');
    answer(' here');
    expect(out.join('')).toBe(' It is here');
  });
});
