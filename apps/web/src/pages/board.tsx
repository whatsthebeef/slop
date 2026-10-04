import { DndContext, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { LISTS, SLOP_TYPES } from '@slop/core';
import type { Action, LabelName, LabelState, List, SlopType } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { CreateGlobDialog } from '@/components/create-glob';
import { GlobCard } from '@/components/glob-card';
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

/** Which buttons a drop onto a list stands for. Moves are always the state machine's actions. */
const DROP_ACTIONS: Partial<Record<List, readonly Action[]>> = {
  doing: ['start', 'pick_up', 'take_over', 'retrigger'],
  planning: ['start_again'],
};

const Column = ({ list, children, count }: { list: List; children: React.ReactNode; count: number }) => {
  const { setNodeRef, isOver } = useDroppable({ id: list });
  return (
    <section
      ref={setNodeRef}
      className={cn('flex min-h-40 min-w-64 flex-1 flex-col gap-2 rounded-lg bg-muted/60 p-2', isOver && 'ring-2 ring-ring')}
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
  const [creating, setCreating] = useState(false);
  const [typeFilter, setTypeFilter] = useState<SlopType | 'all'>('all');
  const [dropChoice, setDropChoice] = useState<{ glob: GlobView; actions: Action[] } | null>(null);

  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const globs = useQuery({ queryKey: globsKey(boardId), queryFn: () => api.globs(boardId) });

  const store = (glob: GlobView) =>
    client.setQueryData<GlobView[]>(globsKey(boardId), (list = []) => [...list.filter((g) => g.id !== glob.id), glob]);

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

  const onDragEnd = (event: DragEndEvent) => {
    const glob = (event.active.data.current as { glob: GlobView } | undefined)?.glob;
    const target = event.over?.id as List | undefined;
    if (glob === undefined || target === undefined || target === glob.list) return;
    const candidates = (DROP_ACTIONS[target] ?? []).filter((a) => glob.allowedActions?.includes(a));
    if (candidates.length === 0) {
      toast(`${glob.id} can't be moved to ${LIST_TITLES[target]} by hand; that happens through events.`);
      return;
    }
    const [only] = candidates;
    if (candidates.length === 1 && only !== undefined) void act(glob, only);
    else setDropChoice({ glob, actions: candidates });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
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
                    onOpen={() => setOpenId(glob.id)}
                    onSwitchLabel={switchLabel(glob)}
                  />
                ))}
              </Column>
            );
          })}
        </main>
      </DndContext>

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

      {dropChoice !== null && (
        <Dialog open onOpenChange={(o) => !o && setDropChoice(null)}>
          <DialogContent title={`Move ${dropChoice.glob.id} to Doing`} className='max-w-sm'>
            <div className='grid gap-2'>
              {dropChoice.actions.map((action) => (
                <Button
                  key={action}
                  onClick={() => {
                    setDropChoice(null);
                    void act(dropChoice.glob, action);
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
    </div>
  );
};
