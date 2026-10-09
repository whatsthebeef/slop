import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { DecisionPipeline, EXTRACT_SYSTEM } from '../src/app/decision-pipeline.js';
import { InboxPipeline } from '../src/app/inbox-pipeline.js';
import { InboxService } from '../src/app/inbox-service.js';
import { LlmBusy, LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { LLM_WAIT_MS, MAX_PROCESSING_ATTEMPTS } from '../src/app/kb-pipeline.js';
import { SearchIndexer } from '../src/app/search-indexer.js';
import type { Result } from '../src/domain/errors.js';
import { INBOX_CONTEXT_CHARS, INBOX_TEXT_LIMIT, inboxRef } from '../src/domain/inbox.js';
import type { InboxItem } from '../src/domain/inbox.js';
import { LLM_WAITING_PREFIX } from '../src/domain/kb.js';
import type { Glob } from '../src/domain/types.js';
import { FakeEmbedder } from '../src/testing/fake-embedder.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob as makeGlob } from './fixtures.js';

const START = '2026-10-05T12:00:00.000Z';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const NOTES =
  'Standup 3 Oct.\n\nWe agreed the sync jobs will be pushed over a websocket connection instead of polling the server.\n\nAna owns the rollout.';

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const errorCode = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code);

const answer = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    title: 'Sync standup',
    kind: 'meeting',
    summary: 'Sync jobs move to a websocket.',
    suggestions: [],
    ...patch,
  });

/** Answers the summary call from a queue; the last answer repeats when `sticky`. Extraction calls get their own canned answer. */
class FakeLlm implements Llm {
  readonly calls: LlmRequest[] = [];
  readonly queue: (string | Error)[] = [];
  extraction = '{"decisions": []}';
  complete(request: LlmRequest): Promise<string> {
    this.calls.push(request);
    if (request.system === EXTRACT_SYSTEM) return Promise.resolve(this.extraction);
    const next = this.queue.shift();
    if (next === undefined) return Promise.reject(new Error('No canned answer'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
  summaries(): LlmRequest[] {
    return this.calls.filter((c) => c.system !== EXTRACT_SYSTEM);
  }
}

describe('inbox', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let llm: FakeLlm;
  let embedder: FakeEmbedder;
  let inbox: InboxService;
  let pipeline: InboxPipeline;
  let now: string;
  let boardId: number;

  const clock = { now: () => now };
  const advance = (ms: number) => {
    now = new Date(Date.parse(now) + ms).toISOString();
  };
  const rows = (): Promise<InboxItem[]> => store.transaction((tx) => tx.listInboxItems(boardId));
  const row = async (id: number): Promise<InboxItem> => {
    const found = await store.transaction((tx) => tx.getInboxItem(boardId, id));
    if (found === null) throw new Error(`No inbox item ${String(id)}`);
    return found;
  };
  const searchItem = (id: number) =>
    store.state.searchItems.get(`${String(boardId)}:${inboxRef(id)}`);
  const addGlob = async (patch: Partial<Glob> = {}) => {
    const g = makeGlob({ boardId, ...patch });
    await store.transaction((tx) => tx.insertGlob(g, null));
    return g;
  };
  const paste = async (
    text = NOTES,
    extra: { title?: string; occurredAt?: string; sourceLabel?: string } = {},
  ): Promise<number> => unwrap(await inbox.add(DEV, boardId, { text, ...extra })).id;
  const processAll = async (): Promise<string[]> => {
    const done: string[] = [];
    for (let i = 0; i < 10; i++) {
      const step = await pipeline.processNext();
      if (step === null) break;
      done.push(step);
    }
    return done;
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    llm = new FakeLlm();
    embedder = new FakeEmbedder();
    now = START;
    inbox = new InboxService({ store, clock, notifier });
    pipeline = new InboxPipeline({ store, clock, notifier, llm, embedder });
    boardId = await store.transaction(async (tx) => {
      for (const email of [DEV, OUTSIDER])
        await tx.upsertUser({ email, name: email, active: true });
      const board = await tx.insertBoard({
        name: 'demo',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
  });

  describe('add', () => {
    it('stores the item and its search item at once, searchable before any summary or embedding', async () => {
      const id = await paste(NOTES, {
        title: 'Sync standup',
        sourceLabel: 'Standup',
        occurredAt: '2026-10-03',
      });
      const item = await row(id);
      expect(item).toMatchObject({
        title: 'Sync standup',
        source: 'paste',
        sourceLabel: 'Standup',
        sourceType: 'meeting',
        occurredAt: '2026-10-03T00:00:00.000Z',
        status: 'new',
        state: 'pending',
        summary: null,
        createdBy: DEV,
      });
      expect(searchItem(id)).toMatchObject({
        sourceType: 'meeting',
        authority: 'discussion',
        status: 'active',
        globIds: [],
        title: 'Sync standup',
        id: item.itemId,
      });
      const chunks = store.state.searchChunks.filter((c) => c.itemId === item.itemId);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.embedding === null)).toBe(true);
      const hits = await store.transaction((tx) =>
        tx.keywordCandidates({ boardId, query: 'websocket', mode: 'all_time' }, 10),
      );
      expect(hits.map((h) => h.itemId)).toContain(item.itemId);
      expect(notifier.hints).toContainEqual({ kind: 'board.inbox', boardId });
    });

    it('uses the first line as the title and now as the date when none is given', async () => {
      const id = await paste();
      expect(await row(id)).toMatchObject({ title: '', occurredAt: START });
      expect(searchItem(id)?.title).toBe('Standup 3 Oct.');
    });

    it('returns the same item for the same text, however it is spaced', async () => {
      const first = unwrap(await inbox.add(DEV, boardId, { text: NOTES }));
      const again = unwrap(
        await inbox.add(DEV, boardId, { text: `  ${NOTES.replace(/\n\n/g, '\n')}\n` }),
      );
      expect(first.created).toBe(true);
      expect(again).toEqual({ id: first.id, created: false });
      expect(await rows()).toHaveLength(1);
      expect(store.state.searchItems.size).toBe(1);
    });

    it('brings a discarded item back as new when the same text is pasted again', async () => {
      const id = await paste();
      unwrap(await inbox.discard(DEV, boardId, id));
      expect(searchItem(id)).toBeUndefined();
      expect(unwrap(await inbox.add(DEV, boardId, { text: NOTES }))).toEqual({ id, created: true });
      expect(await row(id)).toMatchObject({ status: 'new', state: 'pending' });
      expect(searchItem(id)).toBeDefined();
    });

    it('refuses a non-member, blank or oversized text and a bad date', async () => {
      expect(errorCode(await inbox.add(OUTSIDER, boardId, { text: NOTES }))).toBe('forbidden');
      expect(errorCode(await inbox.add(DEV, boardId, { text: '  \n ' }))).toBe('invalid_input');
      expect(
        errorCode(await inbox.add(DEV, boardId, { text: 'x'.repeat(INBOX_TEXT_LIMIT + 1) })),
      ).toBe('invalid_input');
      expect(errorCode(await inbox.add(DEV, boardId, { text: NOTES, occurredAt: 'soon' }))).toBe(
        'invalid_input',
      );
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('processing', () => {
    it('writes the summary and suggestions from candidate globs only, at most three', async () => {
      const wanted = await addGlob({
        id: 's1t1',
        title: 'Push sync jobs over a websocket',
        summary: 'Replace polling with a websocket',
      });
      for (const n of [2, 3, 4])
        await addGlob({
          id: `s1t${String(n)}`,
          title: `Sync jobs websocket part ${String(n)}`,
          summary: 'sync jobs websocket',
        });
      await new SearchIndexer({
        store,
        clock,
        embedder,
        changes: { mergedDiff: () => Promise.resolve(null) },
        llm,
      }).syncBoard(boardId);
      const id = await paste(NOTES, { title: 'Sync jobs websocket' });
      llm.queue.push(
        answer({
          kind: 'thread',
          suggestions: [
            { globId: 's1t1', reason: 'Both are about moving sync jobs to a websocket.' },
            { globId: 's1t99', reason: 'Invented.' },
            { globId: 's1t1', reason: 'Repeated.' },
            { globId: 's1t2', reason: 'b' },
            { globId: 's1t3', reason: 'c' },
            { globId: 's1t4', reason: 'd' },
          ],
        }),
      );
      expect(await processAll()).toEqual([inboxRef(id)]);
      const item = await row(id);
      expect(item).toMatchObject({
        state: 'done',
        summary: 'Sync jobs move to a websocket.',
        attempts: 0,
        lastError: null,
        sourceType: 'thread',
        title: 'Sync jobs websocket',
      });
      expect(item.suggestions.map((s) => s.globId)).toEqual(['s1t1', 's1t2', 's1t3']);
      expect(item.suggestions[0]?.reason).toBe('Both are about moving sync jobs to a websocket.');
      const prompt = llm.summaries()[0]?.prompt ?? '';
      expect(prompt).toContain(`[${wanted.id}] ${wanted.title}`);
      expect(prompt).toContain('<<<');
      expect(searchItem(id)?.sourceType).toBe('thread');
      const view = unwrap(await inbox.list(DEV, boardId))[0];
      expect(view?.suggestions[0]).toMatchObject({ globId: 's1t1', title: wanted.title });
    });

    it('uses the semantic arm when the title is blank, and still summarises with no candidates', async () => {
      await addGlob({
        id: 's1t1',
        title: 'Websocket push',
        summary:
          'standup sync jobs pushed over a websocket connection instead of polling the server',
      });
      const indexer = new SearchIndexer({
        store,
        clock,
        embedder,
        changes: { mergedDiff: () => Promise.resolve(null) },
        llm,
      });
      await indexer.syncBoard(boardId);
      while ((await indexer.processNext()) !== null) {
        // Embeds every chunk.
      }
      const id = await paste();
      llm.queue.push(answer({ suggestions: [{ globId: 's1t1', reason: 'Same topic.' }] }));
      await processAll();
      expect((await row(id)).suggestions.map((s) => s.globId)).toEqual(['s1t1']);
      expect(embedder.calls.at(-1)?.[0]).toContain('websocket');

      const bare = await paste('Lunch order for Friday: pizza');
      store.state.searchChunks = store.state.searchChunks.filter(
        (c) => c.itemId !== (searchItem(id)?.id ?? -1),
      );
      llm.queue.push(answer({ suggestions: [{ globId: 's1t1', reason: 'Not a candidate.' }] }));
      await processAll();
      expect(await row(bare)).toMatchObject({ state: 'done', suggestions: [] });
    });

    it('fills a blank title from the answer, keeps a given one, and re-chunks only when the title changed', async () => {
      const blank = await paste();
      const given = await paste('Other notes about the release', { title: 'Release notes' });
      llm.queue.push(answer({ title: 'Websocket decision' }), answer({ title: 'Ignored' }));
      const before = searchItem(given)?.contentHash;
      const chunkIds = store.state.searchChunks
        .filter((c) => c.itemId === searchItem(given)?.id)
        .map((c) => c.id);
      await processAll();
      expect((await row(blank)).title).toBe('Websocket decision');
      expect(searchItem(blank)?.title).toBe('Websocket decision');
      expect((await row(given)).title).toBe('Release notes');
      // Nothing about the given item's index changed: same chunks, same hash.
      expect(searchItem(given)?.contentHash).toBe(before);
      expect(
        store.state.searchChunks.filter((c) => c.itemId === searchItem(given)?.id).map((c) => c.id),
      ).toEqual(chunkIds);
    });

    it('is idempotent: a done item is not asked about again', async () => {
      const id = await paste();
      llm.queue.push(answer());
      await processAll();
      const after = await row(id);
      const calls = llm.calls.length;
      expect(await pipeline.processNext()).toBeNull();
      expect(unwrap(await inbox.add(DEV, boardId, { text: NOTES })).created).toBe(false);
      expect(await pipeline.processNext()).toBeNull();
      expect(llm.calls).toHaveLength(calls);
      expect(await row(id)).toEqual(after);
    });

    it('drops the answer when the item was discarded while the model worked', async () => {
      const id = await paste();
      llm.complete = async () => {
        unwrap(await inbox.discard(DEV, boardId, id));
        return answer();
      };
      await pipeline.processNext();
      expect(await row(id)).toMatchObject({ status: 'discarded', summary: null, state: 'pending' });
      expect(searchItem(id)).toBeUndefined();
    });

    it('retries unusable answers with growing backoff and fails after the last attempt, keeping the item listed and searchable', async () => {
      const id = await paste();
      for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
        llm.queue.push('not json at all');
        expect(await pipeline.processNext()).toBe(inboxRef(id));
        const item = await row(id);
        expect(item.attempts).toBe(attempt);
        expect(item.lastError).toContain('not usable JSON');
        if (attempt < MAX_PROCESSING_ATTEMPTS) {
          expect(item.state).toBe('pending');
          expect(await pipeline.processNext()).toBeNull();
          advance(30_000 * 2 ** (attempt - 1));
        }
      }
      expect(await row(id)).toMatchObject({ state: 'failed', processAfter: null });
      expect(await pipeline.processNext()).toBeNull();
      expect(unwrap(await inbox.list(DEV, boardId))[0]).toMatchObject({
        processing: 'failed',
        summary: null,
      });
      expect(searchItem(id)).toBeDefined();
    });

    it('waits without spending attempts while the model is unavailable or busy, then succeeds', async () => {
      const id = await paste();
      llm.queue.push(new LlmUnavailable('no credentials', 'sign in'));
      await pipeline.processNext();
      let item = await row(id);
      expect(item).toMatchObject({
        state: 'pending',
        attempts: 0,
        processAfter: new Date(Date.parse(now) + LLM_WAIT_MS).toISOString(),
      });
      expect(item.lastError?.startsWith(LLM_WAITING_PREFIX)).toBe(true);
      expect(unwrap(await inbox.list(DEV, boardId))[0]?.processing).toBe('waiting');
      expect(await pipeline.processNext()).toBeNull();

      advance(LLM_WAIT_MS);
      llm.queue.push(new LlmBusy());
      await pipeline.processNext();
      item = await row(id);
      const first = Date.parse(item.processAfter ?? '') - Date.parse(now);
      expect(item).toMatchObject({ state: 'pending', attempts: 0 });
      expect(item.lastError).toContain('Bedrock busy');

      advance(first);
      llm.queue.push(new LlmBusy());
      await pipeline.processNext();
      expect(Date.parse((await row(id)).processAfter ?? '') - Date.parse(now)).toBeGreaterThan(
        first,
      );
      expect((await row(id)).attempts).toBe(0);

      advance(20 * 60_000);
      llm.queue.push(answer());
      await pipeline.processNext();
      expect(await row(id)).toMatchObject({ state: 'done', attempts: 0, lastError: null });
    });

    it('loses only the semantic arm when the embedder fails', async () => {
      embedder.unavailable = new LlmUnavailable('down', 'later');
      const id = await paste();
      llm.queue.push(answer());
      await processAll();
      expect((await row(id)).state).toBe('done');
    });
  });

  describe('attach, keep and discard', () => {
    let g1: Glob;
    let g2: Glob;
    let id: number;
    beforeEach(async () => {
      g1 = await addGlob({ id: 's1t1', title: 'First', group: 'sync' });
      g2 = await addGlob({ id: 's1t2', title: 'Second', group: 'sync' });
      id = await paste(NOTES, { title: 'Sync standup' });
    });

    it('attaches to two globs: link attachments, status, search links without re-chunking', async () => {
      const hash = searchItem(id)?.contentHash;
      const chunkIds = store.state.searchChunks
        .filter((c) => c.itemId === searchItem(id)?.id)
        .map((c) => c.id);
      const view = unwrap(await inbox.attach(DEV, boardId, id, [g1.id, g2.id]));
      expect(view.status).toBe('attached');
      expect(view.attachedTo.map((a) => a.globId)).toEqual(['s1t1', 's1t2']);
      for (const g of [g1, g2]) {
        const attachments = await store.transaction((tx) => tx.listArtifacts(g.id, 'attachment'));
        expect(attachments).toHaveLength(1);
        expect(attachments[0]).toMatchObject({
          label: 'From the inbox: Sync standup',
          link: `/boards/${String(boardId)}/inbox?item=${String(id)}`,
          content: '',
        });
      }
      expect(searchItem(id)).toMatchObject({
        globIds: ['s1t1', 's1t2'],
        globGroup: 'sync',
        contentHash: hash,
      });
      expect(
        store.state.searchChunks.filter((c) => c.itemId === searchItem(id)?.id).map((c) => c.id),
      ).toEqual(chunkIds);
      expect(notifier.hints).toContainEqual({ kind: 'glob.artifacts', boardId, globId: 's1t1' });
      expect(store.state.events.filter((e) => e.type === 'ArtifactAdded')).toHaveLength(2);
    });

    it('rolls everything back when the item changes under an attach', async () => {
      // The summary write (or another settle) bumps the version between the attach's read and its status write.
      const original = store.transaction.bind(store);
      let bumped = false;
      store.transaction = (work) =>
        original(async (tx) => {
          const real = tx.updateInboxItem.bind(tx);
          return work({
            ...tx,
            updateInboxItem: async (item, expected) => {
              if (!bumped) {
                bumped = true;
                await real({ ...item, status: 'new' }, expected);
              }
              return real(item, expected);
            },
          });
        });
      const before = (await row(id)).version;
      const result = await inbox.attach(DEV, boardId, id, [g1.id, g2.id]);
      store.transaction = original;
      expect(errorCode(result)).toBe('invalid_input');
      expect(bumped).toBe(true);
      expect(await store.transaction((tx) => tx.listInboxLinks(boardId))).toHaveLength(0);
      expect(await store.transaction((tx) => tx.listArtifacts(g1.id, 'attachment'))).toHaveLength(
        0,
      );
      expect(await store.transaction((tx) => tx.listArtifacts(g2.id, 'attachment'))).toHaveLength(
        0,
      );
      expect(store.state.events.filter((e) => e.type === 'ArtifactAdded')).toHaveLength(0);
      expect(await row(id)).toMatchObject({ status: 'new', version: before });
      expect(searchItem(id)?.globIds).toEqual([]);
      // A retry works.
      expect(unwrap(await inbox.attach(DEV, boardId, id, [g1.id])).status).toBe('attached');
    });

    it('attaching again is a no-op, and a new glob adds only its own attachment', async () => {
      unwrap(await inbox.attach(DEV, boardId, id, [g1.id]));
      unwrap(await inbox.attach(DEV, boardId, id, [g1.id, g2.id]));
      expect(
        await store.transaction((tx) =>
          tx.artifactVersions(g1.id, 'attachment', 'From the inbox: Sync standup'),
        ),
      ).toHaveLength(1);
      expect(await store.transaction((tx) => tx.listInboxLinks(boardId))).toHaveLength(2);
    });

    it('labels a second item with the same title apart', async () => {
      const other = await paste('A different note with the same title', { title: 'Sync standup' });
      unwrap(await inbox.attach(DEV, boardId, id, [g1.id]));
      unwrap(await inbox.attach(DEV, boardId, other, [g1.id]));
      const labels = (await store.transaction((tx) => tx.listArtifacts(g1.id, 'attachment')))
        .map((a) => a.label)
        .sort();
      expect(labels).toEqual([
        'From the inbox: Sync standup',
        `From the inbox: Sync standup (#${String(other)})`,
      ]);
    });

    it('refuses a glob of another board, a missing glob, none, too many, and non-members', async () => {
      const otherBoard = await store.transaction((tx) =>
        tx.insertBoard({
          name: 'other',
          repo: 'acme/other',
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [],
          sensitivePaths: [],
        }),
      );
      await store.transaction((tx) =>
        tx.insertGlob(makeGlob({ id: 's2t1', boardId: otherBoard.id }), null),
      );
      expect(errorCode(await inbox.attach(DEV, boardId, id, ['s2t1']))).toBe('not_found');
      expect(errorCode(await inbox.attach(DEV, boardId, id, ['s1t99']))).toBe('not_found');
      expect(errorCode(await inbox.attach(DEV, boardId, id, []))).toBe('invalid_input');
      expect(
        errorCode(
          await inbox.attach(
            DEV,
            boardId,
            id,
            Array.from({ length: 11 }, (_, n) => `s1t${String(n)}`),
          ),
        ),
      ).toBe('invalid_input');
      expect(errorCode(await inbox.attach(OUTSIDER, boardId, id, [g1.id]))).toBe('forbidden');
      expect(errorCode(await inbox.attach(DEV, boardId, 999, [g1.id]))).toBe('not_found');
      // Nothing was written by the refused calls.
      expect((await row(id)).status).toBe('new');
      expect(await store.transaction((tx) => tx.listArtifacts(g1.id, 'attachment'))).toHaveLength(
        0,
      );
    });

    it('keeps a new item, refuses to keep an attached one, and refuses non-members', async () => {
      expect(errorCode(await inbox.keep(OUTSIDER, boardId, id))).toBe('forbidden');
      expect(unwrap(await inbox.keep(DEV, boardId, id)).status).toBe('kept');
      expect(unwrap(await inbox.keep(DEV, boardId, id)).status).toBe('kept');
      expect(searchItem(id)).toBeDefined();
      unwrap(await inbox.attach(DEV, boardId, id, [g1.id]));
      expect(errorCode(await inbox.keep(DEV, boardId, id))).toBe('invalid_input');
    });

    it('discards a new or kept item out of search, and refuses an attached one', async () => {
      expect(errorCode(await inbox.discard(OUTSIDER, boardId, id))).toBe('forbidden');
      const itemId = (await row(id)).itemId;
      unwrap(await inbox.discard(DEV, boardId, id));
      expect(await row(id)).toMatchObject({ status: 'discarded', itemId: null });
      expect(searchItem(id)).toBeUndefined();
      expect(store.state.searchChunks.some((c) => c.itemId === itemId)).toBe(false);
      expect(unwrap(await inbox.list(DEV, boardId))).toHaveLength(0);
      expect(unwrap(await inbox.list(DEV, boardId, ['discarded']))).toHaveLength(1);
      // A discarded item can't be attached or kept.
      expect(errorCode(await inbox.attach(DEV, boardId, id, [g1.id]))).toBe('invalid_input');
      expect(errorCode(await inbox.keep(DEV, boardId, id))).toBe('invalid_input');

      const second = await paste('Another note');
      unwrap(await inbox.attach(DEV, boardId, second, [g2.id]));
      expect(errorCode(await inbox.discard(DEV, boardId, second))).toBe('invalid_input');
      expect(searchItem(second)).toBeDefined();
    });

    it('survives its glob being deleted: the item stays, loses the link and is only kept', async () => {
      unwrap(await inbox.attach(DEV, boardId, id, [g1.id, g2.id]));
      await store.transaction((tx) => tx.deleteGlob(g1.id));
      expect(await row(id)).toMatchObject({ status: 'attached' });
      expect(searchItem(id)?.globIds).toEqual(['s1t2']);
      await store.transaction((tx) => tx.deleteGlob(g2.id));
      expect(await row(id)).toMatchObject({ status: 'kept' });
      expect(searchItem(id)).toMatchObject({ globIds: [] });
      expect(await store.transaction((tx) => tx.listInboxLinks(boardId))).toHaveLength(0);
    });

    it('lists suggestions on live open globs that are not already attached', async () => {
      llm.queue.push(answer({ suggestions: [] }));
      await addGlob({ id: 's1t3', title: 'Done work', status: 'signed_off' });
      store.state.inboxItems = store.state.inboxItems.map((i) => ({
        ...i,
        suggestions: [
          { globId: 's1t1', reason: 'a' },
          { globId: 's1t2', reason: 'b' },
          { globId: 's1t3', reason: 'signed off' },
          { globId: 's1t77', reason: 'gone' },
        ],
      }));
      unwrap(await inbox.attach(DEV, boardId, id, [g1.id]));
      expect(unwrap(await inbox.get(DEV, boardId, id)).suggestions.map((s) => s.globId)).toEqual([
        's1t2',
      ]);
      expect(unwrap(await inbox.get(DEV, boardId, id)).text).toBe(NOTES);
    });
  });

  describe('context and decisions', () => {
    it('puts an attached item in the glob context, cut at the limit, and none otherwise', async () => {
      const g = await addGlob({ id: 's1t1' });
      const artifacts = new ArtifactService({ store, clock, notifier });
      const long = `${NOTES}\n\n${'More talk. '.repeat(2_000)}`;
      const id = await paste(long, { title: 'Sync standup' });
      expect(unwrap(await artifacts.context(DEV, g.id)).inbox).toEqual([]);
      llm.queue.push(answer());
      await processAll();
      unwrap(await inbox.attach(DEV, boardId, id, [g.id]));
      const bundle = unwrap(await artifacts.context(DEV, g.id)).inbox;
      expect(bundle).toHaveLength(1);
      expect(bundle[0]).toMatchObject({
        id,
        title: 'Sync standup',
        summary: 'Sync jobs move to a websocket.',
        url: `/boards/${String(boardId)}/inbox?item=${String(id)}`,
        truncated: true,
      });
      expect(bundle[0]?.text).toHaveLength(INBOX_CONTEXT_CHARS);
      expect(bundle[0]?.text.startsWith('Standup 3 Oct.')).toBe(true);
      const short = await paste('Short note', { title: 'Short' });
      unwrap(await inbox.attach(DEV, boardId, short, [g.id]));
      expect(
        unwrap(await artifacts.context(DEV, g.id)).inbox.find((i) => i.id === short),
      ).toMatchObject({ text: 'Short note', truncated: false });
    });

    it('makes an attached item a decision source on each glob it is on, and nothing else', async () => {
      const g1 = await addGlob({ id: 's1t1' });
      const g2 = await addGlob({ id: 's1t2' });
      const decisions = new DecisionPipeline({ store, clock, notifier, llm, embedder });
      const quote =
        'the sync jobs will be pushed over a websocket connection instead of polling the server';
      llm.extraction = JSON.stringify({
        decisions: [
          {
            statement: 'Push sync jobs over a websocket.',
            quote,
            decidedBy: null,
            decidedAt: null,
          },
        ],
      });
      const id = await paste(NOTES, { title: 'Sync standup', occurredAt: '2026-10-03' });
      await decisions.syncBoard(boardId);
      expect(await decisions.processNext()).toBeNull();

      unwrap(await inbox.attach(DEV, boardId, id, [g1.id, g2.id]));
      const synced = await decisions.syncBoard(boardId);
      expect(synced.queued).toBe(2);
      while ((await decisions.processNext()) !== null) {
        // Extracts each source, then checks each decision.
      }
      const found = await store.transaction((tx) => tx.listDecisions(boardId));
      expect(found.map((d) => d.globId).sort()).toEqual(['s1t1', 's1t2']);
      expect(found[0]).toMatchObject({
        sourceKind: 'inbox',
        quote,
        decidedAt: '2026-10-03T00:00:00.000Z',
        sourceUrl: `/boards/${String(boardId)}/inbox?item=${String(id)}`,
      });
      expect(found[0]?.sourceLabel).toContain('inbox: Sync standup');
      const ref = found[0]?.sourceRef;
      expect(ref === `inbox:${String(id)}:s1t1` || ref === `inbox:${String(id)}:s1t2`).toBe(true);

      // Deleting a glob drops its source and decision.
      await store.transaction((tx) => tx.deleteGlob(g2.id));
      await decisions.syncBoard(boardId);
      expect(
        (await store.transaction((tx) => tx.listDecisions(boardId))).map((d) => d.globId),
      ).toEqual(['s1t1']);
    });
  });

  describe('search index', () => {
    it('leaves pasted items alone when the index sweeps, whatever their type', async () => {
      await addGlob({ id: 's1t1', summary: 'Something' });
      const ids = [
        await paste(),
        await paste('A thread', { title: 'Thread' }),
        await paste('A doc', { title: 'Doc' }),
      ];
      llm.queue.push(
        answer({ kind: 'thread' }),
        answer({ kind: 'doc' }),
        answer({ kind: 'meeting' }),
      );
      await processAll();
      const indexer = new SearchIndexer({
        store,
        clock,
        embedder,
        changes: { mergedDiff: () => Promise.resolve(null) },
        llm,
      });
      const result = await indexer.syncBoard(boardId);
      expect(result.removed).toBe(0);
      for (const id of ids) expect(searchItem(id)).toBeDefined();
      // A second sweep is idempotent too.
      await indexer.syncBoard(boardId);
      for (const id of ids) expect(searchItem(id)?.authority).toBe('discussion');
    });
  });
});
