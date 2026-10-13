import {
  behindAdvice,
  behindWarning,
  checksExplanation,
  agentSetVersionOfTitle,
  isAgentSetGlob,
  machine,
  readyStatus,
  stuckHint,
} from '@slop/core';
import type { Action, BlockedBy, Edge, Role } from '@slop/core';
import type { GlobView } from './api';

/** One problem on a glob, in plain words: what the card shows in a line and the glob view shows in full. */
export interface StatusLine {
  readonly kind:
    | 'provisioning'
    | 'base-red'
    | 'checks'
    | 'failure'
    | 'investigation-failed'
    | 'stuck'
    | 'behind'
    | 'ready'
    | 'merge-waits';
  /** One line, cut short: the card's text. */
  readonly text: string;
  /** The whole sentence, for the glob view. */
  readonly full: string;
  readonly tone: string;
  /** The card's tooltip: the detail, and the other problems ranked below this one. */
  readonly tip: string;
  /** The failing check run, when there is one. */
  readonly url: string | null;
  /** What is being done about it, when that is known. */
  readonly doing: string | null;
  /** The routine session doing it. */
  readonly sessionUrl: string | null;
}

/** True for an investigate-only run: it never started the glob (`purpose` is absent on implementing runs). */
export const isInvestigateRun = (run: { readonly purpose?: string }): boolean =>
  run.purpose === 'investigate';

/** Cut to one line of at most `max` characters. */
export const oneLine = (text: string, max = 90): string => {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The first sentence of a stuck hint, without its "Fix: …" advice. */
export const hintSentence = (hint: string): string =>
  (hint.split(/\.\s|\s+Fix:/)[0] ?? hint).replace(/\.$/, '');

const ALSO = {
  provisioning: "the branch couldn't be created",
  'base-red': 'the base branch is red',
  checks: 'checks failed',
  failure: 'the routine run failed',
  'investigation-failed': 'the investigation failed',
  stuck: 'looks stuck',
  behind: 'the branch is behind the base',
  ready: '',
  'merge-waits': '',
} as const;

/** The one problem a glob shows, in plain words, most important first; the rest go in its tooltip. */
export const statusLine = (glob: GlobView, now: string): StatusLine | null => {
  const hint = stuckHint(glob, now);
  const checks = checksExplanation(glob);
  const failed = glob.status === 'failed' || glob.failure !== null;
  const failure = glob.failure;
  const decision = failure?.kind === 'needs_pairing' ? failure.decision?.trim() : undefined;
  // The routine stopped for a decision only a person can make: say which, not just that it failed.
  const reason =
    failure?.kind === 'needs_pairing'
      ? `Needs a person: ${decision === undefined || decision === '' ? failure.reason : decision}`
      : (failure?.reason ?? 'Routine run failed');
  const run = glob.currentRun ?? null;
  const session = run?.sessionUrl ?? null;
  const investigationFailed =
    run !== null && isInvestigateRun(run) && run.state === 'ended' && run.outcome === 'failed';
  const provisioningFailed =
    glob.provisioning === 'failed' && glob.failure?.kind === 'provisioning';
  const candidates: StatusLine[] = [];
  const make = (
    line: Omit<StatusLine, 'text' | 'url' | 'doing' | 'sessionUrl'> &
      Partial<Pick<StatusLine, 'url' | 'doing' | 'sessionUrl'>>,
  ): StatusLine => ({
    text: oneLine(line.full),
    url: null,
    doing: null,
    sessionUrl: null,
    ...line,
  });
  // A glob with no branch can't do anything else, so this comes before every other problem.
  if (provisioningFailed) {
    candidates.push(make({ kind: 'provisioning', full: reason, tone: 'text-red', tip: reason }));
  }
  if (checks !== null) {
    const details = [checks.text, ...checks.lines.slice(1, 4), checks.url ?? ''].filter(
      (l) => l !== '',
    );
    if (checks.inherited) {
      const head =
        /^(.*?not this glob's change)/.exec(checks.text)?.[1] ??
        "The base branch is red: not this glob's change";
      candidates.push(
        make({
          kind: 'base-red',
          full: head,
          tone: 'text-required',
          tip: details.join('\n'),
          url: checks.url,
          doing: 'this branch is updated when the base is fixed',
        }),
      );
    } else {
      const failure = glob.headChecks?.failure;
      const first = failure?.lines[0];
      const full =
        failure === undefined
          ? 'Checks failed'
          : first === undefined
            ? `${failure.name} failed`
            : `${failure.name} failed: ${first}`;
      const fixing = run?.state === 'watching';
      candidates.push(
        make({
          kind: 'checks',
          full,
          tone: 'text-red',
          tip: details.join('\n'),
          url: checks.url,
          doing: fixing ? 'routine session is fixing it' : null,
          sessionUrl: fixing ? session : null,
        }),
      );
    }
  }
  if (failed && !provisioningFailed) {
    const tip = `${reason}${/^(Routine run never started|The run's session never reached slop)/.test(glob.failure?.reason ?? '') && session !== null ? `\nSession: ${session}` : ''}`;
    candidates.push(make({ kind: 'failure', full: reason, tone: 'text-red', tip }));
  }
  // An investigation is an artifact, not the glob's work: its failure is a note, never the red failure of an implementation.
  if (investigationFailed) {
    const why = run.failureReason ?? 'no reason recorded';
    candidates.push(
      make({
        kind: 'investigation-failed',
        full: `Investigation failed: ${why}`,
        tone: 'text-muted-foreground',
        tip: `Investigation failed: ${why}${session === null ? '' : `\nSession: ${session}`}`,
        sessionUrl: session,
      }),
    );
  }
  if (hint !== null)
    candidates.push(
      make({ kind: 'stuck', full: hintSentence(hint), tone: 'text-required', tip: hint }),
    );
  const behind = behindWarning(glob);
  if (behind !== null) {
    candidates.push(
      make({
        kind: 'behind',
        full: behind,
        tone: 'text-muted-foreground',
        tip: `${behind}\n${behindAdvice(glob)}`,
        doing: behindAdvice(glob),
      }),
    );
  }
  if (candidates.length === 0) {
    const reviewSha = glob.artifacts?.find((a) => a.kind === 'local_review')?.commitSha ?? null;
    const ready = readyStatus(glob, reviewSha);
    // Waiting for checks is activity, not a problem or a next step: the activity label carries it.
    if (ready !== null && ready.kind === 'ready')
      return make({
        kind: ready.kind,
        full: ready.text,
        tone: 'text-signal-strong',
        tip: ready.tip,
      });
  }
  const [top, ...rest] = candidates;
  if (top === undefined) return null;
  const also = rest.length === 0 ? '' : `\nAlso: ${rest.map((c) => ALSO[c.kind]).join(', ')}`;
  return { ...top, tip: `${top.tip}${also}` };
};

/** An action the glob is heading for but can't take yet: a short tooltip for its disabled button and the sentence's tail. */
export interface Waiting {
  readonly action: Action;
  /** Short, for the disabled button's tooltip. */
  readonly tip: string;
  /** What it waits for, finishing "Merge waits …". */
  readonly why: string;
  /** True when it only waits for checks that are still running: shown as activity, not on the status line. */
  readonly running?: true;
}

const MERGE_WAIT_LABELS: Partial<Record<Action, string>> = {
  merge: 'Merge',
  merge_continue: 'Merge and continue',
  mark_ready: 'Mark done (PR ready)',
};

const failedWhy = (glob: GlobView, head: string): string => {
  const short = head.slice(0, 7);
  const inherited = glob.headChecks?.inheritedFrom;
  if (inherited !== undefined)
    return `: ${inherited.base} is red${inherited.since === null ? '' : ` since ${inherited.since}`}`;
  const failure = glob.headChecks?.failure;
  const first = failure?.lines[0];
  const detail =
    failure === undefined ? '' : ` ${failure.name}${first === undefined ? '' : `: ${first}`}`;
  return `: checks failed on ${short}${detail}`;
};

/**
 * Actions the glob is heading for but can't take yet: merging waits for the checks on the PR head, and a super's
 * Merge and continue and Mark done (PR ready) wait for the latest implementation record at the head.
 */
export const waitingFor = (glob: GlobView, actions: readonly Action[], role: Role): Waiting[] => {
  // QA and PO can't take these actions at all, so a reason would mislead them.
  if (role === 'qa' || role === 'po') return [];
  const waiting: Waiting[] = [];
  if (glob.status === 'pr_open' && glob.type !== 'sub' && !actions.includes('merge')) {
    const head = glob.pr?.headSha ?? null;
    const checks = glob.headChecks;
    const wait: Pick<Waiting, 'tip' | 'why' | 'running'> =
      head === null
        ? { tip: 'Waiting for the PR head', why: 'for the PR head', running: true }
        : checks?.sha === head && checks.state === 'failed'
          ? {
              tip:
                checks.inheritedFrom === undefined
                  ? `Checks failed on ${head.slice(0, 7)}`
                  : `${checks.inheritedFrom.base} is red`,
              why: failedWhy(glob, head),
            }
          : {
              tip: `Waiting for the checks on ${head.slice(0, 7)} to pass`,
              why: `for the checks on ${head.slice(0, 7)}`,
              running: true,
            };
    waiting.push({ action: 'merge', ...wait });
    if (glob.type === 'super') waiting.push({ action: 'merge_continue', ...wait });
  }
  if (glob.type !== 'super') return waiting;
  const record = {
    tip: machine.RECORD_NOT_AT_HEAD,
    why: 'for the implementation record at the head',
  };
  if (actions.includes('merge') && !actions.includes('merge_continue'))
    waiting.push({ action: 'merge_continue', ...record });
  if (
    glob.status === 'in_progress' &&
    glob.pr?.state === 'draft' &&
    !actions.includes('mark_ready')
  ) {
    waiting.push({ action: 'mark_ready', ...record });
  }
  return waiting;
};

/** "Merge waits for the checks on d16d563", one sentence per distinct reason. */
export const waitingSentences = (waiting: readonly Waiting[]): string[] =>
  [...new Set(waiting.map((w) => w.why))].map((why) => {
    const labels = waiting
      .filter((w) => w.why === why)
      .map((w) => MERGE_WAIT_LABELS[w.action] ?? w.action);
    const subject = labels.length > 1 ? `${labels.join(' and ')} wait` : `${labels[0] ?? ''} waits`;
    return `${subject}${why.startsWith(':') ? '' : ' '}${why}`;
  });

/**
 * What the glob view shows at its top: the card's line, and for a same or super that can't merge (or continue) yet,
 * why. The card's kind, tone, link and what is being done about it carry over.
 */
export const viewStatusLine = (
  glob: GlobView,
  now: string,
  waiting: readonly Waiting[],
): StatusLine | null => {
  const base = statusLine(glob, now);
  // Checks still running are shown by the activity label.
  const stopped = waiting.filter((w) => w.running !== true);
  if (stopped.length === 0) return base;
  const full = waitingSentences(stopped).join('. ');
  const blocking =
    base === null || base.kind === 'ready' || base.kind === 'checks' || base.kind === 'base-red';
  // A failure, a stuck hint or a conflict outranks the wait; the buttons still carry their short reason.
  if (!blocking) return base;
  return {
    kind:
      base !== null && (base.kind === 'checks' || base.kind === 'base-red')
        ? base.kind
        : 'merge-waits',
    text: oneLine(full),
    full,
    tone: base === null || base.kind === 'ready' ? 'text-muted-foreground' : base.tone,
    tip: base?.tip ?? full,
    url: base?.url ?? null,
    doing: base?.kind === 'ready' ? null : (base?.doing ?? null),
    sessionUrl: base?.sessionUrl ?? null,
  };
};

/** What slop or a routine is doing on its own, in one label: the card's chip and the glob view's, from the same function. */
export interface Activity {
  readonly kind:
    | 'merging'
    | 'checks'
    | 'investigating'
    | 'working'
    | 'watching'
    | 'queued'
    | 'picked_up'
    | 'agent_set';
  readonly text: string;
  /** The detail: session link, owner, who triggered it, the queued notice. */
  readonly tip: string;
  /** Spins while something is running. */
  readonly spinning: boolean;
}

const QUEUED_NOTICE_MINUTES = 10;
/** How long a picked-up glob may sit untouched before the card says no session has started. */
const PICKED_UP_IDLE_MINUTES = 10;

/**
 * One activity label, by precedence: merging, then checks running or awaited on the PR head, then the routine run
 * (working, watching the PR, queued). Null when nothing runs on its own. Problems and next steps stay on the status line.
 */
export const activityLabel = (glob: GlobView, now: string): Activity | null => {
  const run = glob.currentRun ?? null;
  const live = run !== null && run.state !== 'ended' ? run : null;
  const runDetail =
    live === null
      ? []
      : [
          `Owned by ${live.routineOwner}, triggered by ${live.triggeredBy}`,
          ...(live.sessionUrl === null ? [] : [`Session: ${live.sessionUrl}`]),
        ];
  if (glob.status === 'merging') {
    return {
      kind: 'merging',
      text: 'Merging',
      tip: 'slop is updating the branch and squash-merging the PR once the checks pass',
      spinning: true,
    };
  }
  const head = glob.pr?.headSha ?? null;
  const checks = glob.headChecks;
  const checksSettled =
    head !== null &&
    checks?.sha === head &&
    (checks.state === 'passed' || checks.state === 'failed');
  if (
    glob.status === 'pr_open' &&
    glob.pr?.state === 'ready' &&
    head !== null &&
    !checksSettled &&
    glob.failure === null &&
    glob.conflict == null
  ) {
    const short = head.slice(0, 7);
    const running = checks?.sha === head && checks.state === 'pending';
    return {
      kind: 'checks',
      text: running ? `Checks running on ${short}` : `Waiting for checks on ${short}`,
      tip: `Merging waits for the checks on ${short} to pass`,
      spinning: running,
    };
  }
  if (live === null && isAgentSetGlob(glob)) {
    // Slop's own agent-set glob has no run or session: slop commits the set, a person reviews and merges.
    const version = agentSetVersionOfTitle(glob.title);
    if (glob.status === 'pr_open') {
      if (glob.headChecks?.state === 'failed' || glob.failure !== null) return null;
      return {
        kind: 'agent_set',
        text: `Slop committed agent set v${String(version)}: review and merge`,
        tip: 'Slop committed the agent set to this branch. Review the diff, then merge once the checks pass.',
        spinning: false,
      };
    }
    if (glob.status === 'in_progress' || glob.status === 'implementing') {
      return {
        kind: 'agent_set',
        text: "Waiting for slop's commit",
        tip: 'Slop commits the agent set to this branch shortly after the board changes it, then marks the PR ready. Nobody works on it.',
        spinning: false,
      };
    }
    return null;
  }
  if (live === null) {
    // Picked up, and nothing has touched the glob since: say so, with the way out.
    const idle = Math.floor((Date.parse(now) - Date.parse(glob.updatedAt)) / 60_000);
    if (
      glob.status === 'in_progress' &&
      glob.implementer !== null &&
      glob.type !== 'super' &&
      idle >= PICKED_UP_IDLE_MINUTES
    ) {
      return {
        kind: 'picked_up',
        text: 'Picked up, no routine run',
        tip: `${glob.implementer} picked this up and no routine run is working on it. A local session isn't visible to slop. Hand to routine starts a run.`,
        spinning: false,
      };
    }
    return null;
  }
  if (isInvestigateRun(live)) {
    return {
      kind: 'investigating',
      text: 'Investigating',
      tip: ['Investigating the plan; the glob has not started', ...runDetail].join('\n'),
      spinning: true,
    };
  }
  if (live.state === 'active') {
    // On an open PR the run is a fix run: say what it is fixing.
    const fixing = glob.status === 'pr_open' ? (checks?.state === 'failed' ? 'fixing CI' : 'answering review') : null;
    return { kind: 'working', text: fixing ?? 'Routine working', tip: runDetail.join('\n'), spinning: true };
  }
  if (live.state === 'watching') {
    return {
      kind: 'watching',
      text: 'standby',
      tip: ["Machine on standby: fixes new CI failures or review comments until it's merged.", ...runDetail].join('\n'),
      spinning: false,
    };
  }
  const minutes = Math.floor((Date.parse(now) - Date.parse(live.queuedAt)) / 60_000);
  const long = minutes >= QUEUED_NOTICE_MINUTES;
  return {
    kind: 'queued',
    text: long ? `Queued for ${String(minutes)} min` : 'Queued',
    tip: [
      long
        ? `Routine run queued for ${String(minutes)} min: ${live.sessionUrl === null ? 'no session yet' : 'open the session'}`
        : 'Routine run queued',
      ...runDetail,
    ].join('\n'),
    spinning: false,
  };
};

/** How many blocking IDs the card and dialog name before folding the rest into "+N". */
const SHOWN_AHEAD = 2;

export interface BlockedParts {
  /** The IDs to name, direct prerequisites first, then the transitive ones. */
  readonly ids: readonly string[];
  /** How many more are ahead, not named. */
  readonly more: number;
  /** The startable glob to show after the IDs, unless it is already named; null otherwise. */
  readonly next: string | null;
}

/** What a blocked glob's line names: "s15f82, s15f84 +2", then the glob to start next. Null when nothing is ahead. */
export const blockedParts = (glob: GlobView): BlockedParts | null => {
  const ahead = [...(glob.blockedBy ?? [])].sort((a, b) => a.depth - b.depth);
  if (ahead.length === 0) return null;
  const all = ahead.map((b) => b.id);
  // Three or more fold to two names and a count, but never fold away the glob to start next.
  const ids = all.length > SHOWN_AHEAD + 1 ? all.slice(0, SHOWN_AHEAD) : all;
  const next = glob.nextStartable ?? null;
  return {
    ids,
    more: all.length - ids.length,
    next: next === null || ids.includes(next) ? null : next,
  };
};

/** "blocked by s15f82, s15f84 +2 · next: s15f38" for a glob with unmerged prerequisites; null when none. */
export const blockedLine = (glob: GlobView): string | null => {
  const parts = blockedParts(glob);
  if (parts === null) return null;
  const more = parts.more > 0 ? ` +${String(parts.more)}` : '';
  return `blocked by ${parts.ids.join(', ')}${more}${parts.next === null ? '' : ` · next: ${parts.next}`}`;
};

/** The chain for a tip, nearest first, each with its state: "s15f41 (Planning), s15f40 (Planning, 2 links away)". */
export const chainTip = (glob: GlobView): string =>
  (glob.blockedBy ?? [])
    .map(
      (b) =>
        `${b.id} (${statusWords(b.status)}${b.depth > 1 ? `, ${String(b.depth)} links away` : ''})`,
    )
    .join(', ');

export const statusWords = (status: GlobView['status'] | null): string => {
  switch (status) {
    case null:
      return 'deleted';
    case 'planning':
      return 'Planning';
    case 'implementing':
    case 'in_progress':
      return 'Doing';
    case 'failed':
      return 'failed';
    case 'pr_open':
      return 'PR open';
    default:
      return status;
  }
};

/** One direct need of a glob, with its status and why it waits. */
export interface NeedRow {
  readonly id: string;
  /** The status word ("Doing", "PR open", ...); the board's own words, from the blocking chain. */
  readonly status: string | null;
  readonly why: string;
}

/** What the glob view's Dependencies section shows. */
export interface DependencySummary {
  /** Direct needs, each with status and why. */
  readonly needs: readonly NeedRow[];
  /** The rest of the chain ahead (depth above 1), nearest first; the data doesn't say which need each hangs off. */
  readonly alsoAhead: readonly BlockedBy[];
  /** Globs that may change the same files (merge order only). */
  readonly overlaps: readonly Edge[];
  readonly waitedOnBy: readonly string[];
}

/** The Dependencies section's content, or null when there is nothing to list. */
export const dependencySummary = (glob: GlobView): DependencySummary | null => {
  const chain = glob.blockedBy ?? [];
  const needs = (glob.waitingFor ?? []).map((w) => {
    const ahead = chain.find((b) => b.id === w.id);
    return { id: w.id, status: ahead === undefined ? null : statusWords(ahead.status), why: w.why };
  });
  const alsoAhead = chain.filter((b) => b.depth > 1).sort((a, b) => a.depth - b.depth);
  const overlaps = (glob.edges ?? []).filter((e) => e.kind === 'overlaps');
  const waitedOnBy = glob.waitedOnBy ?? [];
  if (
    needs.length + alsoAhead.length + overlaps.length + waitedOnBy.length === 0 &&
    chain.length === 0
  )
    return null;
  return { needs, alsoAhead, overlaps, waitedOnBy };
};
