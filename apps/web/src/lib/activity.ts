import type { GlobView } from './api';

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
  /** Lines shown when the entry is expanded (a failure's first lines, a run's reason); at most `EXPAND_LINES`. */
  readonly more: readonly string[];
  /** How many consecutive identical events this entry stands for. */
  readonly count: number;
}

/** The entries shown before "Show all". */
export const ACTIVITY_SHOWN = 8;
const EXPAND_LINES = 5;

const short = (sha: string): string => sha.slice(0, 7);

const entry = (
  id: string,
  actor: ActivityActor,
  text: string,
  at: string | null,
  link: string | null = null,
  more: readonly string[] = [],
): ActivityEntry => ({ id, actor, text, at, link, more: more.slice(0, EXPAND_LINES), count: 1 });

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
export const activityOf = (glob: GlobView, repo: string | null): ActivityEntry[] => {
  const github = (path: string): string | null => (repo === null ? null : `https://github.com/${repo}/${path}`);
  const out: ActivityEntry[] = [];

  for (const run of glob.runs) {
    const what =
      run.purpose === 'investigate' ? 'Investigation' : run.purpose === 'resolve_conflict' ? 'Conflict fix' : 'Run';
    out.push(entry(`run:${run.id}:start`, 'machine', `${what} started`, run.startedAt ?? run.queuedAt, run.sessionUrl));
    if (run.state === 'ended') {
      const failed = run.outcome === 'failed';
      out.push(
        entry(
          `run:${run.id}:end`,
          failed ? 'warn' : 'machine',
          failed ? `${what} failed` : `${what} ${run.outcome ?? 'ended'}`,
          run.endedAt ?? run.lastProgressAt,
          run.sessionUrl,
          failed && run.failureReason !== null ? run.failureReason.split('\n') : [],
        ),
      );
    } else if (run.state === 'watching') {
      out.push(entry(`run:${run.id}:standby`, 'machine', `${what} on standby`, run.lastProgressAt ?? run.startedAt, run.sessionUrl));
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
        failure === undefined ? [] : [failure.step === null ? failure.name : `${failure.name} · ${failure.step}`, ...failure.lines],
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
        conflict.files,
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
      ),
    );
  }
  for (const p of glob.prs) {
    out.push(entry(`pr:${String(p.number)}:merged`, 'github', `PR #${String(p.number)} merged · ${short(p.mergeSha)}`, p.mergedAt, github(`pull/${String(p.number)}`)));
  }

  for (const step of glob.humanSteps ?? []) {
    if (step.state === 'done' && step.doneAt != null) {
      out.push(entry(`step:${step.id}:done`, 'human', `${step.doneBy ?? 'Someone'} did: ${step.title}`, step.doneAt, null));
    }
  }

  if (glob.signedOffAt !== null) out.push(entry('signed-off', 'human', 'Signed off', glob.signedOffAt));
  out.push(entry('created', 'human', `Created by ${glob.creator}`, glob.createdAt));

  const time = (e: ActivityEntry): number => Date.parse(e.at ?? glob.updatedAt);
  out.sort((a, b) => time(b) - time(a));
  return collapse(out);
};
