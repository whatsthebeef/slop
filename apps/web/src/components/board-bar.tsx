import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { LayoutGrid, LogOut, Moon, Plus, Settings2, Sun, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { NewBoardForm } from '@/components/new-board';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tip';
import { api, RequestError } from '@/lib/api';
import type { BoardView, Me } from '@/lib/api';
import { LABEL_NAMES } from '@slop/core';
import type { BoardSession, LabelName } from '@slop/core';
import { barRows, lastViewedLabel, withSessions, writeSequence } from '@/lib/board-bar';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';

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
const Running = ({ count }: { count: number }) => (
  <Count count={count} word="RUNNING" tip={runs(count)} on="bg-signal" />
);

/** How many of the board's supers are in Doing: a person drives them, so they aren't counted as runs. */
const Supers = ({ count }: { count: number }) => (
  <Count
    count={count}
    word="SUPER"
    tip={`${count} of your ${count === 1 ? 'super is' : 'supers are'} in Doing`}
    on="bg-foreground"
  />
);

/** How many globs on the board wait on a person. */
const Attention = ({ count }: { count: number }) => (
  <Count count={count} word="WAITING" tip={needs(count)} on="bg-red-soft" />
);

const REVIEW_TITLES: Record<LabelName, string> = {
  FR: 'functional review',
  CR: 'code review',
  QA: 'QA',
};

/** How many of your globs need you on one sign-off review (to review it, or to work through the items added). */
const Reviews = ({ name, count }: { name: LabelName; count: number }) => (
  <Count
    count={count}
    word={name}
    tip={`${count} of your globs ${count === 1 ? 'needs' : 'need'} you for ${REVIEW_TITLES[name]}`}
    on="bg-required"
    className="hidden sm:inline-flex"
  />
);

/** Board rows share columns: number, name with its ID and last-viewed label, running, supers, waiting, reviews. */
const ROW =
  'grid min-h-11 grid-cols-[2rem_minmax(0,1fr)_auto_auto_auto] items-center gap-x-4 px-2 py-1 no-underline sm:grid-cols-[2.5rem_minmax(0,1fr)_7rem_7rem_7rem_3.5rem_3.5rem_3.5rem]';

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
      <NewBoardDialog open={creating} onOpenChange={setCreating} />
    </>
  );
};

/** The New board dialog, shared by the app settings and the board bar. */
const NewBoardDialog = ({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="New board" className="max-w-sm">
      <NewBoardForm
        onCreated={() => {
          onOpenChange(false);
          onCreated?.();
        }}
      />
    </DialogContent>
  </Dialog>
);

/** Numbers every session write in this tab (opens, adds and removes), so an older answer never overwrites a newer one. */
const writes = writeSequence();

/**
 * Applies a session write's answer to the /api/me cache instead of refetching it (a refetch lists every board's globs).
 * A refetch already under way may have read the bar before the write, and a board just created isn't in the cache yet,
 * so then it fetches again instead of letting the older read win. An answer to write `seq` is dropped when a later
 * write's answer is already in; the server may have applied the two in the other order, so it fetches again then too.
 */
const applySessions = (
  client: QueryClient,
  boardId: number,
  seq: number,
  sessions: readonly BoardSession[],
): void => {
  if (!writes.accept(seq)) {
    void client.invalidateQueries({ queryKey: ['me'] });
    return;
  }
  const stale = client.isFetching({ queryKey: ['me'] }) > 0;
  const me = client.getQueryData<Me>(['me']);
  if (me !== undefined) client.setQueryData<Me>(['me'], withSessions(me, sessions));
  if (stale || me?.boards.some((b) => b.id === boardId) !== true) {
    void client.invalidateQueries({ queryKey: ['me'] });
  }
};

/**
 * Records that you opened the board (it joins the end of your bar if it isn't in it), once per open: changing tabs,
 * polls and refetches don't, so a board you remove isn't put back until you open it again. True once that has settled.
 */
export const useOpenBoard = (boardId: number | undefined): boolean => {
  const client = useQueryClient();
  const [settled, setSettled] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (boardId === undefined) return;
    const seq = writes.next();
    void api
      .openBoard(boardId)
      .then((r) => applySessions(client, boardId, seq, r.sessions))
      .catch(() => undefined /* a failed record leaves the bar as it was */)
      .finally(() => setSettled(boardId));
  }, [boardId, client]);
  return boardId !== undefined && settled === boardId;
};

interface SessionWrite {
  readonly id: number;
  readonly add: boolean;
}

/**
 * The app's top bar, like tmux's sessions: the boards you keep open, numbered by their place (name with its ID, when
 * you last viewed it, and your counts: runs in progress, supers, globs waiting on you and on each sign-off review).
 * Opening a board adds it at the end; × takes one out and the rest renumber. The current board, if it isn't in the bar,
 * shows after them with an add button. More boards lists the rest, each with an add button, beside New board.
 * App settings float in a corner.
 */
export const BoardBar = ({ current, opened = true }: { current?: number; opened?: boolean }) => {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 30_000 });
  const client = useQueryClient();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  // Opening a board (from More boards or anywhere) collapses the list, as New board does.
  const [shown, setShown] = useState(current);
  if (shown !== current) {
    setShown(current);
    setExpanded(false);
  }
  const write = useMutation({
    mutationFn: async ({ id, add }: SessionWrite) => {
      const seq = writes.next();
      const r = await (add ? api.addSession(id) : api.removeSession(id));
      return { seq, sessions: r.sessions };
    },
    onSuccess: ({ seq, sessions }, { id }) => applySessions(client, id, seq, sessions),
    onError: (error) =>
      toast(error instanceof RequestError ? error.body.message : 'Could not change the board bar'),
  });

  const boards = me.data?.boards ?? [];
  const { managed, sessions, loose, more } = barRows(boards, current);
  // The 30 s poll re-renders the bar, which keeps the labels fresh enough.
  const now = Date.now();

  const row = (board: BoardView, kind: 'session' | 'loose' | 'more', number: string) => {
    const selected = board.id === current;
    const add = kind !== 'session';
    const busy = write.isPending && write.variables.id === board.id;
    // While the open is being recorded the current board may not be in the bar yet: no add button to flicker.
    const control = managed && !(kind === 'loose' && !opened);
    return (
      <li
        key={board.id}
        className={cn(
          'grid grid-cols-[minmax(0,1fr)_2.75rem] items-stretch rounded-sm border',
          kind === 'session' && selected
            ? 'border-foreground bg-lcd text-lcd-foreground'
            : kind === 'loose'
              ? 'border-dashed border-foreground text-foreground'
              : 'border-transparent text-foreground hover:border-border hover:bg-muted',
        )}
      >
        <Link
          to={`/boards/${board.id}`}
          aria-current={selected ? 'page' : undefined}
          className={ROW}
          data-testid={kind === 'more' ? `board-more-${board.id}` : `board-tab-${board.id}`}
        >
          <span className="font-mono text-[13px] opacity-70">{number}</span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[17px] font-semibold tracking-tight">{board.name}</span>
            <span className="shrink-0 font-mono text-[11px] opacity-60">#{board.id}</span>
            {managed && (
              <span className="hidden truncate font-mono text-xs opacity-65 sm:inline">
                {lastViewedLabel(board.lastViewedAt, now, selected)}
              </span>
            )}
          </span>
          <Running count={board.running ?? 0} />
          <Supers count={board.supers ?? 0} />
          <Attention count={board.attention ?? 0} />
          {LABEL_NAMES.map((name) => (
            <Reviews key={name} name={name} count={board.reviews?.[name] ?? 0} />
          ))}
        </Link>
        {control ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => write.mutate({ id: board.id, add })}
            aria-label={add ? `Add ${board.name} to the bar` : `Remove ${board.name} from the bar`}
            className="inline-flex min-h-11 items-center justify-center rounded-sm opacity-60 hover:opacity-100 disabled:opacity-30"
            data-testid={`${add ? 'add' : 'remove'}-session-${board.id}`}
          >
            {add ? <Plus className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
          </button>
        ) : (
          <span aria-hidden />
        )}
      </li>
    );
  };

  return (
    <>
      <AppSettings />
      <header className="flex items-stretch gap-3 border-b border-edge px-3 pt-4 pb-2.5 sm:px-5">
        <nav className="min-w-0 flex-1" aria-label="Boards">
          <ul className="grid gap-0.5">
            {sessions.map((b, i) => row(b, 'session', String(i + 1)))}
            {loose !== undefined && row(loose, 'loose', '–')}
            {expanded && more.map((b) => row(b, 'more', '–'))}
          </ul>
          {boards.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1.5">
              {(more.length > 0 || expanded) && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                  className="inline-flex min-h-9 items-center gap-2 rounded-sm px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  data-testid="more-boards"
                >
                  <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
                  {expanded ? (
                    'Fewer boards'
                  ) : (
                    <>
                      More boards
                      <span className="font-mono text-xs opacity-70">+{more.length}</span>
                    </>
                  )}
                </button>
              )}
              {expanded && (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="inline-flex min-h-9 items-center gap-2 rounded-sm border border-dashed border-foreground/60 px-2 text-sm hover:bg-muted"
                  data-testid="bar-new-board"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden /> New board
                </button>
              )}
              {managed && (
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {expanded ? '+ adds a board to the bar' : "Boards you've opened · × to remove"}
                </span>
              )}
            </div>
          )}
        </nav>
      </header>
      <NewBoardDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => setExpanded(false)}
      />
    </>
  );
};
