import { LISTS, PENDING_TIMEOUT_MS, actionLabel, byListSinceNewest, bySignedOffNewest, decisionOf, haltedBy, latestSignedOff, waitingOnCounts } from '@slop/core';
import type { Action, HumanStepViewer, LabelCommand, LabelName, List, PendingAction } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import { FILTER_TEXT_ID, FILTER_TOGGLE_ID, FilterPane, FilterToggle, useBoardFilters } from '@/components/board-filter-pane';
import { CreateGlobDialog } from '@/components/create-glob';
import { GlobCard } from '@/components/glob-card';
import type { BoardShellContext } from '@/components/board-shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ACTION_PATHS, api, isTransient, RequestError } from '@/lib/api';
import type { GlobView, NewGlob } from '@/lib/api';
import { cardMoveOf, clickOf, presentOf } from '@/lib/present';
import type { CardMove } from '@/lib/present';
import { groupNames } from '@/lib/group-names';
import { groupPath } from '@/lib/group-page';
import { startAgainConfirmation } from '@/lib/start-again';
import { useBoardMotion } from '@/lib/board-motion';
import { mergeOutcomeText, opensGlobView, reportRefusal } from '@/lib/click-outcome';
import { matchesFilters } from '@/lib/board-filters';
import { withGlob } from '@/lib/glob-list';
import { globPath, globQuery, globTargetOf } from '@/lib/glob-section';
import type { GlobTarget } from '@/lib/glob-section';
import { isSlashShortcut } from '@/lib/chat';
import { LIST_TITLES } from '@/lib/list-titles';
import { listScrollLeft, visibleListIndex } from '@/lib/list-snap';
import { cn } from '@/lib/utils';
import { useCurrentPage, usePageContext } from '@/lib/page-context';
import { globsKey, signedOffCountKey, useLiveBoard } from '@/lib/live';
import type { LiveState } from '@/lib/live';
import { useSstorCopy } from '@/components/sstor-notice';
import { useToast } from '@/toast';

type Direction = 'left' | 'right';

/**
 * The move a glob can make from its card: its one primary button (`presentGlob`'s `cardPrimary`: Pick up, Start, Merge or Fix
 * conflict), with where it lands. The card's button, ← → and Enter all read this, so none previews a move without a button.
 */
const moveFor = (glob: GlobView, viewer?: HumanStepViewer, base?: string): { move: CardMove; target: List } | null => {
  const primary = presentOf(glob, { ...(viewer === undefined ? {} : { viewer }), ...(base === undefined ? {} : { base }) }).cardPrimary;
  if (primary === null) return null;
  const move = cardMoveOf(primary);
  return { move, target: move.direction === 'none' ? glob.list : 'doing' };
};

/** A previewed move: its ghost piece shows in the target list where the card would land. */
interface Preview {
  readonly glob: GlobView;
  readonly move: CardMove;
  readonly target: List;
}

const Column = ({
  list,
  children,
  count,
  total,
  boardId,
  ghost,
  filtered,
}: {
  list: List;
  children: ReactNode;
  count: number;
  /** Everything in the list, when it shows only the latest few. */
  total: number;
  /** For the "See all" link at the foot of a list that is cut short. */
  boardId: number;
  ghost: Preview | null;
  /** A filter is on, so an empty list says nothing matches rather than showing nothing. */
  filtered: boolean;
}) => (
  <section
    className='list-well flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-edge bg-muted p-2 max-sm:w-full max-sm:flex-none max-sm:shrink-0 max-sm:snap-start max-sm:overflow-y-auto max-sm:overscroll-y-contain'
    aria-label={LIST_TITLES[list]}
    data-testid={`list-${list}`}
  >
    <h2 className='flex items-center justify-between px-1 font-mono text-[11px] font-semibold tracking-widest text-muted-foreground uppercase'>
      {LIST_TITLES[list]} <span>{total > count ? `${count} of ${total}` : count}</span>
    </h2>
    {ghost !== null && (
      // A moved card lands at the top: lists show the most recently changed first.
      <div className='ghost-piece flex flex-col gap-1 px-3 py-2.5' aria-hidden data-testid='ghost-piece'>
        <span className='font-mono text-[10px] font-semibold tracking-wider text-signal-strong uppercase'>
          Lands here · {actionLabel(ghost.move.action, ghost.glob)}
        </span>
        <span className='text-sm font-medium opacity-55'>
          <span className='font-mono text-xs'>{ghost.glob.id}</span> · {ghost.glob.title}
        </span>
      </div>
    )}
    {children}
    {filtered && count === 0 && (
      <p className='px-1 py-2 text-center text-xs text-muted-foreground' data-testid='no-match'>
        No globs match the filter
      </p>
    )}
    {total > count && (
      <Link to={`/boards/${boardId}/signed-off`} className='px-1 py-1 text-center text-xs text-muted-foreground hover:text-foreground' data-testid='see-all'>
        See all
      </Link>
    )}
  </section>
);

/** The board loads until it gets an answer: an unreachable server or a 5xx is retried, backing off to 10s. */
const KEEP_TRYING = {
  retry: (_count: number, error: Error) => isTransient(error),
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 10_000),
};

/** Why the board can't be shown, told apart so each says what to do. */
const Unavailable = ({ boardId, error }: { boardId: number; error: unknown }) => {
  const status = error instanceof RequestError ? error.status : null;
  const message =
    status === null || status >= 500 ? (
      <span role='status' className='inline-flex items-center gap-2'>
        <span className='h-[7px] w-[7px] animate-pulse bg-amber' aria-hidden />
        Can't reach slop, retrying…
      </span>
    ) : status === 401 ? (
      <>
        You're signed out.{' '}
        <Link className='underline' to='/login'>
          Sign in
        </Link>
      </>
    ) : status === 403 ? (
      <>You're not on board {boardId}. Ask one of its admins to add you.</>
    ) : status === 404 ? (
      <>
        There's no board {boardId}.{' '}
        <Link className='underline' to='/boards'>
          Open your boards
        </Link>
      </>
    ) : (
      <>{error instanceof RequestError ? error.body.message : 'The board could not be loaded.'}</>
    );
  return (
    <p className='p-6 text-sm' data-testid='board-unavailable'>
      {message}
    </p>
  );
};

/** How long a first connection may take before the board says it isn't live. */
const CONNECT_GRACE_MS = 3000;

/**
 * Live updates are the normal state, so nothing shows while they're connected; a notice appears
 * only when they drop (or the first connection is slow). A hidden tab pauses them on purpose.
 */
const OfflineNotice = ({ live }: { live: LiveState }) => {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (live !== 'connecting') return;
    const timer = setTimeout(() => setSlow(true), CONNECT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [live]);
  if (live !== 'reconnecting' && !(live === 'connecting' && slow)) return null;
  return (
    <div
      role='status'
      className='fixed bottom-4 left-1/2 z-30 inline-flex -translate-x-1/2 items-center gap-2 rounded-md border border-foreground/70 bg-card px-3 py-1.5 text-sm shadow-[2px_2px_0_var(--edge)]'
      data-testid='offline-notice'
    >
      <span className='h-[7px] w-[7px] animate-pulse bg-amber' aria-hidden />
      Not live: reconnecting… Changes by others won't show until it's back.
    </div>
  );
};

export const BoardPage = () => {
  const boardId = Number(useParams().boardId);
  const client = useQueryClient();
  const toast = useToast();
  const live = useLiveBoard(boardId);
  // The ＋ (New glob) icon lives in the shell's tab row.
  const { headerActions } = useOutletContext<BoardShellContext>();
  usePageContext({ type: 'board' });
  const [creating, setCreating] = useState(false);
  // Below `sm` the lists are a scroll-snap row; the dots show (and scroll to) the list on screen.
  const listsRow = useRef<HTMLDivElement>(null);
  const [activeList, setActiveList] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [bumps, setBumps] = useState<Record<string, Direction>>({});
  const [haltConfirm, setHaltConfirm] = useState<{
    glob: GlobView;
    target: List;
    action: Action;
    halts: string[];
  } | null>(null);

  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId), ...KEEP_TRYING });
  const globs = useQuery({ queryKey: globsKey(boardId), queryFn: () => api.globs(boardId), ...KEEP_TRYING });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 30_000 });
  const viewer = me.data === undefined || board.data === undefined ? undefined : { email: me.data.email, role: board.data.role };
  const signedOffTotal = useQuery({ queryKey: signedOffCountKey(boardId), queryFn: () => api.signedOffCount(boardId), ...KEEP_TRYING });
  // The Signed Off column keeps the latest few (older ones stay on the Signed off tab), so the cache can hold more than it shows.
  const shown = useMemo(
    () => globs.data?.filter((g) => g.list !== 'signed_off').concat(latestSignedOff(globs.data.filter((g) => g.list === 'signed_off'))),
    [globs.data],
  );
  const motion = useBoardMotion(shown, live);
  // A link to one glob (`?glob=<id>`, e.g. a KB item's evidence) opens its page.
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { filters, filtering, setFilters, filterOpen, setFilterOpen } = useBoardFilters(boardId);
  // `/` opens the filter pane if needed and focuses the text filter, selecting what is in it. Only while this page is
  // the current one: with a glob open over the board the page context is the glob's and `/` does nothing.
  const currentPage = useCurrentPage();
  const [focusFilter, setFocusFilter] = useState(0);
  useEffect(() => {
    if (currentPage.type !== 'board') return;
    const onKey = (e: KeyboardEvent) => {
      if (!isSlashShortcut(e)) return;
      e.preventDefault();
      setFilterOpen(true);
      setFocusFilter((n) => n + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPage.type]);
  // After the commit, so a pane that was closed (and inert) has opened.
  useEffect(() => {
    if (focusFilter === 0) return;
    const input = document.getElementById(FILTER_TEXT_ID);
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }, [focusFilter]);
  // "Create glob" under a chat answer arrives with the answer's text, to start the form from.
  const location = useLocation();
  const [createFrom, setCreateFrom] = useState('');
  const fromChat = (location.state as { createFrom?: unknown } | null)?.createFrom;
  // The notification bar's "Create fix glob" (`?newGlob=<title>&run=<url>`) opens the form with the failing test and run link.
  const fixTitle = searchParams.get('newGlob');
  const fixRun = searchParams.get('run');
  useEffect(() => {
    if (fixTitle === null) return;
    setCreateFrom(fixRun === null ? fixTitle : `${fixTitle}\n\nFailing run: ${fixRun}`);
    setCreating(true);
    setSearchParams((params) => {
      params.delete('newGlob');
      params.delete('run');
      return params;
    }, { replace: true });
  }, [fixTitle, fixRun, setSearchParams]);
  useEffect(() => {
    if (typeof fromChat !== 'string') return;
    setCreateFrom(fromChat);
    setCreating(true);
    void navigate(location.pathname, { replace: true, state: null });
  }, [fromChat]);
  const linked = searchParams.get('glob');
  // The link's section, artifact and label go with it to the glob's page.
  const linkedTarget = globQuery(globTargetOf(searchParams));
  useEffect(() => {
    if (linked !== null) void navigate(globPath(boardId, linked) + linkedTarget, { replace: true });
  }, [linked, linkedTarget, boardId, navigate]);
  const openGlob = (id: string, target: GlobTarget = {}) => void navigate(globPath(boardId, id, target));
  // The status bar's counts include this board; refresh them when its globs change, at most every
  // few seconds (a burst of live updates shouldn't refetch every board's counts each time), with a
  // trailing refresh so the last change in a burst still shows. The first load needs none: the
  // status bar fetches the counts itself.
  const meRefreshed = useRef<number | null>(null);
  useEffect(() => {
    if (globs.dataUpdatedAt === 0) return;
    if (meRefreshed.current === null) {
      meRefreshed.current = Date.now();
      return;
    }
    const refresh = () => {
      meRefreshed.current = Date.now();
      void client.invalidateQueries({ queryKey: ['me'] });
    };
    const wait = meRefreshed.current + 5_000 - Date.now();
    if (wait <= 0) {
      refresh();
      return;
    }
    const timer = setTimeout(refresh, wait);
    return () => clearTimeout(timer);
  }, [globs.dataUpdatedAt, client]);

  // Keeps the known artifact summaries when a response carries none. A response can land after the
  // page has moved to another board, so it goes to the list of the glob's own board.
  const store = (glob: GlobView) =>
    client.setQueryData<GlobView[]>(globsKey(glob.boardId), (list) => withGlob(list, glob, glob.boardId));

  /**
   * Handles a failed request. A version conflict takes the current glob. A click the machine refused is stored on the glob as its
   * last outcome, but only the glob view shows that notice (the card shows status only), so the card always toasts it, after
   * reloading the glob for its new version. Anything else (the network, the server) is toasted.
   */
  const fail = (error: unknown, clicked?: { glob: GlobView; action: Action }) => {
    if (!(error instanceof RequestError)) {
      toast('Something went wrong');
      return;
    }
    if (error.body.current !== undefined) {
      void api.glob(error.body.current.id).then(store);
      toast(`${error.body.current.id} changed meanwhile; it has been refreshed.`);
      return;
    }
    const message = error.body.message;
    if (clicked === undefined) {
      toast(message);
      return;
    }
    void reportRefusal(() => api.glob(clicked.glob.id), store, toast, message);
  };

  const copyCommand = useSstorCopy();
  const inFlight = useRef(new Set<string>());
  // The clicks this client has sent whose result the glob does not carry yet: the card shows them in progress at once.
  const [clicks, setClicks] = useState<Readonly<Record<string, PendingAction>>>({});
  const setClick = (id: string, click: PendingAction | null) =>
    setClicks((p) => (click === null ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== id)) : { ...p, [id]: click }));
  const mutation = useMutation({
    mutationFn: (work: () => Promise<GlobView | null>) => work(),
    onSuccess: (glob) => {
      if (glob !== null) store(glob);
    },
  });

  /** Runs an action; false when it failed (the failure is on the glob, or toasted). */
  const act = async (glob: GlobView, action: Action): Promise<boolean> => {
    const path = ACTION_PATHS[action];
    if (path === null) return false;
    // Copied before the request: browsers refuse clipboard writes once the click's user gesture has passed.
    const finish = copyCommand(action, glob.id, glob.type);
    return mutation.mutateAsync(() => api.action(glob.id, path, glob.version)).then(
      async (result) => {
        const said = result === null ? null : mergeOutcomeText(action, result);
        if (said !== null) toast(said);
        await finish();
        return true;
      },
      (error: unknown) => {
        fail(error, { glob, action });
        return false;
      },
    );
  };

  const reviewLabel = (glob: GlobView) => (label: LabelName, command: LabelCommand) =>
    mutation.mutateAsync(() => api.reviewLabel(glob.id, label, command, glob.version)).then(
      () => true,
      () => false,
    );

  /** Drops the card: the action runs and, once the board updates, the card steps into place. */
  const commit = async (glob: GlobView, action: Action) => {
    setPreview(null);
    // One action in flight per glob: a repeat click, drop or key while one is pending does nothing.
    if (inFlight.current.has(glob.id)) return;
    inFlight.current.add(glob.id);
    motion.markLocal(glob.id);
    // The card shows the click in progress at once, and the glob's own pending takes over once the response is stored.
    setClick(glob.id, clickOf(action, viewer?.email ?? ''));
    const timer = setTimeout(() => setClick(glob.id, null), PENDING_TIMEOUT_MS);
    const done = await act(glob, action).finally(() => {
      clearTimeout(timer);
      inFlight.current.delete(glob.id);
      setClick(glob.id, null);
    });
    // The card has already stepped into place (the mutation stored the returned glob); a failed action opens nothing.
    if (done && opensGlobView(action)) openGlob(glob.id);
    // If nothing moved (the action failed), a later move made elsewhere mustn't look like ours.
    setTimeout(() => motion.forgetLocal(glob.id), 1000);
  };

  /** Runs a move, asking first when it would halt work in progress. */
  const runMove = (glob: GlobView, move: CardMove, target: List) => {
    if (inFlight.current.has(glob.id)) return;
    const halts = haltedBy(glob, move.action);
    if (halts.length > 0) setHaltConfirm({ glob, target, action: move.action, halts });
    else void commit(glob, move.action);
  };

  /** ← / → on a focused card: preview its move that way, or bump the wall when there is none. */
  const arrow = (glob: GlobView, direction: Direction) => {
    const option = moveFor(glob, viewer, board.data?.baseBranch);
    if (option === null || option.move.direction !== direction) {
      setBumps((b) => ({ ...b, [glob.id]: direction }));
      setTimeout(() => setBumps((b) => Object.fromEntries(Object.entries(b).filter(([id]) => id !== glob.id))), 210);
      return;
    }
    setPreview({ glob, ...option });
  };

  if (board.data === undefined || globs.data === undefined) {
    // While retrying, the failure is the reason rather than the error.
    const failure = board.error ?? globs.error ?? board.failureReason ?? globs.failureReason;
    if (failure !== null) return <Unavailable boardId={boardId} error={failure} />;
    return <p className='p-6 text-muted-foreground'>Loading…</p>;
  }

  // A rejected or closed decision (archived) never shows.
  const filterContext = { now: new Date().toISOString(), viewer };
  const all = (shown ?? globs.data).filter((g) => decisionOf(g)?.archived !== true && matchesFilters(g, filters, filterContext));
  const waitingOn = waitingOnCounts(globs.data);
  const groups = groupNames(globs.data.filter((g) => decisionOf(g)?.archived !== true));
  const haltLabel = haltConfirm === null ? '' : actionLabel(haltConfirm.action, haltConfirm.glob);

  return (
    <div className='flex h-full flex-col' data-testid='board' data-live={live}>
      <OfflineNotice live={live} />
      <h1 className='sr-only'>{board.data.name}</h1>
      {headerActions !== null &&
        createPortal(
          <>
            <button
              type='button'
              className='rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground'
              aria-label='New glob'
              title='New glob'
              data-testid='new-glob'
              onClick={() => setCreating(true)}
            >
              <Plus className='h-4 w-4' aria-hidden />
            </button>
            <FilterToggle open={filterOpen} active={filtering} onClick={() => setFilterOpen(!filterOpen)} />
          </>,
          headerActions,
        )}

      <FilterPane
        open={filterOpen}
        values={filters}
        onChange={setFilters}
        groupHref={(name) => groupPath(boardId, name)}
        onClose={() => {
          setFilterOpen(false);
          document.getElementById(FILTER_TOGGLE_ID)?.focus();
        }}
      />

      <nav className='flex gap-1 px-3 pt-1 sm:hidden' aria-label='Lists' data-testid='list-dots'>
        {LISTS.map((list, i) => (
          <button
            key={list}
            type='button'
            className={cn(
              'min-h-8 min-w-0 flex-1 truncate rounded border border-foreground/60 px-1.5 py-1 text-xs',
              i === activeList && 'bg-foreground text-background',
            )}
            title={LIST_TITLES[list]}
            aria-current={i === activeList ? 'true' : undefined}
            onClick={() => listsRow.current?.scrollTo({ left: listScrollLeft(i, listsRow.current.clientWidth), behavior: 'smooth' })}
          >
            {LIST_TITLES[list]}
          </button>
        ))}
      </nav>

      <main
        ref={(el) => {
          motion.container.current = el;
        }}
        className='flex-1 overflow-auto px-5 pb-4 pt-1.5 max-sm:overflow-hidden max-sm:px-3'
      >
        <div
          ref={listsRow}
          className='relative flex min-h-full min-w-full items-stretch gap-3 max-sm:h-full max-sm:snap-x max-sm:snap-mandatory max-sm:overflow-x-auto max-sm:overscroll-x-contain'
          data-testid='lists'
          onScroll={(e) => setActiveList(visibleListIndex(e.currentTarget.scrollLeft, e.currentTarget.clientWidth, LISTS.length))}
        >
          {LISTS.map((list) => {
            const inList = all.filter((g) => g.list === list);
            const items =
              list === 'signed_off' ? bySignedOffNewest(inList) : byListSinceNewest(inList);
            const total = list === 'signed_off' && filtering === 0 ? Math.max(items.length, signedOffTotal.data ?? 0) : items.length;
            return (
              <Column key={list} list={list} count={items.length} total={total} boardId={boardId} ghost={preview?.target === list ? preview : null} filtered={filtering > 0}>
                {items.map((glob) => {
                  const option = moveFor(glob, viewer, board.data.baseBranch);
                  return (
                    <GlobCard
                      key={glob.id}
                      glob={glob}
                      onOpen={() => openGlob(glob.id)}
                      onOpenSection={(target) => openGlob(glob.id, target)}
                      onReviewLabel={reviewLabel(glob)}
                      onFilterGroup={(name) => {
                        setFilters({ ...filters, group: name });
                        setFilterOpen(true);
                      }}
                      pending={clicks[glob.id] ?? null}
                      previewing={preview?.glob.id === glob.id ? preview.move.action : null}
                      onPreview={(move) => {
                        setPreview(move === null || option === null || option.move.action !== move.action ? null : { glob, ...option });
                      }}
                      onMove={(move) => {
                        if (option !== null && option.move.action === move.action) runMove(glob, move, option.target);
                      }}
                      repo={board.data.repo ?? undefined}
                      base={board.data.baseBranch}
                      onArrow={(direction) => arrow(glob, direction)}
                      lock={motion.locks[glob.id]}
                      bump={bumps[glob.id]}
                      tag={motion.tags[glob.id]}
                      viewer={viewer}
                      waitingOnThis={waitingOn.get(glob.id) ?? 0}
                    />
                  );
                })}
              </Column>
            );
          })}
        </div>
      </main>

      <CreateGlobDialog
        board={board.data}
        groups={groups}
        open={creating}
        initialRequest={createFrom}
        onOpenChange={setCreating}
        onCreate={async (input: NewGlob) => {
          const glob = await api.createGlob(boardId, input).catch((error: unknown) => {
            throw error instanceof RequestError ? new Error(error.body.message) : error;
          });
          store(glob);
          return glob;
        }}
      />

      {haltConfirm !== null && (
        <Dialog open onOpenChange={(o) => !o && setHaltConfirm(null)}>
          <DialogContent
            title={`${haltLabel}: move ${haltConfirm.glob.id} to ${LIST_TITLES[haltConfirm.target]}?`}
            className='max-w-sm'
          >
            {haltConfirm.action === 'start_again' && (
              <p className='mb-2 text-sm' data-testid='start-again-says'>
                {startAgainConfirmation(haltConfirm.glob)}
              </p>
            )}
            <p className='text-sm'>This stops:</p>
            <ul className='mt-1 list-disc pl-5 text-sm'>
              {haltConfirm.halts.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            <div className='mt-4 flex justify-end gap-2'>
              <Button variant='ghost' onClick={() => setHaltConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant='destructive'
                data-testid='confirm-halt'
                onClick={() => {
                  setHaltConfirm(null);
                  void commit(haltConfirm.glob, haltConfirm.action);
                }}
              >
                {haltLabel}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
