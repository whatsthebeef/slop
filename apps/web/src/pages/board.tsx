import { describeEditFailure, LISTS, SLOP_TYPES } from '@slop/core';
import type { Action, LabelCommand, LabelName, List, SlopType } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ArtifactRef } from '@/components/artifacts';
import { CreateGlobDialog } from '@/components/create-glob';
import { GlobCard } from '@/components/glob-card';
import type { CardMove } from '@/components/glob-card';
import { GlobDialog } from '@/components/glob-dialog';
import { ReadinessBanner } from '@/components/readiness';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ACTION_LABELS, ACTION_PATHS, api, isTransient, RequestError } from '@/lib/api';
import type { GlobChanges, GlobView, NewGlob } from '@/lib/api';
import { actionLabel, startAgainConfirmation } from '@/lib/start-again';
import { useBoardMotion } from '@/lib/board-motion';
import { withGlob } from '@/lib/glob-list';
import { codeReviewsKey, deploysKey, globsKey, useLiveBoard } from '@/lib/live';
import type { LiveState } from '@/lib/live';
import { useToast } from '@/toast';

const LIST_TITLES: Record<List, string> = {
  planning: 'Planning',
  doing: 'Doing',
  reviewing: 'Reviewing',
  signed_off: 'Signed Off',
};

type Direction = 'left' | 'right';

const MOVE_DESCRIPTIONS: Partial<Record<Action, string>> = {
  start: 'a routine implements it',
  pick_up: 'you implement it',
  take_over: 'you take it over from the routine',
  retrigger: 'a routine runs it again',
};

/**
 * The moves a glob can make, each a state-machine action it allows: right takes a glob from
 * Planning into Doing; left takes a same back to Planning (Start again keeps a sub or super in
 * Doing, so it isn't a move for them). Leaving Doing happens through the merge and signing off
 * through labels, so those lists have no moves.
 */
const movesFor = (glob: GlobView): { move: CardMove; target: List }[] => {
  const allowed = glob.allowedActions ?? [];
  const make = (action: Action, direction: Direction, target: List) => {
    const name = actionLabel(action, glob.type, ACTION_LABELS);
    return {
      target,
      move: {
        action,
        direction,
        label: direction === 'right' ? `${name} ▸` : `◂ ${name}`,
        description: `${name} ${glob.id}: ${MOVE_DESCRIPTIONS[action] ?? LIST_TITLES[target]}`,
      },
    };
  };
  if (glob.list === 'planning') {
    return (['start', 'pick_up', 'take_over', 'retrigger'] as const)
      .filter((a) => allowed.includes(a))
      .map((a) => make(a, 'right', 'doing'));
  }
  if (glob.list === 'doing' && glob.type === 'same' && allowed.includes('start_again')) {
    return [make('start_again', 'left', 'planning')];
  }
  return [];
};

/** What an action would stop, so the board can ask first; empty when nothing is halted. */
const haltedBy = (glob: GlobView, action: Action): string[] => {
  const runLive = glob.currentRun !== null && glob.currentRun.state !== 'ended';
  if (action === 'take_over') return runLive ? ['the routine run in progress'] : [];
  if (action !== 'start_again') return [];
  return [
    ...(runLive ? ['the routine run in progress'] : []),
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
  ghost,
}: {
  list: List;
  children: ReactNode;
  count: number;
  ghost: Preview | null;
}) => (
  <section
    className='list-well flex min-w-64 flex-1 flex-col gap-2 rounded-lg border border-edge bg-muted p-2'
    aria-label={LIST_TITLES[list]}
    data-testid={`list-${list}`}
  >
    <h2 className='flex items-center justify-between px-1 font-mono text-[11px] font-semibold tracking-widest text-muted-foreground uppercase'>
      {LIST_TITLES[list]} <span>{count}</span>
    </h2>
    {ghost !== null && (
      // A moved card lands at the top: lists show the most recently changed first.
      <div className='ghost-piece flex flex-col gap-1 px-3 py-2.5' aria-hidden data-testid='ghost-piece'>
        <span className='font-mono text-[10px] font-semibold tracking-wider text-signal-strong uppercase'>
          Lands here · {actionLabel(ghost.move.action, ghost.glob.type, ACTION_LABELS)}
        </span>
        <span className='text-sm font-medium opacity-55'>
          <span className='font-mono text-xs'>{ghost.glob.id}</span> · {ghost.glob.title}
        </span>
      </div>
    )}
    {children}
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
          All boards
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [openArtifact, setOpenArtifact] = useState<ArtifactRef | null>(null);
  const [creating, setCreating] = useState(false);
  const [typeFilter, setTypeFilter] = useState<SlopType | 'all'>('all');
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
  const motion = useBoardMotion(globs.data, live);
  // A link to one glob (`?glob=<id>`, e.g. a KB item's evidence) opens it here, or on the signed-off
  // page when it is no longer on the board.
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const linked = searchParams.get('glob');
  useEffect(() => {
    if (linked === null || globs.data === undefined) return;
    if (globs.data.some((g) => g.id === linked)) {
      setOpenId(linked);
      setSearchParams(
        (params) => {
          params.delete('glob');
          return params;
        },
        { replace: true },
      );
    } else {
      void navigate(`/boards/${boardId}/signed-off?glob=${encodeURIComponent(linked)}`, { replace: true });
    }
  }, [linked, globs.data, boardId, navigate, setSearchParams]);
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

  // CodeRabbit's badges live beside the globs too (a `glob.reviews` hint refreshes them). A server without the route
  // just leaves the cards without them.
  const codeReviews = useQuery({
    queryKey: [...codeReviewsKey(boardId), boardGlobIds.join(',')],
    queryFn: () => api.boardCodeReviews(boardId, boardGlobIds),
    enabled: boardGlobIds.length > 0,
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
    return mutation.mutateAsync(() => api.action(glob.id, path, glob.version)).then(
      () => true,
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
    motion.markLocal(glob.id);
    await act(glob, action);
    // If nothing moved (the action failed), a later move made elsewhere mustn't look like ours.
    setTimeout(() => motion.forgetLocal(glob.id), 1000);
  };

  /** Runs a move, asking first when it would halt work in progress. */
  const runMove = (glob: GlobView, move: CardMove, target: List) => {
    const halts = haltedBy(glob, move.action);
    if (halts.length > 0) setHaltConfirm({ glob, target, action: move.action, halts });
    else void commit(glob, move.action);
  };

  /** ← / → on a focused card: cycle its moves that way, or bump the wall when there are none. */
  const arrow = (glob: GlobView, direction: Direction) => {
    const options = movesFor(glob).filter((m) => m.move.direction === direction);
    if (options.length === 0) {
      setBumps((b) => ({ ...b, [glob.id]: direction }));
      setTimeout(() => setBumps((b) => Object.fromEntries(Object.entries(b).filter(([id]) => id !== glob.id))), 140);
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

  const all = globs.data;
  const visible = all.filter((g) => typeFilter === 'all' || g.type === typeFilter);
  const groups = [...new Set(all.flatMap((g) => (g.group === null ? [] : [g.group])))].sort();
  const open = openId === null ? undefined : all.find((g) => g.id === openId);

  return (
    <div className='flex h-full flex-col' data-testid='board' data-live={live}>
      <OfflineNotice live={live} />
      {/* The board's toolbar, under the app's status bar; the board's own top padding spaces it below. */}
      <header className='flex flex-wrap items-center gap-3 px-5 pt-4'>
        <h1 className='sr-only'>{board.data.name}</h1>
        <div className='flex gap-0.5 rounded-md border bg-muted p-0.5' role='group' aria-label='Filter by type'>
          {(['all', ...SLOP_TYPES] as const).map((t) => (
            <Button
              key={t}
              size='sm'
              className='capitalize'
              variant={typeFilter === t ? 'selected' : 'ghost'}
              aria-pressed={typeFilter === t}
              onClick={() => setTypeFilter(t)}
            >
              {t}
            </Button>
          ))}
        </div>
        <nav className='ml-auto flex flex-wrap items-center gap-8 text-sm'>
          <Link className='hover:underline' to={`/boards/${boardId}/signed-off`}>
            Signed off
          </Link>
          <Link className='hover:underline' to={`/boards/${boardId}/knowledge`}>
            Knowledge
          </Link>
          <Link className='hover:underline' to={`/boards/${boardId}/settings`}>
            Settings
          </Link>
          {/* Same text size as the nav links beside it (the small button size uses text-xs). */}
          <Button size='sm' className='text-sm' onClick={() => setCreating(true)}>
            <Plus className='h-4 w-4' /> New glob
          </Button>
        </nav>
      </header>

      <ReadinessBanner boardId={boardId} />

      <main
        ref={(el) => {
          motion.container.current = el;
        }}
        className='flex-1 overflow-auto px-5 py-4'
      >
        <div className='flex min-h-full min-w-full items-stretch gap-3'>
          {LISTS.map((list) => {
            const items = visible
              .filter((g) => g.list === list)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            return (
              <Column key={list} list={list} count={items.length} ghost={preview?.target === list ? preview : null}>
                {items.map((glob) => {
                  const moves = movesFor(glob);
                  return (
                    <GlobCard
                      key={glob.id}
                      glob={glob}
                      onOpen={() => {
                        setOpenArtifact(null);
                        setOpenId(glob.id);
                      }}
                      onOpenArtifact={(kind) => {
                        setOpenArtifact({ kind, label: '' });
                        setOpenId(glob.id);
                      }}
                      onReviewLabel={reviewLabel(glob)}
                      moves={moves.map((m) => m.move)}
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
                      codeReview={codeReviews.data?.[glob.id]}
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
        onOpenChange={setCreating}
        onCreate={async (input: NewGlob) => {
          const glob = await api.createGlob(boardId, input).catch((error: unknown) => {
            throw error instanceof RequestError ? new Error(error.body.message) : error;
          });
          store(glob);
        }}
      />

      {open !== undefined && (
        <GlobDialog
          board={board.data}
          glob={open}
          initialArtifact={openArtifact}
          onClose={() => setOpenId(null)}
          onAction={(action) => act(open, action)}
          onReviewLabel={reviewLabel(open)}
          onUpdate={async (changes: GlobChanges) => {
            try {
              store(await api.updateGlob(open.id, open.version, changes));
              return null;
            } catch (error) {
              // The dialog keeps the draft and shows why; a conflict is reloaded on request.
              return describeEditFailure(error instanceof RequestError ? error.body : { message: 'Something went wrong' });
            }
          }}
          onReload={async () => {
            store(await api.glob(open.id));
          }}
          onDelete={async () => {
            await mutation
              .mutateAsync(async () => {
                await api.deleteGlob(open.id, open.version);
                client.setQueryData<GlobView[]>(globsKey(boardId), (list = []) => list.filter((g) => g.id !== open.id));
                setOpenId(null);
                return null;
              })
              .catch(() => undefined);
          }}
        />
      )}

      {haltConfirm !== null && (
        <Dialog open onOpenChange={(o) => !o && setHaltConfirm(null)}>
          <DialogContent
            title={`${actionLabel(haltConfirm.action, haltConfirm.glob.type, ACTION_LABELS)}: move ${haltConfirm.glob.id} to ${LIST_TITLES[haltConfirm.target]}?`}
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
                {actionLabel(haltConfirm.action, haltConfirm.glob.type, ACTION_LABELS)}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
