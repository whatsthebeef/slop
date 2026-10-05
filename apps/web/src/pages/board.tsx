import { LISTS, SLOP_TYPES } from '@slop/core';
import type { Action, LabelName, LabelState, List, SlopType } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { ArtifactRef } from '@/components/artifacts';
import { CreateGlobDialog } from '@/components/create-glob';
import { GlobCard } from '@/components/glob-card';
import type { CardMotion } from '@/components/glob-card';
import { GlobDialog } from '@/components/glob-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ACTION_LABELS, ACTION_PATHS, api, RequestError } from '@/lib/api';
import type { GlobChanges, GlobView, NewGlob } from '@/lib/api';
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

/**
 * The state-machine actions behind a card's arrows, limited to what the glob allows. Right moves
 * a glob from Planning into Doing; left takes a same back to Planning (Start again keeps a sub or
 * super in Doing, so it isn't a move for them). Leaving Doing happens through the merge, and
 * signing off through labels, so those lists have no arrows.
 */
const moveActions = (glob: GlobView, direction: Direction): { target: List; actions: Action[] } | null => {
  const allowed = glob.allowedActions ?? [];
  const pick = (target: List, candidates: readonly Action[]) => {
    const actions = candidates.filter((a) => allowed.includes(a));
    return actions.length === 0 ? null : { target, actions };
  };
  if (direction === 'right') return glob.list === 'planning' ? pick('doing', ['start', 'pick_up', 'take_over', 'retrigger']) : null;
  return glob.list === 'doing' && glob.type === 'same' ? pick('planning', ['start_again']) : null;
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

const Column = ({ list, children, count }: { list: List; children: React.ReactNode; count: number }) => {
  return (
    <section
      className='flex min-h-40 min-w-64 flex-1 flex-col gap-2 rounded-lg bg-muted/60 p-2'
      aria-label={LIST_TITLES[list]}
      data-testid={`list-${list}`}
    >
      <h2 className='flex items-center justify-between px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
        {LIST_TITLES[list]} <span>{count}</span>
      </h2>
      {children}
    </section>
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
  const [moveChoice, setMoveChoice] = useState<{ glob: GlobView; target: List; direction: Direction; actions: Action[] } | null>(null);
  const [haltConfirm, setHaltConfirm] = useState<{
    glob: GlobView;
    target: List;
    direction: Direction;
    action: Action;
    halts: string[];
  } | null>(null);
  const [motions, setMotions] = useState<Record<string, CardMotion>>({});

  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const globs = useQuery({ queryKey: globsKey(boardId), queryFn: () => api.globs(boardId) });

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

  const setMotion = (id: string, motion: CardMotion | undefined) =>
    setMotions((current) =>
      Object.fromEntries([...Object.entries(current).filter(([key]) => key !== id), ...(motion === undefined ? [] : [[id, motion] as const])]),
    );

  /**
   * Slops the card across: it splats out while the action runs, then plops in where it now
   * belongs (or back where it was, if the move failed).
   */
  const slop = async (glob: GlobView, action: Action, direction: Direction) => {
    setMotion(glob.id, { phase: 'out', direction });
    await Promise.all([act(glob, action), new Promise((resolve) => setTimeout(resolve, 380))]);
    setMotion(glob.id, { phase: 'in', direction });
    setTimeout(() => setMotion(glob.id, undefined), 600);
  };

  /** Runs a move's action, asking first when it would halt work in progress. */
  const runMove = (glob: GlobView, target: List, direction: Direction, action: Action) => {
    const halts = haltedBy(glob, action);
    if (halts.length > 0) setHaltConfirm({ glob, target, direction, action, halts });
    else void slop(glob, action, direction);
  };

  const move = (glob: GlobView, direction: Direction) => {
    const options = moveActions(glob, direction);
    if (options === null) return;
    const [only] = options.actions;
    if (options.actions.length === 1 && only !== undefined) runMove(glob, options.target, direction, only);
    else setMoveChoice({ glob, direction, ...options });
  };

  const arrow = (glob: GlobView, direction: Direction) => {
    const options = moveActions(glob, direction);
    return options === null ? undefined : { label: `Move to ${LIST_TITLES[options.target]}`, onMove: () => move(glob, direction) };
  };

  if (board.isError) return <p className='p-6'>You don't have access to this board.</p>;
  if (board.data === undefined || globs.data === undefined) return <p className='p-6 text-muted-foreground'>Loading…</p>;

  const all = globs.data;
  const visible = all.filter((g) => typeFilter === 'all' || g.type === typeFilter);
  const groups = [...new Set(all.flatMap((g) => (g.group === null ? [] : [g.group])))].sort();
  const open = openId === null ? undefined : all.find((g) => g.id === openId);

  return (
    <div className='flex h-dvh flex-col'>
      <header className='flex flex-wrap items-center gap-3 border-b px-4 py-3'>
        <Link to='/' className='text-sm text-muted-foreground hover:underline'>
          slop
        </Link>
        <h1 className='font-semibold'>{board.data.name}</h1>
        <span
          className={cn('h-2 w-2 rounded-full', live === 'live' ? 'bg-emerald-500' : 'bg-amber')}
          title={live === 'live' ? 'Live' : 'Reconnecting…'}
        />
        <div className='flex gap-1' role='group' aria-label='Filter by type'>
          {(['all', ...SLOP_TYPES] as const).map((t) => (
            <Button key={t} size='sm' variant={typeFilter === t ? 'default' : 'ghost'} onClick={() => setTypeFilter(t)}>
              {t}
            </Button>
          ))}
        </div>
        <nav className='ml-auto flex items-center gap-2'>
          <Link className='text-sm hover:underline' to={`/boards/${boardId}/signed-off`}>
            Signed off
          </Link>
          <Link className='text-sm hover:underline' to={`/boards/${boardId}/knowledge`}>
            Knowledge
          </Link>
          <Link className='text-sm hover:underline' to={`/boards/${boardId}/settings`}>
            Settings
          </Link>
          <Button size='sm' onClick={() => setCreating(true)}>
            <Plus className='h-4 w-4' /> New glob
          </Button>
        </nav>
      </header>

      <main className='flex flex-1 gap-3 overflow-x-auto p-4'>
          {LISTS.map((list) => {
            const items = visible
              .filter((g) => g.list === list)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            return (
              <Column key={list} list={list} count={items.length}>
                {items.map((glob) => (
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
                    moveLeft={arrow(glob, 'left')}
                    moveRight={arrow(glob, 'right')}
                    motion={motions[glob.id]}
                  />
                ))}
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

      {moveChoice !== null && (
        <Dialog open onOpenChange={(o) => !o && setMoveChoice(null)}>
          <DialogContent title={`Move ${moveChoice.glob.id} to ${LIST_TITLES[moveChoice.target]}`} className='max-w-sm'>
            <div className='grid gap-2'>
              {moveChoice.actions.map((action) => (
                <Button
                  key={action}
                  onClick={() => {
                    setMoveChoice(null);
                    runMove(moveChoice.glob, moveChoice.target, moveChoice.direction, action);
                  }}
                >
                  {ACTION_LABELS[action]}
                  {action === 'start' && ' — a routine implements it'}
                  {action === 'pick_up' && ' — I will implement it'}
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
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
                  void slop(haltConfirm.glob, haltConfirm.action, haltConfirm.direction);
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
