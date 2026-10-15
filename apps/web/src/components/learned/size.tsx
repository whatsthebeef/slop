import type { SizeOutcome } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { JobStatus } from '@/components/job-status';
import { api } from '@/lib/api';
import { newestFirst } from '@/lib/learned';
import { DefaultLine, Explainer, History, LoadFailed, LoadingText, PanelPart, ResetButton, Value } from './panel';

const SIZE_OUTCOME_TEXT: Partial<Record<SizeOutcome, string>> = {
  kept_whole_clean: 'Flagged and merged cleanly: raised',
  unflagged_struggled: 'Not flagged, and it struggled: lowered',
  flag_confirmed: 'Flag confirmed: unchanged',
  fanout_helped: 'Fanned out and merged cleanly: fan-out floor lowered',
  fanout_stalled: 'Fanned out and stalled or conflicted: fan-out floor raised',
  reset: 'Reset to the defaults',
};

/** The learned size threshold (oversized flag), with its default and history. Evidence is rendered as text. */
const SizeThreshold = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const threshold = useQuery({ queryKey: ['size-threshold', boardId], queryFn: () => api.sizeThreshold(boardId) });
  const reset = useMutation({
    mutationFn: () => api.resetSizeThreshold(boardId),
    onSuccess: (view) => client.setQueryData(['size-threshold', boardId], view),
  });
  const jobs = useQuery({ queryKey: ['kb-jobs', boardId], queryFn: () => api.boardJobs(boardId) });
  const lastRun = jobs.data === undefined ? undefined : (jobs.data.find((j) => j.job === 'size_threshold')?.lastRunAt ?? null);
  const seenRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastRun === undefined) return;
    if (seenRun.current !== undefined && seenRun.current !== lastRun) void client.invalidateQueries({ queryKey: ['size-threshold', boardId] });
    seenRun.current = lastRun;
  }, [client, boardId, lastRun]);
  if (threshold.isError) return <LoadFailed what='the size threshold' onRetry={() => void threshold.refetch()} />;
  if (threshold.data === undefined) return <LoadingText what='the size threshold' />;
  const { current, defaults, bounds, history } = threshold.data;
  const learned = defaults.maxTasks !== current.maxTasks || defaults.maxParts !== current.maxParts || defaults.minParallel !== current.minParallel;
  return (
    <PanelPart title='When a glob is flagged as big' testId='size-threshold'>
      <Value>
        A glob is flagged as big above {current.maxTasks} tasks or {current.maxParts} independent parts, when at least {current.minParallel} could be built at once (
        {learned ? 'learned from outcomes' : 'the default'}).
      </Value>
      <Explainer testId='size-threshold-forecast'>
        Judged from the code (the forecast), the part limit is {Math.max(current.maxParts, 3)} or more separate modules, and only when at least {current.minParallel} of them can be built at the same time.
      </Explainer>
      <DefaultLine testId='size-threshold-defaults'>
        Default: {defaults.maxTasks} tasks, {defaults.maxParts} independent parts, fan-out from {defaults.minParallel} parallel. Learned: {current.maxTasks} tasks, {current.maxParts} independent parts, fan-out from {current.minParallel} parallel.
      </DefaultLine>
      <ResetButton admin={admin} show={learned} pending={reset.isPending} failed={reset.isError} failure='Could not reset the size threshold.' onClick={() => reset.mutate()} />
      <Explainer>
        Intake flags a glob above it, and only when at least {current.minParallel} of its parts could be built at the same time (a long serial plan stays whole), and
        advises with its size workstreams and critical path. A flagged glob that merges cleanly without fanning out raises the threshold. A glob that fans out and merges cleanly lowers the fan-out floor (the parallel parts it takes to flag and fan out); one whose workstreams fail, are retried or conflict, or that otherwise struggles, raises it. An unflagged glob that struggles (the most review rounds, a failed run or a very long PR) lowers it.
        Tasks stay between {bounds.tasks.min} and {bounds.tasks.max}, parts between {bounds.parts.min} and {bounds.parts.max}, fan-out floor between {bounds.parallel.min} and {bounds.parallel.max}, in steps of {bounds.step}.
      </Explainer>
      <JobStatus boardId={boardId} admin={admin} job='size_threshold' />
      <History testId='size-threshold-history' count={history.length} empty='No outcomes recorded yet.'>
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Tasks / parts / parallel</th>
              <th className='pr-3 font-normal'>Why</th>
              <th className='font-normal'>Glob</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst(history).map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3 whitespace-nowrap'>
                  {change.from.maxTasks} / {change.from.maxParts} / {change.from.minParallel} → {change.to.maxTasks} / {change.to.maxParts} / {change.to.minParallel}
                </td>
                <td className='pr-3'>
                  {SIZE_OUTCOME_TEXT[change.outcome] ?? 'Earlier outcome (no longer recorded)'}
                  <span className='block text-muted-foreground'>{change.evidence}</span>
                </td>
                <td>
                  {change.outcome === 'reset' ? null : (
                    <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(change.globId)}`}>
                      {change.globId}
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </History>
    </PanelPart>
  );
};

/** The size forecast's calibration: learned values against the defaults, with the history and its causes as text. */
const SizeCalibrationView = ({ boardId }: { boardId: number }) => {
  const calibration = useQuery({ queryKey: ['size-calibration', boardId], queryFn: () => api.sizeCalibration(boardId) });
  if (calibration.isError) return <LoadFailed what='the size calibration' onRetry={() => void calibration.refetch()} />;
  if (calibration.data === undefined) return <LoadingText what='the size calibration' />;
  const { current, defaults, history } = calibration.data;
  const areas = Object.entries(current.areaFactors);
  const defaultFactor = (area: string): number => Object.entries(defaults.areaFactors).find(([name]) => name === area)?.[1] ?? 1;
  const learned = (now: number, start: number) => (now === start ? 'default' : `learned, default ${start}`);
  return (
    <PanelPart title='How the size forecast is calibrated' testId='size-calibration'>
      <Value>
        The forecast weighs the code {current.weights.code}, similar past globs {current.weights.reference} and the plan text {current.weights.text}, learned from {current.samples} merged globs.
      </Value>
      <DefaultLine>
        Default weights: code {defaults.weights.code}, similar globs {defaults.weights.reference}, text {defaults.weights.text}; every area's factor starts at 1.
      </DefaultLine>
      <Explainer>
        The forecast blends three signals: the code, similar past globs and the plan text. Merged globs move the weights toward the signal that was closest
        and each area's factor toward the lines the area really took.
      </Explainer>
      <ul className='text-xs'>
        <li>
          Code weight {current.weights.code} ({learned(current.weights.code, defaults.weights.code)})
        </li>
        <li>
          Similar globs weight {current.weights.reference} ({learned(current.weights.reference, defaults.weights.reference)})
        </li>
        <li>
          Text weight {current.weights.text} ({learned(current.weights.text, defaults.weights.text)})
        </li>
        {areas.length === 0 ? (
          <li className='text-muted-foreground'>No area corrections yet.</li>
        ) : (
          areas.map(([area, factor]) => (
            <li key={area}>
              {area} lines x{factor} ({learned(factor, defaultFactor(area))})
            </li>
          ))
        )}
      </ul>
      <History testId='size-calibration-history' count={history.length} empty='No calibration moves recorded yet.'>
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>What</th>
              <th className='pr-3 font-normal'>Why</th>
              <th className='font-normal'>Glob</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst(history).map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3 whitespace-nowrap'>{change.kind === 'weights' ? 'weights' : `${change.area ?? 'area'} factor`}</td>
                <td className='pr-3'>{change.cause}</td>
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
    </PanelPart>
  );
};

/** The Size panel's body: the threshold that flags a glob as big, and the forecast's calibration. */
export const SizePanel = ({ boardId, admin }: { boardId: number; admin: boolean }) => (
  <>
    <SizeThreshold boardId={boardId} admin={admin} />
    <SizeCalibrationView boardId={boardId} />
  </>
);
