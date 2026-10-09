import { describe, expect, it } from 'vitest';
import { chunkDocument, CHUNK_MAX_TOKENS, CHUNK_MIN_TOKENS, contentHash } from '../src/domain/chunking.js';
import {
  AUTHORITY_WEIGHTS,
  estimateTokens,
  matchesFilters,
  rankCandidates,
  recency,
  rrfFuse,
  withinBudget,
} from '../src/domain/search.js';
import type { Candidate } from '../src/domain/search.js';

const NOW = '2026-10-05T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

const paragraph = (n: number, sentences = 6) =>
  Array.from({ length: sentences }, (_, i) => `Paragraph ${String(n)} sentence ${String(i)} explains the sync retry behaviour in some detail.`).join(' ');

const doc = (sections: number, paragraphsEach: number) =>
  Array.from({ length: sections }, (_, s) => `## Section ${String(s)}\n\n${Array.from({ length: paragraphsEach }, (_, p) => paragraph(s * 10 + p)).join('\n\n')}`).join('\n\n');

describe('chunkDocument', () => {
  const base = { sourceType: 'glob_plan', date: '2026-09-14T08:00:00.000Z', title: 'Sync retry design' } as const;

  it('keeps a short document in one chunk with a header of stable facts', () => {
    const chunks = chunkDocument({ ...base, text: 'Retry three times, then stop.' });
    expect(chunks).toEqual([{ position: 0, header: '[Plan · 2026-09-14 · "Sync retry design"]', text: 'Retry three times, then stop.' }]);
  });

  it('puts the section name in the header and splits at headings', () => {
    const chunks = chunkDocument({ ...base, text: `# Plan\n\nIntro text.\n\n## Approach\n\n${paragraph(1, 30)}\n\n## Tests\n\n${paragraph(2, 30)}` });
    expect(chunks.map((c) => c.header)).toContain('[Plan · 2026-09-14 · "Sync retry design" · Approach]');
    expect(chunks.map((c) => c.header)).toContain('[Plan · 2026-09-14 · "Sync retry design" · Tests]');
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
  });

  it('never exceeds the maximum and fills windows to between the minimum and the maximum', () => {
    const chunks = chunkDocument({ ...base, text: doc(4, 12) });
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    // Every chunk but the last of each section is full-sized.
    const full = chunks.filter((c) => estimateTokens(c.text) >= CHUNK_MIN_TOKENS);
    expect(full.length).toBeGreaterThanOrEqual(chunks.length - 4);
  });

  it('cuts a paragraph over the maximum at sentence ends', () => {
    const chunks = chunkDocument({ ...base, text: paragraph(1, 120) });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(chunk.text.endsWith('.')).toBe(true);
    }
  });

  it('hard-cuts a sentence over the maximum', () => {
    const chunks = chunkDocument({ ...base, text: 'x'.repeat(6000) });
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
  });

  it('merges a tiny trailing section into the chunk before it, under its heading line', () => {
    const chunks = chunkDocument({ ...base, text: `## Approach\n\n${paragraph(1, 24)}\n\n## Notes\n\nOne last note.` });
    const last = chunks.at(-1);
    expect(last?.text).toContain('## Notes');
    expect(last?.text).toContain('One last note.');
    expect(last?.header).toContain('Approach');
  });

  it('is deterministic, and the hash changes with kind, title, date or text only', () => {
    const text = doc(2, 6);
    expect(chunkDocument({ ...base, text })).toEqual(chunkDocument({ ...base, text }));
    const input = { ...base, text };
    expect(contentHash(input)).toBe(contentHash({ ...input }));
    expect(contentHash({ ...input, text: `${text}!` })).not.toBe(contentHash(input));
    expect(contentHash({ ...input, title: 'Other' })).not.toBe(contentHash(input));
    expect(contentHash({ ...input, date: '2026-09-15T00:00:00.000Z' })).not.toBe(contentHash(input));
    expect(contentHash({ ...input, sourceType: 'postplan' })).not.toBe(contentHash(input));
  });

  it('yields nothing for blank text and keeps headings inside code fences as text', () => {
    expect(chunkDocument({ ...base, text: '  \n ' })).toEqual([]);
    const fenced = chunkDocument({ ...base, text: '```\n# not a heading\n\nstill code\n```' });
    expect(fenced).toHaveLength(1);
    expect(fenced[0]?.header).not.toContain('not a heading');
  });
});

const candidate = (patch: Partial<Candidate> & { chunkId: number }): Candidate => ({
  itemId: patch.chunkId,
  header: '[Plan · 2026-09-14 · "T"]',
  text: 'text',
  relevance: 0.8,
  sourceType: 'glob_plan',
  title: `Item ${String(patch.chunkId)}`,
  occurredAt: NOW,
  authority: 'approved_plan',
  status: 'active',
  supersededByTitle: null,
  supersededByAt: null,
  globIds: ['s1t1'],
  globGroup: null,
  externalUrl: null,
  ...patch,
});

describe('ranking', () => {
  it('halves recency every 90 days and treats the future as now', () => {
    expect(recency(NOW, NOW)).toBe(1);
    expect(recency(daysAgo(90), NOW)).toBeCloseTo(0.5);
    expect(recency(daysAgo(180), NOW)).toBeCloseTo(0.25);
    expect(recency(daysAgo(-5), NOW)).toBe(1);
  });

  it('prefers a recent item to an old one with the same relevance in current mode, but not in all-time', () => {
    const old = candidate({ chunkId: 1, occurredAt: daysAgo(180) });
    const fresh = candidate({ chunkId: 2, occurredAt: daysAgo(1) });
    expect(rankCandidates([old, fresh], 'current', NOW).map((h) => h.itemId)).toEqual([2, 1]);
    const all = rankCandidates([old, fresh], 'all_time', NOW);
    // All-time ignores age: equal scores fall back to the newer item first.
    expect(all[0]?.score).toBe(all[1]?.score);
  });

  it('weights authority in the spec order', () => {
    const weights = ['merged_code', 'decision', 'approved_plan', 'discussion', 'legacy'] as const;
    expect(weights.map((w) => AUTHORITY_WEIGHTS[w])).toEqual([...weights.map((w) => AUTHORITY_WEIGHTS[w])].sort((a, b) => b - a));
    const hits = rankCandidates(
      [
        candidate({ chunkId: 1, authority: 'discussion' }),
        candidate({ chunkId: 2, authority: 'merged_code' }),
        candidate({ chunkId: 3, authority: 'approved_plan' }),
      ],
      'current',
      NOW,
    );
    expect(hits.map((h) => h.itemId)).toEqual([2, 3, 1]);
  });

  it('weights authority as 1, 0.95, 0.9, 0.6, 0.3 (merged code, decision, plan, discussion, legacy)', () => {
    expect(AUTHORITY_WEIGHTS).toEqual({ merged_code: 1, decision: 0.95, approved_plan: 0.9, discussion: 0.6, legacy: 0.3 });
    const hits = rankCandidates(
      [candidate({ chunkId: 1, authority: 'approved_plan' }), candidate({ chunkId: 2, authority: 'decision', sourceType: 'decision' })],
      'current',
      NOW,
    );
    expect(hits.map((h) => h.itemId)).toEqual([2, 1]);
  });

  it('ranks a current decision above any superseded one, labels the superseded with the date, and keeps both in all-time', () => {
    const old = candidate({
      chunkId: 1,
      relevance: 1,
      sourceType: 'decision',
      authority: 'decision',
      status: 'superseded',
      supersededByTitle: 'Use queues',
      supersededByAt: '2026-09-30T10:00:00.000Z',
    });
    const current = candidate({ chunkId: 2, relevance: 0.2, sourceType: 'decision', authority: 'decision', occurredAt: daysAgo(400) });
    const ranked = rankCandidates([old, current], 'current', NOW);
    expect(ranked.map((h) => h.itemId)).toEqual([2, 1]);
    expect(ranked[1]?.label).toBe('superseded by "Use queues" on 2026-09-30');
    expect(ranked[1]?.supersededBy).toEqual({ title: 'Use queues', date: '2026-09-30T10:00:00.000Z' });
    const all = rankCandidates([old, current], 'all_time', NOW);
    expect(all.map((h) => h.itemId)).toEqual([1, 2]);
    expect(all[0]?.label).toBe('superseded by "Use queues" on 2026-09-30');
  });

  it('down-ranks and labels superseded items, in both modes', () => {
    const superseded = candidate({ chunkId: 1, relevance: 1, status: 'superseded', supersededByTitle: 'New design' });
    const active = candidate({ chunkId: 2, relevance: 0.3 });
    const current = rankCandidates([superseded, active], 'current', NOW);
    expect(current.map((h) => h.itemId)).toEqual([2, 1]);
    expect(current[1]?.label).toBe('superseded by "New design"');
    expect(current[1]?.supersededBy).toEqual({ title: 'New design', date: null });
    const all = rankCandidates([superseded, active], 'all_time', NOW);
    // All-time stops penalising it (its relevance wins) but still labels it.
    expect(all.map((h) => h.itemId)).toEqual([1, 2]);
    expect(all[0]?.label).toBe('superseded by "New design"');
  });

  it('ranks legacy material last in current mode, however well it matches', () => {
    const legacy = candidate({ chunkId: 1, relevance: 1, authority: 'legacy', status: 'legacy' });
    const weak = candidate({ chunkId: 2, relevance: 0.05, authority: 'discussion', occurredAt: daysAgo(400) });
    expect(rankCandidates([legacy, weak], 'current', NOW).map((h) => h.itemId)).toEqual([2, 1]);
    expect(rankCandidates([legacy, weak], 'all_time', NOW).map((h) => h.itemId)).toEqual([1, 2]);
    expect(rankCandidates([legacy], 'current', NOW)[0]).toMatchObject({ label: 'legacy', status: 'legacy' });
  });

  it('cites each hit with its source, date, title, link and glob', () => {
    const [hit] = rankCandidates(
      [candidate({ chunkId: 1, sourceType: 'code_review', externalUrl: 'https://example.com/c/1', globIds: ['s1t4', 's1t5'] })],
      'current',
      NOW,
    );
    expect(hit?.citation).toEqual({ source: 'code_review', date: NOW, title: 'Item 1', link: 'https://example.com/c/1', globId: 's1t4' });
    expect(hit?.label).toBeNull();
  });
});

describe('filters', () => {
  const item = { occurredAt: '2026-09-10T00:00:00.000Z', globIds: ['s1t1'], globGroup: 'billing', sourceType: 'postplan' } as const;

  it('applies the date range inclusively, and the glob, group and source filters', () => {
    expect(matchesFilters(item, {})).toBe(true);
    expect(matchesFilters(item, { from: '2026-09-10T00:00:00.000Z', to: '2026-09-10T00:00:00.000Z' })).toBe(true);
    expect(matchesFilters(item, { from: '2026-09-11T00:00:00.000Z' })).toBe(false);
    expect(matchesFilters(item, { to: '2026-09-09T00:00:00.000Z' })).toBe(false);
    expect(matchesFilters(item, { globId: 's1t2' })).toBe(false);
    expect(matchesFilters(item, { group: 'billing', globId: 's1t1' })).toBe(true);
    expect(matchesFilters(item, { group: 'other' })).toBe(false);
    expect(matchesFilters(item, { sourceTypes: ['glob_plan'] })).toBe(false);
    expect(matchesFilters(item, { sourceTypes: ['postplan', 'glob_plan'] })).toBe(true);
  });
});

describe('rrfFuse', () => {
  it('fuses lists by reciprocal rank, scaled so the first of every list is 1', () => {
    const a = candidate({ chunkId: 1 });
    const b = candidate({ chunkId: 2 });
    const c = candidate({ chunkId: 3 });
    const fused = rrfFuse([[a, b], [a, c], [c]]);
    expect(fused.map((f) => f.chunkId)).toEqual([1, 3, 2]);
    expect(fused[0]?.relevance).toBeGreaterThan(fused[1]?.relevance ?? 1);
    expect(rrfFuse([[a], [a]])[0]?.relevance).toBeCloseTo(1);
    expect(rrfFuse([])).toEqual([]);
  });

  it('puts a chunk both lists agree on above one only a single list ranks first', () => {
    const shared = candidate({ chunkId: 1 });
    const keywordOnly = candidate({ chunkId: 2 });
    const fused = rrfFuse([[keywordOnly, shared], [shared]]);
    expect(fused.map((f) => f.chunkId)).toEqual([1, 2]);
  });
});

describe('withinBudget', () => {
  const hits = (n: number, chars: number) =>
    rankCandidates(
      Array.from({ length: n }, (_, i) => candidate({ chunkId: i + 1, relevance: 1 - i / 100, text: 'x'.repeat(chars), header: '' })),
      'all_time',
      NOW,
    );

  it('keeps at most 10 chunks', () => {
    expect(withinBudget(hits(25, 40))).toHaveLength(10);
  });

  it('keeps at most 8000 tokens', () => {
    // 600 tokens each: the chunk cap (10, 6000 tokens) is reached before the token cap.
    expect(withinBudget(hits(25, 2400))).toHaveLength(10);
    // 4000 tokens each: two fit 8000.
    expect(withinBudget(hits(5, 16_000))).toHaveLength(2);
    expect(withinBudget(hits(5, 16_000), 10, 7_999)).toHaveLength(1);
  });

  it('returns nothing for nothing', () => {
    expect(withinBudget([])).toEqual([]);
  });
});
