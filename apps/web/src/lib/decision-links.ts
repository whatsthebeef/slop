import { DECISION_EDGE_KINDS } from '@slop/core';
import type { DecisionAttributes, DecisionEdgeKind, GlobLink } from '@slop/core';

/** How each kind of link between learnings reads on a decision, from the decision's side. */
export const LINK_TEXT: Readonly<Record<DecisionEdgeKind, string>> = {
  duplicate_of: 'Merged into',
  suppressed_by: 'Matched rejected',
  covered_by: 'Covered by',
  possibly_covered_by: 'May already be said by',
  contradicts: 'Contradicts',
  kept_apart_from: 'Kept apart from',
};

/** What closed a learning, in words: merged, suppressed or covered (by a learning, or a document's text). */
export const closedText = (attributes: DecisionAttributes): string | null => {
  switch (attributes.closedAs) {
    case undefined:
      return null;
    case 'merged':
      return 'The knowledge pipeline merged it into another learning';
    case 'suppressed':
      return 'The knowledge pipeline closed it: it matches a rejected learning';
    case 'covered':
      return attributes.coveredByText === undefined
        ? 'The knowledge pipeline closed it: an approved learning already says it'
        : `The knowledge pipeline closed it: ${attributes.coveredByText.name} already says it`;
  }
};

/** A learning's target as one line: where routing put it, else where the submitter suggested. */
export const targetText = (attributes: DecisionAttributes): string | null => {
  const routed = attributes.target?.routed ?? null;
  if (routed !== null) return `${routed.kind} ${routed.name}${routed.section === null ? '' : ` § ${routed.section}`}`;
  const suggested = attributes.target?.suggested ?? null;
  return suggested === null ? null : `suggested: ${suggested}`;
};

/** The links grouped by kind, in `DECISION_EDGE_KINDS` order; kinds with none are left out. */
export const linksByKind = (links: readonly GlobLink[] | undefined): { kind: DecisionEdgeKind; ids: string[] }[] =>
  DECISION_EDGE_KINDS.flatMap((kind) => {
    const ids = (links ?? []).filter((l) => l.kind === kind).map((l) => l.id);
    return ids.length === 0 ? [] : [{ kind, ids }];
  });
