import { ListFilter, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { HumanIcon } from '@/components/actor-icons';
import { CATEGORY_ICON } from '@/components/glob-card';
import { browserStore, clearFilterMemory, hasFilterParams, loadFilterMemory, saveFilterMemory } from '@/lib/board-filter-memory';
import { activeCount, BOARD_FILTERS, defaultFilters, parseFilters, selectedOptions, toggleOption, writeFilters } from '@/lib/board-filters';
import type { BoardFilter, FilterValues } from '@/lib/board-filters';
import { cn } from '@/lib/utils';

const PANE_ID = 'board-filter-pane';
export const FILTER_TOGGLE_ID = 'board-filter-toggle';
export const FILTER_TEXT_ID = 'board-filter-text';
const OPEN_KEY = 'slop.board-filter-open';

/** Whether the pane is open is the viewer's own preference; storage can be missing or blocked, so it is only a convenience. */
export const useFilterPaneOpen = (): [boolean, (open: boolean) => void] => {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // Not remembered; the pane still works.
    }
  };
  return [open, set];
};

/**
 * The filters live in the URL so a filtered view can be linked, and the board remembers them: a URL with filters wins and is
 * saved; a bare URL (back from a glob, another tab or board, a reload) gets the remembered ones. The board and its Signed Off
 * view share them. Whether the pane is open is the viewer's own preference.
 */
export const useBoardFilters = (boardId: number) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const filtering = activeCount(filters);
  const setFilters = (values: FilterValues) => {
    // Back to the defaults forgets the memory first, so the restore below doesn't bring the old filters back.
    if (activeCount(values) === 0) clearFilterMemory(browserStore(), boardId);
    setSearchParams((params) => writeFilters(params, values), { replace: true });
  };
  const query = searchParams.toString();
  useEffect(() => {
    const store = browserStore();
    if (hasFilterParams(searchParams)) {
      saveFilterMemory(store, boardId, searchParams);
      return;
    }
    const saved = loadFilterMemory(store, boardId);
    if (saved === null) return;
    setSearchParams((params) => new URLSearchParams([...params, ...saved]), { replace: true });
  }, [boardId, query]);
  const [filterOpen, setFilterOpen] = useFilterPaneOpen();
  return { filters, filtering, setFilters, filterOpen, setFilterOpen };
};

/** The tab row's filter button, left of the chat button. A dot with the number of filters on shows even while the pane is closed. */
export const FilterToggle = ({
  open,
  active,
  onClick,
}: {
  open: boolean;
  active: number;
  onClick: () => void;
}) => (
  <button
    type="button"
    id={FILTER_TOGGLE_ID}
    className="relative rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
    aria-label="Filter globs"
    aria-pressed={open}
    aria-expanded={open}
    aria-controls={PANE_ID}
    title={active > 0 ? `Filter globs (${String(active)} on)` : 'Filter globs'}
    data-testid="filter-toggle"
    onClick={onClick}
  >
    <ListFilter className="h-4 w-4" aria-hidden />
    {active > 0 && (
      <span
        className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-signal-strong px-1 text-[9px] leading-none font-semibold text-background"
        data-testid="filter-active"
      >
        {active}
      </span>
    )}
  </button>
);

const Control = ({
  filter,
  value,
  onChange,
}: {
  filter: BoardFilter;
  value: string;
  onChange: (value: string) => void;
}) => {
  if (filter.control === 'text') {
    return (
      <span className="relative inline-flex items-center">
        <input
          type="text"
          id={filter.key === 'id' ? FILTER_TEXT_ID : undefined}
          value={value}
          placeholder={filter.placeholder}
          aria-label={filter.label}
          aria-keyshortcuts={filter.key === 'id' ? '/' : undefined}
          className="h-7 w-44 rounded border border-edge bg-card pr-6 pl-2 text-sm"
          data-testid={`filter-${filter.key}`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Escape leaves the field and keeps the text; Enter clears it (the cards all show again) and leaves too.
            if (e.key !== 'Escape' && e.key !== 'Enter') return;
            e.stopPropagation();
            if (e.key === 'Enter') onChange('');
            e.currentTarget.blur();
          }}
        />
        {filter.key === 'id' && value === '' && (
          <kbd
            className="pointer-events-none absolute right-1.5 rounded border border-edge px-1 text-[10px] leading-4 text-muted-foreground"
            aria-hidden
          >
            /
          </kbd>
        )}
      </span>
    );
  }
  if (filter.control === 'tag') return null;
  if (filter.control === 'toggle') {
    const pressed = value !== '';
    return (
      <button
        type="button"
        aria-pressed={pressed}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs',
          pressed ? 'border-foreground bg-muted font-medium' : 'border-edge text-muted-foreground hover:text-foreground',
        )}
        data-testid={`filter-${filter.key}`}
        onClick={() => onChange(pressed ? '' : '1')}
      >
        <HumanIcon className="h-3.5 w-3.5" decorative />
        {filter.label}
      </button>
    );
  }
  const on = selectedOptions(value);
  return (
    <div className="flex gap-1" role="group" aria-label={filter.label}>
      {filter.options.map((option) => {
        const category =
          filter.key === 'category'
            ? CATEGORY_ICON[option.value as keyof typeof CATEGORY_ICON]
            : undefined;
        const pressed = on.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs capitalize',
              pressed
                ? 'border-foreground bg-muted font-medium'
                : 'border-edge text-muted-foreground hover:text-foreground',
            )}
            data-testid={`filter-${filter.key}-${option.value}`}
            onClick={() => onChange(toggleOption(filter, value, option.value))}
          >
            {category !== undefined && (
              <category.icon className={cn('h-3.5 w-3.5', category.className)} aria-hidden />
            )}
            {option.label}
          </button>
        );
      })}
    </div>
  );
};

/** Slides open between the tab row and the columns, moving the cards down rather than covering them. Whatever is in BOARD_FILTERS shows here. */
export const FilterPane = ({
  open,
  values,
  onChange,
  onClose,
  groupHref,
}: {
  open: boolean;
  values: FilterValues;
  onChange: (values: FilterValues) => void;
  onClose: () => void;
  /** The page of the group being filtered to; the group chip links to it. */
  groupHref?: (name: string) => string;
}) => (
  <div
    id={PANE_ID}
    className={cn(
      'grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none',
      open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
    )}
    inert={!open}
    data-testid="filter-pane"
    data-open={open}
    onKeyDown={(e) => {
      if (e.key === 'Escape') onClose();
    }}
  >
    <div className="overflow-hidden">
      <div className="mx-5 mt-1.5 flex flex-wrap items-center gap-x-6 gap-y-2 py-2 pr-8 relative">
        <button
          type="button"
          className="absolute top-2 right-0 rounded p-1 hover:bg-muted"
          aria-label="Close filters"
          data-testid="filter-close"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
        {BOARD_FILTERS.filter((filter) => filter.control !== 'tag').map((filter) => (
          <div key={filter.key} className="flex items-center gap-2 text-xs text-muted-foreground">
            {!filter.hideLabel && filter.control !== 'toggle' && <span>{filter.label}</span>}
            <Control
              filter={filter}
              value={values[filter.key] ?? ''}
              onChange={(value) => onChange({ ...values, [filter.key]: value })}
            />
          </div>
        ))}
        {BOARD_FILTERS.filter((filter) => filter.control === 'tag' && (values[filter.key] ?? '') !== '').map((filter) => (
          <span
            key={filter.key}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-foreground bg-muted pr-1 pl-2.5 text-xs font-medium"
            data-testid={`filter-${filter.key}-chip`}
          >
            {filter.label}: {values[filter.key]}
            {filter.key === 'group' && groupHref !== undefined && (
              <Link className="underline" to={groupHref(values[filter.key] ?? '')} data-testid="filter-group-page">
                Open
              </Link>
            )}
            <button
              type="button"
              className="rounded-full p-0.5 hover:bg-background"
              aria-label={`Remove ${filter.label.toLowerCase()} filter`}
              data-testid={`filter-${filter.key}-remove`}
              onClick={() => onChange({ ...values, [filter.key]: '' })}
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        {activeCount(values) > 0 && (
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground underline hover:text-foreground"
            data-testid="filter-clear"
            onClick={() => onChange(defaultFilters())}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  </div>
);
