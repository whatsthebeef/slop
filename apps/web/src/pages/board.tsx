import { LISTS, SLOP_TYPES } from '@slop/core';
import type { Action, LabelName, LabelState, List, SlopType } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { ArtifactRef } from '@/components/artifacts';
import { CreateGlobDialog } from '@/components/create-glob';
import { GlobCard } from '@/components/glob-card';
import type { CardMove } from '@/components/glob-card';
import { GlobDialog } from '@/components/glob-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ACTION_LABELS, ACTION_PATHS, api, RequestError } from '@/lib/api';
import type { GlobChanges, GlobView, NewGlob } from '@/lib/api';
import { useBoardMotion } from '@/lib/board-motion';
import { globsKey, useLiveBoard } from '@/lib/live';
import { cn } from '@/lib/utils';
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
  start_again: 'back to Planning',
};

/**
 * The moves a glob can make, each a state-machine action it allows: right takes a glob from
 * Planning into Doing; left takes a same back to Planning (Start again keeps a sub or super in
 * Doing, so it isn't a move for them). Leaving Doing happens through the merge and signing off
 * through labels, so those lists have no moves.
 */
const movesFor = (glob: GlobView): { move: CardMove; target: List }[] => {
  const allowed = glob.allowedActions ?? [];
  const make = (action: Action, direction: Direction, target: List) => ({
    target,
    move: {
      action,
      direction,
      label: direction === 'right' ? `${ACTION_LABELS[action]} ▸` : `◂ ${ACTION_LABELS[action]}`,
      description: `${ACTION_LABELS[action]} ${glob.id}: ${MOVE_DESCRIPTIONS[action] ?? LIST_TITLES[target]}`,
    },
  });
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
    className='list-well flex min-h-40 min-w-64 flex-1 flex-col gap-2 rounded-lg border border-edge bg-muted p-2'
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
          Lands here · {ACTION_LABELS[ghost.move.action]}
        </span>
        <span className='text-sm font-medium opacity-55'>
          <span className='font-mono text-xs'>{ghost.glob.id}</span> · {ghost.glob.title}
        </span>
      </div>
    )}
    {children}
  </section>
);

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

  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const globs = useQuery({ queryKey: globsKey(boardId), queryFn: () => api.globs(boardId) });
  const motion = useBoardMotion(globs.data, live);

  // Keeps the known artifact summaries when a response carries none.
  const store = (glob: GlobView) =>
    client.setQueryData<GlobView[]>(globsKey(boardId), (list = []) => {
      const artifacts = glob.artifacts ?? list.find((g) => g.id === glob.id)?.artifacts;
      return [...list.filter((g) => g.id !== glob.id), artifacts === undefined ? glob : { ...glob, artifacts }];
    });

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

  const act = async (glob: GlobView, action: Action) => {
    const path = ACTION_PATHS[action];
    if (path === null) return;
    await mutation.mutateAsync(() => api.action(glob.id, path, glob.version)).catch(() => undefined);
  };

  const switchLabel = (glob: GlobView) => (label: LabelName, state: LabelState) =>
    mutation.mutate(() => api.setLabel(glob.id, label, state, glob.version));

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

  if (board.isError) return <p className='p-6'>You don't have access to this board.</p>;
  if (board.data === undefined || globs.data === undefined) return <p className='p-6 text-muted-foreground'>Loading…</p>;

  const all = globs.data;
  const visible = all.filter((g) => typeFilter === 'all' || g.type === typeFilter);
  const groups = [...new Set(all.flatMap((g) => (g.group === null ? [] : [g.group])))].sort();
  const open = openId === null ? undefined : all.find((g) => g.id === openId);

  return (
    <div className='flex h-dvh flex-col'>
      <header className='flex flex-wrap items-center gap-3 border-b-2 border-foreground/80 px-5 py-3'>
        <Link to='/' className='font-mono text-[15px] font-semibold tracking-wider text-foreground no-underline'>
          SLOPMUX<span className='text-signal'>_</span>
        </Link>
        <span className='h-4.5 w-px bg-edge' aria-hidden />
        <h1 className='text-[15px] font-semibold'>{board.data.name}</h1>
        <span
          className='inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-muted-foreground'
          title={live === 'live' ? 'Live updates connected' : 'Reconnecting…'}
          data-testid='live-indicator'
        >
          <span className={cn('h-[7px] w-[7px]', live === 'live' ? 'bg-signal' : 'bg-amber')} />
          {live === 'live' ? 'LIVE' : 'RECONNECTING'}
        </span>
        <div className='flex gap-0.5 rounded-md border bg-muted p-0.5' role='group' aria-label='Filter by type'>
          {(['all', ...SLOP_TYPES] as const).map((t) => (
            <Button
              key={t}
              size='sm'
              variant={typeFilter === t ? 'selected' : 'ghost'}
              aria-pressed={typeFilter === t}
              onClick={() => setTypeFilter(t)}
            >
              {t}
            </Button>
          ))}
        </div>
        <nav className='ml-auto flex flex-wrap items-center gap-4 text-sm'>
          <Link className='hover:underline' to={`/boards/${boardId}/signed-off`}>
            Signed off
          </Link>
          <Link className='hover:underline' to={`/boards/${boardId}/knowledge`}>
            Knowledge
          </Link>
          <Link className='hover:underline' to={`/boards/${boardId}/settings`}>
            Settings
          </Link>
          <Button size='sm' onClick={() => setCreating(true)}>
            <Plus className='h-4 w-4' /> New glob
          </Button>
        </nav>
      </header>

      <main
        ref={(el) => {
          motion.container.current = el;
        }}
        className='flex flex-1 gap-3 overflow-x-auto px-5 py-4'
      >
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
                    onSwitchLabel={switchLabel(glob)}
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
                  />
                );
              })}
            </Column>
          );
        })}
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
          onSwitchLabel={switchLabel(open)}
          onUpdate={async (changes: GlobChanges) => {
            await mutation.mutateAsync(() => api.updateGlob(open.id, open.version, changes)).catch(() => undefined);
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
            title={`${ACTION_LABELS[haltConfirm.action]}: move ${haltConfirm.glob.id} to ${LIST_TITLES[haltConfirm.target]}?`}
            className='max-w-sm'
          >
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
                {ACTION_LABELS[haltConfirm.action]}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
