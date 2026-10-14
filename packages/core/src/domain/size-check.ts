import type { DomainEvent } from './events.js';
import { contextSectionList, extractPlanFeatures } from './intake-learning.js';
import type { Area, GlobOutcome } from './intake-learning.js';
import { forecastEvidence, forecastReasons } from './size-forecast.js';
import type { SizeForecast } from './size-forecast.js';

/**
 * The learned size check (spec, Intake): intake judges whether a glob is one PR's worth of work. A glob whose estimate
 * exceeds the board's threshold is flagged oversized: the flag advises and never holds the glob. It carries a proposed
 * division into workstreams, which the run can work in parallel inside its one PR; the threshold moves in fixed steps with
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

/** A raise: a flagged glob merged cleanly. Never lowers a value set above the bounds. */
export const raisedThreshold = (t: SizeThreshold): SizeThreshold => ({
  maxTasks: Math.max(t.maxTasks, Math.min(SIZE_TASKS_MAX, t.maxTasks + SIZE_STEP)),
  maxParts: Math.max(t.maxParts, Math.min(SIZE_PARTS_MAX, t.maxParts + SIZE_STEP)),
});

/** A lowering: an unflagged glob struggled. Never raises a value set below the bounds. */
export const loweredThreshold = (t: SizeThreshold): SizeThreshold => ({
  maxTasks: Math.min(t.maxTasks, Math.max(SIZE_TASKS_MIN, t.maxTasks - SIZE_STEP)),
  maxParts: Math.min(t.maxParts, Math.max(SIZE_PARTS_MIN, t.maxParts - SIZE_STEP)),
});

/** `split_stalled` and `split_helped` are no longer recorded (a split is a scope cut now); old rows stay readable. */
export const SIZE_OUTCOMES = ['kept_whole_clean', 'unflagged_struggled', 'flag_confirmed', 'split_stalled', 'split_helped', 'reset'] as const;
/**
 * `kept_whole_clean` (a flagged glob that merged cleanly) raises, `unflagged_struggled` lowers, `flag_confirmed` (a flag that
 * was right) leaves it; `reset` (an admin returning the board to the defaults) is the only one that sets it to something
 * else. The old `split_stalled` raised and `split_helped` left it; they are only read from history now and move nothing.
 */
export type SizeOutcome = (typeof SIZE_OUTCOMES)[number];

export const nextThreshold = (outcome: SizeOutcome, t: SizeThreshold): SizeThreshold =>
  outcome === 'kept_whole_clean'
    ? raisedThreshold(t)
    : outcome === 'unflagged_struggled'
      ? loweredThreshold(t)
      : t;

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
  /** What the board starts from and `reset` returns to. */
  readonly defaults: SizeThreshold;
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
  /**
   * The most parts that could be built at the same time: the model's judgement, null from the text estimate (and absent in
   * checks stored before it existed). A plan is only oversized when this is 2 or more: serial work gains nothing from a split.
   */
  readonly parallelParts?: number | null;
  /** The model's one-line reason for its count; null for the text estimate. */
  readonly reasoning: string | null;
  /** The forecast from the code and from similar merged globs, once made (it takes over the flag and the proposal). */
  readonly forecast?: SizeForecast;
}

/** Without the model: about three tasks to a part. Sections with no task are context, never parts. */
const TASKS_PER_PART = 3;

/** The estimate from plan text alone (what a failed or missing model leaves). */
export const estimateFromText = (plan: string): SizeEstimate => {
  const features = extractPlanFeatures(plan);
  return {
    tasks: features.tasks,
    doneWhenLines: features.doneWhenLines,
    areas: features.areas,
    untaskedSections: features.untaskedSections,
    independentParts: Math.max(1, Math.ceil(features.tasks / TASKS_PER_PART)),
    partsSource: 'text',
    reasoning: null,
  };
};

/** The estimate with the model's count of independent parts. */
export const withModelParts = (estimate: SizeEstimate, parts: number, reasoning: string | null, parallel: number | null = null): SizeEstimate => ({
  ...estimate,
  independentParts: clamp(Math.round(parts), 1, 20),
  partsSource: 'model',
  parallelParts: parallel === null ? null : clamp(Math.round(parallel), 1, 20),
  reasoning,
});

/**
 * Why the estimate exceeds the threshold, as plain text; empty when it doesn't. Size alone never flags: only work with at
 * least 2 parts that could be built at the same time does (a long serial plan stays whole), and only the model can tell.
 */
export const oversizedReasons = (estimate: SizeEstimate, threshold: SizeThreshold): string[] => {
  // The forecast (from the code) judges the parts and what can run at once itself.
  if (estimate.forecast !== undefined) return forecastReasons(estimate.forecast, threshold);
  const parallel = estimate.parallelParts ?? null;
  if (parallel === null || parallel < 2) return [];
  const big = [
    ...(estimate.tasks > threshold.maxTasks ? [`${estimate.tasks} tasks (more than ${threshold.maxTasks})`] : []),
    ...(estimate.independentParts > threshold.maxParts
      ? [`${estimate.independentParts} independent parts (more than ${threshold.maxParts})`]
      : []),
  ];
  return big.length === 0 ? [] : [...big, `${parallel} parts could be built at the same time`];
};

/**
 * Whether slop investigates a glob in Planning by itself: intake flagged it big, or its part count is a guess (the text
 * estimate stands because the model didn't answer) for a plan with more than one task. A one-task plan is plainly small.
 */
export const needsInvestigation = (check: { readonly flagged: boolean; readonly estimate: SizeEstimate } | null): boolean =>
  check !== null && (check.flagged || (check.estimate.partsSource === 'text' && check.estimate.tasks > 1));

/** The evidence stored with an estimate. */
export const evidenceOf = (estimate: SizeEstimate): string[] => [
  ...(estimate.forecast === undefined ? [] : forecastEvidence(estimate.forecast)),
  `${estimate.tasks} tasks, ${estimate.doneWhenLines} "Done when" lines`,
  `Areas: ${estimate.areas.length === 0 ? 'none found' : estimate.areas.join(', ')}`,
  `${estimate.untaskedSections} sections with no task`,
  estimate.partsSource === 'model'
    ? `Model: ${estimate.independentParts} independent parts, ${estimate.parallelParts == null ? 'parallelism not stated' : `${estimate.parallelParts} buildable at the same time`}${estimate.reasoning === null ? '' : ` (${estimate.reasoning})`}`
    : `Text only: ${estimate.independentParts} independent parts (the model's judgement was not available)`,
];

// ---------------------------------------------------------------------------
// Stored check and proposal

/**
 * One workstream of a flagged glob: a share of its plan that can be worked on beside the others inside the one run and PR
 * (parallel work within the glob, not a separate glob).
 */
export interface Workstream {
  readonly name: string;
  /** What the workstream delivers, in a sentence. */
  readonly goal: string;
  /** The files it is expected to change; empty when not known. */
  readonly files: readonly string[];
  /** Its share of the plan. */
  readonly plan: string;
  /** Indexes of earlier workstreams whose result this one builds on: direct prerequisites only. */
  readonly needs: readonly number[];
}

export interface SizeProposal {
  readonly workstreams: readonly Workstream[];
  /** Workstreams on the longest chain of needs (the first included): the most that must be done in a row. */
  readonly criticalPath?: number;
  /** The most workstreams that can run at the same time once their needs are done. */
  readonly maxParallel?: number;
}

/** A proposal as older checks stored it: parts in split_glob's shape (`title`, `plan`, `after`). Read only. */
export interface LegacySizeProposal {
  readonly parts: readonly { readonly title: string; readonly plan: string; readonly after: readonly number[] }[];
  readonly criticalPath?: number;
  readonly maxParallel?: number;
}

/** What a stored check's `proposal` column holds: workstreams, or an older check's parts. */
export type StoredSizeProposal = SizeProposal | LegacySizeProposal;

/** The proposal of a stored check, with an older check's parts read as workstreams. */
export const proposalOfStored = (stored: StoredSizeProposal | null): SizeProposal | null => {
  if (stored === null) return null;
  if ('workstreams' in stored) return stored;
  return {
    workstreams: stored.parts.map((p) => ({ name: p.title, goal: goalOf(p.plan), files: [], plan: p.plan, needs: p.after })),
    ...(stored.criticalPath === undefined ? {} : { criticalPath: stored.criticalPath }),
    ...(stored.maxParallel === undefined ? {} : { maxParallel: stored.maxParallel }),
  };
};

/**
 * A workstream read from untrusted JSON (a stored check, a model's reply): null unless it has a name and a plan; `goal` falls
 * back to the plan's first line, `files` keeps only non-empty strings (no duplicates), and `needs` keeps only distinct indexes
 * of earlier workstreams (`index` is this one's place), in order.
 */
export const parseWorkstream = (value: unknown, index: number): Workstream | null => {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || v.name.trim() === '' || typeof v.plan !== 'string' || v.plan.trim() === '') return null;
  const files = Array.isArray(v.files)
    ? [...new Set(v.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim()))]
    : [];
  const isEarlier = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < index;
  const needs = Array.isArray(v.needs) ? [...new Set(v.needs.filter(isEarlier))].sort((x, y) => x - y) : [];
  const goal = typeof v.goal === 'string' && v.goal.trim() !== '' ? v.goal.trim() : goalOf(v.plan);
  return { name: v.name.trim(), goal, files, plan: v.plan, needs };
};

/** The first line of a plan that is text, not a heading, list item or numbered task: what the work is for. */
export const goalOf = (plan: string): string =>
  plan
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^(#|[-*]|\d+[.)])/.test(l))
    ?.slice(0, 300) ?? '';

/** The shape of a division from its needs: the longest chain of workstreams, and the widest level that can run together. */
export const splitShape = (parts: readonly { readonly needs: readonly number[] }[]): { criticalPath: number; maxParallel: number } => {
  const depth: number[] = [];
  for (const [index, part] of parts.entries()) {
    depth[index] = 1 + Math.max(0, ...part.needs.filter((n) => n < index).map((n) => depth[n] ?? 1));
  }
  const width = new Map<number, number>();
  for (const d of depth) width.set(d, (width.get(d) ?? 0) + 1);
  return { criticalPath: Math.max(0, ...depth), maxParallel: Math.max(0, ...width.values()) };
};

/** A proposal whose workstreams wait on each other in one line: parallel work that gains nothing, so it is not offered. */
export const isChain = (proposal: SizeProposal): boolean => (proposal.criticalPath ?? 0) >= proposal.workstreams.length;

/** `kept_whole` is gone (a flag only advises); the migration cleared it from old checks. */
export const SIZE_DECISIONS = ['split'] as const;
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
  /** Set when the glob was cut into independent globs (a scope cut); null otherwise. */
  readonly decision: SizeDecision | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A flag nobody has acted on: it is advice only (the glob can start at once), and the card shows the chip. */
export const unresolved = (check: SizeCheck | null): boolean => check !== null && check.flagged && check.decision === null;

// ---------------------------------------------------------------------------
// Proposal from the model's parts

export interface ModelPart {
  readonly name: string;
  readonly goal: string | null;
  readonly files: readonly string[];
  readonly plan: string;
  readonly needs: readonly number[];
}

const lower = (s: string): string => s.toLowerCase();

/**
 * The proposal from the model's workstreams (pure). The first is the shared contract the others build on when the model made
 * it so. A section of the plan with no task is context, never a workstream: one the model made of it (no task line, while the
 * plan has tasks) is dropped, and every context section a workstream doesn't already carry is copied into it. A workstream
 * needs only what the model said it needs, cut down to direct prerequisites (one that needs the first through another does not
 * name the first as well). Null when fewer than 2 workstreams remain.
 */
export const buildProposal = (plan: string, modelParts: readonly ModelPart[]): SizeProposal | null => {
  const hasTasks = extractPlanFeatures(plan).tasks > 0;
  const context = contextSectionList(plan);
  const parts = modelParts
    .filter((p) => p.name.trim() !== '' && p.plan.trim() !== '')
    .filter((p) => !hasTasks || extractPlanFeatures(p.plan).tasks > 0)
    .slice(0, MAX_PROPOSED_PARTS)
    .map((p) => {
      const missing = context.filter((section) => !lower(p.plan).includes(lower(section.heading)));
      const carried = [p.plan.trim(), ...missing.map((section) => `## ${section.heading}\n\n${section.body}`)].join('\n\n');
      return { name: p.name.trim().slice(0, 120), goal: p.goal?.trim() ?? goalOf(p.plan), files: p.files, plan: carried, needs: p.needs };
    });
  if (parts.length < 2) return null;
  // Everything each workstream needs, directly or through others, to cut direct needs down.
  const reach: Set<number>[] = [];
  const built: Workstream[] = parts.map((p, index) => {
    const wanted = index === 0 ? [] : [...new Set(p.needs.filter((n) => Number.isInteger(n) && n >= 0 && n < index))];
    const direct = wanted.filter((n) => !wanted.some((m) => m !== n && reach[m]?.has(n) === true));
    reach[index] = new Set(direct.flatMap((n) => [n, ...(reach[n] ?? [])]));
    return { name: p.name, goal: p.goal, files: p.files, plan: p.plan, needs: direct.sort((a, b) => a - b) };
  });
  return { workstreams: built, ...splitShape(built) };
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
  /** The glob has a `GlobSplit` event at all (its scope was cut into independent globs). */
  readonly split: boolean;
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

/** Why a glob struggled (review rounds at the tier's max, failed runs, or a very long PR). */
export const struggles = (input: SizeOutcomeInput, range: PrRange): string[] => {
  const { rounds, maxRounds } = input.outcome.review;
  const median = known(range);
  return [
    ...(rounds !== null && maxRounds !== null && rounds >= maxRounds ? [`hit the maximum of ${maxRounds} review rounds`] : []),
    ...(input.failedRuns > 0 ? [`${input.failedRuns} failed run${input.failedRuns === 1 ? '' : 's'}`] : []),
    ...(median !== null && input.prHours !== null && input.prHours > median * PR_LONG_FACTOR
      ? [`a very long PR (${hours(input.prHours)}, the board's median is ${hours(median)})`]
      : []),
  ];
};

/** Why a flagged glob did not merge cleanly (nothing when it did). */
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
 * - flagged, not split, merged cleanly: `kept_whole_clean` (raise): the flag was advice and the glob went through whole;
 * - flagged and split, or merged whole and not clean: `flag_confirmed` (no move);
 * - unflagged and struggled: `unflagged_struggled` (lower).
 */
export const sizeOutcomeOf = (input: SizeOutcomeInput, range: PrRange): { outcome: SizeOutcome; evidence: string } | null => {
  if (input.flagged) {
    if (input.split) return { outcome: 'flag_confirmed', evidence: 'Flagged oversized and split' };
    const problems = notClean(input, range);
    return problems.length === 0
      ? { outcome: 'kept_whole_clean', evidence: 'Flagged oversized, and merged cleanly: review rounds within the tier, no failed run, PR open time normal, no follow-up bug' }
      : { outcome: 'flag_confirmed', evidence: `Flagged oversized, and it ${problems.join('; ')}` };
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

export const SIZE_EVENT_TYPES = ['PROpened', 'Merged', 'RunFailed', 'RunTriggered', 'PickedUp', 'GlobSplit'] as const;
