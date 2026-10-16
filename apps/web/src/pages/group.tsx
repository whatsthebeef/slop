import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CreateGlobDialog } from '@/components/create-glob';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import type { GlobView, NewGlob } from '@/lib/api';
import { lacksReason } from '@/lib/status-line';
import { groupNames } from '@/lib/group-names';
import { boardGroupPath, groupPath, holdText, movableIn, progressText, regroupNotice } from '@/lib/group-page';
import { globKey, globsKey, useLiveBoard } from '@/lib/live';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';
import { UNTIL_WORDS } from '@slop/core';
import type { GroupSummary, GroupView } from '@slop/core';

const REFRESH_MS = 10_000;

const message = (error: unknown) => (error instanceof RequestError ? error.body.message : 'Something went wrong');
const globHref = (boardId: number, id: string) => `/boards/${String(boardId)}/globs/${id}`;

/** What the page does to the group; each returns an error text, or null when it worked (the view then refreshes). */
export interface GroupActions {
  onRename: (to: string) => Promise<string | null>;
  onMerge: (into: string) => Promise<string | null>;
  onMoveOut: (id: string) => Promise<string | null>;
  onMoveIn: (id: string) => Promise<string | null>;
  onAdd: () => void;
}

const Section = ({ title, count, children }: { title: string; count?: number; children: ReactNode }) => (
  <section className='grid gap-2'>
    <h2 className='text-sm font-semibold'>
      {title}
      {count !== undefined && <span className='ml-1.5 font-normal text-muted-foreground'>{count}</span>}
    </h2>
    {children}
  </section>
);

/** The group as one piece of work: progress, its globs and what holds them, relations, open decisions, and the ways to reshape it. */
export const GroupPageView = ({
  boardId,
  view,
  others,
  candidates,
  actions,
}: {
  boardId: number;
  view: GroupView;
  /** The board's other groups, to merge into. */
  others: readonly GroupSummary[];
  /** Globs that could move into this group. */
  candidates: readonly Pick<GlobView, 'id' | 'title'>[];
  actions: GroupActions;
}) => {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(view.name);
  const [into, setInto] = useState('');
  const [moveIn, setMoveIn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<string | null>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const failure = await work();
    setBusy(false);
    setError(failure);
    return failure === null;
  };
  const rename = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (await run(() => actions.onRename(name))) setRenaming(false);
  };
  const { progress } = view;
  const holdingRelations = view.relations.filter((r) => r.holding);
  const titleOf = (id: string) => view.globs.find((g) => g.id === id)?.title;

  return (
    <main className='mx-auto grid w-full max-w-[63rem] gap-6 p-6' data-testid='group-page'>
      <header className='grid gap-2'>
        <Link className='text-xs text-muted-foreground underline' to={boardGroupPath(boardId, view.name)}>
          Show only this group on the board
        </Link>
        <div className='flex flex-wrap items-baseline gap-3'>
          <h1 className='font-mono text-xl font-semibold' data-testid='group-name'>
            {view.name}
          </h1>
          <span className='text-sm text-muted-foreground' data-testid='group-progress'>
            {progressText(progress)} merged
          </span>
        </div>
        <div
          className='h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted'
          role='progressbar'
          aria-label='Merged globs'
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.merged}
        >
          <div className='h-full bg-foreground' style={{ width: `${progress.total === 0 ? 0 : Math.round((progress.merged / progress.total) * 100)}%` }} />
        </div>
        <p className='text-xs text-muted-foreground'>A group is only the label its globs share: it has no status or sign-off of its own.</p>
      </header>

      {error !== null && (
        <p role='alert' className='rounded-md border border-destructive p-2 text-sm text-destructive' data-testid='group-error'>
          {error}
        </p>
      )}

      <Section title='Globs' count={view.globs.length}>
        <ul className='grid gap-1.5' data-testid='group-globs'>
          {view.globs.map((g) => (
            <li key={g.id} className='grid gap-1 rounded-md border bg-card p-2 text-sm' data-testid={`group-glob-${g.id}`}>
              <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
                <Link className='font-mono text-xs underline' to={globHref(boardId, g.id)}>
                  {g.id}
                </Link>
                <span className='font-medium'>{g.title}</span>
                <span className='ml-auto flex items-center gap-2 text-xs text-muted-foreground'>
                  <span>{g.status}</span>
                  <span>{g.type}</span>
                  <Button
                    variant='ghost'
                    size='sm'
                    disabled={busy}
                    aria-label={`Move ${g.id} out of the group`}
                    onClick={() => void run(() => actions.onMoveOut(g.id))}
                  >
                    Move out
                  </Button>
                </span>
              </div>
              <div className='text-xs text-muted-foreground' data-testid={`group-glob-${g.id}-move`}>
                {holdText(g)}
              </div>
              {g.holding.length > 0 && (
                <div className='text-xs'>
                  Held by{' '}
                  {g.holding.map((h, i) => (
                    <span key={h.relationId}>
                      {i > 0 && ', '}
                      <Link className='font-mono underline' to={globHref(boardId, h.to)}>
                        {h.to}
                      </Link>
                      {h.toIsDecision ? ' (decision)' : ''} {h.gate} until {UNTIL_WORDS[h.until]}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className='flex flex-wrap items-center gap-2'>
          <Button variant='outline' size='sm' onClick={actions.onAdd}>
            Add glob
          </Button>
          <Select className='w-72' aria-label='Glob to move into the group' value={moveIn} onChange={(e) => setMoveIn(e.target.value)}>
            <option value=''>Move a glob in…</option>
            {candidates.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id} {g.title}
              </option>
            ))}
          </Select>
          <Button
            variant='outline'
            size='sm'
            disabled={busy || moveIn === ''}
            onClick={() => void run(() => actions.onMoveIn(moveIn)).then((ok) => ok && setMoveIn(''))}
          >
            Move in
          </Button>
        </div>
      </Section>

      <Section title='Relations' count={view.relations.length}>
        {view.relations.length === 0 ? (
          <p className='text-sm text-muted-foreground'>No relations from these globs.</p>
        ) : (
          <ul className='grid gap-1 text-sm' data-testid='group-relations'>
            {view.relations.map((r) => (
              <li key={r.id} className={cn('flex flex-wrap items-baseline gap-x-1.5 rounded-md border p-2', r.holding ? 'bg-card' : 'text-muted-foreground')} data-testid={`group-relation-${r.id}`}>
                <Link className='font-mono text-xs underline' to={globHref(boardId, r.from)}>
                  {r.from}
                </Link>
                <span>{r.gate === 'start' ? 'starts after' : r.gate === 'merge' ? 'merges after' : 'signs off after'}</span>
                <Link className='font-mono text-xs underline' to={globHref(boardId, r.to)}>
                  {r.to}
                </Link>
                {r.toTitle !== null && <span className='text-xs'>{r.toTitle}</span>}
                {r.toIsDecision && <span className='rounded bg-muted px-1.5 text-xs'>decision</span>}
                <span className='text-xs'>until {UNTIL_WORDS[r.until]}</span>
                {(r.reason ?? '') !== '' && <span className='text-xs text-muted-foreground'>: {r.reason}</span>}
                {lacksReason(r) && (
                  <span className='rounded bg-muted px-1.5 text-xs text-muted-foreground' data-testid={`no-reason-${r.id}`}>
                    no reason given
                  </span>
                )}
                <span className='ml-auto flex gap-1.5 text-xs'>
                  {r.crosses && (
                    <span className='rounded border border-required-border px-1.5' data-testid='relation-crosses'>
                      crosses groups
                    </span>
                  )}
                  <span>{r.holding ? 'holding' : 'met'}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {holdingRelations.length === 0 && view.relations.length > 0 && <p className='text-xs text-muted-foreground'>Nothing is held back.</p>}
      </Section>

      <Section title='Open decisions' count={view.decisions.length}>
        {view.decisions.length === 0 ? (
          <p className='text-sm text-muted-foreground'>No open decisions.</p>
        ) : (
          <ul className='grid gap-1 text-sm' data-testid='group-decisions'>
            {view.decisions.map((d) => (
              <li key={d.id} className='rounded-md border bg-card p-2'>
                <Link className='font-mono text-xs underline' to={globHref(boardId, d.id)}>
                  {d.id}
                </Link>{' '}
                {d.title}
                <div className='text-xs text-muted-foreground'>
                  {d.holdsBack.length === 0
                    ? 'Holds nothing in this group'
                    : `Holds back ${d.holdsBack.map((id) => `${id}${titleOf(id) === undefined ? '' : ` ${titleOf(id) ?? ''}`}`).join(', ')}`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title='Rename or merge'>
        {renaming ? (
          <form className='flex flex-wrap items-center gap-2' onSubmit={(e) => void rename(e)}>
            <Input className='w-64' aria-label='New group name' value={name} onChange={(e) => setName(e.target.value)} />
            <Button size='sm' type='submit' disabled={busy || name.trim() === '' || name.trim() === view.name}>
              Rename
            </Button>
            <Button size='sm' variant='ghost' type='button' onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className='flex flex-wrap items-center gap-2'>
            <Button variant='outline' size='sm' onClick={() => setRenaming(true)}>
              Rename group
            </Button>
            <Select className='w-56' aria-label='Group to merge into' value={into} onChange={(e) => setInto(e.target.value)}>
              <option value=''>Merge into…</option>
              {others.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name} ({progressText(g.progress)})
                </option>
              ))}
            </Select>
            <Button variant='outline' size='sm' disabled={busy || into === ''} onClick={() => void run(() => actions.onMerge(into))}>
              Merge
            </Button>
          </div>
        )}
      </Section>
    </main>
  );
};

/** One group at `/boards/:b/groups/:name`: the view refreshes after every action and on the board's live updates. */
export const GroupPage = () => {
  const params = useParams();
  const boardId = Number(params.boardId);
  const name = params.name ?? '';
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  useLiveBoard(boardId);
  const [creating, setCreating] = useState(false);
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const view = useQuery({ queryKey: ['group', boardId, name], queryFn: () => api.group(boardId, name), refetchInterval: REFRESH_MS });
  const summaries = useQuery({ queryKey: ['groups', boardId], queryFn: () => api.groups(boardId), refetchInterval: REFRESH_MS });
  const boardGlobs = useQuery({ queryKey: globsKey(boardId), queryFn: () => api.globs(boardId) });

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['group', boardId] }),
      client.invalidateQueries({ queryKey: ['groups', boardId] }),
      client.invalidateQueries({ queryKey: globsKey(boardId) }),
    ]);
  };
  /** The glob is read first: its version is what the update carries. */
  const regroup = async (id: string, group: string | null): Promise<string | null> => {
    try {
      const glob = await api.glob(id);
      client.setQueryData(globKey(id), await api.updateGlob(id, glob.version, { group }));
      await refresh();
      return null;
    } catch (error) {
      return message(error);
    }
  };
  const after = async (work: () => Promise<{ name: string; moved: number; failed: readonly { id: string; message: string }[] }>): Promise<string | null> => {
    try {
      const result = await work();
      toast(regroupNotice(result));
      await refresh();
      // Stay put on a partial move: the globs that failed still carry this group's name, and this page is where to try again.
      if (result.failed.length === 0) void navigate(groupPath(boardId, result.name), { replace: true });
      return null;
    } catch (error) {
      return message(error);
    }
  };

  if (view.data === undefined || board.data === undefined) {
    if (view.error !== null) {
      return (
        <p className='p-6 text-sm' data-testid='group-unavailable'>
          {message(view.error)}{' '}
          <Link className='underline' to={`/boards/${String(boardId)}`}>
            Back to the board
          </Link>
        </p>
      );
    }
    return <p className='p-6 text-muted-foreground'>Loading…</p>;
  }
  const shown = view.data;
  const globs = boardGlobs.data ?? [];
  return (
    <>
      <GroupPageView
        // Fresh local state per group: after a merge the page for the target keeps the picker's old choice, which would merge it into itself.
        key={shown.name}
        boardId={boardId}
        view={shown}
        others={(summaries.data ?? []).filter((g) => g.name !== shown.name)}
        candidates={movableIn(globs, shown.name)}
        actions={{
          onRename: (to) => after(() => api.renameGroup(boardId, shown.name, to.trim())),
          onMerge: (into) => after(() => api.mergeGroup(boardId, shown.name, into)),
          onMoveOut: (id) => regroup(id, null),
          onMoveIn: (id) => regroup(id, shown.name),
          onAdd: () => setCreating(true),
        }}
      />
      <CreateGlobDialog
        // Remount on a rename or merge: the form takes initialGroup only when it is created.
        key={shown.name}
        board={board.data}
        groups={groupNames(globs)}
        initialGroup={shown.name}
        open={creating}
        onOpenChange={setCreating}
        onCreate={async (input: NewGlob) => {
          const glob = await api.createGlob(boardId, input).catch((error: unknown) => {
            throw error instanceof RequestError ? new Error(error.body.message) : error;
          });
          client.setQueryData(globKey(glob.id), glob);
          await refresh();
          return glob;
        }}
      />
    </>
  );
};
