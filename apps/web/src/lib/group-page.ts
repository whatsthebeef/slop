import { isHumanCategory, normaliseGroup } from '@slop/core';
import type { Category } from '@slop/core';
import type { GroupGlobRow, GroupSummary, RegroupResult } from '@slop/core';

/** Where a group's page lives; the name is a path segment, so it is encoded. */
export const groupPath = (boardId: number, name: string): string => `/boards/${String(boardId)}/groups/${encodeURIComponent(name)}`;

/** The board view narrowed to a group; the name is a query value, so it is encoded. */
export const boardGroupPath = (boardId: number, name: string): string => `/boards/${String(boardId)}?group=${encodeURIComponent(name)}`;

/** "3/5": merged of work globs. */
export const progressText = (progress: { readonly merged: number; readonly total: number }): string => `${String(progress.merged)}/${String(progress.total)}`;

/** The card's progress for a group: shown only while more than one of its globs is open, so a lone glob keeps a plain label. */
export const cardProgress = (groups: readonly GroupSummary[] | undefined, name: string): string | null => {
  const summary = groups?.find((g) => normaliseGroup(g.name) === normaliseGroup(name));
  return summary !== undefined && summary.open > 1 ? progressText(summary.progress) : null;
};

/** Globs a person can move into the group: work globs of the board that aren't in it, newest id last. */
export const movableIn = <G extends { id: string; group: string | null; category: Category; list: string }>(globs: readonly G[], name: string): G[] =>
  globs
    .filter((g) => !isHumanCategory(g.category) && g.list !== 'signed_off' && (g.group === null || normaliseGroup(g.group) !== normaliseGroup(name)))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

/** One line for a rename or merge: the globs that kept their old name come back to try again. */
export const regroupNotice = (result: RegroupResult): string =>
  result.failed.length === 0
    ? `${String(result.moved)} glob${result.moved === 1 ? '' : 's'} now in ${result.name}`
    : `${String(result.moved)} moved to ${result.name}; ${result.failed.map((f) => f.id).join(', ')} didn't move, try again`;

/** Who holds the move and what for, as one phrase for a row. */
export const holdText = (row: Pick<GroupGlobRow, 'move' | 'holding'>): string => {
  const who = row.move.who === undefined ? row.move.holder : `${row.move.holder} (${row.move.who})`;
  return row.move.reason === '' ? who : `${who}: ${row.move.reason}`;
};
