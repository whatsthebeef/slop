import type { KbOutcome } from './kb.js';
import { isAgentSetKind } from './knowledge.js';
import {
  globAgentSetVersion,
  measureSignals,
  perGlob,
  signalDefinition,
  signalKindOf,
} from './signals.js';
import type { BoardActivity } from './signals.js';

/**
 * Effect checks (spec, self-improvement: "Effect check"): after an approved change with a signal, slop compares the
 * signal's rate over the last N eligible globs merged before the approval with the first N merged after it that ran
 * with the change. Pure: the effect-check service reads the activity and writes the result on the approved item.
 */

export const EFFECT_STATES = [
  'watching',
  'improved',
  'not_improved',
  'worse_elsewhere',
  'unmeasurable',
] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

/** Globs per side (`boards.effect_check_globs`): the default, and the range admins can set. */
export const EFFECT_CHECK_GLOBS_DEFAULT = 10;
export const EFFECT_CHECK_GLOBS_MIN = 3;
export const EFFECT_CHECK_GLOBS_MAX = 50;

/**
 * The verdict's thresholds, fractions as [numerator, denominator] so the comparisons stay whole-number: improved at
 * 7/10 of the rate before or less; markedly worse (see `isMarkedlyWorse`) with at least 3 eligible globs a side, twice
 * the rate before and at least 1/5 (20 points) more.
 */
export const EFFECT_IMPROVED: readonly [number, number] = [7, 10];
export const EFFECT_WORSE_MIN_GLOBS = 3;
export const EFFECT_WORSE_FACTOR = 2;
export const EFFECT_WORSE_MIN_RISE: readonly [number, number] = [1, 5];

/**
 * Whether the effect check measures a signal key. A `dependency:` key isn't: the check doesn't fetch manifests, and a
 * dependency is fixed once documented, so it isn't offered under Watch signal and its approval starts no check.
 */
export const isEffectMeasured = (key: string): boolean => signalKindOf(key) !== 'dependency';

/**
 * Which globs ran with the change: an agent-file change by the board's agent-set version (the glob's
 * `globAgentSetVersion` at least `fromVersion`; unknown versions are left out), a document or learning (served at
 * runtime, without a version) by time (the glob's first recorded work after `since`).
 */
export type EffectBasis =
  | { readonly kind: 'agent_set'; readonly fromVersion: number }
  | { readonly kind: 'time'; readonly since: string };

/** One side's figures: `affected` of `eligible` globs, the rate between them, and the globs. */
export interface EffectFigures {
  readonly affected: number;
  readonly eligible: number;
  readonly rate: number;
  /** The side's globs, in merge order. */
  readonly globIds: readonly string[];
  readonly affectedGlobIds: readonly string[];
}

/** Another signal that got markedly worse over the same globs. */
export interface EffectWorse {
  readonly key: string;
  readonly label: string;
  readonly before: EffectFigures;
  readonly after: EffectFigures;
}

/**
 * An approved item's effect check. `watching` until the after side has `n` globs (its figures are refreshed on every
 * run meanwhile), then final: `improved`, `not_improved`, `worse_elsewhere` (improved, but another signal got markedly
 * worse) or `unmeasurable` (no eligible glob before the approval). A raised revise-or-revert item makes it final too.
 */
export interface EffectCheck {
  readonly state: EffectState;
  /** The signal key watched (an effect item's own `effect:` key resolves to the key its original watched). */
  readonly key: string;
  readonly label: string;
  readonly basis: EffectBasis;
  /** Globs per side: the board's setting while watching, kept once final. */
  readonly n: number;
  /** Null until the first check run. */
  readonly before: EffectFigures | null;
  readonly after: EffectFigures | null;
  readonly worse: readonly EffectWorse[];
  /** The revise-or-revert item raised for `not_improved` or `worse_elsewhere`. */
  readonly raisedItemId: string | null;
  readonly checkedAt: string | null;
}

/** The signal key of a raised revise-or-revert item for `itemId`. */
export const effectSignalKey = (itemId: string): string => `effect:${itemId}`;

/** The item an `effect:` signal key was raised for, or null for any other key. */
export const effectItemOf = (key: string): string | null =>
  key.startsWith('effect:') ? key.slice('effect:'.length) : null;

/** The basis of an approval: the agent-set version an agent-file change created, else its time. */
export const effectBasisOf = (outcome: KbOutcome | null, decidedAt: string): EffectBasis =>
  outcome?.kind === 'applied' &&
  isAgentSetKind(outcome.target) &&
  outcome.agentSetVersion !== undefined
    ? { kind: 'agent_set', fromVersion: outcome.agentSetVersion }
    : { kind: 'time', since: decidedAt };

/** A new check, watching from the approval (figures come with the first run). */
export const startEffectCheck = (
  watch: { readonly key: string; readonly label: string },
  basis: EffectBasis,
  n: number,
): EffectCheck => ({
  state: 'watching',
  key: watch.key,
  label: watch.label,
  basis,
  n,
  before: null,
  after: null,
  worse: [],
  raisedItemId: null,
  checkedAt: null,
});

/** A merged glob as the effect check sees it. */
export interface EffectGlob {
  readonly id: string;
  /**
   * Its first merge to the base branch, which orders both sides: a glob first merged before the approval stays on the
   * before side when it merges again (Merge and continue), counted only up to the approval.
   */
  readonly firstMergedAt: string;
  /** Its latest merge. */
  readonly mergedAt: string;
  readonly version: number | null;
  /** Its first artifact, `RunTriggered` or `PickedUp`; null when nothing is recorded. */
  readonly firstWorkAt: string | null;
}

const earlier = (a: string | null, b: string): string =>
  a === null || Date.parse(b) < Date.parse(a) ? b : a;

const later = (a: string | null, b: string): string =>
  a === null || Date.parse(b) > Date.parse(a) ? b : a;

/** The activity's merged globs, in (latest) merge order. */
export const effectGlobs = (activity: BoardActivity): EffectGlob[] => {
  const merged = new Map<string, string>();
  const firstMerged = new Map<string, string>();
  const firstWork = new Map<string, string>();
  for (const e of activity.events) {
    if (e.type === 'Merged') {
      merged.set(e.globId, later(merged.get(e.globId) ?? null, e.at));
      firstMerged.set(e.globId, earlier(firstMerged.get(e.globId) ?? null, e.at));
    }
    if (e.type === 'RunTriggered' || e.type === 'PickedUp')
      firstWork.set(e.globId, earlier(firstWork.get(e.globId) ?? null, e.at));
  }
  for (const a of activity.artifacts)
    firstWork.set(a.globId, earlier(firstWork.get(a.globId) ?? null, a.createdAt));
  return [...merged.entries()]
    .map(([id, mergedAt]) => ({
      id,
      firstMergedAt: firstMerged.get(id) ?? mergedAt,
      mergedAt,
      version: globAgentSetVersion(activity, id),
      firstWorkAt: firstWork.get(id) ?? null,
    }))
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.id.localeCompare(b.id));
};

const rateOf = (affected: number, eligible: number): number =>
  eligible === 0 ? 0 : Math.round((affected / eligible) * 1000) / 1000;

/** A side's figures for `key` over `globs`. */
const figuresOf = (
  activity: BoardActivity,
  globs: readonly EffectGlob[],
  key: string,
): EffectFigures => {
  const affectedGlobIds = globs
    .filter((g) => perGlob(activity, g.id, key).affected)
    .map((g) => g.id);
  return {
    affected: affectedGlobIds.length,
    eligible: globs.length,
    rate: rateOf(affectedGlobIds.length, globs.length),
    globIds: globs.map((g) => g.id),
    affectedGlobIds,
  };
};

/** Whether a glob ran with the change. */
const ranWith = (basis: EffectBasis, glob: EffectGlob): boolean =>
  basis.kind === 'agent_set'
    ? glob.version !== null && glob.version >= basis.fromVersion
    : glob.firstWorkAt !== null && Date.parse(glob.firstWorkAt) > Date.parse(basis.since);

/**
 * Improved when the rate after is at most 70% of the rate before (so also when it fell to none). Compared on whole
 * numbers, so a boundary isn't lost to rounding: a/b ≤ 7/10 × c/d is 10·a·d ≤ 7·c·b.
 */
export const isImproved = (before: EffectFigures, after: EffectFigures): boolean => {
  const [p, q] = EFFECT_IMPROVED;
  return q * after.affected * before.eligible <= p * before.affected * after.eligible;
};

/**
 * Markedly worse: at least 3 eligible globs on each side, the rate after at least twice the rate before, and at least
 * 20 points higher (on whole numbers: a·d ≥ 2·c·b and 5·(a·d − c·b) ≥ 1·b·d).
 */
export const isMarkedlyWorse = (before: EffectFigures, after: EffectFigures): boolean => {
  if (before.eligible < EFFECT_WORSE_MIN_GLOBS || after.eligible < EFFECT_WORSE_MIN_GLOBS)
    return false;
  const [p, q] = EFFECT_WORSE_MIN_RISE;
  const a = after.affected * before.eligible;
  const c = before.affected * after.eligible;
  return a >= EFFECT_WORSE_FACTOR * c && q * (a - c) >= p * after.eligible * before.eligible;
};

/**
 * Every other signal key that got markedly worse over the same globs: each side's globs that are eligible for that
 * key (the before side over its activity up to the approval), worst rise first.
 */
const worseElsewhere = (
  activity: BoardActivity,
  beforeActivity: BoardActivity,
  before: readonly EffectGlob[],
  after: readonly EffectGlob[],
  key: string,
): EffectWorse[] => {
  const others = new Map<string, string>();
  for (const m of measureSignals(activity)) if (m.key !== key) others.set(m.key, m.label);
  const worse: EffectWorse[] = [];
  for (const [other, label] of others) {
    const eligibleIn = (source: BoardActivity) => (g: EffectGlob) => perGlob(source, g.id, other).eligible;
    const b = figuresOf(beforeActivity, before.filter(eligibleIn(beforeActivity)), other);
    const a = figuresOf(activity, after.filter(eligibleIn(activity)), other);
    if (isMarkedlyWorse(b, a)) worse.push({ key: other, label, before: b, after: a });
  }
  return worse.sort(
    (x, y) =>
      y.after.rate - y.before.rate - (x.after.rate - x.before.rate) || x.key.localeCompare(y.key),
  );
};

/**
 * The activity up to `at`: events, artifacts and findings recorded by then. The before side is read from it, so a
 * glob first merged before the approval that goes on (Merge and continue) doesn't add work done with the change.
 */
export const activityUntil = (activity: BoardActivity, at: string): BoardActivity => {
  const cut = Date.parse(at);
  const by = (time: string) => Date.parse(time) <= cut;
  return {
    ...activity,
    window: { from: activity.window.from, to: by(activity.window.to) ? activity.window.to : at },
    events: activity.events.filter((e) => by(e.at)),
    artifacts: activity.artifacts.filter((a) => by(a.createdAt)),
    findings: activity.findings.filter((f) => by(f.createdAt)),
  };
};

const byFirstMerge = (a: EffectGlob, b: EffectGlob): number =>
  Date.parse(a.firstMergedAt) - Date.parse(b.firstMergedAt) || a.id.localeCompare(b.id);

/**
 * The check's figures and state at the end of the activity. Before: the last `n` globs eligible for the key first
 * merged before the approval, over their activity up to it (`activityUntil`). After: the first `n` eligible globs that
 * ran with the change (`ranWith`) and first merged after it, by first merge. Unmeasurable with no eligible glob before
 * (or a key the check doesn't measure); watching until the after side has `n`.
 */
export const evaluateEffect = (
  activity: BoardActivity,
  globs: readonly EffectGlob[],
  check: Pick<EffectCheck, 'key' | 'basis' | 'n'>,
  decidedAt: string,
): Pick<EffectCheck, 'state' | 'before' | 'after' | 'worse'> => {
  const decided = Date.parse(decidedAt);
  const known = signalDefinition(check.key) !== null && isEffectMeasured(check.key);
  const beforeActivity = activityUntil(activity, decidedAt);
  const eligibleIn = (source: BoardActivity) => (g: EffectGlob) =>
    known && perGlob(source, g.id, check.key).eligible;
  const beforeGlobs = globs
    .filter((g) => Date.parse(g.firstMergedAt) < decided && eligibleIn(beforeActivity)(g))
    .sort(byFirstMerge)
    .slice(-check.n);
  // A glob first merged before the approval is a before glob only, so the sides never overlap.
  const afterGlobs = globs
    .filter((g) => Date.parse(g.firstMergedAt) > decided && ranWith(check.basis, g) && eligibleIn(activity)(g))
    .sort(byFirstMerge)
    .slice(0, check.n);
  const before = figuresOf(beforeActivity, beforeGlobs, check.key);
  const after = figuresOf(activity, afterGlobs, check.key);
  if (before.eligible === 0) return { state: 'unmeasurable', before, after, worse: [] };
  if (after.eligible < check.n) return { state: 'watching', before, after, worse: [] };
  const worse = worseElsewhere(activity, beforeActivity, beforeGlobs, afterGlobs, check.key);
  const state = !isImproved(before, after)
    ? 'not_improved'
    : worse.length > 0
      ? 'worse_elsewhere'
      : 'improved';
  return { state, before, after, worse };
};

/** Whether a final state raises a revise-or-revert item. */
export const raisesItem = (state: EffectState): boolean =>
  state === 'not_improved' || state === 'worse_elsewhere';

const percent = (rate: number): string => `${String(Math.round(rate * 100))}%`;

const cut = (value: string, length: number): string => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

/** The basis in words: "agent set v12 or later", or "work started after 2026-10-07". */
export const basisText = (basis: EffectBasis): string =>
  basis.kind === 'agent_set'
    ? `agent set v${String(basis.fromVersion)} or later`
    : `work started after ${basis.since.slice(0, 10)}`;

const rateText = (figures: EffectFigures): string =>
  `${percent(figures.rate)} (${String(figures.affected)}/${String(figures.eligible)})`;

/**
 * The raised item's statement. Not improved: "Revise or revert s15kN (<statement, cut>): after N globs with <basis>
 * the rate of <label> is X% (a/b), against Y% (c/d) before.", naming the worst other signal that rose too. Worse
 * elsewhere leads with the gain to keep, then the side effect over that signal's own globs: "Revise s15kN (…): after
 * N globs with <basis> the rate of <label> fell from Y% (c/d) to X% (a/b), but the rate of <other> rose from … to …."
 */
export const effectStatement = (
  original: { readonly id: string; readonly statement: string },
  check: Pick<EffectCheck, 'state' | 'label' | 'basis' | 'before' | 'after' | 'worse'>,
): string => {
  const { before, after } = check;
  if (before === null || after === null)
    throw new Error(`${original.id}'s effect check has no figures`);
  const [worst] = check.worse;
  const head = `${cut(original.statement, 80)}): after ${String(after.eligible)} globs with ${basisText(check.basis)} the rate of ${check.label}`;
  if (check.state === 'worse_elsewhere' && worst !== undefined)
    return `Revise ${original.id} (${head} fell from ${rateText(before)} to ${rateText(after)}, but the rate of ${worst.label} rose from ${rateText(worst.before)} to ${rateText(worst.after)}.`;
  const also =
    worst === undefined
      ? ''
      : ` The rate of ${worst.label} also rose from ${rateText(worst.before)} to ${rateText(worst.after)}.`;
  return `Revise or revert ${original.id} (${head} is ${rateText(after)}, against ${rateText(before)} before.${also}`;
};

/** The raised item's evidence: the check, both sides with their globs, and any other signal that got worse. */
export const effectEvidence = (
  original: { readonly id: string; readonly decidedAt: string },
  check: Pick<EffectCheck, 'key' | 'label' | 'basis' | 'n' | 'before' | 'after' | 'worse'>,
): string => {
  const side = (name: string, f: EffectFigures | null) =>
    f === null
      ? `${name}: none`
      : `${name}: ${String(f.affected)} of ${String(f.eligible)} globs (${percent(f.rate)}); globs ${f.globIds.join(', ') || '(none)'}; affected ${f.affectedGlobIds.join(', ') || '(none)'}`;
  return [
    `Effect check by slop of ${original.id} (approved ${original.decidedAt.slice(0, 10)}): ${check.label} (${check.key}), ${String(check.n)} globs a side, with ${basisText(check.basis)}.`,
    side('Before', check.before),
    side('After', check.after),
    ...check.worse.map(
      (w) =>
        `Worse elsewhere: ${w.label} (${w.key}) ${rateText(w.before)} before, ${rateText(w.after)} after.`,
    ),
  ].join('\n');
};
