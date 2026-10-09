import type { DomainEvent } from './events.js';
import { extractPlanFeatures, untaskedSectionList } from './intake-learning.js';
import type { Area, GlobOutcome } from './intake-learning.js';

/**
 * The learned size check (spec, Intake): intake judges whether a glob is one PR's worth of work. A glob whose estimate
 * exceeds the board's threshold is flagged oversized and gets a proposed split; the threshold moves in fixed steps with
 * outcomes recorded after merge, as the sub limit does. Pure: the model, the store and the job are in the service.
 */

export interface SizeThreshold {
  /** Flagged when the plan has more tasks than this. */
  readonly maxTasks: number;
  /** Flagged when the work falls into more independent parts than this. */
  readonly maxParts: number;
}

export const DEFAULT_SIZE_THRESHOLD: SizeThreshold = { maxTasks: 5, maxParts: 3 };
export const SIZE_TASKS_MIN = 2;
export const SIZE_TASKS_MAX = 12;
export const SIZE_PARTS_MIN = 2;
export const SIZE_PARTS_MAX = 6;
/** Each move changes both limits by this much, each within its own bounds. */
export const SIZE_STEP = 1;
/** An outcome counts a raise only when no follow-up bug blamed the glob within this many days of its merge. */
export const SIZE_WINDOW_DAYS = 14;
/** The board needs this many merged PRs before its "normal" PR open time is known. */
export const PR_MIN_SAMPLES = 5;
/** A PR open up to this many times the board's median is within its normal range. */
export const PR_NORMAL_FACTOR = 2;
/** A PR open longer than this many times the board's median is very long. */
export const PR_LONG_FACTOR = 3;
export const MAX_PROPOSED_PARTS = 10;

export interface SizeBounds {
  readonly tasks: { readonly min: number; readonly max: number };
  readonly parts: { readonly min: number; readonly max: number };
  readonly step: number;
}

export const SIZE_BOUNDS: SizeBounds = {
  tasks: { min: SIZE_TASKS_MIN, max: SIZE_TASKS_MAX },
  parts: { min: SIZE_PARTS_MIN, max: SIZE_PARTS_MAX },
  step: SIZE_STEP,
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** A raise: a flagged glob kept whole merged cleanly. Never lowers a value set above the bounds. */
export const raisedThreshold = (t: SizeThreshold): SizeThreshold => ({
  maxTasks: Math.max(t.maxTasks, Math.min(SIZE_TASKS_MAX, t.maxTasks + SIZE_STEP)),
  maxParts: Math.max(t.maxParts, Math.min(SIZE_PARTS_MAX, t.maxParts + SIZE_STEP)),
});

/** A lowering: an unflagged glob struggled. Never raises a value set below the bounds. */
export const loweredThreshold = (t: SizeThreshold): SizeThreshold => ({
  maxTasks: Math.min(t.maxTasks, Math.max(SIZE_TASKS_MIN, t.maxTasks - SIZE_STEP)),
  maxParts: Math.min(t.maxParts, Math.max(SIZE_PARTS_MIN, t.maxParts - SIZE_STEP)),
});

export const SIZE_OUTCOMES = ['kept_whole_clean', 'unflagged_struggled', 'flag_confirmed'] as const;
/** `kept_whole_clean` raises, `unflagged_struggled` lowers, `flag_confirmed` (a flag that was right) leaves it. */
export type SizeOutcome = (typeof SIZE_OUTCOMES)[number];

export const nextThreshold = (outcome: SizeOutcome, t: SizeThreshold): SizeThreshold =>
  outcome === 'kept_whole_clean' ? raisedThreshold(t) : outcome === 'unflagged_struggled' ? loweredThreshold(t) : t;

export interface SizeThresholdChange {
  readonly id: number;
  readonly boardId: number;
  readonly at: string;
  readonly from: SizeThreshold;
  readonly to: SizeThreshold;
  readonly outcome: SizeOutcome;
  readonly globId: string;
  /** Why, as plain text. */
  readonly evidence: string;
}
export type NewSizeThresholdChange = Omit<SizeThresholdChange, 'id'>;

export interface SizeThresholdView {
  readonly current: SizeThreshold;
  readonly bounds: SizeBounds;
  readonly history: readonly SizeThresholdChange[];
}

// ---------------------------------------------------------------------------
// Estimate

export interface SizeEstimate {
  readonly tasks: number;
  readonly doneWhenLines: number;
  readonly areas: readonly Area[];
  /** Sections of the plan with text and no task. */
  readonly untaskedSections: number;
  /** The independent parts the work falls into: the model's judgement, else derived from the text. */
  readonly independentParts: number;
  readonly partsSource: 'model' | 'text';
  /** The model's one-line reason for its count; null for the text estimate. */
  readonly reasoning: string | null;
}

/** Without the model: about three tasks to a part, and every untasked section is a part of its own. */
const TASKS_PER_PART = 3;

/** The estimate from plan text alone (what a failed or missing model leaves). */
export const estimateFromText = (plan: string): SizeEstimate => {
  const features = extractPlanFeatures(plan);
  return {
    tasks: features.tasks,
    doneWhenLines: features.doneWhenLines,
    areas: features.areas,
    untaskedSections: features.untaskedSections,
    independentParts: Math.max(1, Math.ceil(features.tasks / TASKS_PER_PART)) + features.untaskedSections,
    partsSource: 'text',
    reasoning: null,
  };
};

/** The estimate with the model's count of independent parts. */
export const withModelParts = (estimate: SizeEstimate, parts: number, reasoning: string | null): SizeEstimate => ({
  ...estimate,
  independentParts: clamp(Math.round(parts), 1, 20),
  partsSource: 'model',
  reasoning,
});

/** Why the estimate exceeds the threshold, as plain text; empty when it doesn't. */
export const oversizedReasons = (estimate: SizeEstimate, threshold: SizeThreshold): string[] => [
  ...(estimate.tasks > threshold.maxTasks ? [`${estimate.tasks} tasks (more than ${threshold.maxTasks})`] : []),
  ...(estimate.independentParts > threshold.maxParts
    ? [`${estimate.independentParts} independent parts (more than ${threshold.maxParts})`]
    : []),
];

/** The evidence stored with an estimate. */
export const evidenceOf = (estimate: SizeEstimate): string[] => [
  `${estimate.tasks} tasks, ${estimate.doneWhenLines} "Done when" lines`,
  `Areas: ${estimate.areas.length === 0 ? 'none found' : estimate.areas.join(', ')}`,
  `${estimate.untaskedSections} sections with no task`,
  estimate.partsSource === 'model'
    ? `Model: ${estimate.independentParts} independent parts${estimate.reasoning === null ? '' : ` (${estimate.reasoning})`}`
    : `Text only: ${estimate.independentParts} independent parts (the model's judgement was not available)`,
];

// ---------------------------------------------------------------------------
// Stored check and proposal

/** One part of a proposed split, in the shape `GlobService.split` takes (part 0 is the original glob). */
export interface ProposedPart {
  readonly title: string;
  readonly summary: string;
  readonly plan: string;
  /** Indexes of earlier parts this one starts after. */
  readonly after: readonly number[];
}

export interface SizeProposal {
  readonly parts: readonly ProposedPart[];
}

export const SIZE_DECISIONS = ['kept_whole', 'split'] as const;
export type SizeDecision = (typeof SIZE_DECISIONS)[number];

/** What intake judged about a glob's size, stored with the glob. */
export interface SizeCheck {
  readonly globId: string;
  readonly boardId: number;
  /** Hash of the plan the estimate was made from. */
  readonly planHash: string;
  readonly estimate: SizeEstimate;
  readonly evidence: readonly string[];
  /** The threshold the estimate was judged against. */
  readonly threshold: SizeThreshold;
  readonly flagged: boolean;
  /** Why it was flagged; empty when not. */
  readonly reasons: readonly string[];
  readonly proposal: SizeProposal | null;
  /** What a person did about the flag: kept it whole, or it was split. */
  readonly decision: SizeDecision | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A flag nobody has resolved: it holds a sub or an auto-triggered same, and the card shows the chip. */
export const unresolved = (check: SizeCheck | null): boolean => check !== null && check.flagged && check.decision === null;

// ---------------------------------------------------------------------------
// Proposal from the model's parts

export interface ModelPart {
  readonly title: string;
  readonly summary: string;
  readonly plan: string;
  readonly after: readonly number[];
}

const lower = (s: string): string => s.toLowerCase();

/** Whether two parts change the same files or both need a migration: the later one starts after the earlier. */
const sharesWork = (a: string, b: string): boolean => {
  const fa = extractPlanFeatures(a);
  const fb = extractPlanFeatures(b);
  return fa.filePaths.some((p) => fb.filePaths.includes(p)) || (fa.areas.includes('migration') && fb.areas.includes('migration'));
};

/**
 * The proposal from the model's parts (pure). Part 0 stays the original glob. Every untasked section of the plan that no
 * part carries becomes a part of its own, and a part starts after earlier parts that share its files or both need a
 * migration, whatever the model said. Null when fewer than 2 parts remain.
 */
export const buildProposal = (plan: string, modelParts: readonly ModelPart[]): SizeProposal | null => {
  const parts: ModelPart[] = modelParts
    .filter((p) => p.title.trim() !== '' && p.plan.trim() !== '')
    .slice(0, MAX_PROPOSED_PARTS)
    .map((p) => ({ title: p.title.trim().slice(0, 120), summary: p.summary.trim(), plan: p.plan.trim(), after: p.after }));
  for (const section of untaskedSectionList(plan)) {
    if (parts.length >= MAX_PROPOSED_PARTS) break;
    if (parts.some((p) => lower(p.plan).includes(lower(section.heading)))) continue;
    parts.push({
      title: section.heading.slice(0, 120),
      summary: `The "${section.heading}" section of the plan, as its own part.`,
      plan: `## ${section.heading}\n\n${section.body}`,
      after: [],
    });
  }
  if (parts.length < 2) return null;
  return {
    parts: parts.map((p, index) => {
      const after = new Set(
        index === 0 ? [] : p.after.filter((n) => Number.isInteger(n) && n >= 0 && n < index),
      );
      for (let earlier = 0; earlier < index; earlier++) {
        if (sharesWork(parts[earlier]?.plan ?? '', p.plan)) after.add(earlier);
      }
      return { title: p.title, summary: p.summary, plan: p.plan, after: [...after].sort((a, b) => a - b) };
    }),
  };
};

// ---------------------------------------------------------------------------
// Outcomes

/** What the learning reads about one merged glob that has a size check. */
export interface SizeOutcomeInput {
  readonly globId: string;
  readonly flagged: boolean;
  /** The glob's recorded outcome (final: its 14 days have passed). */
  readonly outcome: GlobOutcome;
  /** `RunFailed` events. */
  readonly failedRuns: number;
  /** Hours from the PR opening to the merge; null when no PR was recorded. */
  readonly prHours: number | null;
  /** The glob has a `GlobSplit` event at all (flagged globs split by the proposal or by hand). */
  readonly split: boolean;
  /** A `GlobSplit` event after the glob started: it was cut up mid-way. */
  readonly splitAfterStart: boolean;
}

export interface PrRange {
  readonly median: number | null;
  readonly samples: number;
}

export const prRangeOf = (hours: readonly number[]): PrRange => {
  const sorted = [...hours].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length === 0 ? null : sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { median, samples: sorted.length };
};

const known = (range: PrRange): number | null => (range.samples >= PR_MIN_SAMPLES ? range.median : null);

const hours = (h: number): string => `${Math.round(h * 10) / 10} h`;

/** Why a glob struggled (review rounds at the tier's max, failed runs, a very long PR, a split after it started). */
export const struggles = (input: SizeOutcomeInput, range: PrRange): string[] => {
  const { rounds, maxRounds } = input.outcome.review;
  const median = known(range);
  return [
    ...(rounds !== null && maxRounds !== null && rounds >= maxRounds ? [`hit the maximum of ${maxRounds} review rounds`] : []),
    ...(input.failedRuns > 0 ? [`${input.failedRuns} failed run${input.failedRuns === 1 ? '' : 's'}`] : []),
    ...(median !== null && input.prHours !== null && input.prHours > median * PR_LONG_FACTOR
      ? [`a very long PR (${hours(input.prHours)}, the board's median is ${hours(median)})`]
      : []),
    ...(input.splitAfterStart ? ['was split after it started'] : []),
  ];
};

/** Why a flagged glob kept whole did not merge cleanly (nothing when it did). */
const notClean = (input: SizeOutcomeInput, range: PrRange): string[] => {
  const median = known(range);
  const { fixGlobs } = input.outcome.postMerge;
  return [
    ...struggles(input, range),
    ...(median !== null && input.prHours !== null && input.prHours > median * PR_NORMAL_FACTOR
      ? [`PR open ${hours(input.prHours)}, over ${PR_NORMAL_FACTOR} times the board's median ${hours(median)}`]
      : []),
    ...(fixGlobs.length > 0 ? [`${fixGlobs.join(', ')} named it within ${SIZE_WINDOW_DAYS} days of the merge`] : []),
  ];
};

/**
 * The outcome a merged glob with a size check shows, or null when it says nothing (unflagged and fine).
 * - flagged, not split, merged cleanly: `kept_whole_clean` (raise);
 * - flagged and split, or kept whole and not clean: `flag_confirmed` (no move);
 * - unflagged and struggled: `unflagged_struggled` (lower).
 */
export const sizeOutcomeOf = (input: SizeOutcomeInput, range: PrRange): { outcome: SizeOutcome; evidence: string } | null => {
  if (input.flagged) {
    if (input.split) return { outcome: 'flag_confirmed', evidence: 'Flagged oversized and split' };
    const problems = notClean(input, range);
    return problems.length === 0
      ? { outcome: 'kept_whole_clean', evidence: 'Flagged oversized, kept whole, and merged cleanly: review rounds within the tier, no failed run, PR open time normal, no follow-up bug' }
      : { outcome: 'flag_confirmed', evidence: `Flagged oversized, kept whole, and it ${problems.join('; ')}` };
  }
  const problems = struggles(input, range);
  return problems.length === 0 ? null : { outcome: 'unflagged_struggled', evidence: `Not flagged, and it ${problems.join('; ')}` };
};

/** Hours between a glob's first `PROpened` and its `Merged` event, from its events (oldest first); null without both. */
export const prHoursOf = (events: readonly DomainEvent[]): number | null => {
  const merged = [...events].reverse().find((e) => e.type === 'Merged');
  const opened = events.find((e) => e.type === 'PROpened');
  if (merged === undefined || opened === undefined) return null;
  const ms = Date.parse(merged.at) - Date.parse(opened.at);
  return Number.isFinite(ms) && ms >= 0 ? ms / 3_600_000 : null;
};

/** Whether a `GlobSplit` event came after the glob's first run (or pick-up). */
export const splitAfterStartOf = (events: readonly DomainEvent[]): boolean => {
  const started = events.find((e) => e.type === 'RunTriggered' || e.type === 'PickedUp');
  return started !== undefined && events.some((e) => e.type === 'GlobSplit' && e.at > started.at);
};

export const SIZE_EVENT_TYPES = ['PROpened', 'Merged', 'RunFailed', 'RunTriggered', 'PickedUp', 'GlobSplit'] as const;
