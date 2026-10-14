import {
  behindAdvice,
  behindWarning,
  checksExplanation,
  machine,
  readyStatus,
  MERGE_CONFLICT_STALL_LABEL,
  stuckHint,
  yourTurn,
} from '@slop/core';
import type { Action, Holding, HumanStepKind, HumanStepViewer, Role, StepAction } from '@slop/core';
import { rolloutLine } from './human-steps';
import type { GlobView } from './api';
import { actionPresentation, type ActionIcon } from './action-presentation';

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
    | 'rollout'
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
  /** For `ready` (Your turn): the kind of step it is, so the card can run it or open where it is done. */
  readonly turn?: HumanStepKind;
  /** For `ready` (Your turn): the one action the step's chip runs; absent when the step needs input in the glob view. */
  readonly action?: StepAction;
  /** For `ready`: the due step is a stored work step (a rollout), done in the Human steps section. */
  readonly work?: true;
  /** The problem is a merge conflict: the card says it in a few words and the glob view lists the files. */
  readonly conflict?: true;
}

/** The longest label a Your turn chip shows: one or two words; the step's full title goes in the tooltip. */
const TURN_LABEL_MAX = 24;

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
  rollout: '',
  'merge-waits': '',
} as const;

/** The one problem a glob shows, in plain words, most important first; the rest go in its tooltip. */
export const statusLine = (glob: GlobView, now: string, viewer?: HumanStepViewer): StatusLine | null => {
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
      // Never the inherited failure's text: the short waiting line; the failing test and the run are in the tooltip.
      const base = glob.headChecks?.inheritedFrom?.base ?? 'main';
      candidates.push(
        make({
          kind: 'base-red',
          full: `⏳ waiting · ${base} is red`,
          tone: 'text-required',
          tip: [`Waiting: ${base} is red, not this glob's change`, ...details].join('\n'),
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
    candidates.push(
      make({
        kind: 'failure',
        full: reason,
        tone: 'text-red',
        tip,
        ...(failure?.conflict === undefined
          ? {}
          : { text: MERGE_CONFLICT_STALL_LABEL, conflict: true as const }),
      }),
    );
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
  if (hint !== null) {
    const flagged = failure === null ? glob.conflict : null;
    candidates.push(
      make({
        kind: 'stuck',
        full: hintSentence(hint),
        tone: 'text-required',
        tip: hint,
        ...(flagged == null
          ? {}
          : { text: `conflicts with ${flagged.base}`, conflict: true as const }),
      }),
    );
  }
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
    // Merged with its rollout still open: how far it is, and whose turn.
    const rollout = glob.humanSteps === undefined ? null : rolloutLine(glob, glob.humanSteps, viewer);
    if (rollout !== null)
      return make({
        kind: rollout.turn === null ? 'rollout' : 'ready',
        full: rollout.text,
        ...(rollout.turn === null ? {} : { turn: rollout.turn.kind, work: true as const }),
        tone: rollout.turn === null ? 'text-muted-foreground' : 'text-signal-strong',
        tip: rollout.tip,
      });
    // Your turn is the first due step for the viewer; an API without human steps (or no viewer) still has the Merge turn.
    const turn =
      glob.humanSteps !== undefined && viewer !== undefined
        ? yourTurn(glob.humanSteps, glob, viewer)
        : ready?.kind === 'ready'
          ? { kind: 'merge' as const, title: ready.text }
          : null;
    // Waiting for checks is activity, not a problem or a next step: the activity label carries it.
    if (turn !== null) {
      const stalled = turn.kind === 'unstick' && glob.move?.holder === 'stalled' ? glob.move : null;
      const cause = stalled === null ? null : `${stalled.reason.charAt(0).toUpperCase()}${stalled.reason.slice(1)}${stalled.since === null ? '' : ` since ${new Date(stalled.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}`;
      const turnAction = 'action' in turn ? turn.action : undefined;
      // The chip names one action; the cause (and that other options are in the glob view) is the tooltip's.
      const tip =
        turn.kind === 'merge' && ready?.kind === 'ready'
          ? ready.tip
          : cause !== null
            ? `${cause}\nOther options are in the glob view`
            : turn.title;
      return make({
        kind: 'ready',
        full: oneLine(turn.title, TURN_LABEL_MAX),
        turn: turn.kind,
        ...(turnAction === undefined ? {} : { action: turnAction }),
        tone: 'text-signal-strong',
        tip,
      });
    }
  }
  const [top, ...rest] = candidates;
  if (top === undefined) return null;
  const also = rest.length === 0 ? '' : `\nAlso: ${rest.map((c) => ALSO[c.kind]).join(', ')}`;
  return { ...top, tip: `${top.tip}${also}` };
};

/** An action the glob is heading for but can't take yet: a short tooltip for its disabled button and the sentence's tail. */
export interface Waiting {
  readonly action: Action;
  /** The action's name and actor, from actionPresentation. */
  readonly label: string;
  readonly icon: ActionIcon | null;
  /** Short, for the disabled button's tooltip. */
  readonly tip: string;
  /** What it waits for, finishing "Merge waits …". */
  readonly why: string;
  /** True when it only waits for checks that are still running: shown as activity, not on the status line. */
  readonly running?: true;
}

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
 * Merge & keep working and Done wait for the latest implementation record at the head.
 */
export const waitingFor = (glob: GlobView, actions: readonly Action[], role: Role): Waiting[] => {
  // QA and PO can't take these actions at all, so a reason would mislead them.
  if (role === 'qa' || role === 'po') return [];
  const waiting: Waiting[] = [];
  const named = (action: Action): Pick<Waiting, 'action' | 'label' | 'icon'> => {
    const { label, icon } = actionPresentation(action, glob);
    // Merge can't be pressed here (failed checks, a conflict), so it isn't "Merge when checks pass".
    return { action, label: action === 'merge' ? 'Merge' : label, icon };
  };
  if (
    glob.status === 'pr_open' &&
    glob.type !== 'sub' &&
    !actions.includes('merge') &&
    !machine.isMergeArmed(glob)
  ) {
    const head = glob.pr?.headSha ?? null;
    const checks = glob.headChecks;
    const wait: Pick<Waiting, 'tip' | 'why' | 'running'> =
      head === null
        ? { tip: 'Waiting for the PR head', why: 'for the PR head', running: true }
        : glob.conflict != null
          ? {
              tip: `Conflicts with ${glob.conflict.base}: merge it into the branch and push`,
              why: `: conflicts with ${glob.conflict.base}`,
            }
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
    waiting.push({ ...named('merge'), ...wait });
    if (glob.type === 'super') waiting.push({ ...named('merge_continue'), ...wait });
  }
  if (glob.type !== 'super') return waiting;
  const record = {
    tip: machine.RECORD_NOT_AT_HEAD,
    why: 'for the implementation record at the head',
  };
  if (actions.includes('merge') && !actions.includes('merge_continue'))
    waiting.push({ ...named('merge_continue'), ...record });
  if (
    glob.status === 'in_progress' &&
    glob.pr?.state === 'draft' &&
    !actions.includes('mark_ready')
  ) {
    waiting.push({ ...named('mark_ready'), ...record });
  }
  return waiting;
};

/** "Merge waits for the checks on d16d563", one sentence per distinct reason. */
export const waitingSentences = (waiting: readonly Waiting[]): string[] =>
  [...new Set(waiting.map((w) => w.why))].map((why) => {
    const labels = waiting.filter((w) => w.why === why).map((w) => w.label);
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

/** How many blocking IDs the card and dialog name before folding the rest into "+N". */
const SHOWN_AHEAD = 2;

/**
 * What keeps a glob from starting: its unmet start relations (the server computes them, with the board's old globs read).
 * Only a glob in Planning is held, or a failed one that Retrigger would refuse; once started a start relation holds nothing.
 */
const startHolds = (glob: GlobView): readonly Holding[] =>
  glob.status === 'planning' || glob.status === 'failed' ? (glob.holding ?? []).filter((h) => h.gate === 'start') : [];

/** What a holding names: the glob ID, or "decision s15k190" for a decision glob. */
const named = (h: Pick<Holding, 'to' | 'toIsDecision'>): string => (h.toIsDecision ? `decision ${h.to}` : h.to);

export interface BlockedParts {
  /** The names to say: glob IDs, and "decision <id>" for a decision. */
  readonly ids: readonly string[];
  /** How many more are held back on, not named. */
  readonly more: number;
}

/** What a held glob's line names: "s15f82, decision s15k190 +2". Null when nothing holds its start. */
export const blockedParts = (glob: GlobView): BlockedParts | null => {
  const ahead = startHolds(glob).map(named);
  if (ahead.length === 0) return null;
  // Three or more fold to two names and a count.
  const ids = ahead.length > SHOWN_AHEAD + 1 ? ahead.slice(0, SHOWN_AHEAD) : ahead;
  return { ids, more: ahead.length - ids.length };
};

/** "blocked by s15f82, s15f84 +2" for a glob whose start is held back; null when nothing is. */
export const blockedLine = (glob: GlobView): string | null => {
  const parts = blockedParts(glob);
  if (parts === null) return null;
  const more = parts.more > 0 ? ` +${String(parts.more)}` : '';
  return `blocked by ${parts.ids.join(', ')}${more}`;
};

/** Where what a glob waits for stands, in the board's words. */
const holdState = (state: Holding['state']): string => {
  switch (state) {
    case 'planning':
      return 'Planning';
    case 'open':
      return 'Doing';
    case 'rollout':
      return 'rollout open';
    case 'decided':
      return 'decided';
    case 'merged':
      return 'merged';
    case 'signed_off':
      return 'signed off';
    case 'missing':
      return 'deleted';
  }
};

/** What the tip says glob waits for, each with its state and why: "s15f41 (Planning): uses humanSteps()". */
export const chainTip = (glob: GlobView): string =>
  startHolds(glob)
    .map((h) => `${named(h)} (${holdState(h.state)})${h.reason === null ? '' : `: ${h.reason}`}`)
    .join(', ');

/** One need of a glob, with its state and why it waits. */
export interface NeedRow {
  readonly id: string;
  /** The relation, for the ✕. */
  readonly relationId: string;
  /** Where it stands ("Planning", "Doing", ...); the board's own words. */
  readonly status: string | null;
  readonly why: string;
  /** A recorded relation a person may dismiss with the ✕ (one slop inferred or learned, not already dismissed). */
  readonly dismissible: boolean;
}

/** What the glob view's Dependencies section shows. */
export interface DependencySummary {
  /** What holds the glob's start back, each with where it stands and why. */
  readonly needs: readonly NeedRow[];
  readonly waitedOnBy: readonly string[];
}

/** The Dependencies section's content, or null when there is nothing to list. */
export const dependencySummary = (glob: GlobView): DependencySummary | null => {
  const needs = startHolds(glob).map((h) => ({
    id: h.to,
    relationId: h.relationId,
    status: holdState(h.state),
    why: h.reason ?? (h.toIsDecision ? 'waits for the decision' : 'waits to merge'),
    dismissible: h.source === 'inferred' || h.source === 'learned',
  }));
  const waitedOnBy = glob.waitedOnBy ?? [];
  if (needs.length + waitedOnBy.length === 0) return null;
  return { needs, waitedOnBy };
};

/**
 * The Merge control's warning: the base has moved on since the branch last caught up and no conflict is recorded yet,
 * so slop will merge it into the branch first and stop if it conflicts. Null when nothing is known to be ahead.
 */
export const mergeWarning = (
  glob: Pick<GlobView, 'status' | 'behind' | 'conflict'>,
): string | null => {
  const behind = glob.behind;
  if (glob.status !== 'pr_open' || glob.conflict != null || behind == null || behind.behindBy <= 0)
    return null;
  return `${behind.base} has moved since the checks ran; slop will merge it into the branch first and stop if it conflicts`;
};
