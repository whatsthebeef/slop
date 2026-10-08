import {
  behindAdvice,
  behindWarning,
  checksExplanation,
  machine,
  readyStatus,
  stuckHint,
} from '@slop/core';
import type { Action, Role } from '@slop/core';
import type { GlobView } from './api';

/** One problem on a glob, in plain words: what the card shows in a line and the glob view shows in full. */
export interface StatusLine {
  readonly kind:
    'provisioning' | 'base-red' | 'checks' | 'failure' | 'stuck' | 'behind' | 'ready' | 'merge-waits';
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
  const reason = glob.failure?.reason ?? 'Routine run failed';
  const run = glob.currentRun ?? null;
  const session = run?.sessionUrl ?? null;
  const provisioningFailed = glob.provisioning === 'failed' && glob.failure?.kind === 'provisioning';
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
    const tip = `${reason}${glob.failure?.reason.startsWith('Routine run never started') === true && session !== null ? `\nSession: ${session}` : ''}`;
    candidates.push(make({ kind: 'failure', full: reason, tone: 'text-red', tip }));
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
  mark_ready: 'Ready for review',
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
 * Merge and continue and Ready for review wait for the latest postplan at the head.
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
  const postplan = { tip: machine.POSTPLAN_NOT_AT_HEAD, why: 'for the postplan at the head' };
  if (actions.includes('merge') && !actions.includes('merge_continue'))
    waiting.push({ action: 'merge_continue', ...postplan });
  if (
    glob.status === 'in_progress' &&
    glob.pr?.state === 'draft' &&
    !actions.includes('mark_ready')
  ) {
    waiting.push({ action: 'mark_ready', ...postplan });
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
    base === null ||
    base.kind === 'ready' ||
    base.kind === 'checks' ||
    base.kind === 'base-red';
  // A failure, a stuck hint or a conflict outranks the wait; the buttons still carry their short reason.
  if (!blocking) return base;
  return {
    kind:
      base !== null && (base.kind === 'checks' || base.kind === 'base-red')
        ? base.kind
        : 'merge-waits',
    text: oneLine(full),
    full,
    tone:
      base === null || base.kind === 'ready'
        ? 'text-muted-foreground'
        : base.tone,
    tip: base?.tip ?? full,
    url: base?.url ?? null,
    doing: base?.kind === 'ready' ? null : (base?.doing ?? null),
    sessionUrl: base?.sessionUrl ?? null,
  };
};

/** What slop or a routine is doing on its own, in one label: the card's chip and the glob view's, from the same function. */
export interface Activity {
  readonly kind: 'merging' | 'checks' | 'working' | 'watching' | 'queued';
  readonly text: string;
  /** The detail: session link, owner, who triggered it, the queued notice. */
  readonly tip: string;
  /** Spins while something is running. */
  readonly spinning: boolean;
}

const QUEUED_NOTICE_MINUTES = 10;

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
  if (live === null) return null;
  if (live.state === 'active') {
    return { kind: 'working', text: 'Routine working', tip: runDetail.join('\n'), spinning: true };
  }
  if (live.state === 'watching') {
    return {
      kind: 'watching',
      text: 'Routine watching the PR',
      tip: ['Auto-fixing CI failures and review comments', ...runDetail].join('\n'),
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
