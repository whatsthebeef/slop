/**
 * The search store's vocabulary and ranking (spec, Knowledge and context): what is indexed, how much each kind of
 * source is trusted, and how candidates from SQL are turned into the few cited results a caller reads. Pure: the
 * database only fetches and filters candidates, every weighting happens here.
 */

/** The longest query (or path) a search accepts; the embedding model rejects oversized input. */
export const MAX_QUERY_LENGTH = 2000;

export const SOURCE_TYPES = [
  'glob_plan',
  'glob_summary',
  'implementation_plan',
  'postplan',
  'decision_log',
  'decision',
  'local_review',
  'attachment',
  'change_summary',
  'code_review',
  'kb_doc',
  'learning',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** How a source reads in a chunk header and a citation. */
export const SOURCE_LABELS: Readonly<Record<SourceType, string>> = {
  glob_plan: 'Plan',
  glob_summary: 'Summary',
  implementation_plan: 'Implementation record',
  postplan: 'Postplan (legacy)',
  decision_log: 'Decision log (legacy)',
  decision: 'Decision',
  local_review: 'Local review',
  attachment: 'Attachment',
  change_summary: 'Change',
  code_review: 'Code review',
  kb_doc: 'Knowledge',
  learning: 'Learning',
};

/**
 * Sources that belong to one glob and go with it when it is deleted. A decision taken from a knowledge item has no
 * glob link, so only decisions taken on a glob are matched.
 */
export const GLOB_OWNED_SOURCES: readonly SourceType[] = SOURCE_TYPES.filter((s) => s !== 'kb_doc' && s !== 'learning');

/**
 * Order of authority, highest first (spec): merged code and the implementation record, then current decisions, then
 * plan.md and approved knowledge, then older discussion; superseded decisions are history, ranked down by status.
 */
export const AUTHORITY_TIERS = ['merged_code', 'decision', 'approved_plan', 'discussion', 'legacy'] as const;
export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];

export const AUTHORITY_WEIGHTS: Readonly<Record<AuthorityTier, number>> = {
  merged_code: 1,
  decision: 0.95,
  approved_plan: 0.9,
  discussion: 0.6,
  legacy: 0.3,
};

/** `superseded`: a decision a newer one replaced (decision supersession); `legacy` is reserved for imports, nothing sets it yet. */
export const ITEM_STATUSES = ['active', 'superseded', 'legacy'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** `pending_summary`: a merged change whose "why" the model has not written yet (it stays searchable by file path). */
export const ITEM_STATES = ['ready', 'pending_summary'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export const SEARCH_MODES = ['current', 'all_time'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export interface SearchQuery {
  readonly boardId: number;
  readonly query: string;
  /** `current` (default) favours recent, active material; `all_time` ranks history on relevance and authority alone. */
  readonly mode: SearchMode;
  /** Inclusive ISO bounds on when the item happened. */
  readonly from?: string;
  readonly to?: string;
  readonly globId?: string;
  readonly group?: string;
  readonly sourceTypes?: readonly SourceType[];
}

/** One indexed source item as the indexer writes it (`replaceItem`). Chunks go with it. */
export interface NewKnowledgeItem {
  readonly boardId: number;
  readonly sourceType: SourceType;
  /** Stable per source object: `artifact:s1f2:plan:`, `kb:<name>`, `review:<externalId>`, `change:<sha>`. */
  readonly externalRef: string;
  readonly title: string;
  readonly occurredAt: string;
  readonly authority: AuthorityTier;
  readonly status: ItemStatus;
  readonly supersededBy: number | null;
  /** The globs it links to: filter metadata, never part of a chunk header. */
  readonly globIds: readonly string[];
  readonly globGroup: string | null;
  /** Where a citation points: a path in slop's UI, or a code-host URL. */
  readonly externalUrl: string | null;
  readonly contentHash: string;
  readonly state: ItemState;
}

/** A stored item, as the summary step reads it back. */
export interface KnowledgeItem extends NewKnowledgeItem {
  readonly id: number;
  readonly attempts: number;
  readonly processAfter: string | null;
  readonly lastError: string | null;
}

export interface NewChunk {
  readonly position: number;
  readonly header: string;
  readonly text: string;
}

/** The embedding dimensions of the column and of every `Embedder`. */
export const EMBEDDING_DIMENSIONS = 1024;

/** A chunk waiting for its vector. */
export interface PendingChunk {
  readonly id: number;
  readonly header: string;
  readonly text: string;
}

/** What a candidate query returns for one chunk: the chunk, its item's metadata and a raw relevance in [0, 1]. */
export interface Candidate {
  readonly chunkId: number;
  readonly itemId: number;
  readonly header: string;
  readonly text: string;
  readonly relevance: number;
  readonly sourceType: SourceType;
  readonly title: string;
  readonly occurredAt: string;
  readonly authority: AuthorityTier;
  readonly status: ItemStatus;
  /** The title of the item that replaced this one (superseded items). */
  readonly supersededByTitle: string | null;
  /** When the item that replaced this one happened (superseded items). */
  readonly supersededByAt: string | null;
  readonly globIds: readonly string[];
  readonly globGroup: string | null;
  readonly externalUrl: string | null;
}

export interface Citation {
  readonly source: SourceType;
  readonly date: string;
  readonly title: string;
  readonly link: string | null;
  readonly globId: string | null;
}

export interface SearchHit {
  readonly itemId: number;
  readonly header: string;
  readonly text: string;
  readonly score: number;
  readonly citation: Citation;
  readonly status: ItemStatus;
  readonly supersededBy: { readonly title: string; readonly date: string | null } | null;
  /** `superseded by "..." on <date>` or `legacy`, so a reader can tell history from current truth. */
  readonly label: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENCY_HALF_LIFE_DAYS = 90;
export const SUPERSEDED_FACTOR = 0.15;
export const RRF_K = 60;
export const MAX_RESULT_CHUNKS = 10;
export const MAX_RESULT_TOKENS = 8000;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const isLegacy = (c: Pick<Candidate, 'status' | 'authority'>): boolean => c.status === 'legacy' || c.authority === 'legacy';

/** 1 for something that happened now, halving every `RECENCY_HALF_LIFE_DAYS`; a future date counts as now. */
export const recency = (occurredAt: string, now: string): number => {
  const ageDays = Math.max(0, Date.parse(now) - Date.parse(occurredAt)) / DAY_MS;
  return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
};

/** `relevance × authority × recency × status`; `all_time` drops recency and the superseded penalty. */
export const scoreOf = (c: Candidate, mode: SearchMode, now: string): number => {
  const authority = AUTHORITY_WEIGHTS[c.authority];
  if (mode === 'all_time') return c.relevance * authority;
  return c.relevance * authority * recency(c.occurredAt, now) * (c.status === 'superseded' ? SUPERSEDED_FACTOR : 1);
};

const labelOf = (c: Candidate): string | null => {
  if (c.status === 'superseded') {
    if (c.supersededByTitle === null) return 'superseded';
    return `superseded by "${c.supersededByTitle}"${c.supersededByAt === null ? '' : ` on ${c.supersededByAt.slice(0, 10)}`}`;
  }
  return isLegacy(c) ? 'legacy' : null;
};

export const toHit = (c: Candidate, score: number): SearchHit => ({
  itemId: c.itemId,
  header: c.header,
  text: c.text,
  score,
  citation: { source: c.sourceType, date: c.occurredAt, title: c.title, link: c.externalUrl, globId: c.globIds[0] ?? null },
  status: isLegacy(c) ? 'legacy' : c.status,
  supersededBy: c.supersededByTitle === null ? null : { title: c.supersededByTitle, date: c.supersededByAt },
  label: labelOf(c),
});

const isSupersededDecision = (c: Candidate): boolean => c.sourceType === 'decision' && c.status === 'superseded';

/**
 * Candidates as hits, best first. In `current` mode legacy material ranks after everything else, however well it
 * matches, and a superseded decision ranks after every current one (the current decision comes first, its replaced
 * predecessors follow labelled); ties go to the newer item. `all_time` ranks on relevance and authority alone.
 */
export const rankCandidates = (candidates: readonly Candidate[], mode: SearchMode, now: string): SearchHit[] => {
  const scored = candidates.map((c) => ({ c, score: scoreOf(c, mode, now) }));
  scored.sort((a, b) => {
    if (mode === 'current' && isLegacy(a.c) !== isLegacy(b.c)) return isLegacy(a.c) ? 1 : -1;
    if (mode === 'current' && isSupersededDecision(a.c) !== isSupersededDecision(b.c)) return isSupersededDecision(a.c) ? 1 : -1;
    return b.score - a.score || b.c.occurredAt.localeCompare(a.c.occurredAt) || a.c.chunkId - b.c.chunkId;
  });
  return scored.map(({ c, score }) => toHit(c, score));
};

/**
 * Reciprocal rank fusion of ranked lists of the same chunks (keyword and semantic). The fused relevance is scaled to
 * [0, 1] (1 = first in every list) so the ranking weights act on it as on any other relevance.
 */
export const rrfFuse = (lists: readonly (readonly Candidate[])[], k: number = RRF_K): Candidate[] => {
  const fused = new Map<number, { candidate: Candidate; score: number }>();
  for (const list of lists) {
    list.forEach((candidate, rank) => {
      const entry = fused.get(candidate.chunkId) ?? { candidate, score: 0 };
      entry.score += 1 / (k + rank + 1);
      fused.set(candidate.chunkId, entry);
    });
  }
  const best = lists.length / (k + 1);
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.candidate.chunkId - b.candidate.chunkId)
    .map(({ candidate, score }) => ({ ...candidate, relevance: best === 0 ? 0 : score / best }));
};

/** The leading hits that fit `maxChunks` and `maxTokens` (a hit that would overflow ends the list). */
export const withinBudget = (
  hits: readonly SearchHit[],
  maxChunks: number = MAX_RESULT_CHUNKS,
  maxTokens: number = MAX_RESULT_TOKENS,
): SearchHit[] => {
  const kept: SearchHit[] = [];
  let tokens = 0;
  for (const hit of hits) {
    tokens += estimateTokens(hit.header) + estimateTokens(hit.text);
    if (kept.length >= maxChunks || tokens > maxTokens) break;
    kept.push(hit);
  }
  return kept;
};

/** Whether an item passes a query's filters (date range, glob, group, source types); SQL applies the same. */
export const matchesFilters = (
  item: Pick<Candidate, 'occurredAt' | 'globIds' | 'globGroup' | 'sourceType'>,
  q: Pick<SearchQuery, 'from' | 'to' | 'globId' | 'group' | 'sourceTypes'>,
): boolean =>
  (q.from === undefined || Date.parse(item.occurredAt) >= Date.parse(q.from)) &&
  (q.to === undefined || Date.parse(item.occurredAt) <= Date.parse(q.to)) &&
  (q.globId === undefined || item.globIds.includes(q.globId)) &&
  (q.group === undefined || item.globGroup === q.group) &&
  (q.sourceTypes === undefined || q.sourceTypes.length === 0 || q.sourceTypes.includes(item.sourceType));
