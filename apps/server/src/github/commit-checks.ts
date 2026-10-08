import type { CheckFailure } from '@slop/core';
import { failureLines, jobOwnLog } from '@slop/core';
import type { Repo } from '../codehost.js';
import { FAILED_CONCLUSIONS } from './merge-state.js';

/** The slice of Octokit's `request` this module uses, so tests can fake GitHub. */
export type Request = (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;

export interface CommitChecks {
  readonly state: 'passed' | 'pending' | 'failed';
  /** The first failing check, explained; null when nothing failed or nothing could be read. */
  readonly failure: CheckFailure | null;
}

interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string | null;
  readonly completed_at: string | null;
  readonly output: { readonly title: string | null; readonly summary: string | null } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const asCheckRun = (value: unknown): CheckRun | null => {
  if (!isRecord(value)) return null;
  const { id, name, status, conclusion, html_url, completed_at, output } = value;
  if (typeof id !== 'number' || typeof name !== 'string' || typeof status !== 'string') return null;
  const out = isRecord(output) ? output : null;
  return {
    id,
    name,
    status,
    conclusion: typeof conclusion === 'string' ? conclusion : null,
    html_url: typeof html_url === 'string' ? html_url : null,
    completed_at: typeof completed_at === 'string' ? completed_at : null,
    output: out === null ? null : { title: typeof out.title === 'string' ? out.title : null, summary: typeof out.summary === 'string' ? out.summary : null },
  };
};

/** How much of a job log is read: errors are at the end. */
const LOG_TAIL_LINES = 60;

/** The step a GitHub Actions job failed on, from the job's steps. */
const failedStep = async (request: Request, repo: Repo, jobId: number): Promise<string | null> => {
  try {
    const { data } = await request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}', { owner: repo.owner, repo: repo.name, job_id: jobId });
    const steps = isRecord(data) && Array.isArray(data.steps) ? data.steps : [];
    for (const step of steps) {
      if (isRecord(step) && typeof step.name === 'string' && typeof step.conclusion === 'string' && FAILED_CONCLUSIONS.has(step.conclusion)) {
        return step.name;
      }
    }
  } catch {
    // Not an Actions job (another app's check): no steps to name.
  }
  return null;
};

/** The last lines of an Actions job's own log (service container output after cleanup is dropped); null when it isn't available (expired, not an Actions job, no access). */
const logTail = async (request: Request, repo: Repo, jobId: number): Promise<string | null> => {
  try {
    const { data } = await request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { owner: repo.owner, repo: repo.name, job_id: jobId });
    return typeof data === 'string' ? jobOwnLog(data).split('\n').slice(-LOG_TAIL_LINES).join('\n') : null;
  } catch {
    return null;
  }
};

/**
 * The state of the checks on a commit and, when one failed, which and why: the check's name, the failed step and the
 * first error lines from the tail of its log (GitHub Actions: a check run's ID is its job's ID), else the run's own
 * output. Explaining a failure is best effort; the state is returned either way.
 */
export const readCommitChecks = async (request: Request, repo: Repo, sha: string): Promise<CommitChecks> => {
  const { data } = await request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    owner: repo.owner,
    repo: repo.name,
    ref: sha,
    filter: 'latest',
    per_page: 100,
  });
  const runs = (isRecord(data) && Array.isArray(data.check_runs) ? data.check_runs : []).flatMap((r: unknown) => {
    const run = asCheckRun(r);
    return run === null ? [] : [run];
  });
  const failed = runs
    .filter((r) => r.status === 'completed' && r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion))
    // The earliest failure is the most likely cause; ties keep GitHub's order.
    .sort((a, b) => (a.completed_at ?? '').localeCompare(b.completed_at ?? ''));
  const first = failed[0];
  if (first === undefined) return { state: runs.some((r) => r.status !== 'completed') ? 'pending' : 'passed', failure: null };

  const [step, tail] = await Promise.all([failedStep(request, repo, first.id), logTail(request, repo, first.id)]);
  const fromOutput = [first.output?.title, first.output?.summary].filter((t): t is string => typeof t === 'string' && t !== '').join('\n');
  const lines = failureLines(tail ?? fromOutput);
  return { state: 'failed', failure: { name: first.name, step, lines, url: first.html_url } };
};
