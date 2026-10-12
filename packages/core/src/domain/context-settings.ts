/**
 * Per-board context settings (spec, Context tuning): the numbers that decide what search, choices and the inbox hand
 * to agents. Each has today's default and hard bounds; a board's stored value is clamped to them on every read. The
 * default is the single source of truth: the constants elsewhere (`RECENCY_HALF_LIFE_DAYS`, `MAX_SUGGESTIONS`, ...)
 * are read from here so no number is written twice.
 */

export const CONTEXT_SETTING_KEYS = [
  'discussion_weight',
  'recency_half_life_days',
  'replaced_factor',
  'replacement_similarity',
  'related_choices',
  'related_results',
  'choice_extraction_cap',
  'source_text_limit',
  'inbox_suggestions',
  'inbox_candidates',
  'promotion_min_returns',
  'promotion_discussion_min_returns',
  'promotion_min_globs',
] as const;
export type ContextSettingKey = (typeof CONTEXT_SETTING_KEYS)[number];

export const isContextSettingKey = (value: string): value is ContextSettingKey => CONTEXT_SETTING_KEYS.some((k) => k === value);

export interface ContextSettingSpec {
  readonly key: ContextSettingKey;
  readonly label: string;
  /** `weight`, `days`, `similarity`, `count`, `characters`: what the number measures. */
  readonly unit: string;
  /** What moving it changes, in a sentence for an admin. */
  readonly effect: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** The size of one learned move; 0 for a setting that doesn't move. */
  readonly step: number;
  /** Whether the weekly tuning may move it. A fixed setting has `min === max === default`. */
  readonly learned: boolean;
}

export const CONTEXT_SETTING_SPECS: Readonly<Record<ContextSettingKey, ContextSettingSpec>> = {
  discussion_weight: {
    key: 'discussion_weight',
    label: 'Discussion weight',
    unit: 'weight',
    effect: 'How much a choice or note from pasted discussion counts against records and plans when results are ranked.',
    default: 0.6,
    min: 0.3,
    max: 0.95,
    step: 0.05,
    learned: true,
  },
  recency_half_life_days: {
    key: 'recency_half_life_days',
    label: 'Recency half-life',
    unit: 'days',
    effect: 'How fast older material fades in current-mode results: its score halves every this many days.',
    default: 90,
    min: 30,
    max: 365,
    step: 15,
    learned: true,
  },
  replaced_factor: {
    key: 'replaced_factor',
    label: 'Replaced choice factor',
    unit: 'factor',
    effect: 'How far a replaced choice is ranked down in current-mode results.',
    default: 0.15,
    min: 0.15,
    max: 0.15,
    step: 0,
    learned: false,
  },
  replacement_similarity: {
    key: 'replacement_similarity',
    label: 'Replacement similarity',
    unit: 'similarity',
    effect: 'How close in meaning an earlier choice must be to be checked as one a new choice replaces.',
    default: 0.75,
    min: 0.6,
    max: 0.9,
    step: 0.025,
    learned: true,
  },
  related_choices: {
    key: 'related_choices',
    label: 'Related choices first',
    unit: 'count',
    effect: 'How many current choices lead the related section of an agent’s context.',
    default: 3,
    min: 3,
    max: 3,
    step: 0,
    learned: false,
  },
  related_results: {
    key: 'related_results',
    label: 'Related results',
    unit: 'count',
    effect: 'How many results the related section of an agent’s context holds.',
    default: 5,
    min: 5,
    max: 5,
    step: 0,
    learned: false,
  },
  choice_extraction_cap: {
    key: 'choice_extraction_cap',
    label: 'Choices per source',
    unit: 'count',
    effect: 'The most choices read from one plan, record or pasted text.',
    default: 40,
    min: 40,
    max: 40,
    step: 0,
    learned: false,
  },
  source_text_limit: {
    key: 'source_text_limit',
    label: 'Source text limit',
    unit: 'characters',
    effect: 'How much of a source the model reads when it looks for choices.',
    default: 30_000,
    min: 30_000,
    max: 30_000,
    step: 0,
    learned: false,
  },
  inbox_suggestions: {
    key: 'inbox_suggestions',
    label: 'Inbox suggestions',
    unit: 'count',
    effect: 'The most globs the inbox suggests for a pasted text.',
    default: 3,
    min: 3,
    max: 3,
    step: 0,
    learned: false,
  },
  inbox_candidates: {
    key: 'inbox_candidates',
    label: 'Inbox candidates',
    unit: 'count',
    effect: 'How many candidate globs the inbox model chooses its suggestions from.',
    default: 8,
    min: 4,
    max: 16,
    step: 1,
    learned: true,
  },
  promotion_min_returns: {
    key: 'promotion_min_returns',
    label: 'Returns to raise a choice',
    unit: 'count',
    effect: 'How often a choice from a record or plan must be handed to agents before it is raised as a learning.',
    default: 5,
    min: 3,
    max: 10,
    step: 1,
    learned: true,
  },
  promotion_discussion_min_returns: {
    key: 'promotion_discussion_min_returns',
    label: 'Returns to raise a discussion choice',
    unit: 'count',
    effect: 'The same for a choice that came from pasted discussion.',
    default: 10,
    min: 5,
    max: 20,
    step: 1,
    learned: true,
  },
  promotion_min_globs: {
    key: 'promotion_min_globs',
    label: 'Globs to raise a choice',
    unit: 'count',
    effect: 'How many different globs a choice must have been handed to before it is raised as a learning.',
    default: 3,
    min: 3,
    max: 3,
    step: 0,
    learned: false,
  },
};

/** Every setting's value. */
export type ContextSettings = Readonly<Record<ContextSettingKey, number>>;

/** Builds a full record without a cast: the listing is explicit so a new key is a compile error here. */
const build = (value: (key: ContextSettingKey) => number): ContextSettings => ({
  discussion_weight: value('discussion_weight'),
  recency_half_life_days: value('recency_half_life_days'),
  replaced_factor: value('replaced_factor'),
  replacement_similarity: value('replacement_similarity'),
  related_choices: value('related_choices'),
  related_results: value('related_results'),
  choice_extraction_cap: value('choice_extraction_cap'),
  source_text_limit: value('source_text_limit'),
  inbox_suggestions: value('inbox_suggestions'),
  inbox_candidates: value('inbox_candidates'),
  promotion_min_returns: value('promotion_min_returns'),
  promotion_discussion_min_returns: value('promotion_discussion_min_returns'),
  promotion_min_globs: value('promotion_min_globs'),
});

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = build((key) => CONTEXT_SETTING_SPECS[key].default);

/** `value` within the setting's bounds, rounded to a whole number when its step is whole; non-finite gives the default. */
export const clampContextSetting = (key: ContextSettingKey, value: number): number => {
  const spec = CONTEXT_SETTING_SPECS[key];
  if (!Number.isFinite(value)) return spec.default;
  const whole = Number.isInteger(spec.step) && spec.step > 0 ? Math.round(value) : value;
  return Math.min(spec.max, Math.max(spec.min, whole));
};

/** A board's settings from its stored values: unknown keys are ignored, missing ones take the default, the rest are clamped. */
export const resolveContextSettings = (stored: Readonly<Record<string, number>>): ContextSettings =>
  build((key) => {
    const value = stored[key];
    return value === undefined ? CONTEXT_SETTING_SPECS[key].default : clampContextSetting(key, value);
  });

/** One recorded move of a setting (or its reset), with the value before and after and why. */
export interface ContextSettingChange {
  readonly id: number;
  readonly boardId: number;
  readonly at: string;
  readonly key: ContextSettingKey;
  readonly before: number;
  readonly after: number;
  /** What the tuning saw (a signal name) or `reset`. */
  readonly outcome: string;
  /** The numbers behind it, as plain text. */
  readonly evidence: string;
}

export type NewContextSettingChange = Omit<ContextSettingChange, 'id'>;
