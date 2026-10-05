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
  // Re-checked when the tab regains focus, so returning from GitHub's install page updates it.
  const connection = useQuery({
    queryKey: ['repo-connection', boardId],
    queryFn: () => api.repoConnection(boardId),
    refetchOnWindowFocus: true,
  });
  const [repo, setRepo] = useState('');
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
    setRepo(board.data.repo ?? '');
  }, [board.data]);

  const save = useMutation({
    mutationFn: () => {
      if (board.data === undefined) throw new Error('No board');
      return api.updateSettings(boardId, board.data.version, {
        environments: envs,
        timeZone,
        baseBranch,
        repo: repo.trim() === '' ? null : repo.trim(),
      });
    },
    onSuccess: () => {
      toast('Settings saved');
      void client.invalidateQueries({ queryKey: ['board', boardId] });
      void client.invalidateQueries({ queryKey: ['repo-connection', boardId] });
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

      <section className='grid gap-2'>
        <h2 className='text-sm font-semibold'>Repository</h2>
        {connection.data === undefined ? (
          <p className='text-sm text-muted-foreground'>Checking…</p>
        ) : connection.data.repo === null ? (
          <p className='text-sm text-muted-foreground'>No repository set. Add one below (owner/name).</p>
        ) : !connection.data.configured ? (
          <p className='text-sm'>
            slop's GitHub App isn't set up yet. An admin creates it at <a className='underline' href='/setup/github-app'>/setup/github-app</a>.
          </p>
        ) : (
          <div className='flex flex-wrap items-center gap-3 text-sm'>
            <span className='font-mono'>{connection.data.repo}</span>
            {connection.data.connected ? (
              <span className='rounded-sm border border-foreground bg-lcd px-2 py-0.5 font-mono text-xs text-lcd-foreground'>Connected</span>
            ) : (
              <span className='rounded-sm border border-required-border px-2 py-0.5 font-mono text-xs text-required'>Not installed</span>
            )}
            {!connection.data.connected && connection.data.installUrl !== null && (
              <a
                className='rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground'
                href={connection.data.installUrl}
                target='_blank'
                rel='noreferrer'
              >
                Install {connection.data.appName} on GitHub
              </a>
            )}
            <Button variant='ghost' size='sm' onClick={() => void connection.refetch()}>
              Check again
            </Button>
          </div>
        )}
        {connection.data !== undefined && !connection.data.connected && connection.data.configured && connection.data.repo !== null && (
          <p className='text-xs text-muted-foreground'>
            On GitHub, choose the repository's account, then "Only select repositories" and add {connection.data.repo}. This page
            updates when you come back.
          </p>
        )}
      </section>

      <section className='grid gap-3'>
        <h2 className='text-sm font-semibold'>Board</h2>
        <Label>
          Repository (owner/name)
          <Input value={repo} disabled={!admin} onChange={(e) => setRepo(e.target.value)} />
        </Label>
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
                  // An environment without branch deploys can't be the subs' default.
                  setEnvs(
                    envs.map((x, j) =>
                      j !== i
                        ? x
                        : e.target.checked
                          ? { ...x, allowBranchDeploy: true }
                          : { name: x.name, allowBranchDeploy: false },
                    ),
                  )
                }
              />
              branch deploys
            </label>
            <label
              className='flex shrink-0 items-center gap-1 text-xs'
              title='Subs created without an environment get this one'
            >
              <input
                type='checkbox'
                disabled={!admin || !env.allowBranchDeploy}
                checked={env.subDefault === true}
                onChange={(e) =>
                  // At most one default: choosing one clears the others.
                  setEnvs(
                    envs.map((x, j) =>
                      j === i && e.target.checked
                        ? { ...x, subDefault: true }
                        : { name: x.name, allowBranchDeploy: x.allowBranchDeploy },
                    ),
                  )
                }
              />
              default for subs
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
