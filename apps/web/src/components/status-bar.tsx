import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, LogOut, Moon, Plus, Settings2, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { NewBoardForm } from '@/components/new-board';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tip';
import { api } from '@/lib/api';
import type { BoardView } from '@/lib/api';
import { LABEL_NAMES } from '@slop/core';
import type { LabelName } from '@slop/core';
import { RECENT_SLOTS, recentBoards, visitBoard } from '@/lib/recent-boards';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const needs = (count: number) => `${count} of your globs ${count === 1 ? 'needs' : 'need'} you`;
const runs = (count: number) =>
  `${count} routine ${count === 1 ? 'run' : 'runs'} in progress on your globs`;

/** A board's count of something, always shown (dimmed at zero); screen readers get the tooltip text. */
const Count = ({
  count,
  word,
  tip,
  on,
  className,
}: {
  count: number;
  word: string;
  tip: string;
  /** The marker's colour when the count isn't zero. */
  on: string;
  className?: string;
}) => (
  <Tip text={tip}>
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-[11px] tracking-wider',
        count === 0 ? 'opacity-45' : 'font-semibold',
        className,
      )}
    >
      <span aria-hidden className={cn('h-[7px] w-[7px]', count === 0 ? 'bg-edge' : on)} />
      <span aria-hidden>
        {count} <span className="hidden sm:inline">{word}</span>
      </span>
    </span>
  </Tip>
);

/** How many of the board's globs have a routine run in progress. */
export const Running = ({ count }: { count: number }) => (
  <Count count={count} word="RUNNING" tip={runs(count)} on="bg-signal" />
);

/** How many of the board's supers are in Doing: a person drives them, so they aren't counted as runs. */
export const Supers = ({ count }: { count: number }) => (
  <Count
    count={count}
    word="SUPER"
    tip={`${count} of your ${count === 1 ? 'super is' : 'supers are'} in Doing`}
    on="bg-foreground"
  />
);

/** How many globs on the board wait on a person. */
export const Attention = ({ count }: { count: number }) => (
  <Count count={count} word="WAITING" tip={needs(count)} on="bg-red-soft" />
);

const REVIEW_TITLES: Record<LabelName, string> = {
  FR: 'functional review',
  CR: 'code review',
  QA: 'QA',
};

/** How many of your globs need you on one sign-off review (to review it, or to work through the items added). */
export const Reviews = ({ name, count }: { name: LabelName; count: number }) => (
  <Count
    count={count}
    word={name}
    tip={`${count} of your globs ${count === 1 ? 'needs' : 'need'} you for ${REVIEW_TITLES[name]}`}
    on="bg-required"
    className="hidden sm:inline-flex"
  />
);

/** Board rows and the All boards row share columns: number, name, running, supers, waiting, reviews. */
const ROW =
  'grid grid-cols-[2rem_minmax(0,1fr)_auto_auto_auto] items-center gap-x-4 rounded-sm border px-2 py-1 no-underline sm:grid-cols-[2.5rem_minmax(0,1fr)_7rem_7rem_7rem_3.5rem_3.5rem_3.5rem]';

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted';

/**
 * App-wide settings and actions behind a floating button in the corner: the theme, a new board,
 * signing out. App-level config (seed agents and the like) goes here later.
 */
const AppSettings = () => {
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Popover open={menu} onOpenChange={setMenu}>
        <PopoverTrigger
          className="press fixed right-4 bottom-4 z-30 inline-flex h-9 w-9 items-center justify-center rounded-md border border-foreground/70 bg-card text-foreground shadow-[2px_2px_0_var(--edge)] hover:bg-muted"
          aria-label="App settings"
          data-testid="app-settings"
        >
          <Settings2 className="h-4 w-4" />
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-56 p-3">
          <div className="grid gap-2">
            <h2 className="text-xs font-semibold text-muted-foreground">App settings</h2>
            <div className="flex items-center justify-between gap-2 text-sm">
              Theme
              <div
                className="flex gap-0.5 rounded-md border bg-muted p-0.5"
                role="group"
                aria-label="Theme"
              >
                {(['light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={theme === t}
                    onClick={() => theme !== t && toggle()}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs capitalize',
                      theme === t
                        ? 'bg-card font-semibold text-foreground shadow-sm'
                        : 'text-muted-foreground',
                    )}
                    data-testid={`theme-${t}`}
                  >
                    {t === 'light' ? (
                      <Sun className="h-3.5 w-3.5" />
                    ) : (
                      <Moon className="h-3.5 w-3.5" />
                    )}
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="-mx-1 grid border-t pt-1">
              <button
                type="button"
                className={MENU_ITEM}
                onClick={() => {
                  setMenu(false);
                  setCreating(true);
                }}
                data-testid="new-board"
              >
                <Plus className="h-4 w-4" /> New board…
              </button>
              <button
                type="button"
                className={MENU_ITEM}
                onClick={() =>
                  void api.logout().then(() => {
                    // The next person to sign in mustn't see this person's boards.
                    client.clear();
                    return navigate('/login');
                  })
                }
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent title="New board" className="max-w-sm">
          <NewBoardForm onCreated={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
};

/**
 * The app's top bar, like a terminal multiplexer's status line: the three most recently opened
 * boards stacked full width (number, name, runs in progress, globs waiting on a person and on each
 * sign-off review; the current one marked) and an All boards row. App settings float in a corner.
 */
export const StatusBar = ({ current }: { current?: number }) => {
  const [recent, setRecent] = useState<number[]>([]);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 30_000 });

  useEffect(() => {
    setRecent(current === undefined ? recentBoards() : visitBoard(current));
  }, [current]);

  const boards = me.data?.boards ?? [];
  const byId = new Map(boards.map((b) => [b.id, b]));
  const remembered = recent.flatMap((id) => {
    const board = byId.get(id);
    return board === undefined ? [] : [board];
  });
  // Slots for boards you've lost access to (or not yet opened) go to your other boards, newest first.
  const fill = boards
    .filter((b) => !remembered.includes(b))
    .sort((a, b) => b.id - a.id)
    .slice(0, RECENT_SLOTS - remembered.length);
  const tabs = [...remembered, ...fill];
  const rest = boards.length - tabs.length;

  const row = (board: BoardView) => {
    const selected = board.id === current;
    return (
      <li key={board.id}>
        <Link
          to={`/boards/${board.id}`}
          aria-current={selected ? 'page' : undefined}
          className={cn(
            ROW,
            selected
              ? 'border-foreground bg-lcd text-lcd-foreground'
              : 'border-transparent text-foreground hover:border-border hover:bg-muted',
          )}
          data-testid={`board-tab-${board.id}`}
        >
          <span className="font-mono text-xs opacity-70">{board.id}</span>
          <span className="truncate text-[15px] font-semibold tracking-tight">{board.name}</span>
          <Running count={board.running ?? 0} />
          <Supers count={board.supers ?? 0} />
          <Attention count={board.attention ?? 0} />
          {LABEL_NAMES.map((name) => (
            <Reviews key={name} name={name} count={board.reviews?.[name] ?? 0} />
          ))}
        </Link>
      </li>
    );
  };

  return (
    <>
      <AppSettings />
      <header className="flex items-stretch gap-3 border-b border-edge px-3 pt-4 pb-2.5 sm:px-5">
        <nav className="min-w-0 flex-1" aria-label="Boards">
          <ul className="grid gap-0.5">
            {tabs.slice(0, RECENT_SLOTS).map(row)}
            {boards.length > 1 && (
              <li>
                <Link
                  to="/boards"
                  aria-current={current === undefined ? 'page' : undefined}
                  className={cn(
                    ROW,
                    current === undefined
                      ? 'border-foreground bg-lcd text-lcd-foreground'
                      : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted',
                  )}
                  data-testid="all-boards"
                >
                  <LayoutGrid className="h-3.5 w-3.5 opacity-60" aria-hidden />
                  <span className="truncate text-sm">
                    All boards
                    {rest > 0 && (
                      <span className="ml-2 font-mono text-xs opacity-70">+{rest} more</span>
                    )}
                  </span>
                </Link>
              </li>
            )}
          </ul>
        </nav>
      </header>
    </>
  );
};
