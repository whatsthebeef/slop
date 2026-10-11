import { matchesGlob } from './sub-gate.js';

/**
 * Which overlap predictions a board trusts (spec, Dependencies). Each path pattern the board predicts overlaps from has a
 * weight in [0, 1]: it starts at the catalog's default (1 for an overlap pattern, 0 for one that never overlaps) and moves
 * with outcomes. Below `PREDICT_MIN` the pattern is no longer predicted. A learned weight is stored with its counts; the
 * default is never stored, so changing the catalog moves every board that hasn't learned.
 */
export const PREDICT_MIN = 0.3;
/** A clean overlap (merged with no conflict and no rework) lowers the weight by this much: three clean ones stop a default pattern. */
export const WEAKEN_STEP = 0.25;
/** A conflict, a rework run or a missed prerequisite raises it by this much. */
export const STRENGTHEN_STEP = 0.5;

/** The catalog's starting rules for a board: patterns that never overlap (lockfiles, generated files) and ones that do (migrations). */
export interface DependencyDefaults {
  readonly neverOverlap: readonly string[];
  readonly overlap: readonly string[];
}

export const NO_DEFAULTS: DependencyDefaults = { neverOverlap: [], overlap: [] };

/** What moved a rule's weight. */
export const DEPENDENCY_CAUSES = [
  'clean_overlap',
  'conflicted_overlap',
  'unmerged_prerequisite',
  'start_anyway_succeeded',
  'reset',
] as const;
export type DependencyCause = (typeof DEPENDENCY_CAUSES)[number];

/** A rule the board learned: its weight now and the outcomes behind it. */
export interface DependencyRule {
  readonly boardId: number;
  readonly pattern: string;
  readonly weight: number;
  readonly cleanCount: number;
  readonly conflictCount: number;
  readonly updatedAt: string;
}

/** One move of a rule, with its cause; recorded once per board, glob, pattern and cause so the learning is idempotent. */
export interface DependencyRuleChange {
  readonly id: number;
  readonly boardId: number;
  readonly at: string;
  readonly pattern: string;
  readonly from: number;
  readonly to: number;
  readonly cause: DependencyCause;
  /** The glob whose outcome it was (null for a reset). */
  readonly globId: string | null;
  readonly evidence: string;
}
export type NewDependencyRuleChange = Omit<DependencyRuleChange, 'id'>;

/** A rule as board settings shows it: the weight in force, the catalog default and whether the board moved it. */
export interface DependencyRuleView {
  readonly pattern: string;
  readonly weight: number;
  readonly defaultWeight: number;
  readonly state: 'default' | 'learned';
  readonly predicted: boolean;
  readonly cleanCount: number;
  readonly conflictCount: number;
  readonly updatedAt: string | null;
}

/** The catalog's weight for a pattern: 0 when it never overlaps, else 1. */
export const defaultWeight = (pattern: string, defaults: DependencyDefaults): number => (defaults.neverOverlap.includes(pattern) ? 0 : 1);

const clamp = (n: number): number => Math.min(1, Math.max(0, Math.round(n * 100) / 100));

/** The rule after an outcome: weakened by a clean overlap, strengthened by any of the others. */
export const movedRule = (
  boardId: number,
  pattern: string,
  current: DependencyRule | undefined,
  start: number,
  cause: DependencyCause,
  now: string,
): DependencyRule => {
  const weight = current?.weight ?? start;
  const weaken = cause === 'clean_overlap' || cause === 'start_anyway_succeeded';
  return {
    boardId,
    pattern,
    weight: clamp(weaken ? weight - WEAKEN_STEP : weight + STRENGTHEN_STEP),
    cleanCount: (current?.cleanCount ?? 0) + (weaken ? 1 : 0),
    conflictCount: (current?.conflictCount ?? 0) + (weaken ? 0 : 1),
    updatedAt: now,
  };
};

/** Every pattern a board predicts from: the merge policy's exclusive paths and the catalog's overlap patterns, without repeats. */
export const candidatePatterns = (policyPaths: readonly string[] | undefined, defaults: DependencyDefaults): string[] => [
  ...new Set([...(policyPaths ?? []), ...defaults.overlap, ...defaults.neverOverlap]),
];

/** The weights in force: the board's learned ones over the catalog's defaults. */
export const weightsOf = (
  patterns: readonly string[],
  learned: readonly DependencyRule[],
  defaults: DependencyDefaults,
): Map<string, number> =>
  new Map(patterns.map((p) => [p, learned.find((r) => r.pattern === p)?.weight ?? defaultWeight(p, defaults)]));

/**
 * The files an overlap is predicted from: those under a pattern the board still trusts (weight at least `PREDICT_MIN`). A
 * file under a pattern that never overlaps (a lockfile) is left out even when a broader pattern covers it, unless the
 * board raised that pattern's weight itself.
 */
export const predictedFiles = (
  files: readonly string[],
  patterns: readonly string[],
  weights: ReadonlyMap<string, number>,
  defaults: DependencyDefaults,
): string[] =>
  files.filter((file) => {
    const hits = patterns.filter((p) => matchesGlob(file, p));
    const trusted = (p: string): boolean => (weights.get(p) ?? 1) >= PREDICT_MIN;
    if (hits.some((p) => defaults.neverOverlap.includes(p) && !trusted(p))) return false;
    return hits.some((p) => !defaults.neverOverlap.includes(p) && trusted(p));
  });

/** The patterns that cover any of the paths. */
export const patternsCovering = (paths: readonly string[], patterns: readonly string[]): string[] =>
  patterns.filter((p) => paths.some((path) => matchesGlob(path, p)));

/** The glob IDs a failure's text says were not merged, or none when it isn't about prerequisites. */
export const unmergedPrerequisiteIds = (reason: string, known: ReadonlySet<string>, selfId: string): string[] => {
  if (!/\b(unmerged|not (yet )?merged|hasn't merged|has not merged|isn't merged|lacks? (its|their) changes|blocked on)\b/i.test(reason)) return [];
  const ids = reason.match(/\bs\d+[a-z]\d+\b/g) ?? [];
  return [...new Set(ids)].filter((id) => id !== selfId && known.has(id));
};
