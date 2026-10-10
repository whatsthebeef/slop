import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { LABEL_NAMES } from '@slop/core';
import { Plus, X } from 'lucide-react';
import {
  Attention,
  BoardBar,
  NewBoardDialog,
  Reviews,
  Running,
  Supers,
  useSessionWrite,
} from '@/components/board-bar';
import { NewBoardForm } from '@/components/new-board';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';
import { allBoardsOrder, lastViewedBoard, lastViewedLabel } from '@/lib/board-bar';

export const LoginPage = () => {
  const [email, setEmail] = useState('');
  const navigate = useNavigate();
  const returnTo = useSearchParams()[0].get('returnTo') ?? undefined;
  const config = useQuery({ queryKey: ['auth-config'], queryFn: api.authConfig });
  const client = useQueryClient();

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const result = await api.devLogin(email, returnTo);
    await client.invalidateQueries();
    void navigate(result.returnTo);
  };

  if (config.data?.mode === 'cognito') {
    return (
      <main className='grid min-h-dvh place-items-center'>
        <a className='rounded-md bg-primary px-4 py-2 text-primary-foreground' href={returnTo === undefined ? '/auth/login' : `/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
          Sign in
        </a>
      </main>
    );
  }
  return (
    <main className='grid min-h-dvh place-items-center p-4'>
      <form className='grid w-full max-w-xs gap-3' onSubmit={(e) => void submit(e)}>
        <h1 className='font-mono text-lg font-semibold tracking-wider'>SLOPMUX<span className='text-signal'>_</span></h1>
        <p className='text-xs text-muted-foreground'>Development sign-in: any email, no password.</p>
        <Label>
          Email
          <Input type='email' value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </Label>
        <Button type='submit'>Sign in</Button>
      </form>
    </main>
  );
};

/**
 * There's no home page: `/` opens the board in your bar you viewed last (the server's record, so it follows you
 * between browsers); with an empty bar, the board you viewed last, else your first board. With no boards yet it offers
 * to create one.
 */
export const HomePage = () => {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  // Wait for a fresh list: a cached one may be stale (or belong to whoever signed in before).
  if (me.data === undefined || !me.isFetchedAfterMount) {
    return <p className='p-6 text-muted-foreground'>Loading…</p>;
  }
  const target = lastViewedBoard(me.data.boards);
  if (target !== undefined) return <Navigate to={`/boards/${target.id}`} replace />;
  return (
    <div className='flex h-dvh flex-col'>
      <BoardBar />
      <main className='mx-auto grid w-full max-w-sm gap-3 p-6'>
        <h1 className='text-base font-semibold'>Create your first board</h1>
        <NewBoardForm />
      </main>
    </div>
  );
};

/**
 * All boards: every board you're on with its counts and when you last viewed it (the server's record), sessions first
 * in bar order. + adds a board to the bar and × takes it out, so this is where boards are added. New board is here too.
 */
export const BoardsPage = () => {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 30_000 });
  const write = useSessionWrite();
  const [creating, setCreating] = useState(false);
  const boards = allBoardsOrder(me.data?.boards ?? []);
  const managed = (me.data?.boards ?? []).some((b) => b.position !== undefined);
  const now = Date.now();
  return (
    <div className='flex h-dvh flex-col'>
      <BoardBar />
      <main className='mx-auto grid w-full max-w-[63rem] content-start gap-3 overflow-auto p-6'>
        <div className='flex items-center justify-between gap-3'>
          <h1 className='text-base font-semibold'>All boards</h1>
          <Button type='button' variant='outline' onClick={() => setCreating(true)} data-testid='new-board-page'>
            <Plus className='h-4 w-4' aria-hidden /> New board
          </Button>
        </div>
        {me.data === undefined && <p className='text-sm text-muted-foreground'>Loading…</p>}
        <ul className='grid gap-1.5'>
          {boards.map((b) => {
            const inBar = (b.position ?? null) !== null;
            const busy = write.isPending && write.variables.id === b.id;
            return (
              <li key={b.id} className='grid grid-cols-[minmax(0,1fr)_2.5rem] items-stretch rounded-md border bg-card hover:bg-muted'>
                <Link
                  to={`/boards/${b.id}`}
                  className='grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 no-underline'
                  data-testid={`board-row-${b.id}`}
                >
                  <span className='font-mono text-xs text-muted-foreground'>{b.id}</span>
                  <span className='grid min-w-0'>
                    <span className='truncate text-sm font-medium text-foreground'>{b.name}</span>
                    <span className='truncate text-xs text-muted-foreground'>
                      {b.repo ?? 'no repo'} · {b.role} · {lastViewedLabel(b.lastViewedAt, now, false)}
                    </span>
                  </span>
                  <span className='flex items-center gap-3'>
                    <Running count={b.running ?? 0} />
                    <Supers count={b.supers ?? 0} />
                    <Attention count={b.attention ?? 0} />
                    {LABEL_NAMES.map((name) => (
                      <Reviews key={name} name={name} count={b.reviews?.[name] ?? 0} />
                    ))}
                  </span>
                </Link>
                {managed ? (
                  <button
                    type='button'
                    disabled={busy}
                    onClick={() => write.mutate({ id: b.id, add: !inBar })}
                    aria-label={inBar ? `Remove ${b.name} from the bar` : `Add ${b.name} to the bar`}
                    className='inline-flex items-center justify-center rounded-md opacity-60 hover:opacity-100 disabled:opacity-30'
                    data-testid={`${inBar ? 'remove' : 'add'}-session-${b.id}`}
                  >
                    {inBar ? <X className='h-4 w-4' aria-hidden /> : <Plus className='h-4 w-4' aria-hidden />}
                  </button>
                ) : (
                  <span aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
      </main>
      <NewBoardDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
};
