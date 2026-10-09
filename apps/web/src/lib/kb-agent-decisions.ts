import type { KbItem } from '@slop/core';

/** How far back the Knowledge page's "Decided by agent" filter looks. */
export const AGENT_DECISION_DAYS = 7;

/** The items an agent decided (approved or rejected through MCP) within the last `AGENT_DECISION_DAYS`, newest first. */
export const decidedByAgent = <T extends KbItem>(items: readonly T[], now: number): T[] => {
  const since = now - AGENT_DECISION_DAYS * 24 * 60 * 60 * 1000;
  return items
    .filter((item) => item.outcome?.via === 'agent' && item.decidedAt !== null && Date.parse(item.decidedAt) >= since)
    .sort((a, b) => Date.parse(b.decidedAt ?? '') - Date.parse(a.decidedAt ?? ''));
};

/** Whether an admin can reopen the item: the pipeline closed it, or an agent decided it. */
export const reopenable = (item: KbItem): boolean =>
  item.status === 'merged' ||
  item.status === 'suppressed' ||
  item.status === 'covered' ||
  ((item.status === 'approved' || item.status === 'rejected') && item.outcome?.via === 'agent');
