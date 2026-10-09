import { beforeEach, describe, expect, it } from 'vitest';
import { ChatService } from '../src/app/chat-service.js';
import { LlmBusy, LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { SearchService } from '../src/app/search-service.js';
import { CHAT_DONT_KNOW } from '../src/domain/chat.js';
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
  next: string | Error = '{"answer": "unset", "used": []}';
  complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next);
  }
}
const says = (answer: string, used: number[]) => JSON.stringify({ answer, used });

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

  const ask = (question = 'retry backoff', extra: { history?: boolean; globId?: string } = {}, email = DEV) =>
    chat.ask(email, { boardId, question, ...extra });

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
    llm.next = says(`Exponential [${n}]`, [n]);
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
    llm.next = says('x', [nb, 5, na]);
    const cites = unwrap(await ask()).reply.citations ?? [];
    expect(cites.map((c) => [c.n, c.title])).toEqual([na, nb].sort().map((n) => [n, n === na ? 'Alpha' : 'Beta']));
    // Two chunks of one item are one citation, numbered by the first.
    await store.transaction(async (tx) => {
      await tx.replaceItem(
        { boardId, sourceType: 'decision', externalRef: 'multi', title: 'Multi', occurredAt: NOW, authority: 'decision', status: 'active', supersededBy: null, globIds: [], globGroup: null, externalUrl: null, contentHash: 'multi', state: 'ready' },
        [{ position: 0, header: '[Multi]', text: 'zzquux first chunk' }, { position: 1, header: '[Multi]', text: 'zzquux second chunk' }],
      );
    });
    llm.next = says('x', [2, 1]);
    const multi = unwrap(await ask('zzquux')).reply.citations ?? [];
    expect(multi.map((c) => [c.n, c.title])).toEqual([[1, 'Multi']]);
  });

  it('drops a source number the model invented, and knows nothing when none is left', async () => {
    await seed('a', 'retry backoff is exponential');
    llm.next = says('Made up [9]', [9, 0, -1]);
    const reply = unwrap(await ask()).reply;
    expect(reply.content).toBe(CHAT_DONT_KNOW);
    expect(reply.citations).toEqual([]);
    llm.next = says('Real [1] and made up [7]', [1, 7]);
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
    llm.next = says('I cannot tell', []);
    const none = unwrap(await ask()).reply;
    expect(none).toMatchObject({ content: CHAT_DONT_KNOW, citations: [] });
  });

  it('labels a superseded decision with the newer one, and shows the current one first', async () => {
    await seed('new', 'retry backoff is now jittered', { title: 'Jittered backoff', date: '2026-10-01T00:00:00.000Z' });
    const newer = await store.transaction((tx) => tx.getItemByRef(boardId, 'new'));
    await seed('old', 'retry backoff is fixed', { title: 'Fixed backoff', date: '2026-08-01T00:00:00.000Z' });
    const older = await store.transaction((tx) => tx.getItemByRef(boardId, 'old'));
    await store.transaction((tx) => tx.setItemSupersession(older?.id ?? 0, 'superseded', newer?.id ?? 0));
    llm.next = says('Old [1], new [2]', [1, 2]);
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
    expect(errorCode(await chat.history(OUTSIDER, boardId))).toBe('forbidden');
    expect(errorCode(await chat.clear(OUTSIDER, boardId))).toBe('forbidden');
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
    expect(unwrap(await chat.history(DEV, boardId))).toEqual([]);
  });

  it('keeps each person\'s conversation to themselves, oldest first, and clears only theirs', async () => {
    await seed('a', 'retry backoff');
    llm.next = says('Yes [1]', [1]);
    await ask('retry backoff');
    await ask('retry backoff again', {}, OTHER);
    const mine = unwrap(await chat.history(DEV, boardId));
    expect(mine.map((m) => [m.role, m.content])).toEqual([['user', 'retry backoff'], ['assistant', 'Yes [1]']]);
    expect(mine[1]?.citations).toHaveLength(1);
    expect(unwrap(await chat.history(OTHER, boardId)).map((m) => m.content)).toEqual(['retry backoff again', 'Yes [1]']);
    unwrap(await chat.clear(DEV, boardId));
    expect(unwrap(await chat.history(DEV, boardId))).toEqual([]);
    expect(unwrap(await chat.history(OTHER, boardId))).toHaveLength(2);
  });

  it('sends recent turns for follow-ups, but retrieves on the current question', async () => {
    await seed('a', 'retry backoff');
    llm.next = says('Yes [1]', [1]);
    await ask('retry backoff');
    await ask('retry backoff');
    expect(llm.requests[1]?.prompt).toContain('Earlier in this conversation');
    expect(llm.requests[1]?.prompt).toContain('Asker: retry backoff');
    expect(llm.requests[0]?.prompt).not.toContain('Earlier in this conversation');
  });

  it('searches all of history only when asked to, and honours the glob scope', async () => {
    // Old but authoritative against new but chatty: recency decides in current mode, authority in all_time.
    await seed('old', 'retry backoff', { title: 'Old', date: '2024-01-01T00:00:00.000Z', globIds: ['s1t1'] });
    await seed('new', 'retry backoff', { title: 'New', date: '2026-10-01T00:00:00.000Z', globIds: ['s1t2'], sourceType: 'local_review', authority: 'discussion' });
    llm.next = says('x [1]', [1]);
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

  it('stores nothing for a one-off answer', async () => {
    await seed('a', 'retry backoff');
    llm.next = says('Yes [1]', [1]);
    const one = unwrap(await chat.answer(DEV, { boardId, question: 'retry backoff' }));
    expect(one).toMatchObject({ answer: 'Yes [1]', answered: true });
    expect(one.citations).toHaveLength(1);
    expect(unwrap(await chat.history(DEV, boardId))).toEqual([]);
  });

  it('rejects an empty or over-long question', async () => {
    expect(errorCode(await ask('   '))).toBe('invalid_input');
    expect(errorCode(await ask('x'.repeat(2001)))).toBe('invalid_input');
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
      llm.next = says('Sources raise them [1]', [1]);
      const reply = unwrap(await ask('awhy did we do notifcations like that?'));
      expect(reply.answered).toBe(true);
      expect(llm.requests[0]?.prompt).toContain('Question: awhy did we do notifcations like that?');
      expect(rewriter.requests[0]?.prompt).toContain('awhy did we do notifcations like that?');
    });

    it('falls back to the original question when the rewrite fails or is unreadable', async () => {
      await seed('a', 'retry backoff is exponential');
      llm.next = says('Yes [1]', [1]);
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
      llm.next = says('s1t1 is in Doing [1]', [1]);
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
      llm.next = says('many [1]', [1]);
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
      llm.next = says('Something', []);
      expect(unwrap(await ask()).reply.content).toBe(CHAT_DONT_KNOW);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(`board ${boardId}`);
      expect(warnings[0]).toContain('sure, exponential');
      llm.next = says(CHAT_DONT_KNOW, []);
      await ask();
      expect(warnings).toHaveLength(2);
    });
  });
});
