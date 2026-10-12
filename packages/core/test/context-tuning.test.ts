import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_SETTINGS, CONTEXT_SETTING_KEYS } from '../src/domain/context-settings.js';
import type { ContextSettingKey } from '../src/domain/context-settings.js';
import { namesChoice, stepped, tuneContext, TUNING_MIN_INTERVAL_MS } from '../src/domain/context-tuning.js';
import type { AttachFact, CardFact, ChoiceFact, PromotionFact, RetrievalFact, TuningFacts, TuningProposal } from '../src/domain/context-tuning.js';

const NOW = '2026-10-12T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString();

const facts = (patch: Partial<TuningFacts> = {}): TuningFacts => ({
  now: NOW,
  settings: DEFAULT_CONTEXT_SETTINGS,
  lastChangeAt: {},
  choices: [],
  promotions: [],
  cards: [],
  retrievals: [],
  attaches: [],
  ...patch,
});

const proposal = (all: readonly TuningProposal[], key: ContextSettingKey): TuningProposal => {
  const found = all.find((p) => p.key === key);
  if (found === undefined) throw new Error(`no proposal for ${key}`);
  return found;
};
/** A hold whose reason mentions `text`. */
const holdsWith = (p: TuningProposal, text: string): void => {
  expect(p.kind).toBe('hold');
  expect(p.kind === 'hold' ? p.reason : '').toContain(text);
};
const run = (patch: Partial<TuningFacts>, key: ContextSettingKey): TuningProposal => proposal(tuneContext(facts(patch)), key);

const choices = (kind: ChoiceFact['sourceKind'], total: number, gone: number, createdAt = daysAgo(10)): ChoiceFact[] =>
  Array.from({ length: total }, (_, i) => ({ sourceKind: kind, replaceState: i < gone ? 'confirmed' : null, createdAt }));
const promotions = (patch: Partial<PromotionFact>, accepted: number, rejected: number): PromotionFact[] => [
  ...Array.from({ length: accepted }, () => ({ discussion: false, fromPlan: false, accepted: true, at: daysAgo(2), ...patch })),
  ...Array.from({ length: rejected }, () => ({ discussion: false, fromPlan: false, accepted: false, at: daysAgo(2), ...patch })),
];
const cards = (confirmed: number, dismissed: number, at = daysAgo(2)): CardFact[] => [
  ...Array.from({ length: confirmed }, () => ({ accepted: true, at })),
  ...Array.from({ length: dismissed }, () => ({ accepted: false, at })),
];
const retrievals = (cited: number, uncited: number, ageDays = 200): RetrievalFact[] => [
  ...(cited > 0 ? [{ ageDays, cited: true, count: cited, day: daysAgo(3).slice(0, 10) }] : []),
  ...(uncited > 0 ? [{ ageDays, cited: false, count: uncited, day: daysAgo(3).slice(0, 10) }] : []),
];
const attaches = (missed: number, matched: number, at = daysAgo(2)): AttachFact[] => [
  ...Array.from({ length: missed }, () => ({ suggested: false, at })),
  ...Array.from({ length: matched }, () => ({ suggested: true, at })),
];

describe('tuneContext', () => {
  it('holds every learned setting without facts, and gives one proposal per learned setting', () => {
    const all = tuneContext(facts());
    expect(all.map((p) => p.key).sort()).toEqual(
      [...CONTEXT_SETTING_KEYS].filter((k) => ['discussion_weight', 'promotion_min_returns', 'promotion_discussion_min_returns', 'replacement_similarity', 'recency_half_life_days', 'inbox_candidates'].includes(k)).sort(),
    );
    expect(all.every((p) => p.kind === 'hold')).toBe(true);
  });

  describe('discussion_weight', () => {
    it('steps down when discussion choices are replaced or dismissed over twice as often, with 10 of each', () => {
      const p = run({ choices: [...choices('inbox', 10, 6), ...choices('implementation_plan', 10, 2)] }, 'discussion_weight');
      expect(p).toMatchObject({ kind: 'move', before: 0.6, after: 0.55, outcome: 'discussion_replaced_often' });
    });

    it('counts a dismissed (undone) replacement like a replaced one', () => {
      const discussion = choices('inbox', 10, 0).map((c, i) => (i < 4 ? { ...c, replaceState: 'undone' as const } : c));
      const p = run({ choices: [...discussion, ...choices('plan', 10, 1)] }, 'discussion_weight');
      expect(p).toMatchObject({ kind: 'move', after: 0.55 });
    });

    it('needs more than twice the rate: exactly twice holds', () => {
      const p = run({ choices: [...choices('inbox', 10, 4), ...choices('plan', 10, 2)] }, 'discussion_weight');
      expect(p.kind).toBe('hold');
    });

    it('holds below 10 choices in either group', () => {
      holdsWith(run({ choices: [...choices('inbox', 9, 9), ...choices('plan', 10, 0)] }, 'discussion_weight'), 'insufficient sample');
      expect(run({ choices: [...choices('inbox', 10, 9), ...choices('plan', 9, 0)] }, 'discussion_weight').kind).toBe('hold');
    });

    it('ignores choices from accepted learnings (kb_item) in the comparison group', () => {
      expect(run({ choices: [...choices('inbox', 10, 8), ...choices('kb_item', 10, 0)] }, 'discussion_weight').kind).toBe('hold');
    });

    it('steps up when promoted discussion choices are accepted about as often as plan choices, with 5 of each', () => {
      const p = run(
        { promotions: [...promotions({ discussion: true }, 4, 1), ...promotions({ fromPlan: true }, 9, 1)] },
        'discussion_weight',
      );
      // 80% against 90%: a difference of 10 points, within 20% of the larger.
      expect(p).toMatchObject({ kind: 'move', before: 0.6, after: 0.65, outcome: 'discussion_accepted_like_plans' });
    });

    it('holds when the acceptance rates differ by more than 20% of the larger, or the sample is under 5', () => {
      expect(run({ promotions: [...promotions({ discussion: true }, 3, 2), ...promotions({ fromPlan: true }, 5, 0)] }, 'discussion_weight').kind).toBe('hold');
      expect(run({ promotions: [...promotions({ discussion: true }, 4, 0), ...promotions({ fromPlan: true }, 5, 0)] }, 'discussion_weight').kind).toBe('hold');
    });

    it('prefers lowering when both rules fire', () => {
      const p = run(
        {
          choices: [...choices('inbox', 10, 8), ...choices('plan', 10, 1)],
          promotions: [...promotions({ discussion: true }, 5, 0), ...promotions({ fromPlan: true }, 5, 0)],
        },
        'discussion_weight',
      );
      expect(p).toMatchObject({ kind: 'move', after: 0.55 });
    });

    it('is clamped at its bounds', () => {
      const down = run({ settings: { ...DEFAULT_CONTEXT_SETTINGS, discussion_weight: 0.3 }, choices: [...choices('inbox', 10, 10), ...choices('plan', 10, 0)] }, 'discussion_weight');
      holdsWith(down, 'minimum');
      const up = run({ settings: { ...DEFAULT_CONTEXT_SETTINGS, discussion_weight: 0.95 }, promotions: [...promotions({ discussion: true }, 5, 0), ...promotions({ fromPlan: true }, 5, 0)] }, 'discussion_weight');
      holdsWith(up, 'maximum');
    });

    it('does not accumulate floating point noise', () => {
      expect(stepped('discussion_weight', 0.65, 1)).toBe(0.7);
      expect(stepped('discussion_weight', 0.35, -1)).toBe(0.3);
    });
  });

  describe('promotion thresholds', () => {
    const keys = [
      ['promotion_min_returns', false, 5],
      ['promotion_discussion_min_returns', true, 10],
    ] as const;

    for (const [key, discussion, start] of keys) {
      it(`${key}: raises a step when over 60% of 5 or more decided were rejected`, () => {
        const p = run({ promotions: promotions({ discussion }, 3, 5) }, key);
        expect(p).toMatchObject({ kind: 'move', before: start, after: start + 1, outcome: 'promotions_rejected' });
      });

      it(`${key}: holds at exactly 60% rejected, or under 5 decided`, () => {
        expect(run({ promotions: promotions({ discussion }, 4, 6) }, key).kind).toBe('hold');
        holdsWith(run({ promotions: promotions({ discussion }, 0, 4) }, key), 'insufficient sample');
      });

      it(`${key}: lowers a step when over 90% of 5 or more were accepted`, () => {
        const p = run({ promotions: promotions({ discussion }, 10, 0) }, key);
        expect(p).toMatchObject({ kind: 'move', before: start, after: start - 1, outcome: 'promotions_accepted' });
        // 9 of 10 is exactly 90%: not over.
        expect(run({ promotions: promotions({ discussion }, 9, 1) }, key).kind).toBe('hold');
      });
    }

    it('reads each threshold from its own group of choices', () => {
      const all = tuneContext(facts({ promotions: promotions({ discussion: true }, 0, 6) }));
      expect(proposal(all, 'promotion_discussion_min_returns').kind).toBe('move');
      expect(proposal(all, 'promotion_min_returns').kind).toBe('hold');
    });

    it('stops at its bounds', () => {
      const top = run({ settings: { ...DEFAULT_CONTEXT_SETTINGS, promotion_min_returns: 10 }, promotions: promotions({}, 0, 6) }, 'promotion_min_returns');
      holdsWith(top, 'maximum');
      const bottom = run({ settings: { ...DEFAULT_CONTEXT_SETTINGS, promotion_min_returns: 3 }, promotions: promotions({}, 6, 0) }, 'promotion_min_returns');
      holdsWith(bottom, 'minimum');
    });
  });

  describe('replacement_similarity', () => {
    it('lowers a step (0.025) when over 60% of 5 or more cards were confirmed', () => {
      expect(run({ cards: cards(4, 1) }, 'replacement_similarity')).toMatchObject({ kind: 'move', before: 0.75, after: 0.725, outcome: 'replacements_confirmed' });
    });

    it('raises a step when over 60% were dismissed', () => {
      expect(run({ cards: cards(1, 4) }, 'replacement_similarity')).toMatchObject({ kind: 'move', after: 0.775, outcome: 'replacements_dismissed' });
    });

    it('holds at 60%, with a short sample, and with no majority', () => {
      expect(run({ cards: cards(6, 4) }, 'replacement_similarity').kind).toBe('hold');
      holdsWith(run({ cards: cards(4, 0) }, 'replacement_similarity'), 'insufficient sample');
      expect(run({ cards: cards(5, 5) }, 'replacement_similarity').kind).toBe('hold');
    });

    it('stops at its bounds', () => {
      expect(run({ settings: { ...DEFAULT_CONTEXT_SETTINGS, replacement_similarity: 0.6 }, cards: cards(5, 0) }, 'replacement_similarity').kind).toBe('hold');
      expect(run({ settings: { ...DEFAULT_CONTEXT_SETTINGS, replacement_similarity: 0.9 }, cards: cards(0, 5) }, 'replacement_similarity').kind).toBe('hold');
    });
  });

  describe('recency_half_life_days', () => {
    it('lengthens by 15 days when old choices were cited in at least 40% of 10 or more retrievals', () => {
      expect(run({ retrievals: retrievals(4, 6) }, 'recency_half_life_days')).toMatchObject({ kind: 'move', before: 90, after: 105, outcome: 'old_choices_cited' });
    });

    it('shortens by 15 days when they were cited in at most 10%', () => {
      expect(run({ retrievals: retrievals(1, 9) }, 'recency_half_life_days')).toMatchObject({ kind: 'move', after: 75, outcome: 'old_choices_not_cited' });
      expect(run({ retrievals: retrievals(0, 12) }, 'recency_half_life_days')).toMatchObject({ kind: 'move', after: 75 });
    });

    it('holds in between, and under 10 retrievals', () => {
      expect(run({ retrievals: retrievals(2, 8) }, 'recency_half_life_days').kind).toBe('hold');
      holdsWith(run({ retrievals: retrievals(9, 0) }, 'recency_half_life_days'), 'insufficient sample');
    });

    it('counts only retrievals of choices older than the half-life', () => {
      expect(run({ retrievals: retrievals(0, 20, 90) }, 'recency_half_life_days').kind).toBe('hold');
      expect(run({ retrievals: retrievals(0, 20, 91) }, 'recency_half_life_days').kind).toBe('move');
    });

    it('stops at its bounds', () => {
      expect(run({ settings: { ...DEFAULT_CONTEXT_SETTINGS, recency_half_life_days: 365 }, retrievals: retrievals(10, 0) }, 'recency_half_life_days').kind).toBe('hold');
      expect(run({ settings: { ...DEFAULT_CONTEXT_SETTINGS, recency_half_life_days: 30 }, retrievals: retrievals(0, 10, 100) }, 'recency_half_life_days').kind).toBe('hold');
    });
  });

  describe('inbox_candidates', () => {
    it('adds one candidate when over 60% of 5 or more attaches were to globs not suggested', () => {
      expect(run({ attaches: attaches(4, 1) }, 'inbox_candidates')).toMatchObject({ kind: 'move', before: 8, after: 9, outcome: 'attached_to_unsuggested' });
    });

    it('holds at 60%, with a short sample, and at its maximum', () => {
      expect(run({ attaches: attaches(6, 4) }, 'inbox_candidates').kind).toBe('hold');
      holdsWith(run({ attaches: attaches(4, 0) }, 'inbox_candidates'), 'insufficient sample');
      expect(run({ settings: { ...DEFAULT_CONTEXT_SETTINGS, inbox_candidates: 16 }, attaches: attaches(5, 0) }, 'inbox_candidates').kind).toBe('hold');
    });
  });

  describe('timing', () => {
    it('never moves a setting that changed less than 7 days ago, and may after 7', () => {
      const input = { cards: cards(5, 0) };
      const recent = run({ ...input, lastChangeAt: { replacement_similarity: new Date(Date.parse(NOW) - TUNING_MIN_INTERVAL_MS + 1000).toISOString() } }, 'replacement_similarity');
      holdsWith(recent, 'less than 7 days');
      // The cards are decided 2 days ago, so they must also postdate the change: change 8 days ago.
      const later = run({ ...input, lastChangeAt: { replacement_similarity: daysAgo(8) } }, 'replacement_similarity');
      expect(later.kind).toBe('move');
    });

    it('counts only what happened after the setting last changed', () => {
      // Enough evidence, but all of it decided before the last change (8 days ago).
      const old = run({ cards: cards(5, 0, daysAgo(9)), lastChangeAt: { replacement_similarity: daysAgo(8) } }, 'replacement_similarity');
      holdsWith(old, 'insufficient sample');
      const attached = run({ attaches: attaches(5, 0, daysAgo(9)), lastChangeAt: { inbox_candidates: daysAgo(8) } }, 'inbox_candidates');
      expect(attached.kind).toBe('hold');
    });

    it('moves each setting independently of the others\' changes', () => {
      const p = run({ cards: cards(5, 0), lastChangeAt: { discussion_weight: daysAgo(1) } }, 'replacement_similarity');
      expect(p.kind).toBe('move');
    });
  });
});

describe('namesChoice', () => {
  const choice = { id: 12, statement: 'Use the shared retry helper for every outbound call\nBecause of rate limits' };
  it('finds an id or the first line of the statement', () => {
    expect(namesChoice('Followed choice 12 here', choice)).toBe(true);
    expect(namesChoice('See decision #12.', choice)).toBe(true);
    expect(namesChoice('we USE THE SHARED RETRY HELPER for every outbound call', choice)).toBe(true);
  });
  it('does not match another id or a bare number', () => {
    expect(namesChoice('choice 123 and 12 files', choice)).toBe(false);
    expect(namesChoice('nothing relevant', choice)).toBe(false);
  });
  it('ignores a statement too short to be a title match', () => {
    expect(namesChoice('Use it', { id: 3, statement: 'Use it' })).toBe(false);
  });
});
