import type { KnowledgePageAgentSetVersion, KnowledgePageDecision, KnowledgePageDecisionGroup, KnowledgePageFeedback, KnowledgePageVerdict } from './api';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; older than a month, the date. */
export const relativeTime = (iso: string, now: number): string => {
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (ms < MIN) return 'just now';
  if (ms < HOUR) return plural(Math.floor(ms / MIN), 'minute');
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');
  if (ms < 30 * DAY) return plural(Math.floor(ms / DAY), 'day');
  return iso.slice(0, 10);
};

/** The link target for a glob on its board (the same `?glob=` mechanism the cards use). */
export const globHref = (boardId: number, globId: string): string => `/boards/${boardId}?glob=${encodeURIComponent(globId)}`;

/** The board with the Decision category selected (the same `?category=` filter the board's filter bar writes). */
export const decisionsHref = (boardId: number): string => `/boards/${boardId}?category=decision`;

/** The page shows at most this many key decisions; the rest sit behind "N more decisions". */
export const KEY_DECISIONS_MAX = 20;

/** The agent-set history lists this many versions. */
export const AGENT_SET_HISTORY_MAX = 10;

export interface KeyDecisions {
  /** Whether the version has the key flag at all (versions written before it do not: they show every entry). */
  readonly flagged: boolean;
  readonly shown: readonly KnowledgePageDecisionGroup[];
  readonly more: readonly KnowledgePageDecisionGroup[];
  /** Entries in `more`. */
  readonly moreCount: number;
}

const keep = (groups: readonly KnowledgePageDecisionGroup[], wanted: ReadonlySet<KnowledgePageDecision>): KnowledgePageDecisionGroup[] =>
  groups.flatMap((g) => {
    const entries = (g.entries ?? []).filter((e) => wanted.has(e));
    return entries.length === 0 ? [] : [{ area: g.area, entries }];
  });

/** The verdicts by decision glob. */
export const verdictMap = (feedback: readonly KnowledgePageFeedback[] | undefined): ReadonlyMap<string, KnowledgePageVerdict> =>
  new Map((feedback ?? []).map((f) => [f.globId, f.verdict]));

/** The verdicts that apply to an entry's decisions, as the server writes them in: any pin makes it key, else any "not key" makes it not. */
export const entryVerdict = (entry: KnowledgePageDecision, verdicts: ReadonlyMap<string, KnowledgePageVerdict>): KnowledgePageVerdict | null => {
  const given = (entry.globIds ?? []).flatMap((id) => verdicts.get(id) ?? []);
  return given.includes('pin') ? 'pin' : given.includes('hide') ? 'hide' : null;
};

/** Whether the entry is key once the verdicts are applied; undefined for an entry the model never flagged and nobody judged. */
const keyOf = (entry: KnowledgePageDecision, verdicts: ReadonlyMap<string, KnowledgePageVerdict>): boolean | undefined => {
  const verdict = entryVerdict(entry, verdicts);
  return verdict === null ? entry.key : verdict === 'pin';
};

/**
 * Splits a version's decisions into the key ones to show (pinned first, then newest-backed, at most `max`, grouped by
 * area in the stored order) and the rest. Verdicts win over the stored flag. A version in which no entry carries the
 * flag is legacy: it shows everything.
 */
export const keyDecisions = (
  groups: readonly KnowledgePageDecisionGroup[],
  max: number = KEY_DECISIONS_MAX,
  verdicts: ReadonlyMap<string, KnowledgePageVerdict> = new Map(),
): KeyDecisions => {
  const entries = groups.flatMap((g) => g.entries ?? []);
  if (!entries.some((e) => keyOf(e, verdicts) !== undefined)) return { flagged: false, shown: groups, more: [], moreCount: 0 };
  const newest = entries
    .filter((e) => keyOf(e, verdicts) === true)
    .map((entry, order) => ({ entry, order, pinned: entryVerdict(entry, verdicts) === 'pin' }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.entry.at ?? '').localeCompare(a.entry.at ?? '') || a.order - b.order)
    .slice(0, max)
    .map((x) => x.entry);
  const picked = new Set(newest);
  const rest = new Set(entries.filter((e) => !picked.has(e)));
  return { flagged: true, shown: keep(groups, picked), more: keep(groups, rest), moreCount: rest.size };
};

/** The agent-set versions to list: newest first, at most `max`. */
export const recentAgentSetVersions = (
  history: readonly KnowledgePageAgentSetVersion[] | undefined,
  max: number = AGENT_SET_HISTORY_MAX,
): KnowledgePageAgentSetVersion[] => [...(history ?? [])].sort((a, b) => b.version - a.version).slice(0, max);

/** Link labels for an entry's glob ids: "decision", or "decision 2", "decision 3" when there are several. */
export const decisionLinks = (entry: KnowledgePageDecision): { id: string; label: string }[] => {
  const ids = entry.globIds ?? [];
  return ids.map((id, i) => ({ id, label: ids.length === 1 ? 'decision' : `decision ${i + 1}` }));
};
