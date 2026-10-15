import type { DependencyCause } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { newestFirst } from '@/lib/learned';
import { DefaultLine, Explainer, History, LoadFailed, LoadingText, Value } from './panel';

const DEPENDENCY_CAUSE_TEXT: Record<DependencyCause, string> = {
  clean_overlap: 'Globs predicted to share files merged with no conflict or rework',
  conflicted_overlap: 'Globs predicted to share files conflicted or needed a rebase',
  unmerged_prerequisite: 'A run failed because a prerequisite was not merged',
  start_anyway_succeeded: 'A relation was started anyway and merged without it',
  edge_dismissed: 'A person dismissed an inferred relation as wrong',
  reset: 'An admin reset the rule',
};

/**
 * The path patterns the board predicts shared files from (a prediction never holds a start), each with the
 * catalog default and what the board learned from outcomes. Admins reset a rule to its default. Everything is rendered as text.
 */
export const DependencyRules = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const rules = useQuery({ queryKey: ['dependency-rules', boardId], queryFn: () => api.dependencyRules(boardId) });
  const reset = useMutation({
    mutationFn: (pattern: string | undefined) => api.resetDependencyRules(boardId, pattern),
    onSuccess: () => client.invalidateQueries({ queryKey: ['dependency-rules', boardId] }),
  });
  if (rules.isError) return <LoadFailed what='the dependency rules' onRetry={() => void rules.refetch()} />;
  if (rules.data === undefined) return <LoadingText what='the dependency rules' />;
  const { rules: list, history, predictMin } = rules.data;
  const learned = list.filter((r) => r.state === 'learned');
  return (
    <div className='grid gap-3' data-testid='dependency-rules'>
      <Value testId='dependency-rules-value'>
        Slop predicts shared files from {list.length} path {list.length === 1 ? 'pattern' : 'patterns'}
        {learned.length === 0 ? ', all still at their catalog weight' : `; ${learned.length} ${learned.length === 1 ? 'has' : 'have'} been learned away from it`}.
      </Value>
      <DefaultLine testId='dependency-rules-default'>Default: each pattern starts at the weight the catalog gives it (shown beside each learned one).</DefaultLine>
      <Explainer>
        Slop predicts from these path patterns which globs may change the same files, to warn about conflicts and order merges. A
        prediction never holds a glob back: a glob waits for another only through a relation (a need, a decision or a split part).
        A pattern whose predictions merged cleanly is weakened and stops being used below {predictMin}; one that conflicted is
        strengthened. A run that failed for unmerged prerequisites teaches the board a relation.
      </Explainer>
      {list.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No patterns yet: set exclusive paths in the merge policy.</p>
      ) : (
        <ul className='grid gap-1 text-xs'>
          {list.map((rule) => (
            <li key={rule.pattern}>
              <span className='font-mono'>{rule.pattern}</span>{' '}
              <span className='text-muted-foreground'>
                weight {rule.weight} ({rule.state === 'learned' ? `learned, default ${rule.defaultWeight}` : 'default'};{' '}
                {rule.predicted ? 'predicted' : 'not predicted'}; clean {rule.cleanCount}, conflicts {rule.conflictCount})
              </span>
              {admin && rule.state === 'learned' && (
                <Button size='sm' variant='outline' className='ml-2' disabled={reset.isPending} onClick={() => reset.mutate(rule.pattern)}>
                  Reset
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {reset.isError && <span className='text-xs text-red'>Could not reset the rule.</span>}
      <History testId='dependency-rules-history' count={history.length} empty='No changes recorded yet.'>
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Pattern</th>
              <th className='pr-3 font-normal'>Weight</th>
              <th className='font-normal'>Why</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst(history).map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3 font-mono'>{change.pattern}</td>
                <td className='pr-3 whitespace-nowrap'>
                  {change.from} → {change.to}
                </td>
                <td>
                  {DEPENDENCY_CAUSE_TEXT[change.cause]}
                  {change.globId !== null && (
                    <>
                      {' '}
                      <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(change.globId)}`}>
                        {change.globId}
                      </Link>
                    </>
                  )}
                  <span className='block text-muted-foreground'>{change.evidence}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </History>
    </div>
  );
};
