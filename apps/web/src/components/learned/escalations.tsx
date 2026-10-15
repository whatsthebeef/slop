import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { newestFirst } from '@/lib/learned';
import { DefaultLine, Explainer, History, LoadFailed, LoadingText, ResetButton, Value } from './panel';

const STANCE_TEXT = { loosened: 'learned: loosened', default: 'default', strengthened: 'learned: strengthened' } as const;

/**
 * The board's escalation criteria and what slop learned from their outcomes: an escalation approved unchanged loosens
 * its criterion, one that got changes (or a sub that merged and was reverted or blamed) strengthens it. Admins reset
 * the criteria to the defaults; the history stays. Everything is rendered as text.
 */
export const Escalations = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const view = useQuery({ queryKey: ['escalations', boardId], queryFn: () => api.escalations(boardId) });
  const reset = useMutation({
    mutationFn: () => api.resetEscalations(boardId),
    onSuccess: (data) => client.setQueryData(['escalations', boardId], data),
  });
  if (view.isError) return <LoadFailed what='the escalation history' onRetry={() => void view.refetch()} />;
  if (view.data === undefined) return <LoadingText what='the escalation history' />;
  const { criteria, history } = view.data;
  const moved = criteria.filter((c) => c.stance !== 'default').length;
  return (
    <div className='grid gap-3' data-testid='escalations'>
      <Value testId='escalations-value'>
        Agents hand a sub to a person for {criteria.length} {criteria.length === 1 ? 'reason' : 'reasons'}
        {moved === 0 ? ', all still at their default stance' : `; ${moved} ${moved === 1 ? 'has' : 'have'} moved from the default`}.
      </Value>
      <DefaultLine testId='escalations-default'>Default: every criterion starts at its default stance; each outcome below can loosen or strengthen one.</DefaultLine>
      <Explainer>
        Agents escalate a sub to a same when a person should check it. Slop records each escalation and its outcome: approved
        unchanged loosens its criterion; changes asked for, or a revert, strengthens it; a sub that merged unescalated and was
        reverted or blamed by a bug counts against the criterion it should have met. A change of stance is proposed as a
        learning for the agents' guidance.
      </Explainer>
      <ul className='grid gap-1 text-xs'>
        {criteria.map((c) => (
          <li key={c.criterion}>
            <span className='font-medium'>{c.text}</span>{' '}
            <span className='text-muted-foreground'>
              ({STANCE_TEXT[c.stance]}; score {c.score}; unnecessary {c.unnecessary}, justified {c.justified}, missed {c.missed})
            </span>
          </li>
        ))}
      </ul>
      <ResetButton admin={admin} pending={reset.isPending} failed={reset.isError} failure='Could not reset the escalation criteria.' onClick={() => reset.mutate()} />
      <History testId='escalations-history' count={history.length} empty='No escalation outcomes recorded yet.'>
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Criterion</th>
              <th className='pr-3 font-normal'>Outcome</th>
              <th className='font-normal'>Why</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst(history).map((r) => (
              <tr key={r.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(r.at).toLocaleDateString()}</td>
                <td className='pr-3'>{r.outcome === 'reset' ? '' : r.criterion}</td>
                <td className='pr-3 whitespace-nowrap'>{r.outcome}</td>
                <td>
                  {r.cause}
                  {r.globId !== null && (
                    <>
                      {' '}
                      <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(r.globId)}`}>
                        {r.globId}
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
