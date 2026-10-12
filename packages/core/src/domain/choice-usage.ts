import type { DecisionSourceKind } from './decisions.js';

/**
 * Choice usage (spec, Choices that keep mattering): how often a choice is returned to an agent or to chat, counted
 * per board, choice, day and glob. Only counts, never model calls; the weekly mining run reads them.
 */

/** A choice is only worth a person's attention once it has been returned this many times… */
export const CHOICE_MIN_RETURNS = 5;
/** …on at least this many different globs… */
export const CHOICE_MIN_GLOBS = 3;
/** …within this many days. */
export const CHOICE_USAGE_WINDOW_DAYS = 30;
/** A choice from pasted discussion (not a record or plan) must be returned this many times. */
export const CHOICE_DISCUSSION_MIN_RETURNS = 10;
/** Usage rows older than this are pruned. */
export const CHOICE_USAGE_RETENTION_DAYS = 90;

/** The glob a usage row is kept under when the retrieval had no glob (a search or chat question without one). */
export const NO_GLOB = '';

/** One day's returns of a choice on one glob (or on none: `NO_GLOB`). */
export interface ChoiceUsageRow {
  readonly decisionId: number;
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly globId: string;
  readonly count: number;
}

/** What the glob view shows on a choice: "used N times on M globs". */
export interface ChoiceUsage {
  readonly returns: number;
  readonly globs: number;
}

export const usageDay = (now: string): string => now.slice(0, 10);

/** The first day inside a window of `days` days ending at `now`. */
export const usageFrom = (now: string, days: number): string => usageDay(new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString());

/** Per choice: all returns, and the distinct globs they were on (retrievals without a glob add to the first only). */
export const summariseUsage = (rows: readonly ChoiceUsageRow[]): Map<number, ChoiceUsage & { readonly globIds: readonly string[] }> => {
  const byChoice = new Map<number, { returns: number; globs: Set<string> }>();
  for (const row of rows) {
    const entry = byChoice.get(row.decisionId) ?? { returns: 0, globs: new Set<string>() };
    entry.returns += row.count;
    if (row.globId !== NO_GLOB) entry.globs.add(row.globId);
    byChoice.set(row.decisionId, entry);
  }
  return new Map([...byChoice].map(([id, e]) => [id, { returns: e.returns, globs: e.globs.size, globIds: [...e.globs].sort() }]));
};

/** The choice as the signal reads it. */
export interface ChoiceActivity {
  readonly id: number;
  /** The glob it was taken on; null for a choice from a knowledge item. */
  readonly globId: string | null;
  readonly statement: string;
  readonly quote: string;
  readonly sourceKind: DecisionSourceKind;
  readonly sourceLabel: string;
  /** Not replaced by a newer choice. */
  readonly current: boolean;
  /** A board document already says it (its quote or statement is in a document's text). */
  readonly covered: boolean;
  readonly returns: number;
  /** The distinct globs it was returned on, never the glob it was taken on. */
  readonly globIds: readonly string[];
}

/**
 * Whether a choice has returned often enough, on enough globs, for a person to look at it: a choice from a record or
 * plan needs `CHOICE_MIN_RETURNS` returns, one from discussion `CHOICE_DISCUSSION_MIN_RETURNS`, both on at least
 * `CHOICE_MIN_GLOBS` globs. Choices from accepted learnings are already knowledge and never count.
 */
export const choiceInUse = (c: Pick<ChoiceActivity, 'sourceKind' | 'current' | 'covered' | 'returns' | 'globIds'>): boolean => {
  if (!c.current || c.covered || c.sourceKind === 'kb_item') return false;
  const needed = c.sourceKind === 'inbox' ? CHOICE_DISCUSSION_MIN_RETURNS : CHOICE_MIN_RETURNS;
  return c.returns >= needed && c.globIds.length >= CHOICE_MIN_GLOBS;
};
