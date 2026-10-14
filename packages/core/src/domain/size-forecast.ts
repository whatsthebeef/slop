import { isInvestigateEvent } from './events.js';
import type { DomainEvent } from './events.js';
import { contextSectionList, planTaskLines } from './intake-learning.js';
import type { Area, GlobOutcome } from './intake-learning.js';
import type { Investigation } from './investigation.js';
import type { RiskTier } from './knowledge.js';
import type { ProposedPart, SizeEstimate, SizeProposal, SizeThreshold } from './size-check.js';
import { MAX_PROPOSED_PARTS, isChain, splitShape } from './size-check.js';

/**
 * The size forecast (spec, Intake): what a plan will touch, read from the code and from similar merged globs rather than
 * from the plan's wording, calibrated per board against what the work turned out to be. Pure: the code view, the model
 * and the store are in `SizeCheckService`.
 */

/** Every code-view call of one footprint (the model's looking around and the final module read) stays within this. */
export const FOOTPRINT_MAX_CALLS = 6;
/** A unit of work is about this many files: `ceil(files / 4)` is compared with the board's task limit. */
export const FILES_PER_UNIT = 4;
export const REFERENCE_K = 5;
/** A similar glob counts only when its change summary is at least this close to the plan. */
export const REFERENCE_MIN_RELEVANCE = 0.25;
const LINES_PER_FILE = 50;
const LINES_PER_MIGRATION = 40;
const LINES_PER_TASK = 40;
const FILES_PER_TASK = 1.5;

const round = (n: number, places = 0): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : (((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
};

// ---------------------------------------------------------------------------
// Paths

const AREA_OF_PATH: readonly (readonly [Area, RegExp])[] = [
  ['migration', /(^|\/)(drizzle|migrations)\//],
  ['infra', /^infra\//],
  ['catalog', /(^|\/)catalog\//],
  ['web', /^apps\/web\//],
  ['cli', /^(apps|packages)\/cli\/|^sstor\//],
  ['llm', /(^|\/)(llm|prompts?|bedrock)(\/|[.-])/],
  ['server', /^(apps\/server|packages\/core)\//],
];

/** The area a path belongs to, or null. */
export const areaOfPath = (path: string): Area | null => AREA_OF_PATH.find(([, pattern]) => pattern.test(path))?.[0] ?? null;

/** The areas a set of paths falls in, in a fixed order. */
export const areasOfPaths = (paths: readonly string[]): Area[] => {
  const found = new Set(paths.map(areaOfPath));
  return AREA_OF_PATH.map(([area]) => area).filter((a) => found.has(a));
};

export const isMigrationPath = (path: string): boolean => /(^|\/)(drizzle|migrations)\//.test(path);
/** A route-style path: the surface other programs call. */
export const isApiPath = (path: string): boolean => /(^|\/)(http|mcp|routes)\//.test(path);
const isDocPath = (path: string): boolean => /\.(md|json|ya?ml|lock|txt)$/.test(path);

/**
 * The files named by a change summary chunk's `Files:` line (`Files: a, b, +3 more`): the paths shown and the total
 * count, or null when the text has no such line.
 */
export const parseFilesLine = (text: string): { readonly paths: readonly string[]; readonly count: number } | null => {
  const line = /^Files:[ \t]*(.*)$/m.exec(text)?.[1];
  if (line === undefined) return null;
  let more = 0;
  const paths: string[] = [];
  for (const raw of line.split(',')) {
    const item = raw.trim();
    const m = /^\+(\d+) more$/.exec(item);
    if (m?.[1] !== undefined) more = Number(m[1]);
    else if (item !== '') paths.push(item);
  }
  return paths.length === 0 && more === 0 ? null : { paths, count: paths.length + more };
};

// ---------------------------------------------------------------------------
// Types

export interface CodeFootprint {
  /** The files the plan is predicted to change. */
  readonly files: readonly string[];
  readonly modules: readonly string[];
  readonly moduleFiles: Readonly<Record<string, readonly string[]>>;
  /** Files outside the predicted set that import a predicted module, per module. */
  readonly importers: Readonly<Record<string, readonly string[]>>;
  readonly fanIn: number;
  readonly touchesMigration: boolean;
  readonly touchesPublicApi: boolean;
  readonly riskAreas: readonly string[];
}

export interface ReferenceSample {
  readonly globId: string;
  readonly title: string;
  readonly files: number | null;
  readonly lines: number | null;
  readonly rounds: number | null;
  readonly reworkRuns: number;
  readonly escalated: boolean;
  readonly followUpBugs: number;
  readonly areas: readonly Area[];
  /** No rework, no escalation, no follow-up bug, review within the tier. */
  readonly cleanSub: boolean;
}

export interface ReferenceClass {
  readonly samples: readonly ReferenceSample[];
  readonly summary: string;
}

export interface ForecastPart {
  readonly name: string;
  readonly files: readonly string[];
  /** Names of the other parts this one builds on. */
  readonly needs: readonly string[];
}

export interface SizeSignal {
  readonly files: number;
  readonly lines: number;
}

export interface SizeWeights {
  readonly code: number;
  readonly reference: number;
  readonly text: number;
}

export type ForecastConfidence = 'low' | 'medium' | 'high';

export interface SizeForecast {
  readonly source: 'code' | 'text';
  readonly files: { readonly count: number; readonly paths: readonly string[] };
  readonly modules: readonly string[];
  /** After the board's calibration. */
  readonly lines: { readonly min: number; readonly max: number };
  readonly parts: readonly ForecastPart[];
  readonly riskTier: RiskTier;
  readonly riskAreas: readonly string[];
  readonly areas: readonly Area[];
  readonly migration: boolean;
  readonly publicApi: boolean;
  readonly fanIn: number;
  readonly confidence: ForecastConfidence;
  readonly reference: ReferenceClass | null;
  /** What each source said on its own (the weights blend them). */
  readonly signals: { readonly code: SizeSignal | null; readonly reference: SizeSignal | null; readonly text: SizeSignal };
  readonly weights: SizeWeights;
  /** The calibration applied: the factor that scaled files and lines, and the per-area factors it came from. */
  readonly calibrated: { readonly scale: number; readonly areaFactors: Readonly<Record<string, number>> };
  readonly evidence: readonly string[];
}

// ---------------------------------------------------------------------------
// Calibration

export const WEIGHT_STEP = 0.05;
export const WEIGHT_MIN = 0.05;
/** Weights move only when the best and the worst signal are this far apart (relative file error). */
export const WEIGHT_GAP = 0.25;
export const FACTOR_MIN = 0.5;
export const FACTOR_MAX = 3;
/** A factor moves this much of the way to what the last glob showed. */
export const FACTOR_RATE = 0.3;
/** A move smaller than this is not worth a history row. */
export const FACTOR_MIN_MOVE = 0.05;

export interface SizeCalibration {
  readonly weights: SizeWeights;
  /** Actual lines over estimated, per area (1 = the estimate was right); absent areas are 1. */
  readonly areaFactors: Readonly<Partial<Record<Area, number>>>;
  readonly samples: number;
}

export const DEFAULT_SIZE_WEIGHTS: SizeWeights = { code: 0.6, reference: 0.3, text: 0.1 };
export const DEFAULT_SIZE_CALIBRATION: SizeCalibration = { weights: DEFAULT_SIZE_WEIGHTS, areaFactors: {}, samples: 0 };

export type CalibrationValue = { readonly factor: number } | { readonly weights: SizeWeights };

export interface SizeCalibrationChange {
  readonly id: number;
  readonly boardId: number;
  readonly at: string;
  readonly globId: string;
  readonly kind: 'area_factor' | 'weights';
  /** The area for an area factor, else null. */
  readonly area: Area | null;
  readonly from: CalibrationValue;
  readonly to: CalibrationValue;
  /** Why it moved, as plain text. */
  readonly cause: string;
}
export type NewSizeCalibrationChange = Omit<SizeCalibrationChange, 'id'>;

export interface SizeCalibrationView {
  readonly current: SizeCalibration;
  readonly defaults: SizeCalibration;
  readonly history: readonly SizeCalibrationChange[];
}

/** The factor the board's calibration puts on a forecast touching these areas (their mean; 1 when none is known). */
export const calibrationScale = (calibration: SizeCalibration, areas: readonly Area[]): number => {
  if (areas.length === 0) return 1;
  return round(areas.reduce((sum, a) => sum + (calibration.areaFactors[a] ?? 1), 0) / areas.length, 3);
};

/** The calibration as applied to a set of areas: what a forecast records. */
export const applyCalibration = (
  calibration: SizeCalibration,
  areas: readonly Area[],
): { readonly weights: SizeWeights; readonly scale: number; readonly areaFactors: Readonly<Record<string, number>> } => ({
  weights: calibration.weights,
  scale: calibrationScale(calibration, areas),
  areaFactors: Object.fromEntries(areas.map((a) => [a, calibration.areaFactors[a] ?? 1])),
});

// ---------------------------------------------------------------------------
// Parts

/**
 * The parts the footprint falls into: its files clustered by module. A cluster of documents and configuration only is
 * not a part (it joins the largest). A part `needs` another when a file outside the predicted set but in that part's
 * module imports the other's files (the importers the code view reports).
 */
export const partsFromFootprint = (footprint: CodeFootprint): ForecastPart[] => {
  const groups = new Map<string, string[]>();
  for (const [module, files] of Object.entries(footprint.moduleFiles)) if (files.length > 0) groups.set(module, [...files]);
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const largest = ordered.find(([, files]) => files.some((f) => !isDocPath(f)))?.[0] ?? ordered[0]?.[0];
  if (largest === undefined) return [];
  for (const [module, files] of ordered) {
    if (module !== largest && files.every(isDocPath)) {
      groups.get(largest)?.push(...files);
      groups.delete(module);
    }
  }
  const names = new Set(groups.keys());
  const needs = new Map<string, Set<string>>([...names].map((n) => [n, new Set<string>()]));
  for (const [module, importers] of Object.entries(footprint.importers)) {
    if (!names.has(module)) continue;
    for (const path of importers) {
      const importer = moduleOfPath(path);
      if (importer !== module && names.has(importer)) needs.get(importer)?.add(module);
    }
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([name, files]) => ({ name, files, needs: [...(needs.get(name) ?? [])].sort() }));
};

const MODULE_ROOTS: ReadonlySet<string> = new Set(['apps', 'packages', 'services', 'libs', 'modules', 'crates', 'cmd']);
/** Same rule as the code view's module of a path (kept local so this file stays free of the code-view domain). */
const moduleOfPath = (path: string): string => {
  const parts = path.split('/');
  if (parts.length < 2) return '.';
  const [first, second] = parts;
  return first !== undefined && second !== undefined && MODULE_ROOTS.has(first) && parts.length > 2 ? `${first}/${second}` : (first ?? '.');
};

/** The footprint's modules and file sets from a flat list of paths (modules the code view did not describe). */
export const footprintOf = (
  files: readonly string[],
  extra: {
    readonly importers?: Readonly<Record<string, readonly string[]>>;
    readonly fanIn?: number;
    readonly riskAreas?: readonly string[];
    readonly publicApi?: boolean;
  } = {},
): CodeFootprint => {
  const unique = [...new Set(files)];
  const moduleFiles: Record<string, string[]> = {};
  for (const f of unique) (moduleFiles[moduleOfPath(f)] ??= []).push(f);
  return {
    files: unique,
    modules: Object.keys(moduleFiles),
    moduleFiles,
    importers: extra.importers ?? {},
    fanIn: extra.fanIn ?? 0,
    touchesMigration: unique.some(isMigrationPath),
    touchesPublicApi: (extra.publicApi ?? false) || unique.some(isApiPath),
    riskAreas: extra.riskAreas ?? [],
  };
};

// ---------------------------------------------------------------------------
// Reference class

/** The events the reference class and the three-point record read. */
export const FORECAST_EVENT_TYPES = ['PROpened', 'Merged', 'RunFailed', 'Escalated'] as const;

const pluralised = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

/** One similar merged glob with its real outcome (pure). */
export const sampleOf = (input: {
  readonly globId: string;
  readonly title: string;
  readonly files: { readonly paths: readonly string[]; readonly count: number } | null;
  readonly outcome: GlobOutcome | null;
  readonly events: readonly DomainEvent[];
}): ReferenceSample => {
  const { outcome } = input;
  const reworkRuns = input.events.filter((e) => e.type === 'RunFailed' && !isInvestigateEvent(e)).length;
  const escalated = input.events.some((e) => e.type === 'Escalated');
  const followUpBugs = outcome?.postMerge.fixGlobs.length ?? 0;
  const rounds = outcome?.review.rounds ?? null;
  const maxRounds = outcome?.review.maxRounds ?? null;
  return {
    globId: input.globId,
    title: input.title,
    files: input.files?.count ?? null,
    lines: outcome?.size.changedLines ?? null,
    rounds,
    reworkRuns,
    escalated,
    followUpBugs,
    areas: input.files === null ? [] : areasOfPaths(input.files.paths),
    cleanSub: reworkRuns === 0 && !escalated && followUpBugs === 0 && !(rounds !== null && maxRounds !== null && rounds >= maxRounds),
  };
};

export const referenceFrom = (samples: readonly ReferenceSample[]): ReferenceClass => {
  const files = median(samples.flatMap((s) => (s.files === null ? [] : [s.files])));
  const lines = median(samples.flatMap((s) => (s.lines === null ? [] : [s.lines])));
  const rework = samples.filter((s) => s.reworkRuns > 0).length;
  const escalated = samples.filter((s) => s.escalated).length;
  const bugs = samples.filter((s) => s.followUpBugs > 0).length;
  const summary =
    samples.length === 0
      ? 'No similar merged globs found'
      : [
          pluralised(samples.length, 'similar merged glob'),
          files === null ? 'file counts unknown' : `median ${round(files)} files`,
          lines === null ? 'line counts unknown' : `median ${round(lines)} lines`,
          `${String(rework)} needed rework, ${String(escalated)} escalated, ${String(bugs)} followed by a bug`,
          `${String(samples.filter((s) => s.cleanSub).length)} clean`,
        ].join('; ');
  return { samples, summary };
};

const referenceSignal = (reference: ReferenceClass | null): SizeSignal | null => {
  if (reference === null) return null;
  const files = median(reference.samples.flatMap((s) => (s.files === null ? [] : [s.files])));
  const lines = median(reference.samples.flatMap((s) => (s.lines === null ? [] : [s.lines])));
  if (files === null && lines === null) return null;
  return { files: files ?? Math.max(1, (lines ?? 0) / LINES_PER_FILE), lines: lines ?? (files ?? 0) * LINES_PER_FILE };
};

// ---------------------------------------------------------------------------
// Forecast

const codeSignal = (footprint: CodeFootprint): SizeSignal | null =>
  footprint.files.length === 0
    ? null
    : { files: footprint.files.length, lines: footprint.files.length * LINES_PER_FILE + (footprint.touchesMigration ? LINES_PER_MIGRATION : 0) };

const textSignal = (text: SizeEstimate): SizeSignal => ({
  files: Math.max(1, round(text.tasks * FILES_PER_TASK)),
  lines: Math.max(30, text.tasks * LINES_PER_TASK),
});

const tierOf = (footprint: CodeFootprint, files: number): RiskTier =>
  footprint.touchesMigration || footprint.touchesPublicApi || footprint.riskAreas.length > 0 || footprint.fanIn >= 20
    ? 'high'
    : footprint.modules.length >= 2 || files >= 8
      ? 'normal'
      : 'low';

/** The forecast from the code footprint, the reference class and the plan's text estimate, with the board's calibration. */
export const forecastFrom = (
  footprint: CodeFootprint,
  reference: ReferenceClass | null,
  text: SizeEstimate,
  calibration: SizeCalibration,
): SizeForecast => {
  const code = codeSignal(footprint);
  const ref = referenceSignal(reference);
  const textual = textSignal(text);
  const areas = areasOfPaths(footprint.files);
  const applied = applyCalibration(calibration, areas);
  const w = applied.weights;
  const used: [SizeSignal, number][] = [
    ...(code === null ? [] : [[code, w.code] as [SizeSignal, number]]),
    ...(ref === null ? [] : [[ref, w.reference] as [SizeSignal, number]]),
    [textual, w.text],
  ];
  const total = used.reduce((sum, [, weight]) => sum + weight, 0) || 1;
  const blend = (pick: (s: SizeSignal) => number): number => used.reduce((sum, [s, weight]) => sum + pick(s) * weight, 0) / total;
  const files = Math.max(1, round(blend((s) => s.files) * applied.scale));
  const mid = blend((s) => s.lines) * applied.scale;
  const sampled = reference?.samples.length ?? 0;
  const confidence: ForecastConfidence = code === null ? 'low' : sampled >= 3 ? 'high' : 'medium';
  const spread = confidence === 'high' ? { lo: 0.75, hi: 1.35 } : { lo: 0.6, hi: 1.6 };
  const lines = { min: Math.max(1, round(mid * spread.lo)), max: Math.max(1, round(mid * spread.hi)) };
  const parts = partsFromFootprint(footprint);
  const evidence = [
    `Predicted from the code: ${pluralised(footprint.files.length, 'file')} in ${pluralised(parts.length, 'part')} (${parts.map((p) => p.name).join(', ') || 'none'})`,
    ...(footprint.touchesMigration ? ['Touches a migration'] : []),
    ...(footprint.touchesPublicApi ? ['Touches the public API'] : []),
    ...(footprint.riskAreas.length > 0 ? [`Risk areas: ${footprint.riskAreas.join(', ')}`] : []),
    ...(reference === null ? [] : [`History: ${reference.summary}`]),
    ...(applied.scale === 1 ? [] : [`Calibrated for this board: x${String(applied.scale)} (${Object.entries(applied.areaFactors).map(([a, f]) => `${a} x${String(f)}`).join(', ')})`]),
  ];
  return {
    source: code === null ? 'text' : 'code',
    files: { count: files, paths: footprint.files },
    modules: footprint.modules,
    lines,
    parts,
    riskTier: tierOf(footprint, files),
    riskAreas: footprint.riskAreas,
    areas,
    migration: footprint.touchesMigration,
    publicApi: footprint.touchesPublicApi,
    fanIn: footprint.fanIn,
    confidence,
    reference,
    signals: { code, reference: ref, text: textual },
    weights: w,
    calibrated: { scale: applied.scale, areaFactors: applied.areaFactors },
    evidence,
  };
};

/** Units of work the forecast stands for: about four files each. */
export const forecastUnits = (forecast: SizeForecast): number => Math.ceil(forecast.files.count / FILES_PER_UNIT);

/**
 * The forecast's part count that is "many": the board's part limit, but never fewer than this, so the learned floor of
 * 2 cannot flag every two-module change.
 */
export const FORECAST_MIN_PARTS = 3;

/** The forecast's parts in build order, with each one's direct needs as indexes of earlier parts. */
const arranged = (
  forecast: SizeForecast,
): { readonly ordered: readonly ForecastPart[]; readonly after: readonly (readonly number[])[] } => {
  const ordered = orderParts(forecast.parts).slice(0, MAX_PROPOSED_PARTS);
  const reach: Set<number>[] = [];
  const after: number[][] = [];
  for (const [index, part] of ordered.entries()) {
    const wanted = ordered.flatMap((other, earlier) => (earlier < index && part.needs.includes(other.name) ? [earlier] : []));
    // Direct needs only: a part that needs another through a third does not name it as well.
    const direct = wanted.filter((n) => !wanted.some((m) => m !== n && reach[m]?.has(n) === true));
    reach[index] = new Set(direct.flatMap((n) => [n, ...(reach[n] ?? [])]));
    after.push(direct);
  }
  return { ordered, after };
};

/** The shape of the forecast's parts (the longest chain of needs, the most that can run at once). */
export const forecastShape = (forecast: SizeForecast): { criticalPath: number; maxParallel: number } =>
  splitShape(arranged(forecast).after.map((after) => ({ after })));

/**
 * Why the forecast says the work is more than one PR's. Like the text rule, size alone never flags: at least 2 parts must
 * be buildable at the same time (a core -> server -> web chain stays whole). Then it flags when the parts number
 * `maxParts` or more (never fewer than `FORECAST_MIN_PARTS`: each part is a module, so each is already a split point) or
 * the calibrated file count makes more units of work than the task limit.
 */
export const forecastReasons = (forecast: SizeForecast, threshold: SizeThreshold): string[] => {
  const { maxParallel } = forecastShape(forecast);
  if (maxParallel < 2) return [];
  const limit = Math.max(threshold.maxParts, FORECAST_MIN_PARTS);
  const units = forecastUnits(forecast);
  const big = [
    ...(forecast.parts.length >= limit
      ? [`${String(forecast.parts.length)} parts in separate modules (${forecast.parts.map((p) => p.name).join(', ')}); the limit is ${String(limit - 1)}`]
      : []),
    ...(units > threshold.maxTasks ? [`about ${String(forecast.files.count)} files, ${String(units)} units of work (more than ${String(threshold.maxTasks)})`] : []),
  ];
  return big.length === 0 ? [] : [...big, `${String(maxParallel)} parts could be built at the same time`];
};

export const forecastFlag = (forecast: SizeForecast, threshold: SizeThreshold): boolean => forecastReasons(forecast, threshold).length > 0;

/** The evidence lines the forecast adds to a size check. */
export const forecastEvidence = (forecast: SizeForecast): string[] => [
  `Forecast (${forecast.confidence} confidence): ${String(forecast.files.count)} files, ${String(forecast.lines.min)}-${String(forecast.lines.max)} lines, ${pluralised(forecast.parts.length, 'part')}, risk ${forecast.riskTier}`,
  ...forecast.evidence,
];

/**
 * The fan-out proposal from the forecast's part file sets (pure): one part per forecast part, part 0 stays the original
 * glob. Plan tasks that name a part's files or module go to it (the rest to part 0), context sections go to every part.
 * A part starts after the parts it `needs` (direct needs only). Null
 * below 2 parts, and for a chain (parts waiting on each other in one line gain nothing from a split).
 */
export const proposalFromForecast = (plan: string, forecast: SizeForecast): SizeProposal | null => {
  const { ordered, after } = arranged(forecast);
  if (ordered.length < 2) return null;
  const tasks = planTaskLines(plan);
  const owner = (task: string): number => {
    const found = ordered.findIndex((p) => task.includes(p.name) || p.files.some((f) => task.includes(f)));
    return found === -1 ? 0 : found;
  };
  const context = contextSectionList(plan);
  const goal = plan.split(/\r?\n/).find((l) => l.trim() !== '' && !l.startsWith('#'))?.trim() ?? '';
  const parts: ProposedPart[] = ordered.map((part, index) => {
    const own = tasks.filter((t) => owner(t) === index);
    const body = [
      `# ${part.name}`,
      ...(goal === '' ? [] : [goal]),
      '## Files',
      ...part.files.map((f) => `- ${f}`),
      '## Tasks',
      ...(own.length === 0 ? [`- [ ] Make this part's share of the change in ${part.name}`] : own),
      ...context.map((s) => `## ${s.heading}\n\n${s.body}`),
    ];
    return {
      title: `${part.name} (${String(part.files.length)} file${part.files.length === 1 ? '' : 's'})`.slice(0, 120),
      summary: `The change in ${part.name}: ${part.files.slice(0, 3).join(', ')}${part.files.length > 3 ? ', ...' : ''}`,
      plan: body.join('\n\n'),
      after: after[index] ?? [],
    };
  });
  const proposal: SizeProposal = { parts, ...splitShape(parts) };
  return isChain(proposal) ? null : proposal;
};

/** Parts in an order that builds what others need first (stable otherwise). */
const orderParts = (parts: readonly ForecastPart[]): ForecastPart[] => {
  const left = [...parts];
  const out: ForecastPart[] = [];
  while (left.length > 0) {
    const index = left.findIndex((p) => p.needs.every((n) => out.some((o) => o.name === n) || !left.some((l) => l.name === n)));
    out.push(...left.splice(index === -1 ? 0 : index, 1));
  }
  return out;
};

// ---------------------------------------------------------------------------
// Three-point record and calibration

/** The three points of one merged glob: what was forecast, what the investigator found, and what happened. */
export interface SizeRecord {
  readonly globId: string;
  readonly boardId: number;
  readonly recordedAt: string;
  readonly estimate: SizeForecast;
  readonly investigation: Investigation | null;
  readonly actual: {
    readonly files: number | null;
    readonly lines: number | null;
    readonly rounds: number | null;
    readonly reworkRuns: number;
    readonly escalated: boolean;
    readonly followUpBugs: number;
    readonly hoursOpen: number | null;
  };
}

export const sizeRecordOf = (input: {
  readonly globId: string;
  readonly boardId: number;
  readonly at: string;
  readonly forecast: SizeForecast;
  readonly investigation: Investigation | null;
  readonly outcome: GlobOutcome;
  readonly files: { readonly count: number } | null;
  readonly events: readonly DomainEvent[];
  readonly hoursOpen: number | null;
}): SizeRecord => ({
  globId: input.globId,
  boardId: input.boardId,
  recordedAt: input.at,
  estimate: input.forecast,
  investigation: input.investigation,
  actual: {
    files: input.files?.count ?? null,
    lines: input.outcome.size.changedLines,
    rounds: input.outcome.review.rounds,
    reworkRuns: input.events.filter((e) => e.type === 'RunFailed' && !isInvestigateEvent(e)).length,
    escalated: input.events.some((e) => e.type === 'Escalated'),
    followUpBugs: input.outcome.postMerge.fixGlobs.length,
    hoursOpen: input.hoursOpen,
  },
});

export interface Calibrated {
  readonly state: SizeCalibration;
  readonly changes: readonly Omit<NewSizeCalibrationChange, 'boardId' | 'at'>[];
}

const SIGNALS = ['code', 'reference', 'text'] as const;

const normalised = (w: SizeWeights): SizeWeights => {
  const total = w.code + w.reference + w.text;
  return { code: round(w.code / total, 2), reference: round(w.reference / total, 2), text: round(w.text / total, 2) };
};

/**
 * Moves the calibration with one record (pure). Area factors: for each area the forecast named, the factor moves
 * `FACTOR_RATE` of the way to actual lines over the uncalibrated estimate. Weights: when the investigator's file count
 * disagrees with the signals unevenly, the weight of the worst signal moves by `WEIGHT_STEP` to the best. Each move is
 * a change row with its cause; moves under the minimum are not recorded.
 */
export const calibrate = (calibration: SizeCalibration, record: SizeRecord): Calibrated => {
  const changes: Omit<NewSizeCalibrationChange, 'boardId' | 'at'>[] = [];
  const factors: Partial<Record<Area, number>> = { ...calibration.areaFactors };
  const forecast = record.estimate;
  const { lines } = record.actual;
  if (lines !== null && forecast.areas.length > 0) {
    const raw = ((forecast.lines.min + forecast.lines.max) / 2) / (forecast.calibrated.scale || 1);
    if (raw > 0) {
      const target = lines / raw;
      for (const area of forecast.areas) {
        const old = calibration.areaFactors[area] ?? 1;
        const next = round(clamp(old + FACTOR_RATE * (target - old), FACTOR_MIN, FACTOR_MAX), 2);
        if (Math.abs(next - old) < FACTOR_MIN_MOVE) continue;
        factors[area] = next;
        changes.push({
          globId: record.globId,
          kind: 'area_factor',
          area,
          from: { factor: old },
          to: { factor: next },
          cause: `${area}: ${record.globId} changed ${String(lines)} lines against an estimate of about ${String(round(raw))} (x${String(round(target, 2))}), so the ${area} correction moves from x${String(old)} to x${String(next)}`,
        });
      }
    }
  }
  let weights = calibration.weights;
  const truth = record.investigation?.files.length;
  if (truth !== undefined) {
    const errors = SIGNALS.flatMap((name) => {
      const signal = forecast.signals[name];
      return signal === null ? [] : [{ name, files: signal.files, error: Math.abs(signal.files - truth) / Math.max(1, truth) }];
    });
    if (errors.length >= 2) {
      const best = [...errors].sort((a, b) => a.error - b.error)[0];
      const worst = [...errors].filter((e) => weights[e.name] - WEIGHT_STEP >= WEIGHT_MIN - 1e-9).sort((a, b) => b.error - a.error)[0];
      if (best !== undefined && worst !== undefined && best.name !== worst.name && worst.error - best.error >= WEIGHT_GAP) {
        const to = normalised({ ...weights, [worst.name]: weights[worst.name] - WEIGHT_STEP, [best.name]: weights[best.name] + WEIGHT_STEP });
        changes.push({
          globId: record.globId,
          kind: 'weights',
          area: null,
          from: { weights },
          to: { weights: to },
          cause: `The investigation of ${record.globId} found ${String(truth)} files: the ${worst.name} signal said ${String(worst.files)} (${String(round(worst.error * 100))}% off) and the ${best.name} signal said ${String(best.files)} (${String(round(best.error * 100))}% off), so weight moves from ${worst.name} to ${best.name}`,
        });
        weights = to;
      }
    }
  }
  return { state: { weights, areaFactors: factors, samples: calibration.samples + 1 }, changes };
};
