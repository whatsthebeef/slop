import type { MachineStep } from '../machine-steps.js';
import type { PresentableGlob } from './facts.js';
import { stripMarkdown, stripMarkdownLines } from './text.js';
import { firstNameOf } from './text.js';
import { stepLabel } from './position.js';
import { actionPresentation } from './action-presentation.js';
import { PENDING_TIMEOUT_MS, pendingTimedOut } from '../pending-action.js';

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
  /** The sstor command the routine owner copies to carry on the run's conversation locally; null on every other entry. */
  readonly command: string | null;
}

/** What Continue locally does, for its tooltip. */
export const CONTINUE_LOCALLY_TITLE =
  "Picks the glob up and carries on this run's conversation in your terminal (claude --teleport). The cloud run stops.";

/** Whether the viewer owns the routine of a run with a cloud session, so they can carry its conversation on locally. */
export const canContinueLocally = (
  run: { state: string; sessionUrl: string | null; routineOwner: string } | null | undefined,
  email: string | undefined,
): boolean =>
  run != null &&
  run.state !== 'ended' &&
  run.sessionUrl !== null &&
  email !== undefined &&
  run.routineOwner.toLowerCase() === email.toLowerCase();

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
): ActivityEntry => ({
  id,
  actor,
  text: stripMarkdown(text),
  at,
  link,
  linkLabel,
  title: stripMarkdownLines(title),
  count: 1,
  command: null,
});

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

/** When the glob's last run ended or last made progress, else when it was created: the nearest real time for what the PR's own state does not carry. */
const lastRunAt = (glob: PresentableGlob): string => {
  const run = glob.runs.at(-1);
  return run?.endedAt ?? run?.lastProgressAt ?? run?.startedAt ?? glob.createdAt;
};

/**
 * The events that explain a glob, newest first, one line each, derived from what the glob view already carries (runs, the PR,
 * the head's checks, the conflict, the failure, the escalation, human steps). No new table: routine noise (version bumps,
 * provisioning retries, hint refreshes) never reaches it. Entries without a time (the PR's state) sort by `updatedAt`.
 */
export const activityOf = (
  glob: PresentableGlob,
  repo: string | null,
  steps: readonly MachineStep[] = [],
  viewerEmail?: string,
  now: string = glob.updatedAt,
): ActivityEntry[] => {
  const github = (path: string): string | null =>
    repo === null ? null : `https://github.com/${repo}/${path}`;
  const out: ActivityEntry[] = [];

  for (const run of glob.runs) {
    const what =
      run.purpose === 'investigate'
        ? 'Investigation'
        : run.purpose === 'resolve_conflict'
          ? 'Conflict fix'
          : 'Run';
    const started = entry(
      `run:${run.id}:start`,
      'machine',
      `${what} started`,
      run.startedAt ?? run.queuedAt,
      run.sessionUrl,
      'session',
    );
    const current = glob.currentRun?.id === run.id && canContinueLocally(run, viewerEmail);
    out.push({
      ...started,
      linkLabel: run.sessionUrl === null ? started.linkLabel : 'Open in Claude',
      command: current ? `sstor --glob ${glob.id}` : null,
    });
    if (run.state === 'ended') {
      const failed = run.outcome === 'failed';
      // The glob's own failure is pinned in full above the feed, so a run that failed with the same reason doesn't repeat it.
      const reason =
        failed && run.failureReason !== glob.failure?.reason ? run.failureReason : null;
      out.push(
        entry(
          `run:${run.id}:end`,
          failed ? 'warn' : 'machine',
          failed
            ? `${what} failed${reason === null || reason === '' ? '' : `: ${oneLine(reason)}`}`
            : `${what} ${run.outcome ?? 'ended'}`,
          run.endedAt ?? run.lastProgressAt,
          run.sessionUrl,
          'session',
          reason === null || reason === '' ? `${what} failed` : `${what} failed: ${reason}`,
        ),
      );
    } else if (run.state === 'watching') {
      out.push(
        entry(
          `run:${run.id}:standby`,
          'machine',
          `${what} on standby`,
          run.lastProgressAt ?? run.startedAt,
          run.sessionUrl,
          'session',
        ),
      );
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
          : [
              `Checks ${checks.state} on ${short(checks.sha)}`,
              failure.step === null ? failure.name : `${failure.name} · ${failure.step}`,
              ...failure.lines,
            ].join('\n'),
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
        conflict.since === null
          ? null
          : `/boards/${String(glob.boardId)}?glob=${encodeURIComponent(conflict.since)}`,
        'glob',
        [`Conflict with ${conflict.base}`, ...conflict.files].join('\n'),
      ),
    );
  }

  // A failed branch build raises a problem that stays until someone acts on the glob: a red entry with the build log's link.
  const build = glob.buildFailed;
  if (build != null) {
    const said = `Build failed on ${build.environment}: ${build.error}`;
    out.push(
      entry(`build:${build.deployId}`, 'warn', `Build failed on ${build.environment}: ${oneLine(build.error)}`, build.at, build.logUrl, 'build log', said),
    );
  }

  // A failed merge or a failed branch setup raises a problem block that goes once someone acts, so the feed keeps it. A run's
  // own failure is already the run's entry above.
  const failure = glob.failure;
  if (failure != null && (failure.kind === 'merge' || failure.kind === 'provisioning')) {
    const what = failure.kind === 'merge' ? 'Merge failed' : 'Branch setup failed';
    const reason = oneLine(failure.reason);
    out.push(
      entry(
        `failure:${failure.kind}:${failure.at}`,
        'warn',
        `${what}${reason === '' ? '' : `: ${reason}`}`,
        failure.at,
        null,
        'open',
        failure.conflict === undefined
          ? `${what}: ${failure.reason}`
          : [`${what}: ${failure.reason}`, ...failure.conflict.files].join('\n'),
      ),
    );
  }

  // The escalation has its own chip and disclosure, so the feed doesn't repeat its reason.

  // The PR entry says what is true of the PR now: never "ready for review" while it conflicts or its head's checks failed.
  const pr = glob.pr;
  if (pr !== null) {
    const failedHead = checks !== null && checks.state === 'failed' && checks.sha === pr.headSha;
    const state =
      conflict != null
        ? `conflicts with ${conflict.base}`
        : failedHead
          ? 'checks failed'
          : pr.state === 'ready'
            ? 'ready for review'
            : pr.state;
    out.push(
      entry(
        `pr:${String(pr.number)}:${pr.state}:${conflict != null ? 'conflict' : failedHead ? 'checks' : 'ok'}`,
        conflict != null || failedHead ? 'warn' : 'github',
        `PR #${String(pr.number)} ${state}${glob.branch === '' ? '' : ` · ${glob.branch}`}`,
        // The PR records no time of its own: the problem's, else the last run's end (the PR is opened and readied by a run), else the glob's creation.
        conflict != null
          ? conflict.at
          : failedHead
            ? (checks.at ?? lastRunAt(glob))
            : lastRunAt(glob),
        github(`pull/${String(pr.number)}`),
        'PR',
      ),
    );
  }
  for (const p of glob.prs) {
    out.push(
      entry(
        `pr:${String(p.number)}:merged`,
        'github',
        `PR #${String(p.number)} merged · ${short(p.mergeSha)}`,
        p.mergedAt,
        github(`pull/${String(p.number)}`),
        'PR',
      ),
    );
  }

  // The click in flight, and how the last one ended: who asked for what, and why it did not work.
  const named = (kind: Parameters<typeof actionPresentation>[0]): string =>
    actionPresentation(kind, glob, false, viewerEmail).label;
  const clicked = glob.pendingAction;
  if (clicked != null) {
    out.push(
      entry(
        `click:${clicked.kind}:${clicked.at}`,
        'human',
        `${firstNameOf(clicked.by)} clicked ${named(clicked.kind)}`,
        clicked.at,
      ),
    );
  }
  const outcome = glob.lastOutcome;
  if (outcome != null) {
    const reason = oneLine(outcome.reason);
    const text =
      outcome.result === 'timed_out'
        ? `${named(outcome.kind)} had no effect after a minute`
        : `${named(outcome.kind)} failed${reason === '' ? '' : `: ${reason}`}`;
    out.push(
      entry(
        `outcome:${outcome.kind}:${outcome.at}`,
        'warn',
        text,
        outcome.at,
        null,
        'open',
        outcome.result === 'timed_out' ? text : `${named(outcome.kind)} failed: ${outcome.reason}`,
      ),
    );
  }
  // A click older than the timeout with nothing to show for it has timed out, even though nothing wrote that down yet.
  if (clicked != null && outcome == null && pendingTimedOut(glob, clicked, now)) {
    out.push(
      entry(
        `outcome:${clicked.kind}:${clicked.at}:timeout`,
        'warn',
        `${named(clicked.kind)} had no effect after a minute`,
        new Date(Date.parse(clicked.at) + PENDING_TIMEOUT_MS).toISOString(),
      ),
    );
  }

  for (const step of glob.humanSteps ?? []) {
    if (step.state === 'done' && step.doneAt != null) {
      out.push(
        entry(
          `step:${step.id}:done`,
          'human',
          `${step.doneBy ?? 'Someone'} did: ${step.title}`,
          step.doneAt,
          null,
        ),
      );
    }
  }

  // Machine steps are ordinary entries: "fixing CI · running", "creating the branch · queued".
  for (const step of steps) {
    if (step.state === 'done') continue;
    const link = step.detail !== null && /^https?:\/\//.test(step.detail) ? step.detail : null;
    const reason =
      step.state === 'failed' &&
      step.detail !== null &&
      link === null &&
      step.detail !== glob.failure?.reason
        ? step.detail
        : null;
    out.push(
      entry(
        `step:${step.id}`,
        step.state === 'failed' ? 'warn' : 'machine',
        `${stepLabel(step)} · ${step.state}${reason === null ? '' : `: ${oneLine(reason)}`}`,
        step.startedAt ?? step.lastProgressAt,
        link,
        link !== null && /\/actions\/|\/runs?\//.test(link)
          ? 'CI run'
          : link !== null && link.includes('claude.ai')
            ? 'session'
            : 'open',
        reason === null ? undefined : `${stepLabel(step)} · ${step.state}: ${reason}`,
      ),
    );
  }

  (glob.handoffs ?? []).forEach((h, i) => {
    const name = h.by === null ? 'Someone' : firstNameOf(h.by);
    const text =
      h.kind === 'took_over'
        ? `${name} took it over from the routine run`
        : h.kind === 'handed_back'
          ? `${name} handed it to the machine`
          : `${name} picked it up`;
    out.push(
      entry(
        `handoff:${String(i)}:${h.kind}:${h.at}`,
        'human',
        text,
        h.at,
        null,
        'open',
        h.by === null ? text : `${text} (${h.by})`,
      ),
    );
  });

  if (glob.signedOffAt !== null)
    out.push(entry('signed-off', 'human', 'Signed off', glob.signedOffAt));
  out.push(
    entry(
      'created',
      'human',
      `Planned by ${glob.planner} · ${new Date(glob.createdAt).toLocaleString()}`,
      glob.createdAt,
    ),
  );

  const time = (e: ActivityEntry): number => Date.parse(e.at ?? glob.updatedAt);
  out.sort((a, b) => time(b) - time(a));
  return collapse(out);
};
