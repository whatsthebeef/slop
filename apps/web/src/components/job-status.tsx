import { failedRetryMs } from '@slop/core';
import type { BoardJobResult, BoardJobStatus } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { api, RequestError } from '@/lib/api';
import { invalidateKnowledge } from '@/lib/live';
import { useToast } from '@/toast';

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

const message = (error: unknown) => (error instanceof RequestError ? error.body.message : 'Something went wrong');

/** The fallback poll while a job runs; hints normally refresh the list (as the board's deploy poll). */
const JOB_POLL_MS = 15_000;

/** Whether a board job's lease is held (it is running on a server now), as the server worked it out. */
export const isJobRunning = (job: BoardJobStatus | undefined): boolean => job?.running ?? false;

/** A job's last run in a few words. */
export const jobSummary = (result: BoardJobResult): string => {
  switch (result.kind) {
    case 'failed':
      // The next try backs off with each failure in a row (`failedRetryMs`); a failure recorded before the backoff
      // has no time and waits for the weekly run.
      return result.at === undefined
        ? `the last run failed: ${result.error}`
        : `the last run failed: ${result.error}; it tries again after ${when(
            new Date(Date.parse(result.at) + failedRetryMs(result.failures ?? 1)).toISOString(),
          )}`;
    case 'skipped':
      return `waiting: ${result.reason}; it tries again within the hour`;
    case 'mining':
      return `${result.measured} signals measured, ${result.raised.length} raised`;
    case 'sub_limit': {
      const moved = result.changes.filter((c) => c.from !== c.to).length;
      return `limit ${result.limit.toLocaleString('en')} lines, ${result.changes.length} outcomes recorded (${moved} moved it)${result.waiting > 0 ? `, ${result.waiting} waiting` : ''}${(result.gaveUp ?? 0) > 0 ? `, ${result.gaveUp} bug references skipped without a usable answer` : ''}`;
    }
    case 'size_threshold': {
      const moved = result.changes.filter((c) => c.from.maxTasks !== c.to.maxTasks || c.from.maxParts !== c.to.maxParts).length;
      return `threshold ${result.threshold.maxTasks} tasks or ${result.threshold.maxParts} parts, ${result.changes.length} outcomes recorded (${moved} moved it)`;
    }
    case 'context_tuning':
      return `${result.moves.length} ${result.moves.length === 1 ? 'setting' : 'settings'} moved, ${result.held} left as they were`;
    case 'hotspots':
      return `${result.hot} conflict ${result.hot === 1 ? 'hotspot' : 'hotspots'}`;
    case 'intake_outcome':
      return `${result.recorded} outcomes recorded, ${result.refreshed} refreshed${result.backfilled > 0 ? `, ${result.backfilled} snapshots backfilled` : ''}`;
    case 'effect_check':
      return `${result.watching} watching, ${result.decided.length} decided, ${result.raised.length} revise-or-revert items raised`;
    case 'consolidation': {
      const checked = result.alreadyChecked ?? 0;
      // No candidate-pair call: nothing new to compare since the last run, not a search that found nothing.
      if (result.unchanged === true)
        return `candidates unchanged since the last run${checked > 0 ? ` (${checked} pairs already checked)` : ''}, ${result.flaggedStale} flagged stale`;
      return `${result.proposed} pairs proposed${checked > 0 ? ` (${checked} already checked)` : ''}, ${result.merged.length} merged, ${result.flaggedStale} flagged stale`;
    }
  }
};

export type JobName = 'mining' | 'consolidation' | 'effect_check' | 'sub_limit' | 'intake_outcome' | 'size_threshold' | 'context_tuning' | 'hotspots';

export const JOB_LABELS: Record<JobName, { title: string; name: string }> = {
  mining: { title: 'Mined weekly', name: 'Mining' },
  consolidation: { title: 'Consolidated weekly', name: 'Consolidation' },
  effect_check: { title: 'Effect checks daily', name: 'The effect check' },
  sub_limit: { title: 'Learned hourly', name: 'Sub-limit learning' },
  intake_outcome: { title: 'Recorded hourly', name: 'Intake outcomes' },
  size_threshold: { title: 'Learned hourly', name: 'Size-threshold learning' },
  context_tuning: { title: 'Tuned weekly', name: 'Context tuning' },
  hotspots: { title: 'Checked hourly', name: 'Hotspot detection' },
};

/**
 * A board job (weekly mining or consolidation, daily effect checks, the hourly sub limit): when it last ran and what it did, or that it is running, with Run now for
 * admins. Run now starts the job and returns; the `board.kb` hint, reconnects and a slow poll while it runs show the
 * result. The jobs share one query (the board's job list).
 */
export const JobStatus = ({ boardId, admin, job }: { boardId: number; admin: boolean; job: JobName }) => {
  const client = useQueryClient();
  const toast = useToast();
  const { title, name } = JOB_LABELS[job];
  const jobs = useQuery({
    queryKey: ['kb-jobs', boardId],
    queryFn: () => api.boardJobs(boardId),
    refetchInterval: (query) => (query.state.data?.some(isJobRunning) === true ? JOB_POLL_MS : false),
  });
  const run = useMutation({
    mutationFn: () => api.runBoardJob(boardId, job),
    onSuccess: () => {
      toast(`${name} started: the results show here when it is done`);
      invalidateKnowledge(client, boardId);
    },
    onError: (e) => {
      // Someone else's run (another admin, or the weekly one) holds the lease: not a failure.
      if (e instanceof RequestError && e.body.code === 'run_active') {
        toast(`${name} is already running`);
        invalidateKnowledge(client, boardId);
      } else toast(message(e));
    },
  });
  const status = jobs.data?.find((j) => j.job === job);
  const running = isJobRunning(status);
  const leaseEnds = running ? (status?.runningUntil ?? null) : null;
  // A run whose server died holds its lease until it expires: refetch then, so the badge clears.
  useEffect(() => {
    if (leaseEnds === null) return;
    const timer = setTimeout(
      () => void client.invalidateQueries({ queryKey: ['kb-jobs', boardId] }),
      Math.max(0, Date.parse(leaseEnds) - Date.now()) + 1000,
    );
    return () => clearTimeout(timer);
  }, [client, boardId, leaseEnds]);
  const result = status?.lastResult ?? null;
  const last =
    status === undefined || result === null
      ? 'not run yet'
      : result.kind === 'failed' || result.kind === 'skipped'
        ? jobSummary(result)
        : `last run ${when(status.lastRunAt)}: ${jobSummary(result)}`;
  return (
    <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground' data-testid={`${job}-status`}>
      <span>
        {title} · {running ? 'running now…' : last}
      </span>
      {admin && (
        <Button size='sm' variant='outline' disabled={run.isPending || running} onClick={() => run.mutate()}>
          {run.isPending || running ? 'Running…' : 'Run now'}
        </Button>
      )}
    </div>
  );
};
