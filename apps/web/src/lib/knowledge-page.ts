import type { KnowledgePageChange, KnowledgePageDecision } from './api';

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

/** What a recent-changes row says: agent-set rows read "Agent set vN published" whatever text the server wrote. */
export const changeText = (change: KnowledgePageChange): string =>
  change.kind === 'agent_set' && change.agentSetVersion !== undefined ? `Agent set v${change.agentSetVersion} published` : change.text;

/** Newest first, whatever order the server sent. */
export const newestFirst = (changes: readonly KnowledgePageChange[]): KnowledgePageChange[] =>
  [...changes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

/** Link labels for an entry's glob ids: "decision", or "decision 2", "decision 3" when there are several. */
export const decisionLinks = (entry: KnowledgePageDecision): { id: string; label: string }[] => {
  const ids = entry.globIds ?? [];
  return ids.map((id, i) => ({ id, label: ids.length === 1 ? 'decision' : `decision ${i + 1}` }));
};
