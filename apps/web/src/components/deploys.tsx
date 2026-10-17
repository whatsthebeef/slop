import { deploys as deployRules } from '@slop/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { DeployView, GlobSpecResult, GlobView } from '@/lib/api';
import { globPath } from '@/lib/glob-section';
import { globDeploysKey, globTestsKey } from '@/lib/live';
import { atfLine } from './glob-card';

const STATE_TEXT: Record<DeployView['state'], string> = {
  waiting: 'queued',
  running: 'deploying',
  succeeded: 'deployed',
  failed: 'failed',
  replaced: 'replaced in the queue',
};

const when = (iso: string | null) => (iso === null ? '' : new Date(iso).toLocaleString());

/**
 * The glob's deploy history in the glob view: a compact list, collapsed by default. Nothing when the glob has no deploys
 * (every push deploys to the glob's environment on its own).
 */
export const DeploysSection = ({ glob }: { glob: GlobView }) => {
  const history = useQuery({
    queryKey: globDeploysKey(glob.id),
    queryFn: () => api.globDeploys(glob.id),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((d) => d.state === 'waiting' || d.state === 'running') ? 15_000 : false,
  });
  const deploys = history.data ?? [];
  if (deploys.length === 0) return null;

  return (
    <section className='grid gap-2' aria-label='Deploys' data-testid='deploys'>
      <details>
        <summary className='cursor-pointer text-xs font-semibold text-muted-foreground'>Deploys ({deploys.length})</summary>
        <ul className='mt-2 grid gap-1 font-mono text-[11px]'>
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
              {(d.logUrl ?? d.url) != null && (
                <a className='underline' href={d.logUrl ?? d.url ?? undefined} target='_blank' rel='noreferrer'>
                  log
                </a>
              )}
              {/* A finished build with a log link has its attachment on the glob (the last lines too, when it failed). */}
              {d.logUrl != null && (d.state === 'succeeded' || d.state === 'failed') && (
                <Link
                  className='underline'
                  to={globPath(glob.boardId, glob.id, { section: 'artifacts', artifact: 'attachment', label: deployRules.buildLogLabel(d) })}
                  data-testid='deploy-build-log'
                >
                  build log
                </Link>
              )}
              {d.error !== null && <span className='basis-full text-red'>{d.error}</span>}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
};

/** One planned spec's latest result, in words and a tone. A spec nothing has reported says so rather than showing as passed. */
const specResult = (r: GlobSpecResult): { text: string; tone: string } => {
  switch (r.status) {
    case 'passed':
      return { text: 'passed', tone: 'text-signal-strong' };
    case 'failed':
      return { text: 'failed', tone: 'text-red' };
    case 'skipped':
      return { text: 'skipped', tone: 'text-muted-foreground' };
    case 'missing':
      return { text: 'missing (not found at run time)', tone: 'text-required' };
    case null:
      return { text: 'no result yet', tone: 'text-muted-foreground' };
  }
};

/**
 * The glob's ATF in the glob view: each spec its test plan lists with the latest result and a link to the run, then its
 * branch runs and the runs against the release and integration commits that hold it. A failure is a flag only. Hidden
 * until there is a run or a planned spec.
 */
export const TestsSection = ({ glob }: { glob: GlobView }) => {
  // Under the runs-only key's prefix, so the same live invalidation reaches it.
  const query = useQuery({ queryKey: [...globTestsKey(glob.id), 'view'], queryFn: () => api.globTestsView(glob.id) });
  const runs = query.data?.value ?? [];
  const specs = query.data?.specs ?? [];
  if (runs.length === 0 && specs.length === 0) return null;
  return (
    <section className='grid gap-2' aria-label='Tests' data-testid='tests'>
      <h3 className='text-xs font-semibold text-muted-foreground'>Tests</h3>
      {specs.length > 0 && (
        <ul className='grid gap-1 font-mono text-[11px]' aria-label='Planned specs' data-testid='spec-results'>
          {specs.map((r) => {
            const result = specResult(r);
            return (
              <li key={r.spec} className='flex flex-wrap gap-x-2' data-testid='spec-result' data-status={r.status ?? 'none'}>
                <span className='break-all'>{r.spec}</span>
                <span className={result.tone}>{result.text}</span>
                {r.at != null && <span className='text-muted-foreground'>{when(r.at)}</span>}
                {r.url != null && (
                  <a className='underline' href={r.url} target='_blank' rel='noreferrer'>
                    run
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
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
