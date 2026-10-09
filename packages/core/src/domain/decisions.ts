import { hash } from '../app/text-hash.js';

/**
 * Decisions (spec, Decisions and supersession): choices a team made, found in the implementation record's
 * `## Decisions`, plan.md, clarifications and assumptions, and approved knowledge items. Each is a knowledge item of
 * source type `decision` (so search finds it) plus a row here with its structured facts and what replaced it.
 */

export const DECISION_SOURCE_KINDS = ['implementation_plan', 'plan', 'attachment', 'kb_item'] as const;
export type DecisionSourceKind = (typeof DECISION_SOURCE_KINDS)[number];

/**
 * How a decision relates to the newer one that replaces it. `hint`: the model proposed it but a quote failed the
 * check, so nothing changed and a person decides. `applied`: quotes checked out, the decision is superseded.
 * `confirmed`: a person confirmed a hint. `undone`: a person reversed it; it is never applied again for that pair.
 */
export const REPLACE_STATES = ['hint', 'applied', 'confirmed', 'undone'] as const;
export type ReplaceState = (typeof REPLACE_STATES)[number];

export interface Decision {
  readonly id: number;
  readonly boardId: number;
  /** The knowledge item search finds it by. */
  readonly itemId: number;
  /** The glob it was taken on; null for a decision from a knowledge item. */
  readonly globId: string | null;
  readonly group: string | null;
  readonly statement: string;
  /** The words in the source it rests on, verified verbatim. */
  readonly quote: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string;
  readonly sourceKind: DecisionSourceKind;
  /** The stable ref of the source: `artifact:<glob>:<kind>:<label>` or `learning:<id>`. */
  readonly sourceRef: string;
  readonly sourceLabel: string;
  readonly sourceUrl: string | null;
  /** The newer decision this one is replaced by (set for every `replaceState`). */
  readonly replacedBy: number | null;
  readonly replaceState: ReplaceState | null;
  readonly replaceOldQuote: string | null;
  readonly replaceNewQuote: string | null;
  readonly replaceReason: string | null;
  /** When the supersession check ran; null while it is due. */
  readonly checkedAt: string | null;
  /** The supersession check's retry state. */
  readonly attempts: number;
  readonly processAfter: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

/** A decision as the pipeline writes it; a re-extraction keeps what is already stored beyond these. */
export type NewDecision = Pick<
  Decision,
  | 'boardId'
  | 'itemId'
  | 'globId'
  | 'group'
  | 'statement'
  | 'quote'
  | 'decidedBy'
  | 'decidedAt'
  | 'sourceKind'
  | 'sourceRef'
  | 'sourceLabel'
  | 'sourceUrl'
  | 'createdAt'
>;

/** The fields a decision update may change (supersession state and the check's progress). */
export type DecisionPatch = Partial<
  Pick<
    Decision,
    'replacedBy' | 'replaceState' | 'replaceOldQuote' | 'replaceNewQuote' | 'replaceReason' | 'checkedAt' | 'attempts' | 'processAfter' | 'lastError'
  >
>;

export const DECISION_SOURCE_STATES = ['pending', 'done', 'failed'] as const;
export type DecisionSourceState = (typeof DECISION_SOURCE_STATES)[number];

/** One source text decisions are extracted from, with the hash of what was extracted last. */
export interface DecisionSource {
  readonly boardId: number;
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly state: DecisionSourceState;
  readonly attempts: number;
  readonly processAfter: string | null;
  readonly lastError: string | null;
  readonly globId: string | null;
  readonly updatedAt: string;
}

/** Whether a decision no longer stands: a newer one replaced it and nobody undid that. */
export const isSuperseded = (d: Pick<Decision, 'replaceState'>): boolean => d.replaceState === 'applied' || d.replaceState === 'confirmed';

/** Text compared as quotes are: whitespace collapsed, lower case. */
const squashed = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The stable ref of a decision's knowledge item: its source and a hash of its quote, so a source that is edited keeps
 * the decisions whose quote is still in it, and a decision isn't written twice.
 */
export const decisionRef = (sourceRef: string, quote: string): string =>
  `decision:${sourceRef}:${hash(squashed(quote)).padStart(12, '0').slice(0, 12)}`;

/** The decision's item title: the first line of the statement, at most 80 characters. */
export const decisionTitle = (statement: string): string => {
  const line = statement.trim().split(/\r?\n/)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/** The text of a decision's chunk: the statement, who decided it when known, and the words it rests on. */
export const decisionText = (d: Pick<Decision, 'statement' | 'decidedBy' | 'quote'>): string =>
  [d.statement.trim(), ...(d.decidedBy === null ? [] : [`Decided by: ${d.decidedBy}`]), `Source quote: "${d.quote}"`].join('\n\n');

/** The text a supersession check compares quotes against: the statement and the source quote. */
export const decisionBody = (d: Pick<Decision, 'statement' | 'quote'>): string => `${d.statement}\n${d.quote}`;

/** The label of a decision's source, as the glob view and citations show it. */
export const decisionSourceLabel = (kind: DecisionSourceKind, globId: string | null, label: string): string => {
  switch (kind) {
    case 'implementation_plan':
      return `${globId ?? ''} implementation record`.trim();
    case 'plan':
      return `${globId ?? ''} plan.md`.trim();
    case 'attachment':
      return `${globId ?? ''} ${label}`.trim();
    case 'kb_item':
      return 'Approved learning';
  }
};

/** A decision's relation to another, as the API shows it. */
export interface DecisionRelation {
  readonly id: number;
  readonly globId: string | null;
  readonly statement: string;
  readonly decidedAt: string;
  readonly state: ReplaceState;
  readonly sourceLabel: string;
  readonly sourceUrl: string | null;
  /** The quotes and reason behind the relation (on `replacedBy`; empty on `replaces`, whose own row holds them). */
  readonly oldQuote: string | null;
  readonly newQuote: string | null;
  readonly reason: string | null;
}

/** A decision with its supersession, for the glob view and the context bundle. */
export interface DecisionView {
  readonly id: number;
  readonly globId: string | null;
  readonly statement: string;
  readonly quote: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string;
  readonly sourceKind: DecisionSourceKind;
  readonly sourceLabel: string;
  readonly sourceUrl: string | null;
  /** `superseded` once a newer decision replaced it (applied or confirmed); a hint leaves it `current`. */
  readonly status: 'current' | 'superseded';
  /** The newer decision replacing this one: applied or confirmed (`status` superseded), or a proposed hint. */
  readonly replacedBy: DecisionRelation | null;
  /** The older decisions this one replaced or proposes to replace. */
  readonly replaces: readonly DecisionRelation[];
}

const relationOf = (d: Decision, state: ReplaceState, quotes: Pick<Decision, 'replaceOldQuote' | 'replaceNewQuote' | 'replaceReason'>): DecisionRelation => ({
  id: d.id,
  globId: d.globId,
  statement: d.statement,
  decidedAt: d.decidedAt,
  state,
  sourceLabel: d.sourceLabel,
  sourceUrl: d.sourceUrl,
  oldQuote: quotes.replaceOldQuote,
  newQuote: quotes.replaceNewQuote,
  reason: quotes.replaceReason,
});

/** A relation a person can still see: undone ones are gone. */
const shown = (d: Decision): ReplaceState | null => (d.replaceState === null || d.replaceState === 'undone' ? null : d.replaceState);

/** `chosen` as views, with their relations resolved against every decision of the board (`all`), newest first. */
export const decisionViews = (chosen: readonly Decision[], all: readonly Decision[]): DecisionView[] => {
  const byId = new Map(all.map((d) => [d.id, d]));
  return [...chosen]
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || b.id - a.id)
    .map((d) => {
      const state = shown(d);
      const newer = d.replacedBy === null ? undefined : byId.get(d.replacedBy);
      return {
        id: d.id,
        globId: d.globId,
        statement: d.statement,
        quote: d.quote,
        decidedBy: d.decidedBy,
        decidedAt: d.decidedAt,
        sourceKind: d.sourceKind,
        sourceLabel: d.sourceLabel,
        sourceUrl: d.sourceUrl,
        status: isSuperseded(d) ? 'superseded' : 'current',
        replacedBy: state === null || newer === undefined ? null : relationOf(newer, state, d),
        replaces: all
          .filter((o) => o.replacedBy === d.id && shown(o) !== null)
          .map((o) => relationOf(o, shown(o) ?? 'hint', o)),
      };
    });
};

/** Whether a string is an ISO date or timestamp the model gave for a decision (`2026-03-04`, `2026-03-04T10:00:00Z`). */
export const parseDecidedAt = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) return null;
  const at = Date.parse(value.trim());
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};
