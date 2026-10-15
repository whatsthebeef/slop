import type { RiskAreaCause } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { newestFirst } from '@/lib/learned';
import { DefaultLine, Explainer, History, LoadFailed, LoadingText, ResetButton, Value } from './panel';

const RISK_CAUSE_TEXT: Record<RiskAreaCause, string> = {
  reverted: 'A sub that changed it was reverted',
  bug: 'A bug blamed a sub that changed it',
  deploy_failed: 'A deploy failed after a sub changed it',
  blocked: 'A person blocked a sub that changed it at auto-merge',
  small_fix: 'A small sub that changed it needed fixes',
  clean: 'Subs that changed it were clean',
  type_to_same: 'A person changed intake\'s sub to same',
  type_to_sub: 'A person changed intake\'s same to sub',
  reset: 'An admin reset or removed areas',
  cleanup: 'Slop dropped it: too wide, or fewer than two globs of evidence',
};

/**
 * The board's risk areas: work that intake sends to a person's review (type same). Defaults and learned ones, with the
 * history of what changed them and why. Admins reset them to the defaults. Everything is rendered as text.
 */
export const RiskAreas = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const areas = useQuery({ queryKey: ['risk-areas', boardId], queryFn: () => api.riskAreas(boardId) });
  const reset = useMutation({
    mutationFn: () => api.resetRiskAreas(boardId),
    onSuccess: (view) => client.setQueryData(['risk-areas', boardId], view),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.removeRiskArea(boardId, name),
    onSuccess: (view) => client.setQueryData(['risk-areas', boardId], view),
  });
  if (areas.isError) return <LoadFailed what='the risk areas' onRetry={() => void areas.refetch()} />;
  if (areas.data === undefined) return <LoadingText what='the risk areas' />;
  const { areas: list, history } = areas.data;
  const learnedCount = list.filter((a) => a.source === 'learned').length;
  const defaultNames = list.filter((a) => a.source !== 'learned').map((a) => a.name);
  return (
    <div className='grid gap-3' data-testid='risk-areas'>
      <Value testId='risk-areas-value'>
        Intake sends work to a person's review when it touches one of {list.length} {list.length === 1 ? 'area' : 'areas'}
        {learnedCount === 0 ? ' (all defaults)' : ` (${learnedCount} learned from outcomes)`}.
      </Value>
      <DefaultLine testId='risk-areas-default'>
        Default areas: {defaultNames.length === 0 ? 'none are left' : defaultNames.join(', ')}.
      </DefaultLine>
      <Explainer>
        Intake chooses sub unless the work matches one of these areas (or is beyond the sub size). Slop adds an area when a
        sub that changed those paths was reverted, blamed by a bug, failed a deploy or needed fixes while small, or when a
        person changes intake's type, but only for a narrow module or file and only after two separate globs show it. Repeated clean subs remove a learned area.
      </Explainer>
      <ul className='grid gap-1 text-xs'>
        {list.map((area) => (
          <li key={area.name}>
            <span className='font-medium'>{area.name}</span>{' '}
            <span className='text-muted-foreground'>
              ({area.source}
              {area.subSafe ? ', recent subs were clean' : ''}; strength {area.strength}, clean {area.cleanCount})
            </span>
            <span className='block text-muted-foreground'>{area.pathPatterns.join(', ')}</span>
            <span className='block text-muted-foreground'>{area.why}</span>
            {area.source === 'learned' && (
              <span className='block text-muted-foreground'>
                Evidence:{' '}
                {area.evidence.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ', '}
                    <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(id)}`}>
                      {id}
                    </Link>
                  </span>
                ))}
                {admin && (
                  <Button size='sm' variant='outline' className='ml-2' disabled={remove.isPending} onClick={() => remove.mutate(area.name)}>
                    Remove
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <ResetButton admin={admin} pending={reset.isPending} failed={reset.isError} failure='Could not reset the risk areas.' onClick={() => reset.mutate()} />
      <History testId='risk-areas-history' count={history.length} empty='No changes recorded yet.'>
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Area</th>
              <th className='pr-3 font-normal'>Change</th>
              <th className='font-normal'>Why</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst(history).map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3'>{change.areaName ?? 'no known paths'}</td>
                <td className='pr-3 whitespace-nowrap'>{change.kind}</td>
                <td>
                  {RISK_CAUSE_TEXT[change.cause]}
                  {change.globId !== null && (
                    <>
                      {' '}
                      <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(change.globId)}`}>
                        {change.globId}
                      </Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </History>
    </div>
  );
};
