import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { NewBoardForm } from '@/components/new-board';
import { BoardBar } from '@/components/board-bar';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';
import { lastViewedBoard } from '@/lib/board-bar';

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
