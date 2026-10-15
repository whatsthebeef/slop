import { JobStatus } from '@/components/job-status';
import { DefaultLine, Explainer, Value } from './panel';

/** The board's self-improvement jobs over its learnings: when each last ran and what it did, with Run now for admins. */
export const KnowledgeJobs = ({ boardId, admin }: { boardId: number; admin: boolean }) => (
  <div className='grid gap-3' data-testid='kb-jobs'>
    <Value>Three jobs keep the board's learnings up to date: mining (weekly), consolidation (weekly) and the effect check (daily).</Value>
    <DefaultLine>Default: they run on their own schedule; Run now starts one early.</DefaultLine>
    <Explainer>
      Each week slop mines its own data for signals worth a learning, merges open learnings that state the same fact (only on
      quotes it checks) and flags stale ones; each day it checks whether approved changes with a signal worked, and proposes
      revising or reverting one that didn't. What they raise shows on the board as decisions.
    </Explainer>
    <JobStatus boardId={boardId} admin={admin} job='mining' />
    <JobStatus boardId={boardId} admin={admin} job='consolidation' />
    <JobStatus boardId={boardId} admin={admin} job='effect_check' />
  </div>
);
