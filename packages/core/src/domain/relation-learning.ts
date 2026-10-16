import type { Result } from './errors.js';
import { invalidInput, ok } from './errors.js';
import type { RelationSource } from './types.js';

/**
 * How readily slop creates relations, learned per board and relation source from what happened to them (spec, Dependencies).
 * Pure: signals in, precision, recall and a posture out. Recording and storage are in `RelationLearningService`.
 */

/** What happened to a relation, or to two globs that had none. */
export const RELATION_SIGNAL_KINDS = [
  // False positives: a relation that was not needed.
  'fp_override',
  'fp_dismissed',
  'fp_not_needed',
  // True positives: a relation that was needed.
  'tp_needed',
  'tp_promoted',
  // False negatives: a dependency that had no relation.
  'fn_person_added',
  'fn_conflict',
  'fn_red_main',
  'fn_failed_run',
] as const;
export type RelationSignalKind = (typeof RELATION_SIGNAL_KINDS)[number];

const FALSE_POSITIVES: ReadonlySet<RelationSignalKind> = new Set(['fp_override', 'fp_dismissed', 'fp_not_needed']);
const TRUE_POSITIVES: ReadonlySet<RelationSignalKind> = new Set(['tp_needed', 'tp_promoted']);
const FALSE_NEGATIVES: ReadonlySet<RelationSignalKind> = new Set(['fn_person_added', 'fn_conflict', 'fn_red_main', 'fn_failed_run']);

export const isRelationFalsePositive = (kind: RelationSignalKind): boolean => FALSE_POSITIVES.has(kind);
export const isRelationTruePositive = (kind: RelationSignalKind): boolean => TRUE_POSITIVES.has(kind);
export const isRelationFalseNegative = (kind: RelationSignalKind): boolean => FALSE_NEGATIVES.has(kind);

/** The sources the learning tells apart: `mention` stands for `auto` too (the old name of the same thing). */
export const RELATION_LEARNING_SOURCES = ['mention', 'inferred', 'agent', 'person', 'learned', 'split'] as const;
export type RelationLearningSource = (typeof RELATION_LEARNING_SOURCES)[number];

/** The source a signal is recorded under: a collision has no relation, so no source. */
export type RelationSignalSource = RelationLearningSource | 'none';

/** A stored relation source as the learning names it (`auto` is `mention`). */
export const normaliseSource = (source: RelationSource): RelationLearningSource => (source === 'auto' ? 'mention' : source);

/** A signal as it is stored: once per board and `key`. */
export interface RelationSignal {
  readonly id: string;
  readonly boardId: number;
  readonly from: string;
  readonly to: string;
  /** The relation it is about; null for a dependency that had none. */
  readonly relationId: string | null;
  readonly source: RelationSignalSource;
  readonly signal: RelationSignalKind;
  readonly at: string;
  /** One line: what happened. */
  readonly evidence: string;
  /** What makes the signal the same one again (the outbox may repeat a merge); unique per board. */
  readonly key: string;
}

// ---------------------------------------------------------------------------
// Defaults and pins

export const RELATION_LEARNING_DEFAULTS = {
  /** Only signals this recent count. */
  windowDays: 90,
  /** A source whose precision is below this makes only weak links. */
  precisionThreshold: 0.5,
  /** A source whose recall is below this gets bolder. */
  recallThreshold: 0.5,
  /** Fewer samples than this move nothing: a new board behaves as before. */
  minSamples: 5,
} as const;

/** The sources a low precision can make weak: the ones slop creates by itself. */
export const WEAKENABLE_SOURCES: readonly RelationLearningSource[] = ['mention', 'inferred'];
/** The sources a false negative is blamed on: the ones that could have proposed the missing relation. */
export const RECALL_SOURCES: readonly RelationLearningSource[] = ['inferred', 'agent'];

export type RelationPosture = 'gate' | 'weak';
export const RELATION_POSTURES: readonly RelationPosture[] = ['gate', 'weak'];

export const MAX_PIN_HISTORY = 50;

/** One change to the pins: who and when. */
export interface PinChange {
  readonly at: string;
  readonly by: string;
  readonly what: string;
}

/** What an admin pinned for a board; anything absent is learned or the default. */
export interface RelationLearningSettings {
  readonly precisionThreshold?: number;
  readonly recallThreshold?: number;
  readonly windowDays?: number;
  readonly minSamples?: number;
  /** A source pinned to `gate` or `weak`, whatever its precision. */
  readonly postures?: Readonly<Partial<Record<RelationLearningSource, RelationPosture>>>;
  readonly history?: readonly PinChange[];
}

export const NO_SETTINGS: RelationLearningSettings = {};

/** What an admin may pin (the history is kept by the service). */
export type PinInput = Omit<RelationLearningSettings, 'history'>;

const isSource = (value: string): value is RelationLearningSource => RELATION_LEARNING_SOURCES.some((s) => s === value);
const isPosture = (value: unknown): value is RelationPosture => value === 'gate' || value === 'weak';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const fraction = (value: unknown, name: string): Result<number> =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? ok(value) : invalidInput(`${name} must be a number above 0 and at most 1`);
const whole = (value: unknown, name: string, min: number, max: number): Result<number> =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? ok(value) : invalidInput(`${name} must be a whole number from ${min} to ${max}`);

/**
 * Checks what an admin wants pinned: thresholds in (0, 1], a window of 7 to 365 days, a sample minimum of 1 to 100, and a posture
 * only for a source that can be weakened (`auto` is read as `mention`). Unknown keys are refused, so a typo is not silently ignored.
 */
export const validatePins = (raw: unknown): Result<PinInput> => {
  if (!isRecord(raw)) return invalidInput('Pins must be an object');
  const out: { -readonly [K in keyof PinInput]: PinInput[K] } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (key === 'precisionThreshold' || key === 'recallThreshold') {
      const checked = fraction(value, key);
      if (!checked.ok) return checked;
      out[key] = checked.value;
    } else if (key === 'windowDays') {
      const checked = whole(value, key, 7, 365);
      if (!checked.ok) return checked;
      out.windowDays = checked.value;
    } else if (key === 'minSamples') {
      const checked = whole(value, key, 1, 100);
      if (!checked.ok) return checked;
      out.minSamples = checked.value;
    } else if (key === 'postures') {
      if (!isRecord(value)) return invalidInput('postures must be an object of source to gate or weak');
      const postures: Partial<Record<RelationLearningSource, RelationPosture>> = {};
      for (const [name, posture] of Object.entries(value)) {
        const source = name === 'auto' ? 'mention' : name;
        if (!isSource(source) || !WEAKENABLE_SOURCES.includes(source)) return invalidInput(`${name} cannot be pinned: only ${WEAKENABLE_SOURCES.join(' and ')} can be`);
        if (posture === undefined || posture === null) continue;
        if (!isPosture(posture)) return invalidInput(`The posture of ${name} must be gate or weak`);
        postures[source] = posture;
      }
      if (Object.keys(postures).length > 0) out.postures = postures;
    } else {
      return invalidInput(`Unknown pin ${key}`);
    }
  }
  return ok(out);
};

/** The settings with `pins` applied over them (a key absent from `pins` stays) and one history line added; at most `MAX_PIN_HISTORY` are kept. */
export const pinned = (settings: RelationLearningSettings, pins: PinInput, change: PinChange): RelationLearningSettings => {
  const postures = { ...settings.postures, ...pins.postures };
  return {
    ...settings,
    ...pins,
    ...(Object.keys(postures).length === 0 ? {} : { postures }),
    history: [...(settings.history ?? []), change].slice(-MAX_PIN_HISTORY),
  };
};

/** The settings with what an admin reset removed (all pins, or one named pin or source's posture) and one history line added. */
export const unpinned = (settings: RelationLearningSettings, what: string | undefined, change: PinChange): RelationLearningSettings => {
  const history = [...(settings.history ?? []), change].slice(-MAX_PIN_HISTORY);
  if (what === undefined) return { history };
  const source = what === 'auto' ? 'mention' : what;
  const postures: { -readonly [S in RelationLearningSource]?: RelationPosture } = {};
  for (const name of WEAKENABLE_SOURCES) {
    const posture = settings.postures?.[name];
    if (posture !== undefined && name !== source) postures[name] = posture;
  }
  return {
    ...(what !== 'precisionThreshold' && settings.precisionThreshold !== undefined ? { precisionThreshold: settings.precisionThreshold } : {}),
    ...(what !== 'recallThreshold' && settings.recallThreshold !== undefined ? { recallThreshold: settings.recallThreshold } : {}),
    ...(what !== 'windowDays' && settings.windowDays !== undefined ? { windowDays: settings.windowDays } : {}),
    ...(what !== 'minSamples' && settings.minSamples !== undefined ? { minSamples: settings.minSamples } : {}),
    ...(Object.keys(postures).length === 0 ? {} : { postures }),
    history,
  };
};

/** The thresholds in force: a pin, else the default. */
export interface RelationThresholds {
  readonly windowDays: number;
  readonly precision: number;
  readonly recall: number;
  readonly minSamples: number;
}

export const thresholdsOf = (settings: RelationLearningSettings = NO_SETTINGS): RelationThresholds => ({
  windowDays: settings.windowDays ?? RELATION_LEARNING_DEFAULTS.windowDays,
  precision: settings.precisionThreshold ?? RELATION_LEARNING_DEFAULTS.precisionThreshold,
  recall: settings.recallThreshold ?? RELATION_LEARNING_DEFAULTS.recallThreshold,
  minSamples: settings.minSamples ?? RELATION_LEARNING_DEFAULTS.minSamples,
});

// ---------------------------------------------------------------------------
// Metrics

const DAY_MS = 86_400_000;

/** The signals inside the rolling window ending at `now`. */
export const windowed = (signals: readonly RelationSignal[], now: string, windowDays: number): RelationSignal[] => {
  const from = Date.parse(now) - windowDays * DAY_MS;
  const to = Date.parse(now);
  return signals.filter((s) => {
    const at = Date.parse(s.at);
    return at >= from && at <= to;
  });
};

/** How a source did over the window. */
export interface RelationSourceStats {
  readonly source: RelationLearningSource;
  /** Per signal kind, for display. */
  readonly counts: Readonly<Record<RelationSignalKind, number>>;
  readonly tp: number;
  readonly fp: number;
  /** False negatives credited to this source (see `RECALL_SOURCES`); the same ones are credited to each source that could have proposed them. */
  readonly fn: number;
  /** tp / (tp + fp); null with no samples. */
  readonly precision: number | null;
  /** tp / (tp + fn); null for a source that is not blamed for misses, or with no samples. */
  readonly recall: number | null;
  /** tp + fp: what the precision rests on. */
  readonly precisionSamples: number;
  /** tp + fn: what the recall rests on (0 for a source with no recall). */
  readonly recallSamples: number;
}

const emptyCounts = (): Record<RelationSignalKind, number> => ({
  fp_override: 0,
  fp_dismissed: 0,
  fp_not_needed: 0,
  tp_needed: 0,
  tp_promoted: 0,
  fn_person_added: 0,
  fn_conflict: 0,
  fn_red_main: 0,
  fn_failed_run: 0,
});

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/**
 * Precision and recall per source over the rolling window. Precision of a source is tp / (tp + fp). Recall counts every false
 * negative against each source that could have proposed the missing relation (`inferred` and `agent`: a mention is bound to what
 * the text says, so it is not blamed; a person's and a learned relation show precision only).
 */
export const precisionRecall = (signals: readonly RelationSignal[], now: string, windowDays: number = RELATION_LEARNING_DEFAULTS.windowDays): Record<RelationLearningSource, RelationSourceStats> => {
  const inside = windowed(signals, now, windowDays);
  const misses = inside.filter((s) => isRelationFalseNegative(s.signal)).length;
  const out = {} as Record<RelationLearningSource, RelationSourceStats>;
  for (const source of RELATION_LEARNING_SOURCES) {
    const counts = emptyCounts();
    for (const s of inside) if (s.source === source) counts[s.signal] += 1;
    let tp = 0;
    let fp = 0;
    for (const kind of RELATION_SIGNAL_KINDS) {
      if (isRelationTruePositive(kind)) tp += counts[kind];
      if (isRelationFalsePositive(kind)) fp += counts[kind];
    }
    const blamed = RECALL_SOURCES.includes(source);
    const fn = blamed ? misses : 0;
    out[source] = {
      source,
      counts,
      tp,
      fp,
      fn,
      precision: ratio(tp, tp + fp),
      recall: blamed ? ratio(tp, tp + fn) : null,
      precisionSamples: tp + fp,
      recallSamples: blamed ? tp + fn : 0,
    };
  }
  return out;
};

// ---------------------------------------------------------------------------
// RelationPosture

/** How readily a source creates gating relations on a board. */
export interface RelationSourcePosture {
  readonly source: RelationLearningSource;
  /** `gate`: relations hold as usual. `weak`: only `may_relate` links, which hold nothing. */
  readonly posture: RelationPosture;
  /** Inference also proposes relations for globs touching the same modules (the source's recall is low). */
  readonly bold: boolean;
  /** An admin pinned the posture. */
  readonly pinned: boolean;
  /** The source's precision rests on at least the minimum samples (so a `gate` posture is earned, not a default). */
  readonly measured: boolean;
  /** Why, in words: the numbers, "pinned by an admin" or "not enough data". */
  readonly why: string;
}

const percent = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * The posture of a source from its stats and the board's pins. A pin wins. Otherwise a source that can be weakened is weak when
 * its precision is below the threshold over at least the minimum samples; below the minimum the answer is the default (`gate`) and
 * says "not enough data". `bold` is for `inferred` when its recall is below the threshold over at least the minimum samples.
 */
export const postureOf = (source: RelationLearningSource, stats: RelationSourceStats, settings: RelationLearningSettings = NO_SETTINGS): RelationSourcePosture => {
  const t = thresholdsOf(settings);
  const pin = WEAKENABLE_SOURCES.includes(source) ? settings.postures?.[source] : undefined;
  const measured = stats.precision !== null && stats.precisionSamples >= t.minSamples;
  const bold = source === 'inferred' && stats.recall !== null && stats.recallSamples >= t.minSamples && stats.recall < t.recall;
  if (pin !== undefined) return { source, posture: pin, bold, pinned: true, measured, why: `pinned to ${pin} by an admin` };
  if (!WEAKENABLE_SOURCES.includes(source)) return { source, posture: 'gate', bold, pinned: false, measured, why: 'always gates' };
  if (stats.precision === null || stats.precisionSamples < t.minSamples) {
    return { source, posture: 'gate', bold, pinned: false, measured, why: `not enough data (${stats.precisionSamples} of ${t.minSamples} samples)` };
  }
  if (stats.precision < t.precision) {
    return { source, posture: 'weak', bold, pinned: false, measured, why: `precision ${percent(stats.precision)} is below ${percent(t.precision)} over ${stats.precisionSamples} samples` };
  }
  return { source, posture: 'gate', bold, pinned: false, measured, why: `precision ${percent(stats.precision)} over ${stats.precisionSamples} samples` };
};

/** The posture of every source. */
export const posturesOf = (stats: Readonly<Record<RelationLearningSource, RelationSourceStats>>, settings: RelationLearningSettings = NO_SETTINGS): Record<RelationLearningSource, RelationSourcePosture> => {
  const out = {} as Record<RelationLearningSource, RelationSourcePosture>;
  for (const source of RELATION_LEARNING_SOURCES) out[source] = postureOf(source, stats[source], settings);
  return out;
};

/** A source's stats and posture together, for the view. */
export interface RelationSourceView extends RelationSourceStats {
  readonly posture: RelationSourcePosture;
}

/** The board's relation learning as members see it: the window and thresholds in force, each source's numbers and posture, the pins. */
export interface RelationLearningView {
  readonly thresholds: RelationThresholds;
  readonly defaults: RelationThresholds;
  readonly sources: readonly RelationSourceView[];
  readonly pins: RelationLearningSettings;
}

/** Whether a source's relations are made weak right now (the creation paths ask this). */
export const isWeak = (posture: RelationSourcePosture | undefined): boolean => posture?.posture === 'weak';

// ---------------------------------------------------------------------------
// Keys: one per cause, so a repeated cause records once.

export const signalKey = {
  override: (relationId: string): string => `override:${relationId}`,
  dismissed: (relationId: string): string => `dismissed:${relationId}`,
  verdict: (relationId: string): string => `verdict:${relationId}`,
  promoted: (relationId: string): string => `promoted:${relationId}`,
  personAdded: (from: string, to: string): string => `person:${from}>${to}`,
  conflict: (culprit: string, other: string): string => `conflict:${culprit}>${other}`,
  redMain: (culprit: string, other: string): string => `redmain:${culprit}>${other}`,
  failedRun: (from: string, to: string): string => `failed:${from}>${to}`,
} as const;
