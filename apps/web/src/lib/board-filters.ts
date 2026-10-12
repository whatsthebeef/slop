import type { Category } from '@slop/core';
import type { GlobView } from './api';

/** A filter's value is always its URL text, so reading, writing and matching share one form (chips hold comma-joined options). */
export type FilterValues = Readonly<Record<string, string>>;

interface FilterBase {
  /** The URL query parameter. */
  key: string;
  label: string;
  /** Hides the visible label (the control still carries it as its aria-label). */
  hideLabel?: boolean;
  /**
   * What the filter is when the URL has no parameter for it. Without one, empty means off. With one, empty means "show all",
   * which the URL writes as `all` so it stays distinct from the default.
   */
  defaultValue?: string;
  /** Cleans a raw value (from the URL or the control); empty means the filter is off. */
  normalize: (raw: string) => string;
  /** True when the glob passes, given a non-empty normalised value. */
  matches: (glob: GlobView, value: string) => boolean;
}

/** Toggle chips; none selected means all. */
interface ChipsFilter extends FilterBase {
  control: 'chips';
  options: { value: string; label: string }[];
}

interface TextFilter extends FilterBase {
  control: 'text';
  placeholder: string;
}

export type BoardFilter = ChipsFilter | TextFilter;

/** Splits a comma or space separated list, dropping empties. */
const tokens = (raw: string): string[] => raw.split(/[\s,]+/).filter((t) => t !== '');

const CATEGORIES: Category[] = ['feature', 'task', 'bug', 'decision'];

/** The board's filters. Adding one is one entry here: the pane renders this list and the board applies it. */
export const BOARD_FILTERS: BoardFilter[] = [
  {
    key: 'category',
    label: 'Category',
    hideLabel: true,
    defaultValue: 'feature,task,bug',
    control: 'chips',
    options: CATEGORIES.map((value) => ({ value, label: value })),
    // Kept in the options' order and without repeats, so equal selections give equal URLs.
    normalize: (raw) => CATEGORIES.filter((c) => tokens(raw.toLowerCase()).includes(c)).join(','),
    matches: (glob, value) => tokens(value).includes(glob.category),
  },
  {
    key: 'id',
    label: 'Glob ID',
    control: 'text',
    placeholder: 'e.g. f4, s15t2',
    // Kept as typed (a trailing space is the next ID being started), and off when blank.
    normalize: (raw) => (tokens(raw).length === 0 ? '' : raw),
    // Case-insensitive substring of the ID; several IDs match any of them.
    matches: (glob, value) =>
      tokens(value.toLowerCase()).some((t) => glob.id.toLowerCase().includes(t)),
  },
];

/** The URL text meaning "show all" for a filter that has a default. */
const ALL = 'all';

/** The filters' values with nothing chosen: each filter's default. */
export const defaultFilters = (): FilterValues =>
  Object.fromEntries(BOARD_FILTERS.flatMap((f) => (f.defaultValue === undefined ? [] : [[f.key, f.defaultValue] as const])));

/** The active filters in a URL query. A filter with a default has it when the parameter is missing or unreadable. */
export const parseFilters = (params: URLSearchParams): FilterValues =>
  Object.fromEntries(
    BOARD_FILTERS.flatMap((f) => {
      const raw = params.get(f.key) ?? '';
      const value =
        f.defaultValue === undefined
          ? f.normalize(raw)
          : raw.trim().toLowerCase() === ALL
            ? ''
            : f.normalize(raw) || f.defaultValue;
      return value === '' ? [] : [[f.key, value] as const];
    }),
  );

/** The query with the filters' parameters replaced by these values; other parameters stay. */
export const writeFilters = (params: URLSearchParams, values: FilterValues): URLSearchParams => {
  const next = new URLSearchParams(params);
  for (const f of BOARD_FILTERS) {
    const value = f.normalize(values[f.key] ?? '');
    if (value === (f.defaultValue ?? '')) next.delete(f.key);
    else next.set(f.key, value === '' ? ALL : value);
  }
  return next;
};

/** How many filters differ from their defaults. */
export const activeCount = (values: FilterValues): number =>
  BOARD_FILTERS.filter((f) => f.normalize(values[f.key] ?? '') !== (f.defaultValue ?? '')).length;

/** True when the glob passes every active filter; with none active, every glob does. */
export const matchesFilters = (glob: GlobView, values: FilterValues): boolean =>
  BOARD_FILTERS.every((f) => {
    const value = f.normalize(values[f.key] ?? '');
    return value === '' || f.matches(glob, value);
  });

/** A chips value with the option switched on or off. */
export const toggleOption = (filter: BoardFilter, raw: string, option: string): string => {
  const on = tokens(raw);
  return filter.normalize(
    (on.includes(option) ? on.filter((o) => o !== option) : [...on, option]).join(','),
  );
};

export const selectedOptions = (raw: string): string[] => tokens(raw);
