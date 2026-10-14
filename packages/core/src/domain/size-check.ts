import type { DomainEvent } from './events.js';
import { contextSectionList, extractPlanFeatures } from './intake-learning.js';
import type { Area, GlobOutcome } from './intake-learning.js';
import type { WorkstreamsBlock } from './workstreams.js';
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
  /**
   * The fan-out floor: a glob is flagged, and a run fans out, only when at least this many workstreams could be built at the
   * same time. Learned from fan-out outcomes (`fanout_helped` lowers it, `fanout_stalled` raises it).
   */
  readonly minParallel: number;
}

export const DEFAULT_SIZE_THRESHOLD: SizeThreshold = { maxTasks: 5, maxParts: 3, minParallel: 2 };
export const SIZE_TASKS_MIN = 2;
export const SIZE_TASKS_MAX = 12;
export const SIZE_PARTS_MIN = 2;
export const SIZE_PARTS_MAX = 6;
export const SIZE_PARALLEL_MIN = 2;
export const SIZE_PARALLEL_MAX = 4;
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
  readonly parallel: { readonly min: number; readonly max: number };
  readonly step: number;
}

export const SIZE_BOUNDS: SizeBounds = {
  tasks: { min: SIZE_TASKS_MIN, max: SIZE_TASKS_MAX },
  parts: { min: SIZE_PARTS_MIN, max: SIZE_PARTS_MAX },
  parallel: { min: SIZE_PARALLEL_MIN, max: SIZE_PARALLEL_MAX },
  step: SIZE_STEP,
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** A raise: a flagged glob merged cleanly. Never lowers a value set above the bounds; the fan-out floor stays. */
export const raisedThreshold = (t: SizeThreshold): SizeThreshold => ({
  ...t,
  maxTasks: Math.max(t.maxTasks, Math.min(SIZE_TASKS_MAX, t.maxTasks + SIZE_STEP)),
  maxParts: Math.max(t.maxParts, Math.min(SIZE_PARTS_MAX, t.maxParts + SIZE_STEP)),
});

/** A lowering: an unflagged glob struggled. Never raises a value set below the bounds; the fan-out floor stays. */
export const loweredThreshold = (t: SizeThreshold): SizeThreshold => ({
  ...t,
  maxTasks: Math.min(t.maxTasks, Math.max(SIZE_TASKS_MIN, t.maxTasks - SIZE_STEP)),
  maxParts: Math.min(t.maxParts, Math.max(SIZE_PARTS_MIN, t.maxParts - SIZE_STEP)),
});

/** `split_stalled` and `split_helped` are no longer recorded (a split is a scope cut now); old rows stay readable. */
export const SIZE_OUTCOMES = [
  'kept_whole_clean',
  'unflagged_struggled',
  'flag_confirmed',
  'fanout_helped',
  'fanout_stalled',
  'split_stalled',
  'split_helped',
  'reset',
] as const;
/**
 * `kept_whole_clean` (a flagged glob that merged cleanly, not fanned out) raises the task and part limits, `unflagged_struggled`
 * lowers them, `flag_confirmed` (a flag that was right) leaves them; `fanout_helped` (a glob that fanned out and merged
 * cleanly) lowers the fan-out floor `minParallel`, so smaller parallelism is flagged too, and `fanout_stalled` (it fanned out
 * and still struggled or conflicted) raises it; `reset` (an admin returning the board to the defaults) is the only one that
 * sets it to something else. The old `split_stalled` raised and `split_helped` left it; they are only read from history now and
 * move nothing.
 */
export type SizeOutcome = (typeof SIZE_OUTCOMES)[number];

/** The fan-out floor one step lower: parallel work paid off. Never raises a value set below the bounds. */
export const loweredFloor = (t: SizeThreshold): SizeThreshold => ({
  ...t,
  minParallel: Math.min(t.minParallel, Math.max(SIZE_PARALLEL_MIN, t.minParallel - SIZE_STEP)),
});

/** The fan-out floor one step higher: parallel work stalled. Never lowers a value set above the bounds. */
export const raisedFloor = (t: SizeThreshold): SizeThreshold => ({
  ...t,
  minParallel: Math.max(t.minParallel, Math.min(SIZE_PARALLEL_MAX, t.minParallel + SIZE_STEP)),
});

export const nextThreshold = (outcome: SizeOutcome, t: SizeThreshold): SizeThreshold =>
  outcome === 'kept_whole_clean'
    ? raisedThreshold(t)
    : outcome === 'unflagged_struggled'
      ? loweredThreshold(t)
      : outcome === 'fanout_helped'
        ? loweredFloor(t)
        : outcome === 'fanout_stalled'
          ? raisedFloor(t)
          : t;

/** Whether two thresholds differ in any limit. */
export const thresholdMoved = (a: SizeThreshold, b: SizeThreshold): boolean =>
  a.maxTasks !== b.maxTasks || a.maxParts !== b.maxParts || a.minParallel !== b.minParallel;

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
 * least `minParallel` (2 or more) parts that could be built at the same time does (a long serial plan stays whole), and only the model can tell.
 */
export const oversizedReasons = (estimate: SizeEstimate, threshold: SizeThreshold): string[] => {
  // The forecast (from the code) judges the parts and what can run at once itself.
  if (estimate.forecast !== undefined) return forecastReasons(estimate.forecast, threshold);
  const parallel = estimate.parallelParts ?? null;
  if (parallel === null || parallel < Math.max(2, threshold.minParallel)) return [];
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
  /** What the ownership pass merged or moved ("merged A and B: both change x.ts"); shown as evidence. */
  readonly notes?: readonly string[];
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

/** A plan without the bullet that lists `entry` as a file (the file list the workstream was built with). */
const withoutFileLine = (plan: string, entry: string): string =>
  plan
    .split('\n')
    .filter((line) => line.trim() !== `- ${entry}`)
    .join('\n');

/** The plan, once its workstream has given `entry` to `owner`: its bullet goes and a line says who owns it. */
const gaveAway = (plan: string, entry: string, owner: string): string =>
  `${withoutFileLine(plan, entry).trimEnd()}\n\nNote: ${entry} belongs to "${owner}", not to this workstream; leave it to that one.`;

const isDirectory = (entry: string): boolean => entry.endsWith('/');

/** `outer` is `inner` itself, or a directory entry that holds it. */
const covers = (outer: string, inner: string): boolean => outer === inner || (isDirectory(outer) && inner.startsWith(outer));

interface OwnNode {
  name: string;
  goal: string;
  files: string[];
  plan: string;
  needs: Set<OwnNode>;
}

/** Everything a node needs, directly or through others. */
const reachOf = (node: OwnNode): Set<OwnNode> => {
  const out = new Set<OwnNode>();
  const visit = (n: OwnNode): void => {
    for (const need of n.needs) {
      if (!out.has(need)) {
        out.add(need);
        visit(need);
      }
    }
  };
  visit(node);
  return out;
};

/** The first two nodes (in order) with overlapping entries, and the narrower entry of the pair (the file under a directory). */
const firstShared = (nodes: readonly OwnNode[]): { a: OwnNode; b: OwnNode; ea: string; eb: string; narrow: string } | null => {
  for (const [i, a] of nodes.entries()) {
    for (const b of nodes.slice(i + 1)) {
      for (const ea of a.files) {
        const eb = b.files.find((f) => covers(ea, f) || covers(f, ea));
        if (eb !== undefined) return { a, b, ea, eb, narrow: covers(ea, eb) ? eb : ea };
      }
    }
  }
  return null;
};

/** Nodes in an order that puts what others need first, keeping the given order otherwise. */
const topological = (nodes: readonly OwnNode[]): OwnNode[] => {
  const left = [...nodes];
  const out: OwnNode[] = [];
  while (left.length > 0) {
    const next = left.findIndex((n) => [...n.needs].every((need) => out.includes(need)));
    out.push(...left.splice(next === -1 ? 0 : next, 1));
  }
  return out;
};

/**
 * The ownership rule (a file belongs to exactly one workstream) applied to a proposal's workstreams, before it is shown. A
 * directory entry owns the files under it. For a file two workstreams share: when the earliest workstream they both need (one
 * of the two, or one both build on: the contract) can own it, it moves there; otherwise the two merge into one, together with
 * any workstream between them, keeping both plan shares and the union of needs. Repeats until no file is shared; needs and
 * the shape are recomputed. Null when fewer than 2 workstreams are left. `notes` says what was merged or moved.
 */
export const applyOwnership = (workstreams: readonly Workstream[]): SizeProposal | null => {
  let nodes: OwnNode[] = [];
  for (const w of workstreams) {
    const needs = new Set(w.needs.map((n) => nodes[n]).filter((n): n is OwnNode => n !== undefined));
    nodes.push({ name: w.name, goal: w.goal, files: [...w.files], plan: w.plan, needs });
  }
  const notes: string[] = [];
  // Each pass moves a file or merges two workstreams, so it ends; the bound only guards a mistake.
  for (let pass = 0; pass < 1000; pass++) {
    const shared = firstShared(nodes);
    if (shared === null) break;
    const { a, b, ea, eb, narrow } = shared;
    const [reachA, reachB] = [reachOf(a), reachOf(b)];
    // The earliest workstream that can own it: `a` when `b` builds on it and `a` already holds it, or one both build on when
    // each holds exactly that entry. Anything else (a directory entry that would still overlap) is a merge.
    const owner =
      reachB.has(a) && covers(ea, narrow) && eb === narrow
        ? a
        : nodes.find((n) => n !== a && n !== b && reachA.has(n) && reachB.has(n) && ea === narrow && eb === narrow);
    if (owner !== undefined) {
      b.files = b.files.filter((f) => f !== eb);
      b.plan = gaveAway(b.plan, eb, owner.name);
      if (owner !== a) {
        a.files = a.files.filter((f) => f !== ea);
        a.plan = gaveAway(a.plan, ea, owner.name);
        owner.files.push(narrow);
        owner.plan = `${owner.plan.trimEnd()}\n\n- ${narrow}`;
      }
      notes.push(`moved ${narrow} to ${owner.name}: both ${a.name} and ${b.name} change it`);
      continue;
    }
    // Merge a and b with every workstream on a path between them (or the merged one would wait on itself).
    notes.push(`merged ${a.name} and ${b.name}: both change ${narrow}`);
    const group = nodes.filter((n) => n === a || n === b || (reachB.has(n) && reachOf(n).has(a)));
    const first = group[0] as OwnNode;
    const rest = group.slice(1);
    const needs = new Set(group.flatMap((n) => [...n.needs]).filter((n) => !group.includes(n)));
    first.name = group.map((n) => n.name).join(' and ').slice(0, 120);
    first.files = [...new Set(group.flatMap((n) => n.files))];
    const seen = new Set<string>();
    // A file bullet both plans carry is listed once.
    first.plan = group
      .map((n) => n.plan)
      .join('\n\n')
      .split('\n')
      .filter((line) => !/^- \S/.test(line.trim()) || !first.files.concat(...group.map((g) => g.files)).includes(line.trim().slice(2)) || (!seen.has(line.trim()) && seen.add(line.trim())))
      .join('\n');
    first.needs = needs;
    nodes = nodes.filter((n) => !rest.includes(n));
    for (const n of nodes) {
      if ([...n.needs].some((need) => rest.includes(need))) n.needs = new Set([...n.needs].map((need) => (rest.includes(need) ? first : need)));
      n.needs.delete(n);
    }
    nodes = topological(nodes);
  }
  if (nodes.length < 2) return null;
  const index = new Map(nodes.map((n, i) => [n, i]));
  const built: Workstream[] = nodes.map((n) => {
    const wanted = [...n.needs];
    const direct = wanted.filter((need) => !wanted.some((other) => other !== need && reachOf(other).has(need)));
    return { name: n.name, goal: n.goal, files: n.files, plan: n.plan, needs: direct.map((d) => index.get(d) as number).sort((x, y) => x - y) };
  });
  return { workstreams: built, ...splitShape(built), ...(notes.length > 0 ? { notes } : {}) };
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
  return applyOwnership(built);
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
  /** The glob's latest recorded workstreams block (the implementation record's); null when it has none (a small glob). */
  readonly workstreams: WorkstreamsBlock | null;
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

/** Why a fanned-out glob's parallel work stalled: a workstream that failed or was retried, or files that conflicted on integration. */
export const fanoutProblems = (block: WorkstreamsBlock): string[] => {
  const failed = block.workstreams.filter((w) => w.state === 'failed').map((w) => w.name);
  const retried = block.workstreams.filter((w) => w.state !== 'failed' && w.attempts > 1).map((w) => w.name);
  const conflicted = block.workstreams.filter((w) => w.conflicts.length > 0);
  return [
    ...(failed.length > 0 ? [`workstream${failed.length === 1 ? '' : 's'} ${failed.join(', ')} failed`] : []),
    ...(retried.length > 0 ? [`workstream${retried.length === 1 ? '' : 's'} ${retried.join(', ')} needed a retry`] : []),
    ...(conflicted.length > 0
      ? [`${conflicted.length} workstream${conflicted.length === 1 ? '' : 's'} conflicted on integration (${conflicted.map((w) => w.name).join(', ')})`]
      : []),
  ];
};

const fanoutSummary = (block: WorkstreamsBlock): string =>
  `${block.workstreams.length} workstreams, up to ${block.maxParallel} at the same time`;

/**
 * The outcome a merged glob with a size check shows, or null when it says nothing (unflagged and fine). Whether the glob
 * fanned out is read from its workstreams block (`fannedOut`), never from a decision on the board.
 * - unflagged and struggled, fanned out or not: `unflagged_struggled` (lower the limits);
 * - fanned out, otherwise: `fanout_helped` (lower the fan-out floor) when it merged cleanly and its workstreams ran without
 *   failure, retry or conflict; else `fanout_stalled` (raise the floor);
 * - flagged, not fanned out, merged cleanly: `kept_whole_clean` (raise the limits): the flag was advice and the glob went through whole;
 * - flagged, not fanned out, not clean: `flag_confirmed` (no move).
 */
export const sizeOutcomeOf = (input: SizeOutcomeInput, range: PrRange): { outcome: SizeOutcome; evidence: string } | null => {
  const struggled = struggles(input, range);
  if (!input.flagged && struggled.length > 0) return { outcome: 'unflagged_struggled', evidence: `Not flagged, and it ${struggled.join('; ')}` };
  const block = input.workstreams?.fannedOut === true ? input.workstreams : null;
  if (block !== null) {
    const problems = [...notClean(input, range), ...fanoutProblems(block)];
    return problems.length === 0
      ? { outcome: 'fanout_helped', evidence: `Fanned out (${fanoutSummary(block)}) and merged cleanly: no failed or retried workstream, no conflict, review rounds within the tier, no failed run, PR open time normal, no follow-up bug` }
      : { outcome: 'fanout_stalled', evidence: `Fanned out (${fanoutSummary(block)}), and it ${problems.join('; ')}` };
  }
  if (input.flagged) {
    const problems = notClean(input, range);
    return problems.length === 0
      ? { outcome: 'kept_whole_clean', evidence: 'Flagged oversized, and merged cleanly: review rounds within the tier, no failed run, PR open time normal, no follow-up bug' }
      : { outcome: 'flag_confirmed', evidence: `Flagged oversized, and it ${problems.join('; ')}` };
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

export const SIZE_EVENT_TYPES = ['PROpened', 'Merged', 'RunFailed', 'RunTriggered', 'PickedUp', 'WorkstreamsRecorded'] as const;
