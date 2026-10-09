import { SOURCE_TYPES } from '@slop/core';
import type { SearchMode, SearchRequest, SourceType } from '@slop/core';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO date or timestamp as an instant; a bare `to` date covers its whole day. Null when it isn't a date. */
export const parseBound = (value: string, edge: 'from' | 'to'): string | null => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(edge === 'to' && DATE_ONLY.test(value) ? ms + 86_400_000 - 1 : ms).toISOString();
};

export const isDate = (value: string): boolean => !Number.isNaN(Date.parse(value));

export const isSourceType = (value: string): value is SourceType => SOURCE_TYPES.some((s) => s === value);

export interface SearchParams {
  readonly board: number;
  readonly query: string;
  readonly mode?: SearchMode | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly glob?: string | undefined;
  readonly group?: string | undefined;
  readonly sourceTypes?: readonly SourceType[] | undefined;
}

/** The core request for tool or route parameters (dates already validated). */
export const toRequest = (p: SearchParams): SearchRequest => {
  const from = p.from === undefined ? null : parseBound(p.from, 'from');
  const to = p.to === undefined ? null : parseBound(p.to, 'to');
  return {
    boardId: p.board,
    query: p.query,
    ...(p.mode === undefined ? {} : { mode: p.mode }),
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
    ...(p.glob === undefined ? {} : { globId: p.glob }),
    ...(p.group === undefined ? {} : { group: p.group }),
    ...(p.sourceTypes === undefined ? {} : { sourceTypes: p.sourceTypes }),
  };
};
