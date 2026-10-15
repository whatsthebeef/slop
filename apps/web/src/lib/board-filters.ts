import { fixOf, isHumanCategory, modeOf } from '@slop/core';
import type { HumanStepViewer, Mode } from '@slop/core';
import type { GlobView } from './api';
import { needsPerson } from './card-rows';
import { hasOpenQuestions } from './questions';
import { armLabel } from './rollout-stages';

/** What a filter may need beyond the glob itself: the time and the viewer decide whose turn it is. */
export interface FilterContext {
  now: string;
  viewer?: HumanStepViewer;
}

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
  matches: (glob: GlobView, value: string, context: FilterContext) => boolean;
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

/** Has no permanent control: the pane shows it as a removable chip only while it is set (a group tag was clicked). */
interface TagFilter extends FilterBase {
  control: 'tag';
}

/** An on/off switch: its value is `1` when on, and it is off by default. */
interface ToggleFilter extends FilterBase {
  control: 'toggle';
}

export type BoardFilter = ChipsFilter | TextFilter | TagFilter | ToggleFilter;

/** Splits a comma or space separated list, dropping empties. */
const tokens = (raw: string): string[] => raw.split(/[\s,]+/).filter((t) => t !== '');

/** The kinds people see, in chip order. Sub, same and super are how the work is run, not what it is. */
export const KINDS = ['task', 'bug', 'action', 'decision'] as const;
export type Kind = (typeof KINDS)[number];

/** The kind a card's corner icon shows; the filter uses the same test, so a chip selects exactly the cards that show its icon. */
export const kindOf = (glob: Pick<GlobView, 'category' | 'type' | 'fix'>): Kind => {
  const mode: Mode = modeOf(glob);
  if (mode === 'decision' || mode === 'action') return mode;
  return fixOf(glob) ? 'bug' : 'task';
};

const DEFAULT_KINDS = 'task,bug,action';

/** The board's filters. Adding one is one entry here: the pane renders this list and the board applies it. */
export const BOARD_FILTERS: BoardFilter[] = [
  {
    key: 'kind',
    label: 'Kind',
    hideLabel: true,
    defaultValue: DEFAULT_KINDS,
    control: 'chips',
    options: KINDS.map((value) => ({ value, label: value })),
    // Kept in the options' order and without repeats, so equal selections give equal URLs.
    normalize: (raw) => KINDS.filter((k) => tokens(raw.toLowerCase()).includes(k)).join(','),
    matches: (glob, value) => tokens(value).includes(kindOf(glob)),
  },
  {
    key: 'id',
    label: 'ID or name',
    control: 'text',
    placeholder: 'e.g. f4, s15t2, attachments',
    // Kept as typed (a trailing space is the next ID being started), and off when blank.
    normalize: (raw) => (tokens(raw).length === 0 ? '' : raw),
    // Case-insensitive substring of the ID or title; several tokens match any of them, and the whole value matches a title as a phrase.
    matches: (glob, value) => {
      const id = glob.id.toLowerCase();
      const title = glob.title.toLowerCase();
      const phrase = value.trim().toLowerCase();
      return (
        tokens(phrase).some((t) => id.includes(t) || title.includes(t)) || title.includes(phrase)
      );
    },
  },
  {
    key: 'group',
    label: 'Group',
    control: 'tag',
    // Kept as given apart from surrounding space; off when blank.
    normalize: (raw) => raw.trim(),
    // Exact match on the name; globs with no group never match.
    matches: (glob, value) => glob.group === value,
  },
  {
    key: 'human',
    label: 'Only human',
    control: 'toggle',
    normalize: (raw) => (raw.trim() === '1' ? '1' : ''),
    // The same status the card shows: only globs whose status is the human outline.
    matches: (glob, _value, { now, viewer }) => needsPerson(glob, now, viewer),
  },
  {
    key: 'arm',
    label: 'Arm system',
    control: 'toggle',
    normalize: (raw) => (raw.trim() === '1' ? '1' : ''),
    // Globs with a step a person must do at release (the card's "Arm system" label); human work has none.
    matches: (glob) => !isHumanCategory(glob.category) && armLabel(glob) !== null,
  },
  {
    key: 'questions',
    label: 'Has open questions',
    control: 'toggle',
    normalize: (raw) => (raw.trim() === '1' ? '1' : ''),
    // Globs with an unanswered question (the card's Question chip); an older API sends none.
    matches: (glob) => hasOpenQuestions(glob),
  },
];

/** The URL text meaning "show all" for a filter that has a default. */
const ALL = 'all';

/** The filters' values with nothing chosen: each filter's default. */
export const defaultFilters = (): FilterValues =>
  Object.fromEntries(BOARD_FILTERS.flatMap((f) => (f.defaultValue === undefined ? [] : [[f.key, f.defaultValue] as const])));

/** The parameters of the filters this one replaced (`mode` chips and the `fix` toggle), still read from old links and memory. */
export const LEGACY_KEYS = ['mode', 'fix'] as const;

/** An old link's `mode` and `fix` as the kind chips: sub, same and super become Task and Bug, and `fix=1` narrows that to Bug. */
const legacyKinds = (params: URLSearchParams): string | null => {
  const mode = params.get('mode');
  const fix = params.get('fix');
  if (mode === null && fix === null) return null;
  if (mode?.trim().toLowerCase() === ALL) return ALL;
  const modes = mode === null ? ['sub', 'same', 'super', 'action'] : tokens(mode.toLowerCase());
  const machine = modes.some((m) => m === 'sub' || m === 'same' || m === 'super');
  if (fix?.trim() === '1') return machine ? 'bug' : '';
  const kinds: string[] = [];
  if (machine) kinds.push('task', 'bug');
  if (modes.includes('action')) kinds.push('action');
  if (modes.includes('decision')) kinds.push('decision');
  return kinds.join(',');
};

/** The active filters in a URL query. A filter with a default has it when the parameter is missing or unreadable. */
export const parseFilters = (params: URLSearchParams): FilterValues =>
  Object.fromEntries(
    BOARD_FILTERS.flatMap((f) => {
      const legacy = f.key === 'kind' && !params.has('kind') ? legacyKinds(params) : null;
      const raw = params.get(f.key) ?? legacy ?? '';
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
  for (const key of LEGACY_KEYS) next.delete(key);
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
export const matchesFilters = (
  glob: GlobView,
  values: FilterValues,
  context: FilterContext = { now: new Date().toISOString() },
): boolean =>
  BOARD_FILTERS.every((f) => {
    const value = f.normalize(values[f.key] ?? '');
    return value === '' || f.matches(glob, value, context);
  });

/** A chips value with the option switched on or off. */
export const toggleOption = (filter: BoardFilter, raw: string, option: string): string => {
  const on = tokens(raw);
  return filter.normalize(
    (on.includes(option) ? on.filter((o) => o !== option) : [...on, option]).join(','),
  );
};

export const selectedOptions = (raw: string): string[] => tokens(raw);
