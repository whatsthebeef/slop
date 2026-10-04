import { ROLES } from '@slop/core';
import type { Environment, Role } from '@slop/core';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { GroupChip } from '@/components/glob-card';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { useToast } from '@/toast';

const message = (error: unknown) => (error instanceof RequestError ? error.body.message : 'Something went wrong');

export const SettingsPage = () => {
  const boardId = Number(useParams().boardId);
  const client = useQueryClient();
  const toast = useToast();
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const members = useQuery({ queryKey: ['members', boardId], queryFn: () => api.members(boardId) });
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [timeZone, setTimeZone] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('dev');

  useEffect(() => {
    if (board.data === undefined) return;
    setEnvs([...board.data.environments]);
    setTimeZone(board.data.timeZone);
    setBaseBranch(board.data.baseBranch);
  }, [board.data]);

  const save = useMutation({
    mutationFn: () => {
      if (board.data === undefined) throw new Error('No board');
      return api.updateSettings(boardId, board.data.version, { environments: envs, timeZone, baseBranch });
    },
    onSuccess: () => {
      toast('Settings saved');
      void client.invalidateQueries({ queryKey: ['board', boardId] });
    },
    onError: (e) => toast(message(e)),
  });

  const setMember = useMutation({
    mutationFn: ({ email, role }: { email: string; role: Role }) => api.setMember(boardId, email, role),
    onSuccess: () => {
      setNewEmail('');
      void client.invalidateQueries({ queryKey: ['members', boardId] });
    },
    onError: (e) => toast(message(e)),
  });

  const removeMember = useMutation({
    mutationFn: (email: string) => api.removeMember(boardId, email),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['members', boardId] }),
    onError: (e) => toast(message(e)),
  });

  if (board.data === undefined) return <p className='p-6 text-muted-foreground'>Loading…</p>;
  const admin = board.data.role === 'admin';

  return (
    <main className='mx-auto grid max-w-2xl gap-8 p-6'>
      <header className='flex items-center gap-3'>
        <Link className='text-sm text-muted-foreground hover:underline' to={`/boards/${boardId}`}>
          ← {board.data.name}
        </Link>
        <h1 className='font-semibold'>Settings</h1>
      </header>

      <section className='grid gap-3'>
        <h2 className='text-sm font-semibold'>Board</h2>
        <div className='grid grid-cols-2 gap-3'>
          <Label>
            Base branch
            <Input value={baseBranch} disabled={!admin} onChange={(e) => setBaseBranch(e.target.value)} />
          </Label>
          <Label>
            Working-hours time zone
            <Input value={timeZone} disabled={!admin} onChange={(e) => setTimeZone(e.target.value)} />
          </Label>
        </div>
        <h3 className='text-xs font-semibold text-muted-foreground'>Environments</h3>
        {envs.map((env, i) => (
          <div key={i} className='flex items-center gap-2'>
            <Input
              value={env.name}
              disabled={!admin}
              onChange={(e) => setEnvs(envs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <label className='flex shrink-0 items-center gap-1 text-xs'>
              <input
                type='checkbox'
                disabled={!admin}
                checked={env.allowBranchDeploy}
                onChange={(e) =>
                  setEnvs(envs.map((x, j) => (j === i ? { ...x, allowBranchDeploy: e.target.checked } : x)))
                }
              />
              branch deploys
            </label>
            {admin && (
              <Button variant='ghost' size='sm' onClick={() => setEnvs(envs.filter((_, j) => j !== i))}>
                Remove
              </Button>
            )}
          </div>
        ))}
        {admin && (
          <div className='flex gap-2'>
            <Button variant='outline' size='sm' onClick={() => setEnvs([...envs, { name: '', allowBranchDeploy: true }])}>
              Add environment
            </Button>
            <Button size='sm' disabled={save.isPending} onClick={() => save.mutate()}>
              Save settings
            </Button>
          </div>
        )}
      </section>

      <section className='grid gap-3'>
        <h2 className='text-sm font-semibold'>Members</h2>
        {members.data?.map((m) => (
          <div key={m.email} className='flex items-center gap-2 text-sm'>
            <span className='flex-1'>{m.email}</span>
            <Select
              className='w-28'
              value={m.role}
              disabled={!admin}
              onChange={(e) => setMember.mutate({ email: m.email, role: e.target.value as Role })}
            >
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            {admin && (
              <Button variant='ghost' size='sm' onClick={() => removeMember.mutate(m.email)}>
                Remove
              </Button>
            )}
          </div>
        ))}
        {admin && (
          <form
            className='flex gap-2'
            onSubmit={(e) => {
              e.preventDefault();
              setMember.mutate({ email: newEmail, role: newRole });
            }}
          >
            <Input type='email' placeholder='email' value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
            <Select className='w-28' value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            <Button type='submit'>Add</Button>
          </form>
        )}
      </section>
    </main>
  );
};

export const SignedOffPage = () => {
  const boardId = Number(useParams().boardId);
  const pages = useInfiniteQuery({
    queryKey: ['signed-off', boardId],
    queryFn: ({ pageParam }) => api.signedOff(boardId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const globs = pages.data?.pages.flatMap((p) => p.globs) ?? [];
  return (
    <main className='mx-auto grid max-w-2xl gap-4 p-6'>
      <header className='flex items-center gap-3'>
        <Link className='text-sm text-muted-foreground hover:underline' to={`/boards/${boardId}`}>
          ← Board
        </Link>
        <h1 className='font-semibold'>Signed off</h1>
      </header>
      {globs.length === 0 && !pages.isLoading && <p className='text-sm text-muted-foreground'>Nothing signed off yet.</p>}
      {globs.map((g) => (
        <div key={g.id} className='flex items-center gap-2 rounded-md border bg-card p-2 text-sm'>
          <span className='font-mono text-xs text-muted-foreground'>{g.id}</span>
          <span className='flex-1'>{g.title}</span>
          {g.group !== null && <GroupChip name={g.group} />}
          <span className='text-xs text-muted-foreground'>
            {g.signedOffAt === null ? '' : new Date(g.signedOffAt).toLocaleDateString()}
          </span>
        </div>
      ))}
      {pages.hasNextPage && (
        <Button variant='outline' onClick={() => void pages.fetchNextPage()}>
          Load more
        </Button>
      )}
    </main>
  );
};
