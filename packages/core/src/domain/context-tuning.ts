import { CONTEXT_SETTING_SPECS, clampContextSetting } from './context-settings.js';
import type { ContextSettingKey, ContextSettings } from './context-settings.js';
import type { DecisionSourceKind, ReplaceState } from './decisions.js';

/**
 * The weekly context tuning (spec, Context tuning): plain rules over counts, no model calls. Each rule reads what
 * people did with what the settings produced (replaced or dismissed choices, decided learnings and replacement cards,
 * what agents cited, what people attached) and moves one setting one step, within its bounds. A rule needs a minimum
 * sample, never moves a setting that changed in the last 7 days, and counts only what happened after the setting's last
 * change, so the same evidence can't push it step after step. Where a fact isn't stored the sample is short and nothing moves.
 */

/** A setting moves at most once in this long. */
export const TUNING_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** discussion_weight: choices of each group needed to compare how often they are replaced or dismissed. */
export const MIN_CHOICES_PER_GROUP = 10;
/** Discussion choices counting this many times as often as record and plan choices lowers the weight. */
export const DISCUSSION_REPLACED_RATIO = 2;
/** discussion_weight up: the acceptance rates are comparable when they differ by at most this share of the larger. */
export const COMPARABLE_RELATIVE = 0.2;
/** Decided promotions or replacement cards (per group) needed before a rate counts. */
export const MIN_DECIDED = 5;
/** Raised or lengthened when more than this share of decided ones were turned down (or, for cards, undone). */
export const MOSTLY_SHARE = 0.6;
/** Lowered when more than this share of decided promotions were accepted. */
export const ALMOST_ALL_SHARE = 0.9;
/** recency_half_life_days: retrievals of choices older than the half-life needed. */
export const MIN_OLD_RETRIEVALS = 10;
/** Old choices cited in at least this share of their retrievals make the half-life longer… */
export const CITED_LONG_SHARE = 0.4;
/** …and cited in at most this share, shorter. */
export const CITED_SHORT_SHARE = 0.1;

export interface ChoiceFact {
  readonly sourceKind: DecisionSourceKind;
  readonly replaceState: ReplaceState | null;
  readonly createdAt: string;
}

/** A learning raised from a choice in use that a person decided (accepted, or rejected). */
export interface PromotionFact {
  /** The choice came from pasted discussion (it needed `promotion_discussion_min_returns`). */
  readonly discussion: boolean;
  /** Whether the choice came from a plan (rather than a record), for the discussion comparison. */
  readonly fromPlan: boolean;
  readonly accepted: boolean;
  readonly at: string;
}

/** A replacement card a person confirmed (accepted) or dismissed. */
export interface CardFact {
  readonly accepted: boolean;
  readonly at: string;
}

/** An agent was handed a choice on a glob; `cited` when the glob's implementation record names it (id or title). */
export interface RetrievalFact {
  /** The choice's age on the day it was handed over. */
  readonly ageDays: number;
  readonly cited: boolean;
  readonly count: number;
  readonly day: string;
}

/** A person attached an inbox item to a glob; `suggested` when the item's suggestions named that glob. */
export interface AttachFact {
  readonly suggested: boolean;
  readonly at: string;
}

export interface TuningFacts {
  readonly now: string;
  readonly settings: ContextSettings;
  /** When each setting last changed (a move or a reset); absent when never. */
  readonly lastChangeAt: Readonly<Partial<Record<ContextSettingKey, string>>>;
  readonly choices: readonly ChoiceFact[];
  readonly promotions: readonly PromotionFact[];
  readonly cards: readonly CardFact[];
  readonly retrievals: readonly RetrievalFact[];
  readonly attaches: readonly AttachFact[];
}

export type TuningProposal =
  | { readonly kind: 'move'; readonly key: ContextSettingKey; readonly before: number; readonly after: number; readonly outcome: string; readonly evidence: string }
  | { readonly kind: 'hold'; readonly key: ContextSettingKey; readonly reason: string };

const hold = (key: ContextSettingKey, reason: string): TuningProposal => ({ kind: 'hold', key, reason });

const percent = (share: number): string => `${String(Math.round(share * 100))}%`;

/** One step from `before`, within bounds; floating steps are rounded so 0.6 + 0.05 stays 0.65. */
export const stepped = (key: ContextSettingKey, before: number, direction: 1 | -1): number => {
  const spec = CONTEXT_SETTING_SPECS[key];
  return clampContextSetting(key, Math.round((before + direction * spec.step) * 1000) / 1000);
};

/** Facts after `since` (all when never changed). */
const after = <T>(rows: readonly T[], at: (row: T) => string, since: string | undefined): T[] =>
  since === undefined ? [...rows] : rows.filter((row) => at(row) > since);

/** The move one step in `direction`, or why it can't happen now (a setting that doesn't learn, changed this week, or at its bound). */
const move = (
  facts: TuningFacts,
  key: ContextSettingKey,
  direction: 1 | -1,
  outcome: string,
  evidence: string,
): TuningProposal => {
  const spec = CONTEXT_SETTING_SPECS[key];
  if (!spec.learned) return hold(key, 'this setting is fixed');
  const last = facts.lastChangeAt[key];
  if (last !== undefined && Date.parse(facts.now) - Date.parse(last) < TUNING_MIN_INTERVAL_MS) return hold(key, `it changed on ${last.slice(0, 10)}, less than 7 days ago`);
  const before = facts.settings[key];
  const to = stepped(key, before, direction);
  if (to === before) return hold(key, `already at its ${direction === 1 ? 'maximum' : 'minimum'} ${String(before)}`);
  return { kind: 'move', key, before, after: to, outcome, evidence };
};

const rate = (count: number, of: number): number => (of === 0 ? 0 : count / of);

const discussionWeight = (facts: TuningFacts): TuningProposal => {
  const key = 'discussion_weight';
  const since = facts.lastChangeAt[key];
  const choices = after(facts.choices, (c) => c.createdAt, since);
  const gone = (c: ChoiceFact): boolean => c.replaceState === 'applied' || c.replaceState === 'confirmed' || c.replaceState === 'undone';
  const discussion = choices.filter((c) => c.sourceKind === 'inbox');
  const records = choices.filter((c) => c.sourceKind !== 'inbox' && c.sourceKind !== 'kb_item');
  const promotions = after(facts.promotions, (p) => p.at, since);
  const fromDiscussion = promotions.filter((p) => p.discussion);
  const fromPlans = promotions.filter((p) => p.fromPlan);

  if (discussion.length >= MIN_CHOICES_PER_GROUP && records.length >= MIN_CHOICES_PER_GROUP) {
    const d = rate(discussion.filter(gone).length, discussion.length);
    const r = rate(records.filter(gone).length, records.length);
    if (d > DISCUSSION_REPLACED_RATIO * r) {
      return move(
        facts,
        key,
        -1,
        'discussion_replaced_often',
        `${percent(d)} of ${String(discussion.length)} discussion choices were later replaced or dismissed, against ${percent(r)} of ${String(records.length)} record and plan choices`,
      );
    }
  }
  if (fromDiscussion.length >= MIN_DECIDED && fromPlans.length >= MIN_DECIDED) {
    const d = rate(fromDiscussion.filter((p) => p.accepted).length, fromDiscussion.length);
    const p = rate(fromPlans.filter((x) => x.accepted).length, fromPlans.length);
    if (Math.abs(d - p) <= COMPARABLE_RELATIVE * Math.max(d, p)) {
      return move(
        facts,
        key,
        1,
        'discussion_accepted_like_plans',
        `${percent(d)} of ${String(fromDiscussion.length)} promoted discussion choices were accepted, against ${percent(p)} of ${String(fromPlans.length)} promoted plan choices`,
      );
    }
  }
  return hold(
    key,
    discussion.length < MIN_CHOICES_PER_GROUP || records.length < MIN_CHOICES_PER_GROUP
      ? `insufficient sample: ${String(discussion.length)} discussion and ${String(records.length)} record or plan choices, ${String(MIN_CHOICES_PER_GROUP)} each needed`
      : 'no clear difference between discussion and plan choices',
  );
};

/** Promotion thresholds: a step up when most promoted learnings of the group were rejected, down when nearly all were accepted. */
const promotionThreshold = (facts: TuningFacts, key: 'promotion_min_returns' | 'promotion_discussion_min_returns'): TuningProposal => {
  const wantDiscussion = key === 'promotion_discussion_min_returns';
  const decided = after(facts.promotions, (p) => p.at, facts.lastChangeAt[key]).filter((p) => p.discussion === wantDiscussion);
  if (decided.length < MIN_DECIDED) return hold(key, `insufficient sample: ${String(decided.length)} decided promoted learnings, ${String(MIN_DECIDED)} needed`);
  const accepted = decided.filter((p) => p.accepted).length;
  const acceptedShare = accepted / decided.length;
  const evidence = `${String(accepted)} of ${String(decided.length)} promoted ${wantDiscussion ? 'discussion ' : ''}learnings accepted (${percent(acceptedShare)})`;
  if (1 - acceptedShare > MOSTLY_SHARE) return move(facts, key, 1, 'promotions_rejected', evidence);
  if (acceptedShare > ALMOST_ALL_SHARE) return move(facts, key, -1, 'promotions_accepted', evidence);
  return hold(key, `${evidence}: neither mostly rejected nor nearly all accepted`);
};

const replacementSimilarity = (facts: TuningFacts): TuningProposal => {
  const key = 'replacement_similarity';
  const decided = after(facts.cards, (c) => c.at, facts.lastChangeAt[key]);
  if (decided.length < MIN_DECIDED) return hold(key, `insufficient sample: ${String(decided.length)} decided replacement cards, ${String(MIN_DECIDED)} needed`);
  const confirmed = decided.filter((c) => c.accepted).length;
  const share = confirmed / decided.length;
  const evidence = `${String(confirmed)} of ${String(decided.length)} proposed replacements confirmed (${percent(share)})`;
  // Confirmed proposals mean the net is too tight: check more pairs. Dismissed ones mean it is too loose.
  if (share > MOSTLY_SHARE) return move(facts, key, -1, 'replacements_confirmed', evidence);
  if (1 - share > MOSTLY_SHARE) return move(facts, key, 1, 'replacements_dismissed', evidence);
  return hold(key, `${evidence}: no clear majority`);
};

const recencyHalfLife = (facts: TuningFacts): TuningProposal => {
  const key = 'recency_half_life_days';
  const half = facts.settings[key];
  const old = after(facts.retrievals, (r) => r.day, facts.lastChangeAt[key]).filter((r) => r.ageDays > half);
  const total = old.reduce((n, r) => n + r.count, 0);
  if (total < MIN_OLD_RETRIEVALS) {
    return hold(key, `insufficient sample: ${String(total)} retrievals of choices older than ${String(half)} days, ${String(MIN_OLD_RETRIEVALS)} needed (choices only; other items' retrievals aren't recorded)`);
  }
  const cited = old.filter((r) => r.cited).reduce((n, r) => n + r.count, 0);
  const share = cited / total;
  const evidence = `${String(cited)} of ${String(total)} retrievals of choices older than ${String(half)} days were cited in the implementation record (${percent(share)})`;
  if (share >= CITED_LONG_SHARE) return move(facts, key, 1, 'old_choices_cited', evidence);
  if (share <= CITED_SHORT_SHARE) return move(facts, key, -1, 'old_choices_not_cited', evidence);
  return hold(key, `${evidence}: neither often nor never`);
};

const inboxCandidates = (facts: TuningFacts): TuningProposal => {
  const key = 'inbox_candidates';
  const attaches = after(facts.attaches, (a) => a.at, facts.lastChangeAt[key]);
  if (attaches.length < MIN_DECIDED) return hold(key, `insufficient sample: ${String(attaches.length)} attachments to suggested items, ${String(MIN_DECIDED)} needed`);
  const missed = attaches.filter((a) => !a.suggested).length;
  const share = missed / attaches.length;
  const evidence = `${String(missed)} of ${String(attaches.length)} attachments were to globs the inbox did not suggest (${percent(share)})`;
  if (share > MOSTLY_SHARE) return move(facts, key, 1, 'attached_to_unsuggested', evidence);
  return hold(key, `${evidence}: suggestions mostly matched`);
};

/** Every learned setting's proposal for this week, in a fixed order. */
export const tuneContext = (facts: TuningFacts): TuningProposal[] => [
  discussionWeight(facts),
  promotionThreshold(facts, 'promotion_min_returns'),
  promotionThreshold(facts, 'promotion_discussion_min_returns'),
  replacementSimilarity(facts),
  recencyHalfLife(facts),
  inboxCandidates(facts),
];

/** Whether `text` names the choice by its id (`choice 12`, `decision #12`) or by its statement's first line. */
export const namesChoice = (text: string, choice: { readonly id: number; readonly statement: string }): boolean => {
  const lower = text.toLowerCase();
  if (new RegExp(`\\b(?:choice|decision)\\s*#?${String(choice.id)}\\b`).test(lower)) return true;
  const title = (choice.statement.split('\n').find((l) => l.trim() !== '') ?? '').trim().toLowerCase();
  return title.length >= 12 && lower.includes(title);
};
