import { LISTS, bySignedOffNewest, decisionOf, latestSignedOff } from '@slop/core';
import type { Action, LabelCommand, LabelName, List } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import { FILTER_TEXT_ID, FILTER_TOGGLE_ID, FilterPane, FilterToggle, useFilterPaneOpen } from '@/components/board-filter-pane';
import { CreateGlobDialog } from '@/components/create-glob';
import { GlobCard } from '@/components/glob-card';
import type { CardMove } from '@/components/glob-card';
import type { BoardShellContext } from '@/components/board-shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ACTION_PATHS, api, isTransient, RequestError } from '@/lib/api';
import type { GlobView, NewGlob } from '@/lib/api';
import { actionLabel, actionPresentation } from '@/lib/action-presentation';
import { startAgainConfirmation } from '@/lib/start-again';
import { useBoardMotion } from '@/lib/board-motion';
import { runCardAction } from '@/lib/card-pending';
import type { CardPending } from '@/lib/card-pending';
import { activeCount, matchesFilters, parseFilters, writeFilters } from '@/lib/board-filters';
import { browserStore, clearFilterMemory, hasFilterParams, loadFilterMemory, saveFilterMemory } from '@/lib/board-filter-memory';
import type { FilterValues } from '@/lib/board-filters';
import { withGlob } from '@/lib/glob-list';
import { globPath, globQuery, globTargetOf } from '@/lib/glob-section';
import type { GlobTarget } from '@/lib/glob-section';
import { isSlashShortcut } from '@/lib/chat';
import { useCurrentPage, usePageContext } from '@/lib/page-context';
import { deploysKey, globsKey, signedOffCountKey, useLiveBoard } from '@/lib/live';
import type { LiveState } from '@/lib/live';
import { useSstorCopy } from '@/components/sstor-notice';
import { useToast } from '@/toast';

const LIST_TITLES: Record<List, string> = {
  planning: 'Planning',
  doing: 'Doing',
  reviewing: 'Reviewing',
  signed_off: 'Signed Off',
};

type Direction = 'left' | 'right';

/**
 * The moves a glob can make, each a state-machine action it allows: right takes a glob from
 * Planning into Doing. Discard isn't a card move (it is in the glob view). Leaving Doing happens through the merge and signing off
 * through labels, so those lists have no moves.
 */
const movesFor = (glob: GlobView): { move: CardMove; target: List }[] => {
  // No moves while slop is still creating the glob's branch and PR: a second action then would race the setup.
  if (glob.provisioning === 'pending') return [];
  const allowed = glob.allowedActions ?? [];
  const make = (action: Action, direction: Direction, target: List) => {
    const { label: name, tip, icon } = actionPresentation(action, glob);
    return {
      target,
      move: {
        action,
        direction,
        label: direction === 'right' ? `${name} ▸` : `◂ ${name}`,
        description: `${name} ${glob.id}: ${tip}`,
        icon,
      },
    };
  };
  if (glob.list === 'planning') {
    return (['start', 'start_anyway', 'pick_up', 'take_over', 'retrigger'] as const)
      .filter((a) => allowed.includes(a))
      .map((a) => make(a, 'right', 'doing'));
  }
  return [];
};

/** What an action would stop, so the board can ask first; empty when nothing is halted. */
const haltedBy = (glob: GlobView, action: Action): string[] => {
  const runLive = glob.currentRun !== null && glob.currentRun.state !== 'ended';
  if (action === 'take_over') return runLive ? ['the machine run in progress'] : [];
  if (action !== 'start_again') return [];
  return [
    ...(runLive ? ['the machine run in progress'] : []),
    ...(glob.pr !== null ? [`PR #${glob.pr.number} (closed) and the ${glob.branch} branch (deleted)`] : []),
    ...(glob.implementer !== null ? [`${glob.implementer} as implementer`] : []),
  ];
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
    className='list-well flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-edge bg-muted p-2'
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

/** How often the board re-reads deploy state while a deploy is in progress (a safety net for missed hints). */
const DEPLOY_POLL_MS = 15_000;

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
  // Filters live in the URL so a filtered board can be linked; whether their pane is open is the viewer's own preference.
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const filtering = activeCount(filters);
  const setFilters = (values: FilterValues) => {
    // Back to the defaults forgets the memory first, so the restore below doesn't bring the old filters back.
    if (activeCount(values) === 0) clearFilterMemory(browserStore(), boardId);
    setSearchParams((params) => writeFilters(params, values), { replace: true });
  };
  // The board remembers its filters: a URL with filters wins and is saved; a bare URL (back from a glob, another tab or
  // board, a reload) gets the remembered ones.
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
  // Deploy state (branch deploys, and the release and integration environments each glob is in) lives beside the
  // globs; read it for the globs on the board.
  const boardGlobIds = (globs.data ?? []).map((g) => g.id).sort();
  const deployState = useQuery({
    queryKey: [...deploysKey(boardId), boardGlobIds.join(',')],
    queryFn: () => api.boardDeploys(boardId, boardGlobIds),
    enabled: boardGlobIds.length > 0,
    // Hints normally refresh it; while something is deploying, also check now and then.
    refetchInterval: (query) =>
      Object.values(query.state.data?.indicators ?? {}).some((i) => i.state === 'deploying') ? DEPLOY_POLL_MS : false,
  });

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

  /** Shows the error; on a version conflict, takes the current glob so the next click works. */
  const fail = (error: unknown) => {
    if (error instanceof RequestError) {
      if (error.body.current !== undefined) {
        void api.glob(error.body.current.id).then(store);
        toast(`${error.body.current.id} changed meanwhile; it has been refreshed.`);
        return;
      }
      toast(error.body.message);
      return;
    }
    toast('Something went wrong');
  };

  const copyCommand = useSstorCopy();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<CardPending>({});
  const mutation = useMutation({
    mutationFn: (work: () => Promise<GlobView | null>) => work(),
    onSuccess: (glob) => {
      if (glob !== null) store(glob);
    },
    onError: fail,
  });

  /** Runs an action; false when it failed (the failure is already shown). */
  const act = async (glob: GlobView, action: Action): Promise<boolean> => {
    const path = ACTION_PATHS[action];
    if (path === null) return false;
    // Copied before the request: browsers refuse clipboard writes once the click's user gesture has passed.
    const finish = copyCommand(action, glob.id);
    return mutation.mutateAsync(() => api.action(glob.id, path, glob.version)).then(
      async () => {
        await finish();
        return true;
      },
      () => false,
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
    motion.markLocal(glob.id);
    await runCardAction(
      inFlight.current,
      glob.id,
      action,
      () => act(glob, action),
      (id, pendingAction) =>
        setPending((p) => (pendingAction === null ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== id)) : { ...p, [id]: pendingAction })),
      () => toast(`${glob.id} is still working; refresh if it doesn't move.`),
    );
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

  /** ← / → on a focused card: cycle its moves that way, or bump the wall when there are none. */
  const arrow = (glob: GlobView, direction: Direction) => {
    const options = movesFor(glob).filter((m) => m.move.direction === direction);
    if (options.length === 0) {
      setBumps((b) => ({ ...b, [glob.id]: direction }));
      setTimeout(() => setBumps((b) => Object.fromEntries(Object.entries(b).filter(([id]) => id !== glob.id))), 210);
      return;
    }
    const current = preview?.glob.id === glob.id ? options.findIndex((m) => m.move.action === preview.move.action) : -1;
    const next = options[(current + 1) % options.length] ?? options[0];
    if (next !== undefined) setPreview({ glob, ...next });
  };

  if (board.data === undefined || globs.data === undefined) {
    // While retrying, the failure is the reason rather than the error.
    const failure = board.error ?? globs.error ?? board.failureReason ?? globs.failureReason;
    if (failure !== null) return <Unavailable boardId={boardId} error={failure} />;
    return <p className='p-6 text-muted-foreground'>Loading…</p>;
  }

  // A rejected or closed decision (archived) never shows.
  const all = (shown ?? globs.data).filter((g) => decisionOf(g)?.archived !== true && matchesFilters(g, filters));
  const groups = [...new Set(all.flatMap((g) => (g.group === null ? [] : [g.group])))].sort();
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
        onClose={() => {
          setFilterOpen(false);
          document.getElementById(FILTER_TOGGLE_ID)?.focus();
        }}
      />

      <main
        ref={(el) => {
          motion.container.current = el;
        }}
        className='flex-1 overflow-auto px-5 pb-4 pt-1.5'
      >
        <div className='relative flex min-h-full min-w-full items-stretch gap-3'>
          {LISTS.map((list) => {
            const inList = all.filter((g) => g.list === list);
            const items =
              list === 'signed_off' ? bySignedOffNewest(inList) : inList.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const total = list === 'signed_off' && filtering === 0 ? Math.max(items.length, signedOffTotal.data ?? 0) : items.length;
            return (
              <Column key={list} list={list} count={items.length} total={total} boardId={boardId} ghost={preview?.target === list ? preview : null} filtered={filtering > 0}>
                {items.map((glob) => {
                  const moves = movesFor(glob);
                  return (
                    <GlobCard
                      key={glob.id}
                      glob={glob}
                      onOpen={() => openGlob(glob.id)}
                      onOpenSection={(target) => openGlob(glob.id, target)}
                      onReviewLabel={reviewLabel(glob)}
                      moves={moves.map((m) => m.move)}
                      pending={pending[glob.id]}
                      previewing={preview?.glob.id === glob.id ? preview.move.action : null}
                      onPreview={(move) => {
                        const target = moves.find((m) => m.move.action === move?.action)?.target;
                        setPreview(move === null || target === undefined ? null : { glob, move, target });
                      }}
                      onMove={(move) => {
                        const target = moves.find((m) => m.move.action === move.action)?.target;
                        if (target !== undefined) runMove(glob, move, target);
                      }}
                      onArrow={(direction) => arrow(glob, direction)}
                      lock={motion.locks[glob.id]}
                      bump={bumps[glob.id]}
                      tag={motion.tags[glob.id]}
                      deploy={deployState.data?.indicators[glob.id]}
                      environments={deployState.data?.environments?.[glob.id]}
                      atf={deployState.data?.atf?.[glob.id]}
                      viewer={viewer}
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
                {startAgainConfirmation(haltConfirm.glob, board.data.baseBranch)}
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
