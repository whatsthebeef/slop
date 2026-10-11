import type { DomainEvent } from './events.js';
import { contextSectionList, extractPlanFeatures } from './intake-learning.js';
import type { Area, GlobOutcome } from './intake-learning.js';
import { forecastEvidence, forecastReasons } from './size-forecast.js';
import type { SizeForecast } from './size-forecast.js';

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

export const SIZE_OUTCOMES = ['kept_whole_clean', 'unflagged_struggled', 'flag_confirmed', 'split_stalled', 'split_helped', 'reset'] as const;
/**
 * `kept_whole_clean` and `split_stalled` (a split whose parts serialised and stalled) raise, `unflagged_struggled` lowers,
 * `flag_confirmed` (a flag that was right) and `split_helped` (a split whose parts ran in parallel) leave it; `reset` (an
 * admin returning the board to the defaults) is the only one that sets it to something else.
 */
export type SizeOutcome = (typeof SIZE_OUTCOMES)[number];

export const nextThreshold = (outcome: SizeOutcome, t: SizeThreshold): SizeThreshold =>
  outcome === 'kept_whole_clean' || outcome === 'split_stalled'
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

/** One part of a proposed split, in the shape `GlobService.split` takes (part 0 is the original glob). */
export interface ProposedPart {
  readonly title: string;
  readonly summary: string;
  readonly plan: string;
  /** Indexes of earlier parts this one needs merged before it starts (`after` in split_glob's shape): direct prerequisites only. */
  readonly after: readonly number[];
  /** Earlier parts that touch the same files or both need a migration: they order the merges but never block a start. Absent in older proposals. */
  readonly overlaps?: readonly number[];
  /** `sub` for a small, low-risk part (it starts by itself); absent: the original's type. Never set on part 0. */
  readonly type?: 'sub';
}

export interface SizeProposal {
  readonly parts: readonly ProposedPart[];
  /** Parts on the longest chain of needs (part 0 included): the fewest merges in a row. Absent in older proposals. */
  readonly criticalPath?: number;
  /** The most parts that can be built at the same time once their needs have merged. */
  readonly maxParallel?: number;
}

/** The shape of a split from its needs: the longest chain of parts, and the widest level of parts that can run together. */
export const splitShape = (parts: readonly { readonly after: readonly number[] }[]): { criticalPath: number; maxParallel: number } => {
  const depth: number[] = [];
  for (const [index, part] of parts.entries()) {
    depth[index] = 1 + Math.max(0, ...part.after.filter((n) => n < index).map((n) => depth[n] ?? 1));
  }
  const width = new Map<number, number>();
  for (const d of depth) width.set(d, (width.get(d) ?? 0) + 1);
  return { criticalPath: Math.max(0, ...depth), maxParallel: Math.max(0, ...width.values()) };
};

/** A proposal whose parts wait on each other in one line: a split that gains nothing, so it is not offered. */
export const isChain = (proposal: SizeProposal): boolean => (proposal.criticalPath ?? 0) >= proposal.parts.length;

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

/** Whether two parts change the same files or both need a migration: they overlap (merge order), but neither needs the other. */
const sharesWork = (a: string, b: string): boolean => {
  const fa = extractPlanFeatures(a);
  const fb = extractPlanFeatures(b);
  return fa.filePaths.some((p) => fb.filePaths.includes(p)) || (fa.areas.includes('migration') && fb.areas.includes('migration'));
};

/** The most tasks a part may have and still start by itself as a sub. */
const SUB_PART_MAX_TASKS = 2;

/** A small part that touches no migration or infrastructure is low-risk: it can be a sub. */
const lowRisk = (plan: string): boolean => {
  const f = extractPlanFeatures(plan);
  return f.tasks <= SUB_PART_MAX_TASKS && !f.areas.includes('migration') && !f.areas.includes('infra');
};

/**
 * The proposal from the model's parts (pure). Part 0 stays the original glob, and is the shared contract the others build
 * on when the model made it so. A section of the plan with no task is context, never a part: a part the model made of one
 * (no task line, while the plan has tasks) is dropped, and every context section a part doesn't already carry is copied
 * into it. A part needs only what the model said it needs, cut down to direct prerequisites (a part that needs part 0
 * through another part does not name part 0 as well); sharing files or both needing a migration is an overlap, never a
 * need. Low-risk parts after part 0 are subs. Null when fewer than 2 parts remain.
 */
export const buildProposal = (plan: string, modelParts: readonly ModelPart[]): SizeProposal | null => {
  const hasTasks = extractPlanFeatures(plan).tasks > 0;
  const context = contextSectionList(plan);
  const parts: (ModelPart & { own: string })[] = modelParts
    .filter((p) => p.title.trim() !== '' && p.plan.trim() !== '')
    .filter((p) => !hasTasks || extractPlanFeatures(p.plan).tasks > 0)
    .slice(0, MAX_PROPOSED_PARTS)
    .map((p) => {
      const missing = context.filter((section) => !lower(p.plan).includes(lower(section.heading)));
      const carried = [p.plan.trim(), ...missing.map((section) => `## ${section.heading}\n\n${section.body}`)].join('\n\n');
      return { title: p.title.trim().slice(0, 120), summary: p.summary.trim(), plan: carried, own: p.plan.trim(), after: p.after };
    });
  if (parts.length < 2) return null;
  // Everything each part needs, directly or through others, to cut direct needs down and keep overlaps from repeating them.
  const reach: Set<number>[] = [];
  const built: ProposedPart[] = parts.map((p, index) => {
    const wanted = index === 0 ? [] : [...new Set(p.after.filter((n) => Number.isInteger(n) && n >= 0 && n < index))];
    const direct = wanted.filter((n) => !wanted.some((m) => m !== n && reach[m]?.has(n) === true));
    const reached = new Set(direct.flatMap((n) => [n, ...(reach[n] ?? [])]));
    reach[index] = reached;
    const overlaps: number[] = [];
    for (let earlier = 0; earlier < index; earlier++) {
      if (!reached.has(earlier) && sharesWork(parts[earlier]?.own ?? '', p.own)) overlaps.push(earlier);
    }
    return {
      title: p.title,
      summary: p.summary,
      plan: p.plan,
      after: direct.sort((a, b) => a - b),
      overlaps,
      ...(index > 0 && lowRisk(p.own) ? { type: 'sub' as const } : {}),
    };
  });
  return { parts: built, ...splitShape(built) };
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

/** What the learning reads about a split once every part merged (or was deleted). */
export interface SplitOutcomeInput {
  readonly parts: number;
  /** Parts on the longest chain of needs the parts actually had. */
  readonly criticalPath: number;
  /** `RunFailed` events across the parts. */
  readonly failedRuns: number;
  /** Parts deleted before they merged. */
  readonly missing: number;
  /** Parts whose PR conflicted with the base branch. */
  readonly conflicts: number;
  /** Hours from the split to the last part's merge; null when unknown. */
  readonly hours: number | null;
}

/**
 * What a finished split says: `split_stalled` when its parts ended up in one chain (nothing ran in parallel, so the split
 * only added merges) and something stalled (a failed run, a deleted part, a conflict, or far longer than the board's PRs
 * usually take), with the cause; otherwise `split_helped`. Only the first moves the threshold, toward keeping work whole.
 */
export const splitOutcomeOf = (input: SplitOutcomeInput, range: PrRange): { outcome: SizeOutcome; evidence: string } => {
  const serialised = input.criticalPath >= input.parts;
  const median = known(range);
  const causes = [
    ...(input.failedRuns > 0 ? [`${input.failedRuns} failed run${input.failedRuns === 1 ? '' : 's'}`] : []),
    ...(input.missing > 0 ? [`${input.missing} part${input.missing === 1 ? ' was' : 's were'} deleted`] : []),
    ...(input.conflicts > 0 ? [`${input.conflicts} part${input.conflicts === 1 ? '' : 's'} conflicted with the base branch`] : []),
    ...(median !== null && input.hours !== null && input.hours > median * PR_LONG_FACTOR * input.parts
      ? [`${hours(input.hours)} from the split to the last merge, the board's median PR is ${hours(median)}`]
      : []),
  ];
  const shape = `${input.parts} parts, critical path ${input.criticalPath}`;
  return serialised && causes.length > 0
    ? { outcome: 'split_stalled', evidence: `Split into ${shape}: the parts ran one after another and stalled: ${causes.join('; ')}` }
    : {
        outcome: 'split_helped',
        evidence: serialised ? `Split into ${shape}: the parts ran one after another but nothing stalled` : `Split into ${shape}: parts could run in parallel`,
      };
};

/** The part IDs (part 0 first) of the latest split a glob was cut by, from its `GlobSplit` events; null when none says. */
export const splitPartsOf = (globId: string, events: readonly DomainEvent[]): string[] | null => {
  for (const e of [...events].reverse()) {
    if (e.type !== 'GlobSplit' || e.globId !== globId) continue;
    if (e.data['part'] !== 0) continue;
    const parts = e.data['parts'];
    if (!Array.isArray(parts)) continue;
    const ids = parts.filter((p): p is string => typeof p === 'string');
    return ids.length >= 2 && ids.length === parts.length ? ids : null;
  }
  return null;
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
