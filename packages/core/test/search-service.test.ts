import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import { SearchService } from '../src/app/search-service.js';
import type { Result } from '../src/domain/errors.js';
import type { AuthorityTier, ItemStatus, NewKnowledgeItem, SourceType } from '../src/domain/search.js';
import { FakeEmbedder, vectorOf } from '../src/testing/fake-embedder.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { glob as makeGlob } from './fixtures.js';

const NOW = '2026-10-05T12:00:00.000Z';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * DAY).toISOString();

const errorCode = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code);
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

interface Seed {
  readonly ref: string;
  readonly text: string;
  readonly title?: string;
  readonly sourceType?: SourceType;
  readonly authority?: AuthorityTier;
  readonly status?: ItemStatus;
  readonly occurredAt?: string;
  readonly globIds?: string[];
  readonly group?: string | null;
  readonly boardId?: number;
}

describe('SearchService', () => {
  let store: MemoryStore;
  let embedder: FakeEmbedder;
  let search: SearchService;
  let boardId: number;
  let otherBoardId: number;

  const seed = async (s: Seed): Promise<void> => {
    const board = s.boardId ?? boardId;
    const item: NewKnowledgeItem = {
      boardId: board,
      sourceType: s.sourceType ?? 'glob_plan',
      externalRef: s.ref,
      title: s.title ?? s.ref,
      occurredAt: s.occurredAt ?? NOW,
      authority: s.authority ?? 'approved_plan',
      status: s.status ?? 'active',
      supersededBy: null,
      globIds: s.globIds ?? [],
      globGroup: s.group ?? null,
      externalUrl: null,
      contentHash: s.ref,
      state: 'ready',
    };
    await store.transaction(async (tx) => {
      await tx.replaceItem(item, [{ position: 0, header: `[${item.title}]`, text: s.text }]);
      const pending = await tx.chunksToEmbed(1000);
      await tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: vectorOf(c.text) })));
    });
  };

  const query = (extra: Partial<{ query: string; mode: 'current' | 'all_time'; from: string; to: string; globId: string; group: string }> = {}) => ({
    boardId,
    query: 'retry backoff',
    ...extra,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    embedder = new FakeEmbedder();
    search = new SearchService({ store, clock: { now: () => NOW }, embedder });
    await store.transaction(async (tx) => {
      for (const email of [DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
      const make = () =>
        tx.insertBoard({ name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      boardId = (await make()).id;
      otherBoardId = (await make()).id;
      await tx.upsertMember({ boardId, email: DEV, role: 'dev' });
      await tx.upsertMember({ boardId: otherBoardId, email: OUTSIDER, role: 'dev' });
    });
  });

  it('refuses a non-member on every method and the board search', async () => {
    await seed({ ref: 'a', text: 'retry backoff' });
    for (const method of ['text', 'semantic', 'changes', 'board'] as const) {
      expect(errorCode(await search[method](OUTSIDER, query())), method).toBe('forbidden');
    }
    expect(errorCode(await search.text('nobody@example.com', query()))).toBe('forbidden');
  });

  it('never returns another board\'s material, even through a glob or group filter', async () => {
    await seed({ ref: 'mine', text: 'retry backoff', globIds: ['s1t1'], group: 'sync' });
    await seed({ ref: 'theirs', text: 'retry backoff', globIds: ['s2t1'], group: 'sync', boardId: otherBoardId });
    expect(unwrap(await search.text(DEV, query())).map((h) => h.citation.title)).toEqual(['mine']);
    expect(unwrap(await search.text(DEV, query({ globId: 's2t1' })))).toEqual([]);
    expect(unwrap(await search.semantic(DEV, query())).map((h) => h.citation.title)).toEqual(['mine']);
    expect(unwrap(await search.board(DEV, query({ group: 'sync' }))).hits.map((h) => h.citation.title)).toEqual(['mine']);
  });

  it('text ranks by authority, and returns citations', async () => {
    await seed({ ref: 'plan', title: 'Plan', text: 'retry backoff design', authority: 'approved_plan' });
    await seed({ ref: 'merged', title: 'Change', text: 'retry backoff design', authority: 'merged_code', sourceType: 'postplan' });
    await seed({ ref: 'talk', title: 'Review', text: 'retry backoff design', authority: 'discussion', sourceType: 'local_review' });
    const hits = unwrap(await search.text(DEV, query()));
    expect(hits.map((h) => h.citation.title)).toEqual(['Change', 'Plan', 'Review']);
    expect(hits[0]?.citation).toMatchObject({ source: 'postplan', title: 'Change', date: NOW });
  });

  it('current mode decays old items and labels superseded ones; all_time ranks on relevance and authority', async () => {
    await seed({ ref: 'old', title: 'Old', text: 'retry backoff', occurredAt: daysAgo(360) });
    await seed({ ref: 'new', title: 'New', text: 'retry backoff', occurredAt: daysAgo(1) });
    await seed({ ref: 'dead', title: 'Dead', text: 'retry backoff', occurredAt: daysAgo(1) });
    await store.transaction((tx) => tx.replaceItem(
      { boardId, sourceType: 'glob_plan', externalRef: 'dead', title: 'Dead', occurredAt: daysAgo(1), authority: 'approved_plan', status: 'superseded', supersededBy: null, globIds: [], globGroup: null, externalUrl: null, contentHash: 'dead2', state: 'ready' },
      [{ position: 0, header: '[Dead]', text: 'retry backoff' }],
    ));
    const current = unwrap(await search.text(DEV, query()));
    expect(current.map((h) => h.citation.title)).toEqual(['New', 'Dead', 'Old']);
    expect(current.find((h) => h.citation.title === 'Dead')?.label).toBe('superseded');
    const history = unwrap(await search.text(DEV, query({ mode: 'all_time' })));
    expect(history.map((h) => h.score)).toEqual([0.9, 0.9, 0.9]);
    expect(history.find((h) => h.citation.title === 'Dead')?.label).toBe('superseded');
  });

  it('puts legacy material last in current mode', async () => {
    await seed({ ref: 'legacy', title: 'Legacy', text: 'retry backoff', authority: 'legacy', status: 'legacy' });
    await seed({ ref: 'talk', title: 'Talk', text: 'retry backoff and more words', authority: 'discussion', occurredAt: daysAgo(300) });
    const hits = unwrap(await search.text(DEV, query()));
    expect(hits.map((h) => h.citation.title)).toEqual(['Talk', 'Legacy']);
    expect(hits[1]?.label).toBe('legacy');
  });

  it('applies the date range, glob, group and source type filters', async () => {
    await seed({ ref: 'a', title: 'A', text: 'retry backoff', occurredAt: daysAgo(10), globIds: ['s1t1'], group: 'sync' });
    await seed({ ref: 'b', title: 'B', text: 'retry backoff', occurredAt: daysAgo(50), globIds: ['s1t2'], group: 'billing', sourceType: 'kb_doc' });
    const titles = async (extra: Parameters<typeof query>[0] & { sourceTypes?: SourceType[] }) =>
      unwrap(await search.text(DEV, { ...query(extra), sourceTypes: extra.sourceTypes })).map((h) => h.citation.title);
    expect(await titles({ from: daysAgo(20) })).toEqual(['A']);
    expect(await titles({ to: daysAgo(20) })).toEqual(['B']);
    expect(await titles({ globId: 's1t2' })).toEqual(['B']);
    expect(await titles({ group: 'sync' })).toEqual(['A']);
    expect(await titles({ sourceTypes: ['kb_doc'] })).toEqual(['B']);
  });

  it('rejects an empty query', async () => {
    expect(errorCode(await search.text(DEV, query({ query: '  ' })))).toBe('invalid_input');
  });

  it('rejects a query over the length cap on every method', async () => {
    const long = query({ query: 'a'.repeat(2001) });
    expect(errorCode(await search.text(DEV, long))).toBe('invalid_input');
    expect(errorCode(await search.semantic(DEV, long))).toBe('invalid_input');
    expect(errorCode(await search.board(DEV, long))).toBe('invalid_input');
    expect(errorCode(await search.text(DEV, query({ query: 'a'.repeat(2000) })))).toBe('ok');
  });

  it('returns at most 10 chunks', async () => {
    for (let i = 0; i < 14; i++) await seed({ ref: `r${String(i)}`, text: 'retry backoff' });
    expect(unwrap(await search.text(DEV, query()))).toHaveLength(10);
  });

  it('semantic finds a chunk by meaning words and reports llm_unavailable while the embedder is down', async () => {
    await seed({ ref: 'a', title: 'A', text: 'retry backoff jitter' });
    await seed({ ref: 'b', title: 'B', text: 'billing invoices' });
    expect(unwrap(await search.semantic(DEV, query()))[0]?.citation.title).toBe('A');
    embedder.unavailable = new LlmUnavailable('AWS sign-in expired', 'Sign in again');
    const down = await search.semantic(DEV, query());
    expect(down).toMatchObject({ ok: false, error: { code: 'llm_unavailable', reason: 'AWS sign-in expired', fix: 'Sign in again' } });
    // Text search never needs the embedder.
    expect(unwrap(await search.text(DEV, query()))).toHaveLength(1);
  });

  it('changes lists merged changes newest first, within the range, by query or path, ignoring other sources', async () => {
    await seed({ ref: 'plan', text: 'retry backoff' });
    await seed({ ref: 'c1', title: 'Old change', sourceType: 'change_summary', authority: 'merged_code', text: 'Files: src/sync/retry.ts\nAdded retries.', occurredAt: daysAgo(30) });
    await seed({ ref: 'c2', title: 'New change', sourceType: 'change_summary', authority: 'merged_code', text: 'Files: src/sync/retry.ts\nTuned retries.', occurredAt: daysAgo(2) });
    await seed({ ref: 'c3', title: 'Other change', sourceType: 'change_summary', authority: 'merged_code', text: 'Files: src/billing/invoice.ts\nInvoices.', occurredAt: daysAgo(1) });
    const titles = async (q: string, extra: { from?: string } = {}) =>
      unwrap(await search.changes(DEV, { boardId, query: q, ...extra })).map((h) => h.citation.title);
    expect(await titles('sync/retry')).toEqual(['New change', 'Old change']);
    expect(await titles('retries', { from: daysAgo(10) })).toEqual(['New change']);
  });

  it('board fuses keyword and semantic results, and falls back to keyword-only while the embedder is down', async () => {
    await seed({ ref: 'a', title: 'A', text: 'retry backoff jitter' });
    await seed({ ref: 'b', title: 'B', text: 'retry only' });
    const both = unwrap(await search.board(DEV, query()));
    expect(both.semantic).toBe('ok');
    expect(both.hits.map((h) => h.citation.title)).toEqual(['A', 'B']);
    embedder.unavailable = new LlmUnavailable('AWS sign-in expired', 'Sign in again');
    const fallback = unwrap(await search.board(DEV, query()));
    expect(fallback.semantic).toBe('unavailable');
    expect(fallback.hits.map((h) => h.citation.title)).toEqual(['A', 'B']);
  });
});

describe('ArtifactService.context related', () => {
  let store: MemoryStore;
  let boardId: number;
  const clock = { now: () => NOW };
  const notifier = { publish: () => undefined };

  beforeEach(async () => {
    store = new MemoryStore();
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: DEV, active: true });
      boardId = (
        await tx.insertBoard({ name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] })
      ).id;
      await tx.upsertMember({ boardId, email: DEV, role: 'dev' });
      await tx.insertGlob(makeGlob({ id: 's1t1', boardId, title: 'Sync retries', summary: 'Retry failed syncs with backoff.' }), null);
      const put = async (ref: string, text: string, globIds: string[]) => {
        await tx.replaceItem(
          { boardId, sourceType: 'glob_plan', externalRef: ref, title: ref, occurredAt: NOW, authority: 'approved_plan', status: 'active', supersededBy: null, globIds, globGroup: null, externalUrl: `/x/${ref}`, contentHash: ref, state: 'ready' },
          [{ position: 0, header: `[${ref}]`, text }],
        );
      };
      await put('own', 'Sync retries with backoff', ['s1t1']);
      for (let i = 0; i < 7; i++) await put(`other${String(i)}`, 'Sync retries history', ['s1t9']);
      const pending = await tx.chunksToEmbed(100);
      await tx.setEmbeddings(pending.map((c) => ({ id: c.id, embedding: vectorOf(c.text) })));
    });
  });

  it('adds up to 5 cited related hits without the glob\'s own items, and leaves the other fields alone', async () => {
    const plain = unwrap(await new ArtifactService({ store, clock, notifier }).context(DEV, 's1t1'));
    expect(plain.related).toBeUndefined();

    const search = new SearchService({ store, clock, embedder: new FakeEmbedder() });
    const artifacts = new ArtifactService({ store, clock, notifier, related: (tx, glob) => search.related(tx, glob) });
    const withRelated = unwrap(await artifacts.context(DEV, 's1t1'));
    const { related, ...rest } = withRelated;
    expect(rest).toEqual(plain);
    expect(related).toHaveLength(5);
    expect(related?.every((h) => h.citation.title.startsWith('other') && h.citation.link !== null)).toBe(true);
  });

  it('still returns related (keyword only) when the embedder is down', async () => {
    const embedder = new FakeEmbedder();
    embedder.unavailable = new LlmUnavailable('down', 'later');
    const search = new SearchService({ store, clock, embedder });
    const artifacts = new ArtifactService({ store, clock, notifier, related: (tx, glob) => search.related(tx, glob) });
    expect(unwrap(await artifacts.context(DEV, 's1t1')).related).toHaveLength(5);
  });
});
