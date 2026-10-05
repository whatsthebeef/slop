import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { useToast } from '@/toast';

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

export const HomePage = () => {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createBoard({
        name,
        repo: repo.trim() === '' ? null : repo.trim(),
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    onSuccess: (board) => {
      void client.invalidateQueries({ queryKey: ['me'] });
      void navigate(`/boards/${board.id}`);
    },
    onError: (error) => toast(error instanceof RequestError ? error.body.message : 'Could not create the board'),
  });

  if (me.data === undefined) return <p className='p-6 text-muted-foreground'>Loading…</p>;
  return (
    <main className='mx-auto grid max-w-lg gap-6 p-6'>
      <header className='flex items-center justify-between'>
        <h1 className='font-mono text-lg font-semibold tracking-wider'>SLOPMUX<span className='text-signal'>_</span></h1>
        <span className='flex items-center gap-3 text-sm text-muted-foreground'>
          {me.data.email}
          <Button
            variant='ghost'
            size='sm'
            onClick={() => void api.logout().then(() => navigate('/login'))}
          >
            Sign out
          </Button>
        </span>
      </header>
      <section className='grid gap-2'>
        <h2 className='text-sm font-semibold'>Your boards</h2>
        {me.data.boards.length === 0 && <p className='text-sm text-muted-foreground'>No boards yet.</p>}
        {me.data.boards.map((b) => (
          <Link key={b.id} to={`/boards/${b.id}`} className='rounded-md border bg-card p-3 hover:bg-muted'>
            <span className='font-medium'>{b.name}</span>{' '}
            <span className='text-xs text-muted-foreground'>
              {b.repo ?? 'no repo'} · {b.role}
            </span>
          </Link>
        ))}
      </section>
      <form
        className='grid gap-3 rounded-md border p-4'
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 className='text-sm font-semibold'>New board</h2>
        <Label>
          Name
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Label>
        <Label>
          Repo (owner/name)
          <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder='optional' />
        </Label>
        <Button type='submit' disabled={create.isPending}>
          Create board
        </Button>
      </form>
    </main>
  );
};
