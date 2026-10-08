import type { Deploy } from '@slop/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, RequestError } from '@/lib/api';
import type { BoardView, GlobView } from '@/lib/api';
import { deploysKey, globDeploysKey, globEnvironmentsKey, globTestsKey } from '@/lib/live';
import { useToast } from '@/toast';
import { atfLine } from './glob-card';
import { Tip } from './ui/tip';

const STATE_TEXT: Record<Deploy['state'], string> = {
  waiting: 'queued',
  running: 'deploying',
  succeeded: 'deployed',
  failed: 'failed',
  replaced: 'replaced in the queue',
};

const when = (iso: string | null) => (iso === null ? '' : new Date(iso).toLocaleString());

/** Why Deploy now can't run for this glob, or null when it can. */
const blockedBecause = (board: BoardView, glob: GlobView, running: readonly string[]): string | null => {
  if (board.deploy === null) return 'The board has no deploy integration (Settings)';
  if (glob.environment === null) return 'Choose an environment first';
  if (!board.environments.some((e) => e.name === glob.environment && e.allowBranchDeploy)) {
    return `${glob.environment} doesn't take branch deploys`;
  }
  if (glob.pr?.headSha == null) return 'Nothing pushed yet';
  if (running.includes(glob.environment)) return `A deploy is running in ${glob.environment}; try again when it finishes`;
  return null;
};

/**
 * The glob's deploys in the glob view: Deploy now (any board member, disabled for everyone while a
 * deploy runs in the environment) and a history line per deploy.
 */
export const DeploysSection = ({ board, glob }: { board: BoardView; glob: GlobView }) => {
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const history = useQuery({
    queryKey: globDeploysKey(glob.id),
    queryFn: () => api.globDeploys(glob.id),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((d) => d.state === 'waiting' || d.state === 'running') ? 15_000 : false,
  });
  const state = useQuery({
    queryKey: [...deploysKey(board.id), 'running'],
    queryFn: () => api.boardDeploys(board.id, []),
  });
  const deploys = history.data ?? [];
  if (board.deploy === null && deploys.length === 0) return null;
  const blocked = blockedBecause(board, glob, state.data?.running ?? []);

  const deployNow = async () => {
    setBusy(true);
    try {
      await api.deployNow(glob.id);
      await Promise.all([
        client.invalidateQueries({ queryKey: globDeploysKey(glob.id) }),
        client.invalidateQueries({ queryKey: deploysKey(board.id) }),
      ]);
    } catch (error) {
      toast(error instanceof RequestError ? error.body.message : 'Deploy now failed');
    } finally {
      setBusy(false);
    }
  };

  const button = (
    <Button size='sm' variant='outline' disabled={busy || blocked !== null} onClick={() => void deployNow()}>
      Deploy now
    </Button>
  );

  return (
    <section className='grid gap-2' aria-label='Deploys' data-testid='deploys'>
      <div className='flex items-center gap-2'>
        <h3 className='text-xs font-semibold text-muted-foreground'>Deploys</h3>
        <span className='ml-auto' />
        {blocked === null ? button : <Tip text={blocked}>{button}</Tip>}
      </div>
      {blocked !== null && <p className='text-xs text-muted-foreground'>Deploy now: {blocked}</p>}
      {deploys.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          No deploys yet. Each push deploys to the glob's environment, if it has one.
        </p>
      ) : (
        <ul className='grid gap-1 font-mono text-[11px]'>
          {deploys.map((d) => (
            <li key={d.id} className='flex flex-wrap gap-x-2' data-testid='deploy-row'>
              <span className={d.state === 'failed' ? 'text-red' : d.state === 'succeeded' ? 'text-signal-strong' : ''}>
                {STATE_TEXT[d.state]}
              </span>
              <span>{d.environment}</span>
              <span>{d.sha.slice(0, 7)}</span>
              <span className='text-muted-foreground'>
                {d.trigger === 'push' ? 'push' : `Deploy now by ${d.requestedBy ?? 'someone'}`} · {when(d.finishedAt ?? d.startedAt ?? d.requestedAt)}
              </span>
              {d.url !== null && (
                <a className='underline' href={d.url} target='_blank' rel='noreferrer'>
                  log
                </a>
              )}
              {d.error !== null && <span className='basis-full text-red'>{d.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/**
 * The board's release and integration environments in the glob view: whether each one's deployed commit contains the
 * glob's merge, and what it runs. Independent of branch deploys, so it shows on boards without a deploy integration.
 */
export const EnvironmentsSection = ({ board, glob }: { board: BoardView; glob: GlobView }) => {
  const observed = board.environments.some((e) => e.role !== undefined);
  const query = useQuery({
    queryKey: globEnvironmentsKey(glob.id),
    queryFn: () => api.globEnvironments(glob.id),
    enabled: observed,
  });
  const environments = query.data ?? [];
  // No heading while loading, on an error or against an older API.
  if (!observed || environments.length === 0) return null;
  return (
    <section className='grid gap-2' aria-label='Environments' data-testid='environments'>
      <h3 className='text-xs font-semibold text-muted-foreground'>Environments</h3>
      <ul className='grid gap-1 font-mono text-[11px]'>
        {environments.map((env) => {
          const presence = env.presence;
          const held = presence?.contained === true;
          const warned = held && env.production && glob.status !== 'signed_off';
          return (
            <li key={env.environment} className='flex flex-wrap gap-x-2' data-testid='environment-row'>
              <span>{env.environment}</span>
              <span className='text-muted-foreground'>{env.production ? 'production' : env.role}</span>
              {held ? (
                <span className={warned ? 'text-required' : 'text-signal-strong'}>
                  in it since {when(presence.since)} at {presence.checkedSha.slice(0, 7)}
                  {warned && ' (before sign-off)'}
                </span>
              ) : (
                <span className='text-muted-foreground'>not yet</span>
              )}
              {env.latest !== null && (
                <span className='text-muted-foreground'>
                  runs {env.latest.sha.slice(0, 7)}
                  {env.latest.ref === null ? '' : ` (${env.latest.ref})`} · {when(env.latest.at)}
                </span>
              )}
              {env.latest?.url != null && (
                <a className='underline' href={env.latest.url} target='_blank' rel='noreferrer'>
                  deploy
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/**
 * The glob's ATF runs in the glob view: its branch runs, and the runs against the release and integration commits that
 * hold it. A failure is a flag only. Hidden until there is a run.
 */
export const TestsSection = ({ glob }: { glob: GlobView }) => {
  const query = useQuery({ queryKey: globTestsKey(glob.id), queryFn: () => api.globTests(glob.id) });
  const runs = query.data ?? [];
  if (runs.length === 0) return null;
  return (
    <section className='grid gap-2' aria-label='Tests' data-testid='tests'>
      <h3 className='text-xs font-semibold text-muted-foreground'>Tests</h3>
      <ul className='grid gap-1 font-mono text-[11px]'>
        {runs.map((run, i) => (
          <li key={run.id ?? `${run.scope}:${run.environment ?? ''}:${run.sha}:${run.at}:${String(i)}`} className='flex flex-wrap gap-x-2' data-testid='test-run'>
            <span className={run.failing ? 'text-red' : run.stale === true ? 'text-muted-foreground' : 'text-signal-strong'}>
              ATF {run.failing ? 'failed' : 'passed'}
            </span>
            <span>{atfLine(run)}</span>
            <span className='text-muted-foreground'>{when(run.at)}</span>
            {run.url !== null && (
              <a className='underline' href={run.url} target='_blank' rel='noreferrer'>
                report
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
