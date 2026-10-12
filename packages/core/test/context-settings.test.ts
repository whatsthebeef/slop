import { describe, expect, it } from 'vitest';
import { MAX_DECISIONS_PER_SOURCE, SOURCE_TEXT_LIMIT, VECTOR_MIN_RELEVANCE } from '../src/app/decision-pipeline.js';
import { RELATED_DECISIONS, RELATED_LIMIT } from '../src/app/search-service.js';
import { CHOICE_DISCUSSION_MIN_RETURNS, CHOICE_MIN_GLOBS, CHOICE_MIN_RETURNS, choiceInUse } from '../src/domain/choice-usage.js';
import {
  CONTEXT_SETTING_KEYS,
  CONTEXT_SETTING_SPECS,
  DEFAULT_CONTEXT_SETTINGS,
  isContextSettingKey,
  resolveContextSettings,
} from '../src/domain/context-settings.js';
import { MAX_SUGGESTIONS, parseSummary } from '../src/domain/inbox.js';
import { AUTHORITY_WEIGHTS, RECENCY_HALF_LIFE_DAYS, SUPERSEDED_FACTOR, rankCandidates, recency, scoreOf } from '../src/domain/search.js';
import type { Candidate } from '../src/domain/search.js';
import { measureSignals } from '../src/domain/signals.js';
import type { BoardActivity } from '../src/domain/signals.js';
import { MemoryStore } from '../src/testing/memory-store.js';

const NOW = '2026-10-05T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

const candidate = (patch: Partial<Candidate> & { chunkId: number }): Candidate => ({
  itemId: patch.chunkId,
  header: '[h]',
  text: 'text',
  relevance: 0.8,
  sourceType: 'decision',
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

describe('defaults', () => {
  it('are today’s numbers', () => {
    expect(DEFAULT_CONTEXT_SETTINGS).toEqual({
      discussion_weight: 0.6,
      recency_half_life_days: 90,
      replaced_factor: 0.15,
      replacement_similarity: 0.75,
      related_choices: 3,
      related_results: 5,
      choice_extraction_cap: 40,
      source_text_limit: 30_000,
      inbox_suggestions: 3,
      inbox_candidates: 8,
      promotion_min_returns: 5,
      promotion_discussion_min_returns: 10,
      promotion_min_globs: 3,
    });
  });

  it('are what the constants they replaced still say', () => {
    expect(AUTHORITY_WEIGHTS).toEqual({ merged_code: 1, decision: 0.95, approved_plan: 0.9, discussion: 0.6, legacy: 0.3 });
    expect(RECENCY_HALF_LIFE_DAYS).toBe(90);
    expect(SUPERSEDED_FACTOR).toBe(0.15);
    expect(VECTOR_MIN_RELEVANCE).toBe(0.75);
    expect(SOURCE_TEXT_LIMIT).toBe(30_000);
    expect(MAX_DECISIONS_PER_SOURCE).toBe(40);
    expect(RELATED_DECISIONS).toBe(3);
    expect(RELATED_LIMIT).toBe(5);
    expect(MAX_SUGGESTIONS).toBe(3);
    expect([CHOICE_MIN_RETURNS, CHOICE_DISCUSSION_MIN_RETURNS, CHOICE_MIN_GLOBS]).toEqual([5, 10, 3]);
  });

  it('sit inside their bounds, and a fixed setting has no room to move', () => {
    for (const key of CONTEXT_SETTING_KEYS) {
      const spec = CONTEXT_SETTING_SPECS[key];
      expect(spec.key).toBe(key);
      expect(spec.min).toBeLessThanOrEqual(spec.default);
      expect(spec.max).toBeGreaterThanOrEqual(spec.default);
      if (!spec.learned) expect([spec.min, spec.max, spec.step]).toEqual([spec.default, spec.default, 0]);
      else expect(spec.step).toBeGreaterThan(0);
    }
    expect(CONTEXT_SETTING_KEYS.filter((k) => CONTEXT_SETTING_SPECS[k].learned)).toEqual([
      'discussion_weight',
      'recency_half_life_days',
      'replacement_similarity',
      'inbox_candidates',
      'promotion_min_returns',
      'promotion_discussion_min_returns',
    ]);
  });

  it('keep the thresholds within 2x and the specified ranges', () => {
    const { inbox_candidates: c, promotion_min_returns: r, promotion_discussion_min_returns: d } = CONTEXT_SETTING_SPECS;
    for (const s of [c, r, d]) {
      expect(s.min).toBeGreaterThanOrEqual(s.default / 2);
      expect(s.max).toBeLessThanOrEqual(s.default * 2);
    }
    expect([CONTEXT_SETTING_SPECS.discussion_weight.min, CONTEXT_SETTING_SPECS.discussion_weight.max]).toEqual([0.3, 0.95]);
    expect([CONTEXT_SETTING_SPECS.recency_half_life_days.min, CONTEXT_SETTING_SPECS.recency_half_life_days.max]).toEqual([30, 365]);
    expect([CONTEXT_SETTING_SPECS.replacement_similarity.min, CONTEXT_SETTING_SPECS.replacement_similarity.max]).toEqual([0.6, 0.9]);
  });
});

describe('resolveContextSettings', () => {
  it('gives the defaults for nothing stored', () => {
    expect(resolveContextSettings({})).toEqual(DEFAULT_CONTEXT_SETTINGS);
  });

  it('takes stored values within bounds and clamps the rest', () => {
    const s = resolveContextSettings({ discussion_weight: 0.7, recency_half_life_days: 1000, replacement_similarity: 0.1, inbox_candidates: 2, promotion_min_returns: 4.6 });
    expect(s).toMatchObject({ discussion_weight: 0.7, recency_half_life_days: 365, replacement_similarity: 0.6, inbox_candidates: 4, promotion_min_returns: 5 });
  });

  it('ignores unknown keys and non-numbers, and holds fixed settings at their value', () => {
    const s = resolveContextSettings({ nonsense: 7, discussion_weight: Number.NaN, source_text_limit: 5, related_results: 50, replaced_factor: 0.9 });
    expect(s).toEqual(DEFAULT_CONTEXT_SETTINGS);
    expect('nonsense' in s).toBe(false);
  });

  it('knows its keys', () => {
    expect(isContextSettingKey('discussion_weight')).toBe(true);
    expect(isContextSettingKey('nonsense')).toBe(false);
  });
});

describe('scoring with settings', () => {
  it('is unchanged without settings', () => {
    const c = candidate({ chunkId: 1, authority: 'discussion', occurredAt: daysAgo(90) });
    expect(scoreOf(c, 'current', NOW)).toBeCloseTo(0.8 * 0.6 * 0.5);
    expect(scoreOf(c, 'current', NOW)).toBe(scoreOf(c, 'current', NOW, DEFAULT_CONTEXT_SETTINGS));
  });

  it('moves only the discussion tier with the discussion weight', () => {
    const s = resolveContextSettings({ discussion_weight: 0.9 });
    expect(scoreOf(candidate({ chunkId: 1, authority: 'discussion' }), 'all_time', NOW, s)).toBeCloseTo(0.8 * 0.9);
    expect(scoreOf(candidate({ chunkId: 2, authority: 'approved_plan' }), 'all_time', NOW, s)).toBeCloseTo(0.8 * 0.9);
    expect(scoreOf(candidate({ chunkId: 3, authority: 'decision' }), 'all_time', NOW, s)).toBeCloseTo(0.8 * 0.95);
    expect(scoreOf(candidate({ chunkId: 4, authority: 'legacy' }), 'all_time', NOW, s)).toBeCloseTo(0.8 * 0.3);
  });

  it('can rank discussion above a plan when its weight rises past it', () => {
    const talk = candidate({ chunkId: 1, authority: 'discussion' });
    const plan = candidate({ chunkId: 2, authority: 'approved_plan', relevance: 0.7 });
    expect(rankCandidates([talk, plan], 'current', NOW).map((h) => h.itemId)).toEqual([2, 1]);
    const s = resolveContextSettings({ discussion_weight: 0.95 });
    expect(rankCandidates([talk, plan], 'current', NOW, s).map((h) => h.itemId)).toEqual([1, 2]);
  });

  it('fades faster or slower with the half-life', () => {
    expect(recency(daysAgo(90), NOW)).toBeCloseTo(0.5);
    expect(recency(daysAgo(90), NOW, 30)).toBeCloseTo(0.125);
    const old = candidate({ chunkId: 1, occurredAt: daysAgo(90) });
    const slow = resolveContextSettings({ recency_half_life_days: 365 });
    expect(scoreOf(old, 'current', NOW, slow)).toBeGreaterThan(scoreOf(old, 'current', NOW));
    expect(scoreOf(old, 'all_time', NOW, slow)).toBe(scoreOf(old, 'all_time', NOW));
  });
});

describe('promotion thresholds with settings', () => {
  const choice = { sourceKind: 'plan', current: true, covered: false, returns: 4, globIds: ['a', 'b', 'c'] } as const;

  it('use today’s numbers without settings', () => {
    expect(choiceInUse({ ...choice, returns: 5 })).toBe(true);
    expect(choiceInUse(choice)).toBe(false);
  });

  it('follow the board’s returns', () => {
    expect(choiceInUse(choice, resolveContextSettings({ promotion_min_returns: 4 }))).toBe(true);
    expect(choiceInUse({ ...choice, sourceKind: 'inbox', returns: 12 }, resolveContextSettings({ promotion_discussion_min_returns: 15 }))).toBe(false);
    expect(choiceInUse({ ...choice, sourceKind: 'inbox', returns: 12 })).toBe(true);
  });

  it('drive the mined signal through the activity’s settings', () => {
    const activity = (settings?: BoardActivity['settings']): BoardActivity => ({
      window: { from: '2026-09-09T12:00:00.000Z', to: NOW },
      globs: [],
      events: [],
      artifacts: [],
      findings: [],
      reviewFeedback: [],
      manifestChanges: null,
      documents: [],
      learnings: [],
      choices: [{ id: 1, globId: null, statement: 'Use backoff', quote: 'we use backoff', sourceKind: 'plan', sourceLabel: 'plan', current: true, covered: false, returns: 4, globIds: ['a', 'b', 'c'] }],
      ...(settings !== undefined && { settings }),
    });
    const crossed = (a: BoardActivity) => measureSignals(a).find((m) => m.key === 'choice_in_use:1')?.crosses;
    expect(crossed(activity())).toBe(false);
    expect(crossed(activity(resolveContextSettings({ promotion_min_returns: 4 })))).toBe(true);
    expect(crossed(activity(resolveContextSettings({ promotion_min_returns: 10 })))).toBe(false);
  });
});

describe('inbox summary with settings', () => {
  const answer = JSON.stringify({
    title: 't',
    kind: 'meeting',
    summary: 's',
    suggestions: ['g1', 'g2', 'g3', 'g4'].map((globId) => ({ globId, reason: 'r' })),
  });
  const candidates = new Set(['g1', 'g2', 'g3', 'g4']);

  it('keeps three suggestions by default and as many as the board allows', () => {
    expect(parseSummary(answer, candidates)?.suggestions).toHaveLength(3);
    expect(parseSummary(answer, candidates, 2)?.suggestions).toHaveLength(2);
    expect(parseSummary(answer, candidates, 4)?.suggestions).toHaveLength(4);
  });
});

describe('the store port in memory', () => {
  it('keeps settings per board, resets them and records changes newest first', async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      await tx.setContextSetting(1, 'discussion_weight', 0.7, NOW);
      await tx.setContextSetting(1, 'recency_half_life_days', 999, NOW);
    });
    const one = await store.transaction((tx) => tx.getContextSettings(1));
    expect(one).toMatchObject({ discussion_weight: 0.7, recency_half_life_days: 365 });
    expect(await store.transaction((tx) => tx.getContextSettings(2))).toEqual(DEFAULT_CONTEXT_SETTINGS);
    await store.transaction((tx) => tx.resetContextSetting(1, 'discussion_weight'));
    expect((await store.transaction((tx) => tx.getContextSettings(1))).discussion_weight).toBe(0.6);

    const base = { boardId: 1, key: 'discussion_weight', before: 0.6, after: 0.65, outcome: 'tuned', evidence: 'e' } as const;
    await store.transaction((tx) => tx.insertContextSettingChange({ ...base, at: daysAgo(3) }));
    await store.transaction((tx) => tx.insertContextSettingChange({ ...base, at: daysAgo(1), evidence: 'later' }));
    await store.transaction((tx) => tx.insertContextSettingChange({ ...base, boardId: 2, at: daysAgo(0) }));
    expect((await store.transaction((tx) => tx.listContextSettingChanges(1))).map((c) => c.evidence)).toEqual(['later', 'e']);
  });
});
