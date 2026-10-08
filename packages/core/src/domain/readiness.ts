import { failureSummary } from './checks.js';
import type { Board, Glob } from './types.js';

/**
 * Board readiness: what a board needs before slop can run its globs end to end, checked where slop
 * can see it and ticked by hand where it can't. Each item says what's wrong and how to fix it.
 */
export const READINESS_KEYS = [
  'repo_app',
  'sub_gate',
  'claude_workflow',
  'agent_set',
  'build_doc',
  'environments',
  'routines',
  'routine_repo',
  'claude_app',
] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];

/** The items slop can't check for itself: an admin ticks them in board settings. */
export const MANUAL_READINESS_KEYS = ['routines', 'routine_repo', 'claude_app'] as const;
export type ManualReadinessKey = (typeof MANUAL_READINESS_KEYS)[number];
export type ReadinessTicks = Readonly<Partial<Record<ManualReadinessKey, boolean>>>;

/** ok; missing (do something); failing (ticked or set up, but recent runs say otherwise); unknown (can't check yet). */
export type ReadinessState = 'ok' | 'missing' | 'failing' | 'unknown';

/** Where to fix an item: a page on the board, or an outside link. */
export type ReadinessFix =
  | { readonly kind: 'settings' | 'knowledge'; readonly label: string }
  | { readonly kind: 'link'; readonly label: string; readonly href: string };

export interface ReadinessItem {
  readonly key: ReadinessKey;
  readonly title: string;
  readonly state: ReadinessState;
  readonly detail: string;
  readonly fix: ReadinessFix | null;
  readonly manual: boolean;
}

/** What slop found out about the board's setup (null where it couldn't look). */
export interface ReadinessFacts {
  readonly board: Board;
  /** Whether slop's GitHub App can reach the repo; null without a repo or before the app exists. */
  readonly repoConnected: boolean | null;
  readonly installUrl: string | null;
  /** Whether the base branch has `.github/workflows/sub-gate.yml`; null when slop can't read the repo. */
  readonly subGateWorkflow: boolean | null;
  /** Whether a workflow on the base branch runs `anthropics/claude-code-action`; null when slop can't read the repo. */
  readonly claudeWorkflow: boolean | null;
  /**
   * The agent-set version committed on the base branch (`.claude/slop-agent-set.json`): null when
   * the file is absent, 'unreadable' when it isn't valid, 'unknown' when slop couldn't read the repo.
   */
  readonly committedAgentSetVersion: number | null | 'unreadable' | 'unknown';
  readonly hasBuildDoc: boolean;
  readonly ticks: ReadinessTicks;
  /** Recent routine failures on the board's globs, newest first. */
  readonly recentFailures: readonly { readonly globId: string; readonly reason: string }[];
  /** Globs whose watching run hasn't reacted to failed checks (see `unreactedCheckFailures`). */
  readonly unreactedCheckFailures: readonly string[];
}

/** The action a workflow must run for `@claude` mentions to get a response. */
export const CLAUDE_ACTION = 'anthropics/claude-code-action';

/** Whether a workflow file's text runs the Claude Code action. */
export const runsClaudeAction = (workflow: string): boolean => workflow.includes(CLAUDE_ACTION);

const claudeWorkflowFix = (repo: string | null): string =>
  `Add a Claude workflow: run /install-github-app in Claude Code for ${repo ?? 'the repo'}, or copy catalog/scripts/claude.yml to .github/workflows/ and add the CLAUDE_CODE_OAUTH_TOKEN secret`;

/**
 * Which readiness item a routine failure points to, and its fix, from the failure's reason.
 * Null when the reason doesn't match a known setup problem.
 */
export const routineFailureFix = (reason: string): { key: ManualReadinessKey; fix: string } | null => {
  if (/resource not accessible by integration|workflows? permission|claude github app/i.test(reason)) {
    return { key: 'claude_app', fix: "Install the Claude GitHub App on the repo, with the workflows permission" };
  }
  if (/repository not found|not (have )?access(ible)? to (the )?repo|could not read from remote|permission to \S+ denied|not in the routine'?s repositories/i.test(reason)) {
    return { key: 'routine_repo', fix: "Add the repo to the routine's repositories" };
  }
  if (/routine (fire )?(failed|not found)|fire (url|token)|no routine/i.test(reason)) {
    return { key: 'routines', fix: 'Check the routine and its fire URL and token in .routines.json' };
  }
  return null;
};

const item = (
  key: ReadinessKey,
  title: string,
  state: ReadinessState,
  detail: string,
  fix: ReadinessFix | null,
): ReadinessItem => ({ key, title, state, detail, fix, manual: MANUAL_READINESS_KEYS.some((k) => k === key) });

/** The readiness checklist, in the order a board is set up. */
export const readiness = (facts: ReadinessFacts): ReadinessItem[] => {
  const { board } = facts;
  const repo = board.repo;
  const settings: ReadinessFix = { kind: 'settings', label: 'Board settings' };
  const items: ReadinessItem[] = [];

  items.push(
    repo === null
      ? item('repo_app', "slop's GitHub App on the repo", 'missing', 'The board has no repository', settings)
      : facts.repoConnected === null
        ? item('repo_app', "slop's GitHub App on the repo", 'unknown', "slop's GitHub App isn't set up yet", {
            kind: 'link',
            label: 'Set up the GitHub App',
            href: '/setup/github-app',
          })
        : facts.repoConnected
          ? item('repo_app', "slop's GitHub App on the repo", 'ok', `Connected to ${repo}`, null)
          : item(
              'repo_app',
              "slop's GitHub App on the repo",
              'missing',
              `slop can't reach ${repo}`,
              facts.installUrl === null ? settings : { kind: 'link', label: 'Install the app', href: facts.installUrl },
            ),
  );

  const subGatePath = '.github/workflows/sub-gate.yml';
  items.push(
    facts.subGateWorkflow === null
      ? item('sub_gate', 'Sub-gate workflow', 'unknown', "slop can't read the repo yet", null)
      : facts.subGateWorkflow
        ? item('sub_gate', 'Sub-gate workflow', 'ok', `${subGatePath} is on ${board.baseBranch}; make checks (.github/workflows/checks.yml, run on every PR) and sub-gate required status checks on ${board.baseBranch} so merges honour them`, null)
        : item('sub_gate', 'Sub-gate workflow', 'missing', `Subs can't merge themselves without ${subGatePath} on ${board.baseBranch}`, {
            kind: 'link',
            label: 'Add the workflow',
            href: `https://github.com/${repo ?? ''}/new/${board.baseBranch}?filename=${subGatePath}`,
          }),
  );

  const claudeTitle = `Claude workflow on ${board.baseBranch}`;
  items.push(
    facts.claudeWorkflow === null
      ? item('claude_workflow', claudeTitle, 'unknown', "slop can't read the repo yet", null)
      : facts.claudeWorkflow
        ? item('claude_workflow', claudeTitle, 'ok', `A workflow on ${board.baseBranch} runs ${CLAUDE_ACTION}, so @claude comments get a response (it also needs the Claude GitHub App)`, null)
        : item('claude_workflow', claudeTitle, 'missing', claudeWorkflowFix(repo), {
            kind: 'link',
            label: 'Add the workflow',
            href: `https://github.com/${repo ?? ''}/new/${board.baseBranch}?filename=.github/workflows/claude.yml`,
          }),
  );

  const committed = facts.committedAgentSetVersion;
  items.push(
    committed === 'unknown'
      ? item('agent_set', 'Agent set in the repo', 'unknown', "slop can't read the repo yet", null)
      : committed === 'unreadable'
        ? item('agent_set', 'Agent set in the repo', 'missing', `.claude/slop-agent-set.json on ${board.baseBranch} isn't valid: run slop init ${String(board.id)} and commit it`, {
            kind: 'knowledge',
            label: 'Agent set',
          })
        : committed === null
      ? item('agent_set', 'Agent set in the repo', 'missing', `No .claude/slop-agent-set.json on ${board.baseBranch}: run slop init ${String(board.id)} in a checkout and commit it`, {
          kind: 'knowledge',
          label: 'Agent set',
        })
      : committed < board.agentSetVersion
        ? item('agent_set', 'Agent set in the repo', 'missing', `The repo has version ${String(committed)}; the board's is ${String(board.agentSetVersion)}. Routines update it on their next run, or run slop init ${String(board.id)}`, {
            kind: 'knowledge',
            label: 'Agent set',
          })
        : item('agent_set', 'Agent set in the repo', 'ok', `Version ${String(committed)}`, null),
  );

  items.push(
    facts.hasBuildDoc
      ? item('build_doc', 'Build doc', 'ok', 'Agents get the build, test and lint commands', null)
      : item('build_doc', 'Build doc', 'missing', 'Agents have to guess the build, test and lint commands: import the build doc template or run /kb-bootstrap', {
          kind: 'knowledge',
          label: 'Knowledge',
        }),
  );

  const deployable = board.environments.filter((e) => e.allowBranchDeploy);
  const subDefault = board.environments.find((e) => e.subDefault === true);
  items.push(
    deployable.length === 0
      ? item('environments', 'Environments', 'missing', 'No environment takes branch deploys', settings)
      : subDefault === undefined
        ? item('environments', 'Environments', 'missing', 'No environment is the default for subs', settings)
        : item('environments', 'Environments', 'ok', `${deployable.map((e) => e.name).join(', ')}; subs default to ${subDefault.name}`, null),
  );

  const MANUAL: Record<ManualReadinessKey, string> = {
    routines: 'Routines for the board',
    routine_repo: "The repo in the routine's repositories",
    claude_app: 'Claude GitHub App on the repo',
  };
  for (const key of MANUAL_READINESS_KEYS) {
    const failure = facts.recentFailures.find((f) => routineFailureFix(f.reason)?.key === key);
    const fix = failure === undefined ? null : routineFailureFix(failure.reason);
    // One run that never started can be a hiccup; repeats point at the routine itself.
    const neverStarted = key === 'routines' ? facts.recentFailures.filter((f) => /^Routine run never started/.test(f.reason)) : [];
    const unreacted = key === 'claude_app' ? facts.unreactedCheckFailures[0] : undefined;
    const noWorkflow = facts.claudeWorkflow === false ? ' and the repo has no Claude workflow (see the "Claude workflow" item)' : '';
    items.push(
      failure !== undefined && fix !== null
        ? item(key, MANUAL[key], 'failing', `${failure.globId} failed: ${failure.reason}. ${fix.fix}`, settings)
        : neverStarted.length >= 2
          ? item(key, MANUAL[key], 'failing', `${neverStarted.length} routine runs never started (latest ${neverStarted[0]?.globId ?? ''}): check the routine's fire URL and token, and that its session can reach slop`, settings)
        : unreacted !== undefined
          ? item(key, MANUAL[key], 'failing', `${unreacted}'s checks failed and its routine run hasn't reacted: auto-fix depends on the Claude GitHub App, so check it is installed on the repo${noWorkflow}`, settings)
        : facts.ticks[key] === true
          ? item(key, MANUAL[key], 'ok', 'Ticked by an admin', null)
          : item(key, MANUAL[key], 'missing', "slop can't check this: tick it in board settings once it's done", settings),
    );
  }
  return items;
};

/** Routine failures on globs, newest first, from the globs' current failure (recent ones only). */
export const recentRoutineFailures = (
  globs: readonly Glob[],
  since: string,
): { globId: string; reason: string }[] =>
  globs
    .filter((g) => g.failure !== null && g.failure.at >= since)
    .sort((a, b) => (b.failure?.at ?? '').localeCompare(a.failure?.at ?? ''))
    .map((g) => ({ globId: g.id, reason: g.failure?.reason ?? '' }));

/** How long a sub's PR may sit ready before the card says its gate looks stuck. */
const STUCK_MINUTES = 15;

/**
 * Minutes since the head's checks failed with a watching run that hasn't pushed or called slop
 * since; null when the glob isn't in that state. A push resets the head checks, a run ending or a
 * take-over means the run is no longer watching.
 */
const minutesUnreacted = (glob: Glob, now: string): number | null => {
  if (glob.status !== 'pr_open') return null;
  const run = glob.runs[glob.runs.length - 1];
  if (run === undefined || run.state !== 'watching') return null;
  const head = glob.pr?.headSha ?? null;
  const checks = glob.headChecks;
  if (head === null || checks === null || checks.sha !== head || checks.state !== 'failed' || checks.at === undefined) return null;
  // Red because the base branch is: nothing for the routine to push.
  if (checks.inheritedFrom !== undefined) return null;
  const since = Math.max(Date.parse(checks.at), Date.parse(run.lastProgressAt ?? checks.at));
  return (Date.parse(now) - since) / 60_000;
};

/** Globs whose checks failed on the head and whose watching run hasn't reacted for a while. */
export const unreactedCheckFailures = (globs: readonly Glob[], now: string): string[] =>
  globs.filter((g) => (minutesUnreacted(g, now) ?? 0) >= STUCK_MINUTES).map((g) => g.id);

/** How long after asking the Claude GitHub App to resolve a conflict the card suggests resolving it locally. */
const CONFLICT_FIX_MINUTES = 15;

/**
 * A conflict flagged on an open PR. A human implementer resolves it locally from the start; for the rest the card
 * suggests that once the Claude GitHub App was asked and the PR still conflicts after a while.
 */
const conflictHint = (glob: Glob, now: string): string | null => {
  const conflict = glob.conflict;
  if (conflict == null) return null;
  const shown = conflict.files.slice(0, 5).join(', ');
  const more = conflict.files.length > 5 ? ` and ${String(conflict.files.length - 5)} more` : '';
  const files = conflict.files.length === 0 ? '' : `: ${shown}${more}`;
  const cause = conflict.since === null ? '' : ` since ${conflict.since} merged`;
  const hint = `Conflicts with ${conflict.base}${cause}${files}`;
  const waited =
    conflict.requestedAt !== undefined &&
    (Date.parse(now) - Date.parse(conflict.requestedAt)) / 60_000 >= CONFLICT_FIX_MINUTES;
  return glob.implementer !== null || waited ? `${hint}. Resolve locally: sstor --glob ${glob.id} --resolve` : hint;
};

/**
 * The early warning on a glob in Doing whose branch lacks commits from the base branch, before any conflict exists:
 * "main is 4 merges ahead; 6 files changed on both sides". Null when it is up to date, not in Doing, or already in
 * conflict (the conflict hint says more).
 */
export const behindWarning = (glob: Glob): string | null => {
  const behind = glob.behind;
  if (behind == null || behind.behindBy <= 0 || glob.status !== 'in_progress' || glob.conflict != null) return null;
  const merges = `${String(behind.behindBy)} merge${behind.behindBy === 1 ? '' : 's'}`;
  const files = behind.files.length;
  const both = files === 0 ? 'no files changed on both sides' : `${String(files)} file${files === 1 ? '' : 's'} changed on both sides`;
  return `${behind.base} is ${merges} ahead; ${both}`;
};

/** What to do about `behindWarning`, for the card's tooltip. */
export const behindAdvice = (glob: Glob): string =>
  `Merge ${glob.behind?.base ?? 'the base branch'} into ${glob.id} now${glob.type === 'super' ? ', or land the finished parts with Merge and continue,' : ''} before the conflicts grow`;

/**
 * A short hint on a card when a glob looks stuck on setup rather than on work: a ready sub with no
 * sub-gate result, a sub whose gate passed but hasn't merged, or a routine failure with a known fix.
 */
export const stuckHint = (glob: Glob, now: string): string | null => {
  if (glob.failure !== null) {
    const fix = routineFailureFix(glob.failure.reason);
    if (fix !== null) return fix.fix;
  }
  const conflict = conflictHint(glob, now);
  if (conflict !== null) return conflict;
  const unreacted = minutesUnreacted(glob, now);
  if (unreacted !== null && unreacted >= STUCK_MINUTES) {
    const session = glob.runs[glob.runs.length - 1]?.sessionUrl ?? null;
    return `Checks failed on the head ${String(Math.floor(unreacted))} minutes ago and the routine hasn't pushed or reported since. Fix: take over (sstor --glob ${glob.id} --take-over)${session === null ? '' : ` or open the run's session: ${session}`}`;
  }
  if (glob.type !== 'sub' || glob.status !== 'pr_open') return null;
  const minutes = (Date.parse(now) - Date.parse(glob.updatedAt)) / 60_000;
  if (minutes < STUCK_MINUTES) return null;
  const head = glob.pr?.headSha ?? null;
  if (head !== null && glob.headChecks?.sha === head && glob.headChecks.state === 'passed') {
    return 'The sub-gate passed but slop hasn\'t merged it: check the board\'s sub size limit and sensitive paths, or merge it';
  }
  if (glob.headChecks === null || glob.headChecks.sha !== head || glob.headChecks.state === 'pending') {
    return `No sub-gate result after ${String(STUCK_MINUTES)} minutes: is .github/workflows/sub-gate.yml on the base branch?`;
  }
  return null;
};

/** What a card says about checks that failed on the glob's current head. */
export interface ChecksExplanation {
  /** One line: the failing step and its first error, or that the base branch is red. */
  readonly text: string;
  /** The failing log's first error lines. */
  readonly lines: readonly string[];
  /** The run on the code host. */
  readonly url: string | null;
  /** The base branch fails the same way: not this glob's change. */
  readonly inherited: boolean;
}

/** Why the glob's head checks failed, from what slop read of the failing run; null when they haven't failed on the head. */
export const checksExplanation = (glob: Glob): ChecksExplanation | null => {
  const checks = glob.headChecks;
  if (checks === null || checks.state !== 'failed' || checks.sha !== glob.pr?.headSha) return null;
  const failure = checks.failure;
  const detail = failure === undefined ? 'Checks failed' : failureSummary(failure);
  const lines = failure?.lines ?? [];
  const url = failure?.url ?? null;
  const inherited = checks.inheritedFrom;
  if (inherited === undefined) return { text: detail, lines, url, inherited: false };
  const since = inherited.since === null ? '' : ` (since ${inherited.since})`;
  return { text: `${inherited.base} is red${since}: not this glob's change. ${detail}`, lines, url, inherited: true };
};

/** After this long queued, the card says how long (the run may have never started). */
const QUEUED_NOTICE_MINUTES = 10;

/** `Routine run queued for 25 min: open the session`, once a run has waited a while without calling slop; else null. */
export const queuedRunNotice = (glob: Glob, now: string): string | null => {
  const run = glob.runs[glob.runs.length - 1];
  if (run === undefined || run.state !== 'queued') return null;
  const minutes = Math.floor((Date.parse(now) - Date.parse(run.queuedAt)) / 60_000);
  if (minutes < QUEUED_NOTICE_MINUTES) return null;
  return `Routine run queued for ${String(minutes)} min: ${run.sessionUrl === null ? 'no session yet' : `open the session ${run.sessionUrl}`}`;
};

/** What a card says about a ready same or super PR: merge it, or wait for its checks. */
export interface ReadyStatus {
  readonly kind: 'ready' | 'waiting';
  readonly text: string;
  readonly tip: string;
}

/**
 * "Ready to merge" for a same or super at pr_open with a ready PR and passed head checks; "Waiting for checks"
 * while they run. Null otherwise, including subs (the sub gate merges them) and any failure or conflict, which
 * the caller ranks first. `reviewSha` is the commit of the latest local review, when there is one.
 */
export const readyStatus = (glob: Glob, reviewSha: string | null = null): ReadyStatus | null => {
  if (glob.type === 'sub' || glob.status !== 'pr_open' || glob.pr?.state !== 'ready') return null;
  if (glob.failure !== null || glob.conflict != null) return null;
  const head = glob.pr.headSha ?? '';
  const checks = glob.headChecks;
  if (checks?.state === 'failed' && checks.sha === head) return null;
  const run = glob.runs[glob.runs.length - 1];
  const watching = run !== undefined && run.state !== 'ended';
  const stale =
    reviewSha !== null && reviewSha !== head ? `\nLocal review is from ${reviewSha.slice(0, 7)}, before the latest push.` : '';
  if (checks !== null && checks.sha === head && checks.state === 'passed') {
    const merge = `The developer merges sames and supers: Merge on the card, or sstor -i ${glob.id} --merge.`;
    const auto = watching ? "\nThe run's session stays on the PR to auto-fix new CI failures or review comments." : '';
    return { kind: 'ready', text: 'Ready to merge', tip: `Checks passed at ${head.slice(0, 7)}. ${merge}${auto}${stale}` };
  }
  return { kind: 'waiting', text: 'Waiting for checks', tip: `Checks are still running on ${head.slice(0, 7)}.${stale}` };
};
