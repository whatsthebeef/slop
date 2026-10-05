import { LABEL_NAMES } from '@slop/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { NewBoardForm } from '@/components/new-board';
import { Attention, Reviews, Running, StatusBar, Supers } from '@/components/status-bar';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';
import { boardVisits, lastBoard } from '@/lib/recent-boards';

export const LoginPage = () => {
  const [email, setEmail] = useState('');
  const navigate = useNavigate();
  const config = useQuery({ queryKey: ['auth-config'], queryFn: api.authConfig });
  const client = useQueryClient();

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    await api.devLogin(email);
    await client.invalidateQueries();
    void navigate('/');
  };

  if (config.data?.mode === 'cognito') {
    return (
      <main className='grid min-h-dvh place-items-center'>
        <a className='rounded-md bg-primary px-4 py-2 text-primary-foreground' href='/auth/login'>
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
 * There's no home page: `/` opens the board you used last (or your first). With no boards yet it
 * offers to create one; after that, new boards come from the app settings menu.
 */
export const HomePage = () => {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  // Wait for a fresh list: a cached one may be stale (or belong to whoever signed in before).
  if (me.data === undefined || !me.isFetchedAfterMount) {
    return <p className='p-6 text-muted-foreground'>Loading…</p>;
  }
  const boards = me.data.boards;
  const last = lastBoard();
  const target = boards.find((b) => b.id === last) ?? boards[0];
  if (target !== undefined) return <Navigate to={`/boards/${target.id}`} replace />;
  return (
    <div className='flex h-dvh flex-col'>
      <StatusBar />
      <main className='mx-auto grid w-full max-w-sm gap-3 p-6'>
        <h1 className='text-base font-semibold'>Create your first board</h1>
        <NewBoardForm />
      </main>
    </div>
  );
};

const opened = (at: number | undefined) =>
  at === undefined ? 'not opened here' : `opened ${new Date(at).toLocaleString()}`;

/** Every board you're on, the most recently opened (in this browser) first, then the newest. */
export const BoardsPage = () => {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const visits = boardVisits();
  const boards = [...(me.data?.boards ?? [])].sort(
    (a, b) => (visits[b.id] ?? 0) - (visits[a.id] ?? 0) || b.id - a.id,
  );
  return (
    <div className='flex h-dvh flex-col'>
      <StatusBar />
      <main className='mx-auto grid w-full max-w-[63rem] content-start gap-3 overflow-auto p-6'>
        <h1 className='text-base font-semibold'>All boards</h1>
        {me.data === undefined && <p className='text-sm text-muted-foreground'>Loading…</p>}
        <ul className='grid gap-1.5'>
          {boards.map((b) => (
            <li key={b.id}>
              <Link
                to={`/boards/${b.id}`}
                className='grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md border bg-card px-3 py-3 no-underline hover:bg-muted'
                data-testid={`board-row-${b.id}`}
              >
                <span className='font-mono text-xs text-muted-foreground'>{b.id}</span>
                <span className='grid min-w-0'>
                  <span className='truncate text-sm font-medium text-foreground'>{b.name}</span>
                  <span className='truncate text-xs text-muted-foreground'>
                    {b.repo ?? 'no repo'} · {b.role} · {opened(visits[b.id])}
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
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
};
