import * as machine from '../machine.js';
import type { Action } from '../machine.js';
import type { PresentableGlob } from './facts.js';

/** Who does the work: the machine (slop or its agents) or a human in their own session. No icon for bookkeeping or destructive actions. */
export type ActionIcon = 'machine' | 'human';

/** Where the glob view puts an action: a candidate for the main button, the More menu, or the Reset area. */
export type ActionPlacement = 'main' | 'more' | 'reset' | 'none';

export interface ActionPresentation {
  readonly label: string;
  readonly icon: ActionIcon | null;
  /** One line: the tooltip, the menu description and the card move's description. */
  readonly tip: string;
  readonly placement: ActionPlacement;
}

type Subject = Pick<PresentableGlob, 'type' | 'status' | 'implementer' | 'pr'> &
  Partial<
    Pick<
      PresentableGlob,
      'headChecks' | 'artifacts' | 'currentRun' | 'rolloutSteps' | 'actionState' | 'buildFailed'
    >
  >;

/** Whether Fix checks fixes a failed branch build (Retry): the glob has one, and the checks at the PR head have not failed. */
export const fixesBuild = (glob: Subject): boolean => {
  const head = glob.pr?.headSha ?? null;
  const checksFailed =
    head !== null && glob.headChecks?.sha === head && glob.headChecks.state === 'failed';
  return glob.buildFailed != null && !checksFailed;
};

/**
 * Whether Review code, when offered, retries slop's automatic review: a merged glob with no after-merge review, or a ready
 * same with no before-merge review at the PR head. The server only offers it then, or to a person's own same or super.
 */
export const isReviewRetry = (glob: Subject): boolean => {
  const pr = glob.pr;
  if (pr === null || (pr.state !== 'merged' && !(pr.state === 'ready' && glob.type !== 'sub')))
    return false;
  return !(glob.artifacts ?? []).some(
    (a) =>
      a.review !== undefined &&
      (pr.state === 'merged'
        ? a.review.stage === 'post_merge'
        : a.review.stage === 'pre_merge' && machine.sameCommit(a.review.headSha, pr.headSha)),
  );
};

const prRef = (glob: Subject): string => (glob.pr === null ? 'the PR' : `PR #${glob.pr.number}`);

/** What Discard does to the glob's PR and branch. */
const discardTip = (glob: Subject, then: string): string =>
  `${glob.pr === null ? 'Deletes' : `Closes ${prRef(glob)} and deletes`} the branch${then}`;

/**
 * The one place an action's name, icon, tooltip and placement come from, so the glob view, the card moves
 * and every hint say the same thing. A few actions mean different things by glob state: Start now vs Start
 * (start_anyway), three kinds of Pick up, and three kinds of Discard.
 */
/** The line a Merge tooltip or confirmation adds when the glob has rollout steps: it is merged, then stays open for them. */
const mergeRolloutNote = (glob: { readonly rolloutSteps?: number }): string => {
  const n = glob.rolloutSteps ?? 0;
  return n > 0
    ? `. Then run its ${String(n)} rollout step${n === 1 ? '' : 's'} (it stays open until they're done)`
    : '';
};

export const actionPresentation = (
  action: Action,
  glob: Subject,
  decision = false,
  viewer?: string,
): ActionPresentation => {
  switch (action) {
    case 'start': {
      // An investigation is running: Start queues behind it, so no second one runs.
      const run = glob.currentRun;
      const investigating = run != null && run.purpose === 'investigate' && run.state !== 'ended';
      return {
        label: investigating ? 'Start after investigation' : 'Start',
        icon: 'machine',
        tip: investigating
          ? 'The machine implements it when the running investigation finishes, and reuses its result'
          : 'The machine implements it',
        placement: 'main',
      };
    }
    case 'start_anyway':
      // On a glob a person picked up, it is a hand-over to the machine; in Planning it jumps what the glob waits for.
      return glob.status === 'in_progress'
        ? {
            label: 'Start',
            icon: 'machine',
            tip: `The machine takes over${glob.implementer === null ? '' : ` from ${glob.implementer}`}`,
            placement: 'more',
          }
        : {
            label: 'Start now',
            icon: 'machine',
            tip: 'Starts before what it waits for has merged; its branch lacks their changes',
            placement: 'more',
          };
    case 'merge_anyway':
      return {
        label: 'Merge anyway',
        icon: 'machine',
        tip: 'Merges although a relation holds it back: you say why, the relation is marked overridden and who did it is recorded',
        placement: 'more',
      };
    case 'sign_off_anyway':
      return {
        label: 'Sign off anyway',
        icon: 'human',
        tip: 'Signs off although a relation holds it back: you say why, the relation is marked overridden and who did it is recorded',
        placement: 'more',
      };
    case 'pick_up':
      return glob.status === 'planning'
        ? {
            label: 'Pick up',
            icon: 'human',
            tip:
              glob.type === 'super'
                ? 'You pair on it with the product owner: copies the sstor command that opens the pairing session'
                : 'You implement it in your own session',
            // A super is paired on and a decision is decided by a person, so picking it up is the next step.
            placement: glob.type === 'super' || decision ? 'main' : 'more',
          }
        : glob.implementer !== null && glob.implementer === viewer
          ? {
              // Your own glob: no state change, it reopens your session (the main step while nothing else is moving it).
              label: 'Resume',
              icon: 'human',
              tip: 'Reopens your session on this glob',
              placement: 'main',
            }
          : {
              label: 'Pick up',
              icon: 'human',
              tip: `You take it over from ${glob.implementer ?? 'the machine'}`,
              placement: 'more',
            };
    case 'take_over':
      return {
        label: 'Pick up',
        icon: 'human',
        tip: 'Stops the machine run; you continue on its branch',
        placement: 'more',
      };
    case 'retrigger':
      return {
        label: 'Retry',
        icon: 'machine',
        tip: 'A new machine run on the same branch',
        placement: 'main',
      };
    case 'retry_autofix': {
      // Offered for a failed branch build (and no failed checks to fix): a fix run that reads the build log.
      if (fixesBuild(glob))
        return {
          label: 'Retry',
          icon: 'machine',
          tip: 'A machine run fixes the failed build, reading its build log',
          placement: 'main',
        };
      return {
        label: 'Fix checks',
        icon: 'machine',
        tip: 'The machine watches the PR and fixes the failed checks',
        placement: 'main',
      };
    }
    case 'resolve_conflict':
      return {
        label: 'Fix conflict',
        icon: 'machine',
        tip: 'A machine run merges the base branch into this branch, resolves the conflicts and pushes; a failed attempt can be tried again',
        placement: 'main',
      };
    case 'retry_checks':
      return {
        label: 'Retry checks',
        icon: 'machine',
        tip: 'Runs the failed checks of this head again; the glob merges when they pass',
        placement: 'main',
      };
    case 'retry_merge':
      return {
        label: 'Retry merge',
        icon: 'machine',
        tip: 'Tries the merge again',
        placement: 'main',
      };
    case 'mark_ready':
      return {
        label: 'Done',
        icon: 'human',
        tip: 'Takes the PR out of draft. A sub then merges by itself; a same or super waits for Merge',
        placement: 'main',
      };
    case 'merge': {
      // Checks not passed on the head (pending or not reported): Merge arms "merge when checks pass" and lands nothing yet.
      const head = glob.pr?.headSha ?? null;
      const passed =
        head !== null && glob.headChecks?.sha === head && glob.headChecks.state === 'passed';
      return passed
        ? {
            label: 'Merge',
            icon: 'machine',
            tip: `Squash-merges ${prRef(glob)}${mergeRolloutNote(glob)}`,
            placement: 'main',
          }
        : {
            label: 'Merge when checks pass',
            icon: 'machine',
            tip: `Slop merges automatically if the checks on ${head === null ? 'the head' : head.slice(0, 7)} go green; it stops and tells you if they fail or the branch conflicts`,
            placement: 'main',
          };
    }
    case 'cancel_merge':
      return {
        label: 'Cancel merge',
        icon: null,
        tip: 'Stops waiting for the checks, or takes the glob out of the merge line; the PR stays open and Merge comes back',
        placement: 'more',
      };
    case 'merge_continue':
      // A same is never offered it (Merge covers its rollout steps); this only reads an old alias as Merge.
      // A super keeps Merge (final) as its main step; this is its menu item.
      if (glob.type !== 'super')
        return {
          label: 'Merge',
          icon: 'machine',
          tip: `Squash-merges ${prRef(glob)}`,
          placement: 'main',
        };
      return {
        label: 'Merge & keep working',
        icon: 'machine',
        tip: 'Lands what is done; the glob stays in Doing for a new PR',
        placement: 'more',
      };
    case 'investigate':
      return {
        label: 'Investigate plan',
        icon: 'machine',
        tip: 'Reads the plan and the code and attaches proposals; no branch or commits',
        placement: 'more',
      };
    case 'review_now':
      return {
        label: isReviewRetry(glob) ? 'Retry review' : 'Review code',
        icon: 'machine',
        tip: isReviewRetry(glob)
          ? "The automatic independent review is missing for this commit: an independent model reviews the PR's code again and posts findings; never blocks merging"
          : "An independent model reviews the PR's code as it would land on the base branch and posts findings; never blocks merging",
        placement: 'more',
      };
    case 'start_again':
      return {
        label: 'Discard and back to Planning',
        icon: null,
        tip: `${discardTip(glob, '')}; the glob goes back to Planning and nothing starts`,
        placement: 'reset',
      };
    case 'delete':
      return { label: 'Delete', icon: null, tip: 'Deletes the glob', placement: 'reset' };
    case 'decide':
      return {
        label: 'Approve change',
        icon: 'human',
        tip: 'Approves the proposed change as drafted',
        placement: 'main',
      };
    case 'sign_off':
      return {
        label: 'Sign off',
        icon: 'human',
        tip: 'Confirms the decision is final; it moves to Signed Off',
        placement: 'main',
      };
    case 'reopen':
      return {
        label: 'Reopen',
        icon: null,
        // A decision has no PR: its Reopen is the plain one; a merged glob starts its next generation.
        tip:
          decision || glob.pr === null
            ? 'Reopens the decision'
            : 'Sends the merged glob back to Doing as a new generation, with a reason; approvals are cleared',
        placement: 'more',
      };
    case 'complete_action':
      return {
        label: 'Done',
        icon: 'human',
        tip:
          glob.actionState === 'ready'
            ? 'You ran it and it worked: slop records what was prepared and closes the action, with a note of what you checked if you like'
            : 'You did it: marks the action done, with a note of what you checked if you like',
        placement: 'main',
      };
    case 'prepare_action':
      return glob.actionState === 'preparation_failed'
        ? {
            label: 'Retry',
            icon: 'machine',
            tip: 'A new preparation run on the same branch',
            placement: 'main',
          }
        : {
            label: 'Prepare',
            icon: 'machine',
            tip: 'The machine writes the script or document you then run; it never runs it itself',
            placement: 'main',
          };
    case 'fail_action':
      return {
        label: 'Failed…',
        icon: null,
        tip: 'It did not work: paste the output (secrets are masked) and the machine prepares another round on the same branch',
        placement: 'more',
      };
    case 'dismiss_action':
      return {
        label: 'Dismiss…',
        icon: null,
        tip: 'Not needed after all: ends the action with your reason, and what waited for it is released',
        placement: 'more',
      };
    // Replaced by the type popover.
    case 'deescalate':
      return {
        label: 'Make it a sub',
        icon: 'machine',
        tip: 'Clears "needs a human"; the machine merges it itself',
        placement: 'none',
      };
    case 'make_super':
      return {
        label: 'Pair on it',
        icon: 'human',
        tip: 'A human pairs with the machine',
        placement: 'none',
      };
  }
};

/**
 * The actions a glob offers, as the glob view, the card moves and the chips show them. pick_up and take_over are both
 * labelled Pick up; when both are allowed a run is live, so only take_over (which stops it) is offered.
 */
export const presentedActions = <A extends string>(allowed: readonly A[]): A[] =>
  allowed.filter((a) => !(a === ('pick_up' as string) && allowed.includes('take_over' as A)));

/** An action's name for this glob. */
export const actionLabel = (action: Action, glob: Subject): string =>
  actionPresentation(action, glob).label;

/** What an action would stop, so the board can ask first; empty when nothing is halted. */
export const haltedBy = (
  glob: Pick<PresentableGlob, 'currentRun' | 'pr' | 'branch' | 'implementer'>,
  action: Action,
): string[] => {
  const runLive = glob.currentRun !== null && glob.currentRun.state !== 'ended';
  // A queued or standby run holds nothing unpushed, so only an active one is worth asking about.
  if (action === 'take_over')
    return glob.currentRun?.state === 'active' ? ['the machine run in progress'] : [];
  if (action !== 'start_again') return [];
  return [
    ...(runLive ? ['the machine run in progress'] : []),
    ...(glob.pr !== null
      ? [`PR #${glob.pr.number} (closed) and the ${glob.branch} branch (deleted)`]
      : []),
    ...(glob.implementer !== null ? [`${glob.implementer} as implementer`] : []),
  ];
};
