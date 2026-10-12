import type { ContextSettingChange, ContextSettingView } from './context-settings.js';
import type { DecisionSourceKind } from './decisions.js';
import type { AuthorityTier, SourceType } from './search.js';

/**
 * The context report (spec, Context tuning): what agents were handed in the last `CONTEXT_REPORT_DAYS` days, what became
 * of the choices, how the inbox's suggestions fared and the settings with their history. Counts only; no model calls.
 */
export const CONTEXT_REPORT_DAYS = 30;
/** The most items listed under "most retrieved". */
export const CONTEXT_REPORT_TOP = 20;
/** The most globs named behind one of those items. */
export const CONTEXT_REPORT_TOP_GLOBS = 5;

/** A count and its share of the total (0 to 1; 0 when the total is 0). */
export interface Counted<K extends string> {
  readonly key: K;
  readonly count: number;
  readonly share: number;
}

export interface TopRetrieved {
  readonly decisionId: number;
  /** The statement's first line. */
  readonly statement: string;
  readonly sourceKind: DecisionSourceKind;
  readonly returns: number;
  readonly globs: readonly { readonly id: string; readonly title: string }[];
  /** How many globs it was returned on in all (the list is cut at `CONTEXT_REPORT_TOP_GLOBS`). */
  readonly globCount: number;
}

export interface ContextConflict {
  readonly decisionId: number;
  readonly statement: string;
  readonly document: string;
  readonly note: string;
}

export interface ContextReport {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly retrievals: {
    readonly total: number;
    readonly bySource: readonly Counted<SourceType>[];
    readonly byTier: readonly Counted<AuthorityTier>[];
  };
  readonly topRetrieved: readonly TopRetrieved[];
  readonly choices: {
    readonly total: number;
    readonly bySource: readonly Counted<DecisionSourceKind>[];
    readonly newThisWeek: number;
    /** Replaced by a newer choice, as they stand now. */
    readonly replaced: { readonly autoApplied: number; readonly confirmed: number; readonly undone: number };
    /** Replacement cards a person decided within the window. */
    readonly cards: { readonly confirmed: number; readonly dismissed: number };
    /** Learnings raised from choices in use, and how people decided them, within the window. */
    readonly promoted: { readonly raised: number; readonly accepted: number; readonly rejected: number };
  };
  /** Choices that contradict a knowledge document; empty while `conflictsNote` says there is nothing stored to read. */
  readonly conflicts: readonly ContextConflict[];
  readonly conflictsNote: string;
  readonly inbox: {
    readonly attachedViaSuggestion: number;
    readonly attachedElsewhere: number;
    readonly kept: number;
    readonly discarded: number;
  };
  readonly settings: readonly ContextSettingView[];
  readonly history: readonly ContextSettingChange[];
}

/** `count` of `total` as a share, 0 when there is nothing to share. */
export const shareOf = (count: number, total: number): number => (total <= 0 ? 0 : count / total);

/** Counts per key, largest first (ties by key), each with its share of the total. */
export const countShares = <K extends string>(keys: readonly K[]): Counted<K>[] => {
  const counts = new Map<K, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return sharesOf(counts);
};

export const sharesOf = <K extends string>(counts: ReadonlyMap<K, number>): Counted<K>[] => {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return [...counts]
    .map(([key, count]) => ({ key, count, share: shareOf(count, total) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
};
