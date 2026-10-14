import type { MachineStep } from '@slop/core';
import type { GlobView } from './api';
import { stepLabel } from './position';

/** Who or what an activity entry is about, which picks its icon. */
export type ActivityActor = 'machine' | 'human' | 'github' | 'warn';

/** One line of the glob view's Activity log. */
export interface ActivityEntry {
  readonly id: string;
  readonly actor: ActivityActor;
  readonly text: string;
  /** When it happened; null where slop doesn't record the time (the PR's own state). */
  readonly at: string | null;
  readonly link: string | null;
  /** What the link is called: "open", "CI run", "session", "PR", "glob". */
  readonly linkLabel: string;
  /** The entry's full text for its tooltip, where the line cuts it short (a failure's reason). */
  readonly title: string;
  /** How many consecutive identical events this entry stands for. */
  readonly count: number;
}

/** The entries shown before "Show all". */
export const ACTIVITY_SHOWN = 8;
/** Longest a reason gets on its line; the entry's tooltip has all of it. */
const LINE_MAX = 80;

const short = (sha: string): string => sha.slice(0, 7);

const entry = (
  id: string,
  actor: ActivityActor,
  text: string,
  at: string | null,
  link: string | null = null,
  linkLabel = 'open',
  title = text,
): ActivityEntry => ({ id, actor, text, at, link, linkLabel, title, count: 1 });

/** A reason on one line: its first line, cut at `LINE_MAX`. */
const oneLine = (reason: string): string => {
  const first = (reason.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  return first.length > LINE_MAX ? `${first.slice(0, LINE_MAX - 1)}…` : first;
};

/** Consecutive entries with the same text (newest first) become one with a count: "checks failed ×3". */
const collapse = (entries: readonly ActivityEntry[]): ActivityEntry[] => {
  const out: ActivityEntry[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last !== undefined && last.text === e.text && last.actor === e.actor) {
      out[out.length - 1] = { ...last, count: last.count + 1 };
    } else out.push(e);
  }
  return out;
};

/**
 * The events that explain a glob, newest first, one line each, derived from what the glob view already carries (runs, the PR,
 * the head's checks, the conflict, the failure, the escalation, human steps). No new table: routine noise (version bumps,
 * provisioning retries, hint refreshes) never reaches it. Entries without a time (the PR's state) sort by `updatedAt`.
 */
export const activityOf = (glob: GlobView, repo: string | null, steps: readonly MachineStep[] = []): ActivityEntry[] => {
  const github = (path: string): string | null => (repo === null ? null : `https://github.com/${repo}/${path}`);
  const out: ActivityEntry[] = [];

  for (const run of glob.runs) {
    const what =
      run.purpose === 'investigate' ? 'Investigation' : run.purpose === 'resolve_conflict' ? 'Conflict fix' : 'Run';
    out.push(entry(`run:${run.id}:start`, 'machine', `${what} started`, run.startedAt ?? run.queuedAt, run.sessionUrl, 'session'));
    if (run.state === 'ended') {
      const failed = run.outcome === 'failed';
      // The glob's own failure is pinned in full above the feed, so a run that failed with the same reason doesn't repeat it.
      const reason = failed && run.failureReason !== glob.failure?.reason ? run.failureReason : null;
      out.push(
        entry(
          `run:${run.id}:end`,
          failed ? 'warn' : 'machine',
          failed ? `${what} failed${reason === null || reason === '' ? '' : `: ${oneLine(reason)}`}` : `${what} ${run.outcome ?? 'ended'}`,
          run.endedAt ?? run.lastProgressAt,
          run.sessionUrl,
          'session',
          reason === null || reason === '' ? `${what} failed` : `${what} failed: ${reason}`,
        ),
      );
    } else if (run.state === 'watching') {
      out.push(entry(`run:${run.id}:standby`, 'machine', `${what} on standby`, run.lastProgressAt ?? run.startedAt, run.sessionUrl, 'session'));
    }
  }

  const checks = glob.headChecks;
  if (checks !== null && checks.state !== 'pending') {
    const failure = checks.failure;
    out.push(
      entry(
        `checks:${checks.sha}:${checks.state}`,
        checks.state === 'failed' ? 'warn' : 'github',
        `Checks ${checks.state} on ${short(checks.sha)}`,
        checks.at ?? glob.updatedAt,
        failure?.url ?? null,
        'CI run',
        failure === undefined
          ? undefined
          : [`Checks ${checks.state} on ${short(checks.sha)}`, failure.step === null ? failure.name : `${failure.name} · ${failure.step}`, ...failure.lines].join('\n'),
      ),
    );
  }

  const conflict = glob.conflict;
  if (conflict != null) {
    out.push(
      entry(
        'conflict',
        'warn',
        `Conflict with ${conflict.base}${conflict.since === null ? '' : ` after ${conflict.since}`}`,
        conflict.at,
        conflict.since === null ? null : `/boards/${String(glob.boardId)}?glob=${encodeURIComponent(conflict.since)}`,
        'glob',
        [`Conflict with ${conflict.base}`, ...conflict.files].join('\n'),
      ),
    );
  }

  // The glob's own failure is pinned at the top of the log in full, so the feed doesn't repeat it.

  // The escalation has its own chip and disclosure, so the feed doesn't repeat its reason.

  const pr = glob.pr;
  if (pr !== null) {
    const state = pr.state === 'ready' ? 'ready for review' : pr.state;
    out.push(
      entry(
        `pr:${String(pr.number)}:${pr.state}`,
        'github',
        `PR #${String(pr.number)} ${state}${glob.branch === '' ? '' : ` · ${glob.branch}`}`,
        glob.updatedAt,
        github(`pull/${String(pr.number)}`),
        'PR',
      ),
    );
  }
  for (const p of glob.prs) {
    out.push(entry(`pr:${String(p.number)}:merged`, 'github', `PR #${String(p.number)} merged · ${short(p.mergeSha)}`, p.mergedAt, github(`pull/${String(p.number)}`), 'PR'));
  }

  for (const step of glob.humanSteps ?? []) {
    if (step.state === 'done' && step.doneAt != null) {
      out.push(entry(`step:${step.id}:done`, 'human', `${step.doneBy ?? 'Someone'} did: ${step.title}`, step.doneAt, null));
    }
  }

  // Machine steps are ordinary entries: "fixing CI · running", "creating the branch · queued".
  for (const step of steps) {
    if (step.state === 'done') continue;
    const link = step.detail !== null && /^https?:\/\//.test(step.detail) ? step.detail : null;
    const reason = step.state === 'failed' && step.detail !== null && link === null && step.detail !== glob.failure?.reason ? step.detail : null;
    out.push(
      entry(
        `step:${step.id}`,
        step.state === 'failed' ? 'warn' : 'machine',
        `${stepLabel(step)} · ${step.state}${reason === null ? '' : `: ${oneLine(reason)}`}`,
        step.startedAt ?? step.lastProgressAt,
        link,
        link !== null && /\/actions\/|\/runs?\//.test(link) ? 'CI run' : link !== null && link.includes('claude.ai') ? 'session' : 'open',
        reason === null ? undefined : `${stepLabel(step)} · ${step.state}: ${reason}`,
      ),
    );
  }

  if (glob.signedOffAt !== null) out.push(entry('signed-off', 'human', 'Signed off', glob.signedOffAt));
  out.push(entry('created', 'human', `Planned by ${glob.planner} · ${new Date(glob.createdAt).toLocaleString()}`, glob.createdAt));

  const time = (e: ActivityEntry): number => Date.parse(e.at ?? glob.updatedAt);
  out.sort((a, b) => time(b) - time(a));
  return collapse(out);
};
