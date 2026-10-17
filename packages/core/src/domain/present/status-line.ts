import { OTHER_BOARD_GLOB } from '../relations.js';
import * as machine from '../machine.js';
import { actionState, preparationOf } from '../action-glob.js';
import {
  appliedHolding,
  MERGE_CONFLICT_STALL_LABEL,
  mergeLineTip,
} from '../whose-move.js';
import {
  behindAdvice,
  behindWarning,
  currentBehind,
  checksExplanation,
  readyStatus,
  stuckHint,
} from '../readiness.js';
import { UNTIL_WORDS } from '../relations.js';
import { yourTurn } from '../human-steps.js';
import { stepGroup } from './human-steps.js';
import type { Action } from '../machine.js';
import type { Holding } from '../relations.js';
import type { HumanStepKind, HumanStepViewer, StepAction } from '../human-steps.js';
import type { RelationSource, Role } from '../types.js';
import { stripMarkdown } from './text.js';
import { rolloutLine } from './human-steps.js';
import { hasAfterMergeStep, ROLLOUT_AFTER_MERGE_TEXT } from './rollout-view.js';
import type { PresentableGlob } from './facts.js';
import {
  checksInFlightWhileMerging,
  mergeLineStatus,
  mergingChecksText,
} from './check-wording.js';
import { actionPresentation, type ActionIcon } from './action-presentation.js';

/** One problem on a glob, in plain words: what the card shows in a line and the glob view shows in full. */
export interface StatusLine {
  readonly kind:
    | 'provisioning'
    | 'base-red'
    | 'checks'
    | 'failure'
    | 'investigation-failed'
    | 'start-queued'
    | 'stuck'
    | 'behind'
    | 'ready'
    | 'rollout'
    | 'merging'
    | 'action';
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
  /** `merging`: the glob waits in the board's merge line (not the head): the card shows the hourglass, not the machine. */
  readonly waiting?: true;
}

/**
 * The kinds that mean something is wrong and someone must act: they get the red problem block with a dismiss control. The
 * rest are normal states (merging, checks running, base red, queued, rollout steps due) that the corner status and its
 * tooltip already say, so they never get a block.
 */
const PROBLEM_KINDS: ReadonlySet<StatusLine['kind']> = new Set([
  'provisioning',
  'checks',
  'failure',
  'investigation-failed',
  'stuck',
]);

/** True when the status line is a real problem rather than a normal state. */
export const isProblemLine = (line: Pick<StatusLine, 'kind'>): boolean =>
  PROBLEM_KINDS.has(line.kind);

/** The longest label a Your turn chip shows: one or two words; the step's full title goes in the tooltip. */
const TURN_LABEL_MAX = 24;

/** The one word a person's step shows in the corner, by group: never the step's title. Housekeeping has none. */
const PERSON_WORD: Readonly<Partial<Record<ReturnType<typeof stepGroup>, string>>> = {
  answer: 'question',
  do: 'do',
  decide: 'decide',
};

/** True for an investigate-only run: it never started the glob (`purpose` is absent on implementing runs). */
export const isInvestigateRun = (run: { readonly purpose?: string }): boolean =>
  run.purpose === 'investigate';

/** Cut to one line of at most `max` characters. */
export const oneLine = (text: string, max = 90): string => {
  const line = stripMarkdown(text.split('\n')[0] ?? '');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The first sentence of a stuck hint, without its "Fix: …" advice. */
export const hintSentence = (hint: string): string =>
  (hint.split(/\.\s|\s+Fix:/)[0] ?? hint).replace(/\.$/, '');

/** A prepared action's state in words: who has the ball (the icon) and what it is doing. */
export interface ActionLine {
  readonly state: 'preparing' | 'preparation_failed' | 'ready' | 'recording';
  /** The machine (spinning while it works), a person, or an alert when preparation failed. */
  readonly icon: 'machine-spinning' | 'human' | 'alert';
  readonly text: string;
  readonly tip: string;
  readonly tone: string;
}

/**
 * A recorded (Done) prepared action whose record will not merge by itself: its run failed or conflicted, or its PR is open and
 * neither armed nor queued (red checks, disarmed). A person must fix it and merge; nothing else moves it.
 */
export const recordingStuck = (glob: PresentableGlob): boolean =>
  glob.status === 'failed' ||
  glob.failure != null ||
  glob.conflict != null ||
  (glob.status === 'pr_open' && glob.mergeMode !== 'when_green');

/**
 * Where a prepared action stands (a routine prepares the script or document, the person runs it, then slop records it): preparing,
 * ready to run, recording, or a failed preparation. Null for a plain action, for any other glob, and while it waits to start
 * (the hold line says what it waits for).
 */
export const actionLine = (glob: PresentableGlob): ActionLine | null => {
  const preparation = glob.preparation ?? preparationOf(glob);
  if (glob.category !== 'action' || preparation == null) return null;
  const state = glob.actionState ?? actionState(glob);
  const round = preparation.rounds > 1 ? ` · round ${String(preparation.rounds)}` : '';
  switch (state) {
    case 'preparing':
      return {
        state,
        icon: 'machine-spinning',
        text: `preparing${round}`,
        tip: `The machine is preparing what you will run (round ${String(preparation.rounds)}); it never runs it itself`,
        tone: 'text-muted-foreground',
      };
    case 'preparation_failed': {
      const why = glob.failure?.reason ?? 'The preparation run failed';
      return {
        state,
        icon: 'alert',
        text: 'preparation failed',
        tip: `${why}\nRetry prepares it again on the same branch`,
        tone: 'text-red',
      };
    }
    case 'ready':
      return {
        state,
        icon: 'human',
        text: 'ready to run',
        tip: 'Your turn: run what was prepared, then press Done, or Failed… and paste the output for another round',
        tone: 'text-signal-strong',
      };
    case 'recording':
      if (recordingStuck(glob))
        return {
          state,
          icon: 'human',
          text: 'record stuck',
          tip: 'Done is recorded but the prepared branch is not merging: fix what blocks it (failed checks or a conflict), then merge it',
          tone: 'text-red',
        };
      return {
        state,
        icon: 'machine-spinning',
        text: 'recording',
        tip: 'Done is recorded: slop is merging the prepared branch once the checks pass, then the action closes',
        tone: 'text-muted-foreground',
      };
    default:
      return null;
  }
};

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

/**
 * Every problem and normal state the glob is in, as lines in the order they are pushed (not ranked): the failures, the merge,
 * a queued start, a stall and the base moving on. `statusLine` takes the first for the status; the notice ranks them its own way.
 */
export const statusCandidates = (
  glob: PresentableGlob,
  now: string,
  base?: string,
): { readonly lines: StatusLine[]; readonly acting: ActionLine | null } => {
  const hint = stuckHint(glob, now, glob.gateCheck);
  const checks = checksExplanation(glob);
  const merging = glob.status === 'merging';
  // A merge's own failure moves the glob to failed; any other failure on a merging glob predates the merge request.
  const failure = merging && glob.failure?.kind !== 'merge' ? null : glob.failure;
  const failed = glob.status === 'failed' || failure !== null;
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
  const acting = actionLine(glob);
  const candidates: StatusLine[] = [];
  // A glob with no branch can't do anything else, so this comes before every other problem.
  if (provisioningFailed) {
    candidates.push(make({ kind: 'provisioning', full: reason, tone: 'text-red', tip: reason }));
  }
  // A conflict stops the checks from re-running, so a failure beside it is the conflict's, not a second problem.
  const conflicted = (glob.conflict ?? failure?.conflict ?? null) !== null;
  if (checks !== null && !(conflicted && !checks.inherited)) {
    const details = [checks.text, ...checks.lines.slice(1, 4), checks.url ?? ''].filter(
      (l) => l !== '',
    );
    if (checks.inherited) {
      // Never the inherited failure's text: the short waiting line; the failing test and the run are in the tooltip.
      const base = glob.headChecks?.inheritedFrom?.base ?? 'main';
      candidates.push(
        make({
          kind: 'base-red',
          full: `${base} is red`,
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
  if (merging) {
    const sha = glob.pr?.headSha ?? null;
    const short = sha === null ? 'the PR head' : sha.slice(0, 7);
    // Checks in flight read the shared merging wording ("running checks", or "merging from <base>" while catching up).
    // Waiting in the board's merge line it reads its place instead: only the head merges, and it does no work until its turn.
    const queued = mergeLineStatus(glob);
    const merge =
      queued ?? (checksInFlightWhileMerging(glob) ? mergingChecksText(glob, base) : 'merging');
    // A prepared action's merge is its record being written after Done.
    const full = acting?.state === 'recording' ? `recording · ${merge}` : merge;
    const rollout = hasAfterMergeStep(glob.humanSteps) ? `; ${ROLLOUT_AFTER_MERGE_TEXT}` : '';
    candidates.push(
      make({
        kind: 'merging',
        full,
        tone: 'text-muted-foreground',
        tip:
          queued === null
            ? `Merging ${short}: slop merges it once the checks pass, and stops and says why if they fail${rollout}`
            : `Merging ${short}: waiting in the merge line. ${mergeLineTip(glob.mergeLinePlace?.ahead ?? [])}${rollout}`,
        ...(queued === null ? {} : { waiting: true as const }),
      }),
    );
  }
  if (failed && !provisioningFailed) {
    const tip = `${reason}${/^(Routine run never started|The run's session never reached slop)/.test(failure?.reason ?? '') && session !== null ? `\nSession: ${session}` : ''}`;
    candidates.push(
      make({
        kind: 'failure',
        full: acting?.state === 'preparation_failed' ? `Preparation failed: ${reason}` : reason,
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
  // Start was pressed during an investigation: the glob starts by itself when that run ends.
  if (glob.status === 'planning' && glob.waiting?.investigation !== undefined) {
    const since = run?.startedAt ?? run?.queuedAt;
    const tip = `Start is queued: the glob starts when its investigation finishes${since === undefined ? '' : ` (running since ${new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`} and reuses its result${session === null ? '' : `\nSession: ${session}`}`;
    candidates.push(
      make({
        kind: 'start-queued',
        full: 'Investigating — starts after',
        tone: 'text-muted-foreground',
        tip,
        doing: 'the investigation is running',
        sessionUrl: session,
      }),
    );
  }
  // A Re-run answer that started no work: the run is idle (or gone) and the PR still carries the old plan.
  if (machine.rerunIdle(glob)) {
    candidates.push(
      make({
        kind: 'stuck',
        full: "Re-run didn't start the work",
        tone: 'text-required',
        tip: "Re-run didn't start the work: nothing has been pushed since the plan changed.\nStart runs it again on the current plan",
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
  return { lines: candidates, acting };
};

/** The one problem a glob shows, in plain words, most important first. */
export const statusLine = (
  glob: PresentableGlob,
  now: string,
  viewer?: HumanStepViewer,
  base?: string,
): StatusLine | null => {
  const { lines: candidates, acting } = statusCandidates(glob, now, base);
  // A prepared action with nothing wrong says where it stands (the person's turn, the machine's, or recording).
  if (candidates.length === 0 && acting !== null && acting.state !== 'preparation_failed')
    return make({ kind: 'action', full: acting.text, tone: acting.tone, tip: acting.tip });
  if (candidates.length === 0) {
    const reviewSha = glob.artifacts?.find((a) => a.kind === 'local_review')?.commitSha ?? null;
    const ready = readyStatus(glob, reviewSha, { rolloutSteps: glob.rolloutSteps ?? 0 });
    // Merged with its rollout still open: how far it is, and whose turn.
    const rollout =
      glob.humanSteps === undefined
        ? null
        : rolloutLine(glob, glob.humanSteps, viewer, glob.machineSteps);
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
      const cause =
        stalled === null
          ? null
          : `${stalled.reason.charAt(0).toUpperCase()}${stalled.reason.slice(1)}${stalled.since === null ? '' : ` since ${new Date(stalled.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}`;
      // A person's step (Answer, Do, Decide) reads as one word; its title and the count of the rest are the tooltip's.
      const personWord = 'id' in turn ? PERSON_WORD[stepGroup(turn)] : undefined;
      const moreSteps =
        personWord === undefined || glob.humanSteps === undefined
          ? 0
          : glob.humanSteps.filter(
              (s) => s !== turn && s.state === 'due' && PERSON_WORD[stepGroup(s)] !== undefined,
            ).length;
      const turnAction = 'action' in turn ? turn.action : undefined;
      // The chip names one action; the cause (and that other options are in the glob view) is the tooltip's.
      const tip =
        turn.kind === 'merge' && ready?.kind === 'ready'
          ? ready.tip
          : cause !== null
            ? `${cause}\nOther options are in the glob view`
            : personWord === undefined
              ? turn.title
              : `${oneLine(turn.title)}${moreSteps > 0 ? ` (+${String(moreSteps)} more)` : ''}`;
      return make({
        kind: 'ready',
        full: personWord ?? oneLine(turn.title, TURN_LABEL_MAX),
        turn: turn.kind,
        ...(turnAction === undefined ? {} : { action: turnAction }),
        tone: 'text-signal-strong',
        tip,
      });
    }
  }
  return candidates[0] ?? null;
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

const failedWhy = (glob: PresentableGlob, head: string): string => {
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

/** What an action's Done waits for: the glob that builds its script, or the script itself not being on the base branch yet. */
const actionWaiting = (glob: PresentableGlob, actions: readonly Action[]): Waiting[] => {
  // A prepared action waits to be prepared; a plain one waits to be done.
  const step: Action =
    (glob.preparation ?? preparationOf(glob)) == null ? 'complete_action' : 'prepare_action';
  if (glob.status !== 'planning' || actions.includes(step)) return [];
  const { label, icon } = actionPresentation(step, glob);
  const first = appliedHolding(glob, glob.holding ?? [])[0];
  if (first !== undefined) {
    const tip =
      scriptHoldTip(glob, first) ?? `Waits for ${named(first)} to be ${UNTIL_WORDS[first.until]}`;
    return [
      {
        action: step,
        label,
        icon,
        tip,
        why: `for ${named(first)} to be ${UNTIL_WORDS[first.until]}`,
      },
    ];
  }
  if (glob.script?.onBase !== false) return [];
  const why = `: script not on main yet: ${glob.script.path}`;
  return [{ action: step, label, icon, tip: `Script not on main yet: ${glob.script.path}`, why }];
};

/**
 * Actions the glob is heading for but can't take yet: merging waits for the checks on the PR head, and a super's
 * Merge & keep working and Done wait for the latest implementation record at the head.
 */
export const waitingFor = (
  glob: PresentableGlob,
  actions: readonly Action[],
  role: Role,
): Waiting[] => {
  // Any member may do an action, so its reason is shown whatever the role.
  if (glob.category === 'action') return actionWaiting(glob, actions);
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
    const mergeHolds = appliedHolding(glob, glob.holding ?? []).filter((h) => h.gate === 'merge');
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
            : checks?.sha === head && checks.state === 'passed' && mergeHolds.length > 0
              ? {
                  tip: `Held for ${mergeHolds.map(waitsForWords).join(', ')}: Merge anyway merges it now`,
                  why: `for ${mergeHolds.map(waitsForWords).join(', ')} (Merge anyway skips it)`,
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

/** How many blocking IDs the card and dialog name before folding the rest into "+N". */
const SHOWN_AHEAD = 2;

/**
 * What keeps a glob from starting: its unmet start relations (the server computes them, with the board's old globs read).
 * Only a glob in Planning is held, or a failed one that Retrigger would refuse; once started a start relation holds nothing.
 */
const startHolds = (glob: PresentableGlob): readonly Holding[] =>
  glob.status === 'planning' || glob.status === 'failed'
    ? (glob.holding ?? []).filter((h) => h.gate === 'start')
    : [];

/** What a holding names: the glob ID, or "decision s15k190" / "action s15a3" for human work. */
const named = (h: Pick<Holding, 'to' | 'toIsDecision' | 'toIsAction' | 'external'>): string =>
  h.external?.hidden === true
    ? OTHER_BOARD_GLOB
    : h.toIsDecision
      ? `decision ${h.to}`
      : h.toIsAction === true
        ? `action ${h.to}`
        : h.to;

/** Whether a relation is one a person or an agent added without saying why (inferred, learned, split and automatic ones carry their own). */
export const lacksReason = (r: {
  readonly reason: string | null;
  readonly source: RelationSource;
}): boolean => (r.source === 'person' || r.source === 'agent') && (r.reason ?? '').trim() === '';

/** The tail of a relation's line in a tip: ": <reason>", or " (no reason given)" for a person's or agent's relation without one. */
const reasonTail = (r: {
  readonly reason: string | null;
  readonly source: RelationSource;
}): string =>
  (r.reason ?? '').trim() !== ''
    ? `: ${r.reason ?? ''}`
    : lacksReason(r)
      ? ' (no reason given)'
      : '';

/** What a hold waits for, for a tip: "s15t220 (board Ops) to be merged and rolled out" (the until is spelled out only for `merged`). */
const waitsForWords = (h: Holding): string => {
  const board =
    h.external !== undefined && !h.external.hidden && h.external.boardName !== null
      ? ` (board ${h.external.boardName})`
      : '';
  return `${named(h)}${board}${h.until === 'merged' ? ` to be ${UNTIL_WORDS.merged}` : ''}`;
};

export interface BlockedParts {
  /** The names to say: glob IDs, and "decision <id>" for a decision. */
  readonly ids: readonly string[];
  /** How many more are held back on, not named. */
  readonly more: number;
}

/** What a held glob's line names: "s15f82, decision s15k190 +2". Null when nothing holds its start. */
export const blockedParts = (glob: PresentableGlob): BlockedParts | null => {
  const ahead = startHolds(glob).map(named);
  if (ahead.length === 0) return null;
  // Three or more fold to two names and a count.
  const ids = ahead.length > SHOWN_AHEAD + 1 ? ahead.slice(0, SHOWN_AHEAD) : ahead;
  return { ids, more: ahead.length - ids.length };
};

/** Where what a glob waits for stands, in the board's words. */
const holdState = (state: Holding['state']): string => {
  switch (state) {
    case 'planning':
      return 'Planning';
    case 'open':
      return 'Doing';
    case 'rollout':
      return 'to do';
    case 'decided':
      return 'decided';
    case 'done':
      return 'done';
    case 'merged':
      return 'merged';
    case 'signed_off':
      return 'signed off';
    case 'missing':
      return 'deleted';
  }
};

/** What the tip says glob waits for, each with its state and why: "s15f41 (Planning): uses humanSteps()". */
export const chainTip = (glob: PresentableGlob): string =>
  startHolds(glob)
    .map(
      (h) =>
        `${named(h)}${h.external?.hidden === true ? '' : ` (${holdState(h.state)})`}${h.reason === null ? '' : `: ${h.reason}`}`,
    )
    .join(', ');

export interface HoldLine {
  /** The holder's ID ("s15f145", "decision s15k123"), or "merge held · s15f145" / "sign-off held · s15f145" for a later gate; the other holds are in the tip. */
  readonly text: string;
  /** One line per hold: what it waits for, where that stands and why. */
  readonly tip: string;
  /** A person must decide when the first hold is a decision glob, or acts once an action is free; otherwise the hourglass. */
  readonly icon: 'human' | 'hourglass';
}

const GATE_WORDS = {
  start: { head: 'waiting', tip: 'Waits for' },
  merge: { head: 'merge held', tip: 'Merge waits for' },
  sign_off: { head: 'sign-off held', tip: 'Sign-off waits for' },
} as const;

/**
 * An action held by the glob that builds its script says so: "Its script scripts/x.sh is written by s1t1, which hasn't merged to
 * main yet." Null for any other hold.
 */
const scriptHoldTip = (glob: PresentableGlob, h: Holding): string | null => {
  if (glob.category !== 'action' || h.gate !== 'start' || h.toIsDecision || h.toIsAction === true)
    return null;
  const script = glob.script?.path;
  if (script === undefined && h.reason !== 'builds its script') return null;
  return `Its script${script === undefined ? '' : ` ${script}`} is written by ${h.to}, which hasn't merged to main yet.`;
};

/**
 * What holds the glob where it stands (a relation to another glob or a decision, at any gate): the corner's words and the
 * tooltip. Which holds apply is core's `appliedHolding`, the rule `whoseMove` uses. Null when nothing holds it.
 */
export const holdLine = (glob: PresentableGlob): HoldLine | null => {
  const held = appliedHolding(glob, glob.holding ?? []);
  const [first] = held;
  if (first === undefined) return null;
  return {
    text: first.gate === 'start' ? named(first) : `${GATE_WORDS[first.gate].head} · ${named(first)}`,
    tip: held
      .map(
        (h) =>
          scriptHoldTip(glob, h) ??
          `${GATE_WORDS[h.gate].tip} ${waitsForWords(h)}${h.external?.hidden === true ? '' : ` (${holdState(h.state)})`}${reasonTail(h)}`,
      )
      .join('\n'),
    // A person will do an action once it is free, so it reads as theirs even while it waits.
    icon:
      first.toIsDecision || first.toIsAction === true || glob.category === 'action'
        ? 'human'
        : 'hourglass',
  };
};

/**
 * The tip lines the relation features add to a card: what supersedes it, what waits for it and why ("s1t8 waits: needs the schema"),
 * how many globs on other boards wait, and open suggestions. Each is absent when its field is (an older API sends none).
 */
export const relationTips = (glob: PresentableGlob): string[] => {
  const lines: string[] = [];
  const by = glob.relations?.supersededBy;
  if (by != null)
    lines.push(`Superseded by ${by.hidden === true ? OTHER_BOARD_GLOB : by.id}${reasonTail(by)}`);
  for (const h of glob.holdsBack ?? glob.relations?.holdsBack ?? []) {
    const from = h.external?.hidden === true ? OTHER_BOARD_GLOB : h.from;
    lines.push(`${from} waits${reasonTail(h)}`);
  }
  const others = glob.relations?.waitedOnByOtherBoards ?? 0;
  if (others > 0)
    lines.push(
      `${String(others)} ${others === 1 ? 'glob' : 'globs'} on other boards ${others === 1 ? 'waits' : 'wait'} for this`,
    );
  for (const s of glob.suggestions ?? []) lines.push(`Suggestion: ${s.text}`);
  return lines;
};

export interface WorkstreamLine {
  readonly text: string;
  /** Every workstream with its state (and the files that conflicted). */
  readonly tip: string;
  /** A person acts on a failed workstream or a decision; otherwise the machine is on it. */
  readonly icon: 'human' | 'machine' | 'machine-spinning';
  readonly tone: string;
}

/** Joins names for the corner: the first, plus "+N" for the rest. */
const firstPlus = (names: readonly string[]): string =>
  `${names[0] ?? ''}${names.length > 1 ? ` +${String(names.length - 1)}` : ''}`;

/**
 * The run state of a fanned-out glob's workstreams, while it is being built (not once it is merged). Most pressing first: a
 * failed workstream, one waiting for a decision, an integration conflict, then plain progress. Null for a small glob or when
 * every workstream is done or skipped.
 */
export const workstreamLine = (glob: PresentableGlob): WorkstreamLine | null => {
  if (glob.status !== 'implementing' && glob.status !== 'in_progress' && glob.status !== 'pr_open')
    return null;
  const items = (glob.workstreams?.items ?? []).filter((w) => w.state !== 'skipped');
  if (items.length === 0) return null;
  const inState = (state: string): string[] =>
    items.filter((w) => w.state === state).map((w) => w.name);
  const tip = items
    .map(
      (w) =>
        `${w.name}: ${w.state.replace(/_/g, ' ')}${w.conflicts.length === 0 ? '' : ` (conflicts: ${w.conflicts.join(', ')})`}`,
    )
    .join('\n');
  const failed = inState('failed');
  if (failed.length > 0)
    return { text: `failed · ${firstPlus(failed)}`, tip, icon: 'human', tone: 'text-red' };
  const deciding = inState('waiting_decision');
  if (deciding.length > 0)
    return {
      text: `waiting · decision for ${firstPlus(deciding)}`,
      tip,
      icon: 'human',
      tone: 'text-required',
    };
  const conflicting = items
    .filter((w) => w.state === 'running' && w.conflicts.length > 0)
    .map((w) => w.name);
  if (conflicting.length > 0)
    return {
      text: `integration conflict · ${conflicting.join('+')}`,
      tip,
      icon: 'machine-spinning',
      tone: 'text-muted-foreground',
    };
  const running = items.some((w) => w.state === 'running');
  if (!running && !items.some((w) => w.state === 'not_started')) return null;
  return {
    text: `working · ${String(inState('done').length)}/${String(items.length)} workstreams`,
    tip,
    icon: running ? 'machine-spinning' : 'machine',
    tone: 'text-muted-foreground',
  };
};

/**
 * The Merge control's warning: the base has moved on since the branch last caught up and no conflict is recorded yet,
 * so slop will merge it into the branch first and stop if it conflicts. Null when nothing is known to be ahead.
 */
export const mergeWarning = (
  glob: Pick<PresentableGlob, 'status' | 'behind' | 'conflict' | 'pr'>,
): string | null => {
  const behind = currentBehind(glob);
  if (glob.status !== 'pr_open' || glob.conflict != null || behind == null || behind.behindBy <= 0)
    return null;
  return `${behind.base} has moved since the checks ran; slop will merge it into the branch first and stop if it conflicts`;
};
