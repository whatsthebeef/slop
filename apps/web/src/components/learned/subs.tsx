import { SUB_LIMIT_DEFAULT } from '@slop/core';
import type { SubLimitChange } from '@slop/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { JobStatus } from '@/components/job-status';
import { api } from '@/lib/api';
import { newestFirst } from '@/lib/learned';
import { DefaultLine, Explainer, History, LoadFailed, LoadingText, Value } from './panel';

const lines = (n: number) => n.toLocaleString('en');

/** A sub's changed lines; unknown when neither its gate verdict nor its merge commit gave a count. */
const changed = (n: number | null) => (n === null ? 'line count unknown' : `${lines(n)} lines`);

/** Why an outcome moved the limit, in words. */
const outcomeText = (change: Pick<SubLimitChange, 'outcome' | 'changedLines'>): string =>
  change.outcome === 'merged_unchanged'
    ? `Converted for its size (${changed(change.changedLines)}) and merged unchanged`
    : `Passed the gate (${changed(change.changedLines)}) and needed fixes after merging`;

/**
 * The learned sub size limit: nobody sets it (slop moves it with outcomes), so the only admin action is the job's Run now.
 * Every value is rendered as text, including the evidence quotes, which come from labels' checklists and bug reports.
 */
export const SubLimit = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const limit = useQuery({ queryKey: ['sub-limit', boardId], queryFn: () => api.subLimit(boardId) });
  // The job's status (shared with its Run now): a finished run refetches the limit and its history.
  const jobs = useQuery({ queryKey: ['kb-jobs', boardId], queryFn: () => api.boardJobs(boardId) });
  const lastRun = jobs.data === undefined ? undefined : (jobs.data.find((j) => j.job === 'sub_limit')?.lastRunAt ?? null);
  // The run seen when the jobs first loaded: the limit was fetched after it, so only a later run refetches.
  const seenRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastRun === undefined) return;
    if (seenRun.current !== undefined && seenRun.current !== lastRun) void client.invalidateQueries({ queryKey: ['sub-limit', boardId] });
    seenRun.current = lastRun;
  }, [client, boardId, lastRun]);
  if (limit.isError) return <LoadFailed what='the sub size limit' onRetry={() => void limit.refetch()} />;
  if (limit.data === undefined) return <LoadingText what='the sub size limit' />;
  const { current, bounds, history } = limit.data;
  return (
    <div className='grid gap-3' data-testid='sub-limit'>
      <Value>
        A sub that changes more than {lines(current)} lines becomes a same ({current === SUB_LIMIT_DEFAULT ? 'the default' : 'learned from outcomes'}).
      </Value>
      <DefaultLine testId='sub-limit-default'>Default: {lines(SUB_LIMIT_DEFAULT)} lines. Slop moves it with outcomes; nobody sets it by hand.</DefaultLine>
      <Explainer>
        A converted sub that merges unchanged raises the limit; a sub that
        needed fixes after merging (a sign-off label asking for changes, or a bug report blaming it) lowers it. It stays
        between {lines(bounds.min)} and {lines(bounds.max)}. The step starts at {lines(bounds.startStep ?? 500)} lines, grows by half while
        outcomes keep the same direction and halves when one reverses; it is {lines(bounds.step)} now. A small sub that
        needed fixes leaves the limit alone and counts for the risk areas.
      </Explainer>
      <JobStatus boardId={boardId} admin={admin} job='sub_limit' />
      <History testId='sub-limit-history' count={history.length} empty='No outcomes recorded yet.'>
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Limit</th>
              <th className='pr-3 font-normal'>Step</th>
              <th className='pr-3 font-normal'>Why</th>
              <th className='font-normal'>Glob</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst(history).map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3 whitespace-nowrap'>
                  {lines(change.fromLines)} → {lines(change.toLines)}
                </td>
                <td className='pr-3 whitespace-nowrap'>{change.step === undefined ? '' : lines(change.step)}</td>
                <td className='pr-3'>
                  {outcomeText(change)}
                  <span className='block text-muted-foreground'>{change.evidence}</span>
                </td>
                <td>
                  <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(change.globId)}`}>
                    {change.globId}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </History>
    </div>
  );
};
