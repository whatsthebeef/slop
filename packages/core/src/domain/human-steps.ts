import { actionState } from './action-glob.js';
import { doThisCommands, fetchCommandFor } from './action-script.js';
import { isActionAttributes, isDecisionAttributes } from './attributes.js';
import type { Action } from './machine.js';
import { listOf } from './matrix.js';
import { MAX_QUESTIONS, isOpenQuestion, questionLine, startQuestions, mergeQuestions } from './questions.js';
import type { Glob, List, Role } from './types.js';

/**
 * Human steps: everything only a person can do on a glob, as one list. Two sources feed it. Steps the state machine
 * implies (merge a ready same, decide or sign off a decision, resolve a conflict nobody else will, pair on a super,
 * upload a missing file) are derived from the glob on every read and never stored. Work steps (a rollout, or a step a
 * person adds) are stored, and `humanSteps` merges both. The card, the glob view and Your turn all read that one result.
 */

export const HUMAN_STEP_KINDS = [
  'resolve_conflict',
  /** An open question that holds the glob's start or merge: a person answers or dismisses it. */
  'answer',
  'merge',
  'done',
  'upload_file',
  'decide',
  'sign_off',
  'pair',
  'rollout',
  'review_label',
  /** An open action glob: a person does it, then marks it done. */
  'action',
  'unstick',
] as const;
export type HumanStepKind = (typeof HUMAN_STEP_KINDS)[number];

/**
 * The three kinds of step a person sees, and slop's own housekeeping. Decide: a decision glob's outcome or a review label. Answer: a question
 * within the glob. Do: a command or task (a rollout, a once step, an action glob). Housekeeping (merge, a conflict, an upload, a stuck run,
 * pairing, marking ready, signing off) are slop's own next moves: the primary action and the corner status show them, never a step block.
 */
export const HUMAN_STEP_GROUPS = ['decide', 'answer', 'do', 'housekeeping'] as const;
export type HumanStepGroup = (typeof HUMAN_STEP_GROUPS)[number];

/** Each step kind's group, in one table: the web and the board's "needs you" logic read it. The kinds themselves are unchanged. */
export const HUMAN_STEP_GROUP: Readonly<Record<HumanStepKind, HumanStepGroup>> = {
  decide: 'decide',
  review_label: 'decide',
  answer: 'answer',
  rollout: 'do',
  action: 'do',
  resolve_conflict: 'housekeeping',
  merge: 'housekeeping',
  done: 'housekeeping',
  upload_file: 'housekeeping',
  sign_off: 'housekeeping',
  pair: 'housekeeping',
  unstick: 'housekeeping',
};

/** What a person sees a step as: Decide, Answer or Do. Housekeeping has no label because it is never shown as a step. */
export const HUMAN_STEP_GROUP_LABEL: Readonly<Record<Exclude<HumanStepGroup, 'housekeeping'>, string>> = { decide: 'Decide', answer: 'Answer', do: 'Do' };

/** Whether a step is slop's own next move (Merge, Fix conflict, Upload, Retry, Pick up) rather than something a person decides, answers or does. */
export const isHousekeepingStep = (step: Pick<HumanStep, 'kind'>): boolean => HUMAN_STEP_GROUP[step.kind] === 'housekeeping';

/** Who a step is for: a role, `anyone`, or one person's email. `admin` means anyone who may decide (an admin or the PO). */
export const HUMAN_STEP_ROLES = ['implementer', 'admin', 'po', 'qa', 'anyone'] as const;
export type HumanStepWho = string;

/**
 * When a step falls due. `after_deploy:<env>` falls due once the step's `dueSince` is set: a recorded deploy of the glob's merge to <env>, or a person's mark.
 * `downstream` is the "also on the rest of the pipeline" step: due once the glob is merged, it blocks nothing and a person ticks it when the change is released further (slop never tracks those deploys).
 * `once` is a one-shot command inside the change: it has no environment, falls due as soon as its script is on the glob's branch
 * (at once when it has none), stays done once done and is never reopened by a later generation.
 */
export type HumanStepDue = 'now' | 'after_merge' | 'once' | 'downstream' | `after_deploy:${string}`;

export const isHumanStepDue = (value: string): value is HumanStepDue =>
  value === 'now' || value === 'after_merge' || value === 'once' || value === 'downstream' || (value.startsWith('after_deploy:') && value.length > 'after_deploy:'.length);

/** The environment an `after_deploy:<env>` step names; null for any other step (a downstream step names none: its wording comes from the board's knowledge doc). */
export const environmentOf = (due: HumanStepDue): string | null => (due.startsWith('after_deploy:') ? due.slice('after_deploy:'.length) : null);

/** The refusal for a step that waits for an environment the board doesn't have, naming the ones it has. */
export const unknownEnvironmentText = (environment: string, known: readonly string[]): string =>
  `Unknown environment ${environment}: this board's environments are ${known.length === 0 ? 'none (it defines no environments, so use after_merge or once)' : known.join(', ')}`;

export const HUMAN_STEP_STATES = ['pending', 'due', 'done', 'dismissed'] as const;
export type HumanStepState = (typeof HUMAN_STEP_STATES)[number];

/** What an open step holds back. */
export const HUMAN_STEP_BLOCKS = ['sign_off', 'reviewing', 'dependants'] as const;
export type HumanStepBlock = (typeof HUMAN_STEP_BLOCKS)[number];

/** A script a step points at: an artifact of the glob (by label) or a path in the repo. */
export type HumanStepScript = { readonly artifact: string } | { readonly path: string };

/** What a step's chip runs: a state-machine action, or opening the run's session (a link, not a state change). */
export type StepAction = Action | 'open_session';

/** The title of the placeholder step the investigator leaves when it predicts a rollout (origin `investigation`). */
export const PREDICTED_ROLLOUT_TITLE = 'Rollout: steps to be written';

export interface HumanStep {
  readonly id: string;
  readonly kind: HumanStepKind;
  /** Short: the action ("Merge", "Roll out the host stack"). */
  readonly title: string;
  /** Markdown, when the title isn't enough. */
  readonly detail: string | null;
  readonly who: HumanStepWho;
  readonly due: HumanStepDue;
  readonly state: HumanStepState;
  readonly blocks: readonly HumanStepBlock[];
  /** A capability slop can verify (checked in a later part); null for steps only a person can confirm. */
  readonly check: string | null;
  readonly script: HumanStepScript | null;
  /** Structured fields of a work step, all plain text: why it is needed (one sentence), the access a person needs, the command lines to run, and how to tell it worked. */
  readonly why: string | null;
  readonly permissions: string | null;
  readonly commands: readonly string[];
  readonly verify: string | null;
  /** `machine`: derived from the glob's state; `work`: stored (added by an agent or a person). */
  readonly source: 'machine' | 'work';
  /** Who ticked it; for a dismissed step, who dismissed it (`slop` for a re-sync). */
  readonly doneBy: string | null;
  /** When it was ticked; for a dismissed step, when it was dismissed. */
  readonly doneAt: string | null;
  /** Why a dismissed step was dismissed; null for any other step. */
  readonly dismissedReason?: string | null;
  /** The investigator's open rollout placeholder: a prediction the run replaces with real steps, not a task anyone can do yet. */
  readonly predicted?: true;
  /** The one action the step's chip runs; its label is the title. Absent when the step needs input in the glob view. */
  readonly action?: StepAction;
  /** The one other action the glob view offers beside `action`; never shown on the card. */
  readonly alternative?: Action;
  /** The environment this step waits for, when the board no longer (or never did) define it: it can never fall due, so the glob view offers to dismiss or re-point it. */
  readonly unknownEnvironment?: string;
}

/** What a stored work step is in the database: open until it is ticked or dismissed; due-ness is worked out on read. */
export const STORED_STEP_STATES = ['open', 'done', 'dismissed'] as const;
export type StoredStepState = (typeof STORED_STEP_STATES)[number];

export interface StoredHumanStep {
  readonly id: string;
  readonly boardId: number;
  readonly globId: string;
  readonly kind: HumanStepKind;
  readonly title: string;
  readonly detail: string | null;
  readonly who: HumanStepWho;
  readonly due: HumanStepDue;
  readonly state: StoredStepState;
  readonly blocks: readonly HumanStepBlock[];
  readonly check: string | null;
  readonly script: HumanStepScript | null;
  readonly why: string | null;
  readonly permissions: string | null;
  readonly commands: readonly string[];
  readonly verify: string | null;
  /** What wrote it (`rollout-section`, `investigation`, `person`), so a later write can replace its own steps only. */
  readonly origin: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly doneBy: string | null;
  readonly doneAt: string | null;
  readonly dismissedReason: string | null;
  /** When an `after_deploy:<env>` step fell due (the environment held the glob, or a person marked it deployed); null until then. Sticky: a rollback never clears it. */
  readonly dueSince: string | null;
}

/** What `derivedSteps` can't read from the glob itself. */
export interface HumanStepFacts {
  /** A super's latest implementation record is at its PR's head (Done is open). */
  readonly recordAtHead?: boolean;
  /** File attachments that never arrived, for the upload step. */
  readonly missingUploads?: readonly { readonly key: string; readonly fileName: string }[];
  /** Open rollout steps holding back sign-off (`openRolloutSteps`): a same with any is merged with Merge and continue. */
  readonly rolloutSteps?: number;
  /**
   * The repo paths of once steps' scripts that are on the glob's branch. Absent when the branch wasn't checked (no code host, or it
   * couldn't answer): a once step is then due, since a person isn't held up by a check slop could not make.
   */
  readonly scriptsOnBranch?: ReadonlySet<string>;
  /** A prepared action ready to run: its plan.md (the commands come from `## Do this`) and its script's artifact label, when it has one. */
  readonly actionPlan?: string | null;
  readonly actionArtifactLabel?: string | null;
}

/** The person looking: their email and role on the board. */
export interface HumanStepViewer {
  readonly email: string;
  readonly role: Role;
}

/**
 * Whether merging is a person's turn: a same or super whose PR head has passed checks and has no conflict. Once Merge
 * was pressed ("merge when checks pass" is armed) the step is done and slop holds the ball.
 */
export const canMerge = (glob: Glob): boolean =>
  glob.status === 'pr_open' &&
  glob.type !== 'sub' &&
  glob.mergeMode !== 'when_green' &&
  glob.conflict == null &&
  glob.pr?.headSha != null &&
  glob.headChecks?.sha === glob.pr.headSha &&
  glob.headChecks.state === 'passed';

/** Whether the glob's change is on the base branch: its PR merged, or it moved on to review. */
export const isMerged = (glob: Pick<Glob, 'pr' | 'status'>): boolean =>
  glob.pr?.state === 'merged' || glob.status === 'reviewing' || glob.status === 'signed_off';

const derived = (
  kind: HumanStepKind,
  title: string,
  who: HumanStepWho,
  rest: Partial<Pick<HumanStep, 'detail' | 'blocks' | 'id'>> = {},
): HumanStep => ({
  id: rest.id ?? `machine:${kind}`,
  kind,
  title,
  detail: rest.detail ?? null,
  who,
  due: 'now',
  state: 'due',
  blocks: rest.blocks ?? [],
  check: null,
  script: null,
  why: null,
  permissions: null,
  commands: [],
  verify: null,
  source: 'machine',
  doneBy: null,
  doneAt: null,
});

/** Steps the machine implies for the glob right now. Pure: the glob and the facts in, the steps out. */
export const derivedSteps = (glob: Glob, facts: HumanStepFacts = {}): HumanStep[] => {
  const steps: HumanStep[] = [];
  if (glob.category === 'action') {
    const attributes = glob.attributes !== undefined && isActionAttributes(glob.attributes) ? glob.attributes : null;
    if (glob.status === 'planning' && attributes?.outcome === null && attributes.preparation === undefined) {
      steps.push(derived('action', `Do: ${glob.title}`, attributes.assignee ?? 'anyone', { id: 'machine:action' }));
    }
    // A prepared action in its ready state: the person runs what the routine prepared. The block shows the commands, one per line,
    // the fetch of the script first. Preparing and recording are the machine's turn and have no human step.
    if (attributes?.preparation !== undefined && actionState(glob) === 'ready') {
      const fetch = fetchCommandFor(glob.id, attributes.preparation.record, facts.actionArtifactLabel);
      const commands = [...(fetch === null ? [] : [fetch]), ...doThisCommands(facts.actionPlan ?? '')];
      steps.push({ ...derived('action', `Run: ${glob.title}`, attributes.assignee ?? 'anyone', { id: 'machine:action' }), commands });
    }
    return steps;
  }
  if (glob.category === 'decision') {
    const outcome =
      glob.attributes !== undefined && isDecisionAttributes(glob.attributes) ? glob.attributes.outcome : null;
    if (glob.status === 'in_progress' && (outcome === null || outcome.kind === 'needs_work'))
      steps.push(derived('decide', 'Decide', 'admin'));
    if (glob.status === 'reviewing') steps.push(derived('sign_off', 'Sign off', 'admin'));
    return steps;
  }
  const hasOpenPr =
    glob.pr !== null &&
    (glob.pr.state === 'draft' || glob.pr.state === 'ready') &&
    (glob.status === 'pr_open' || glob.status === 'in_progress');
  // A person who implements the glob fixes its conflict or failed merge themselves: no routine run will.
  const personMergeFailure = glob.failure?.kind === 'merge' && glob.implementer !== null;
  if (glob.implementer !== null && ((hasOpenPr && glob.conflict != null) || personMergeFailure))
    steps.push(derived('resolve_conflict', 'Resolve conflict', 'implementer'));
  const run = glob.runs[glob.runs.length - 1];
  // Merge as the card says it: the button's conditions, and nothing failed or being fixed by a run.
  if (canMerge(glob) && glob.failure === null && run?.state !== 'active') {
    const rollout = glob.type === 'same' && (facts.rolloutSteps ?? 0) > 0;
    steps.push(
      rollout
        ? derived('merge', 'Merge', 'anyone', {
            detail: 'Has rollout steps: Merge merges it, keeps it open and puts the steps up as a checklist to run from master.',
            blocks: ['reviewing'],
          })
        : derived('merge', 'Merge', 'anyone', {
            detail: `Sames and supers are merged by a person: Merge here or sstor -i ${glob.id} --merge.`,
            blocks: ['reviewing'],
          }),
    );
  }
  if (glob.status === 'in_progress' && glob.pr?.state === 'draft' && facts.recordAtHead === true)
    steps.push(derived('done', 'Mark ready', 'implementer'));
  for (const file of facts.missingUploads ?? [])
    steps.push(derived('upload_file', `Upload ${file.fileName}`, 'anyone', { id: `machine:upload_file:${file.key}` }));
  if (glob.type === 'super' && glob.status === 'planning') steps.push(derived('pair', 'Pair', 'anyone'));
  // One step per question that holds the start or the merge: answering or dismissing it is only a person's call.
  for (const q of [...(glob.status === 'planning' ? startQuestions(glob) : []), ...mergeQuestions(glob).filter(isOpenQuestion)].slice(0, MAX_QUESTIONS))
    steps.push(derived('answer', `Answer: ${questionLine(q)}`, 'anyone', { id: `machine:answer:${q.id}` }));
  return steps;
};

/** Whether a once step is due: it has no script in the repo, the glob is merged (so the script is on the base branch), the branch wasn't checked, or the script is on the branch. */
const onceDue = (glob: Pick<Glob, 'pr' | 'status'>, script: HumanStepScript | null | undefined, onBranch: ReadonlySet<string> | undefined): boolean =>
  script == null || !('path' in script) || isMerged(glob) || onBranch === undefined || onBranch.has(script.path);

/**
 * What a stored step is for this glob. After the merge: due once the glob is merged, but not while it is still in Merging
 * (the code host may show the PR merged before slop has moved the glob on). Downstream: due once the glob is merged, like after the merge. After a deploy: due once `dueSince` is set. Once:
 * due as soon as its script is on the branch (see `onceDue`), merged or not.
 */
export const stateOf = (
  glob: Pick<Glob, 'pr' | 'status'>,
  step: Pick<StoredHumanStep, 'state' | 'due' | 'dueSince'> & Partial<Pick<StoredHumanStep, 'script'>>,
  onBranch?: ReadonlySet<string>,
): HumanStepState => {
  if (step.state === 'done') return 'done';
  if (step.state === 'dismissed') return 'dismissed';
  if (step.due === 'now') return 'due';
  if (step.due === 'once') return onceDue(glob, step.script, onBranch) ? 'due' : 'pending';
  if (step.due === 'after_merge' || step.due === 'downstream') return isMerged(glob) && glob.status !== 'merging' ? 'due' : 'pending';
  return step.dueSince !== null ? 'due' : 'pending';
};

/** What a rollout step holds back by default: after the merge, sign-off and dependants; after a deploy or downstream, nothing (a step that says `blocks` keeps it; a downstream step never holds anything back). */
export const defaultStepBlocks = (due: HumanStepDue): readonly HumanStepBlock[] =>
  due.startsWith('after_deploy:') || due === 'downstream' ? [] : ['sign_off', 'dependants'];

const fromStored = (glob: Glob, s: StoredHumanStep, onBranch?: ReadonlySet<string>): HumanStep => ({
  id: s.id,
  kind: s.kind,
  title: s.title,
  detail: s.detail,
  who: s.who,
  due: s.due,
  state: stateOf(glob, s, onBranch),
  blocks: s.blocks,
  check: s.check,
  script: s.script,
  why: s.why,
  permissions: s.permissions,
  commands: s.commands,
  verify: s.verify,
  source: 'work',
  doneBy: s.doneBy,
  doneAt: s.doneAt,
  ...(s.state === 'dismissed' ? { dismissedReason: s.dismissedReason } : {}),
  ...(s.origin === 'investigation' && s.title === PREDICTED_ROLLOUT_TITLE && s.state === 'open' ? { predicted: true as const } : {}),
});

const STATE_RANK: Readonly<Record<HumanStepState, number>> = { due: 0, pending: 1, done: 2, dismissed: 3 };

/**
 * Every step on the glob, derived and stored, most pressing first: due before pending before done, a step that blocks
 * before one that doesn't, then by kind. Dismissed steps are kept (the glob view shows them struck through).
 */
export const humanSteps = (
  glob: Glob,
  facts: HumanStepFacts = {},
  stored: readonly StoredHumanStep[] = [],
): HumanStep[] => {
  const all = [...derivedSteps(glob, facts), ...stored.filter((s) => s.globId === glob.id).map((s) => fromStored(glob, s, facts.scriptsOnBranch))];
  return all
    .map((step, index) => ({ step, index }))
    .sort(
      (a, b) =>
        STATE_RANK[a.step.state] - STATE_RANK[b.step.state] ||
        Number(b.step.blocks.length > 0) - Number(a.step.blocks.length > 0) ||
        HUMAN_STEP_KINDS.indexOf(a.step.kind) - HUMAN_STEP_KINDS.indexOf(b.step.kind) ||
        a.index - b.index,
    )
    .map(({ step }) => step);
};

/** Steps still to do: due or pending. */
export const isOpenStep = (step: Pick<HumanStep, 'state'>): boolean => step.state === 'due' || step.state === 'pending';

/** Whether a step's `who` includes the viewer. The glob says who its implementer is (the planner, while nobody is). */
export const isForViewer = (
  step: Pick<HumanStep, 'who'>,
  glob: Pick<Glob, 'implementer' | 'planner'>,
  viewer: HumanStepViewer,
): boolean => {
  switch (step.who) {
    case 'anyone':
      return true;
    case 'implementer':
      return (glob.implementer ?? glob.planner) === viewer.email;
    case 'admin':
      return viewer.role === 'admin' || viewer.role === 'po';
    case 'po':
      return viewer.role === 'po';
    case 'qa':
      return viewer.role === 'qa';
    default:
      return step.who.toLowerCase() === viewer.email.toLowerCase();
  }
};

/** The steps that are the viewer's to do. */
export const stepsForViewer = <T extends Pick<HumanStep, 'who'>>(
  steps: readonly T[],
  glob: Pick<Glob, 'implementer' | 'planner'>,
  viewer: HumanStepViewer,
): T[] => steps.filter((s) => isForViewer(s, glob, viewer));

/** Your turn: the first due step for the viewer (the list is already most pressing first), or null. */
export const yourTurn = <T extends Pick<HumanStep, 'who' | 'state'>>(
  steps: readonly T[],
  glob: Pick<Glob, 'implementer' | 'planner'>,
  viewer: HumanStepViewer,
): T | null => steps.find((s) => s.state === 'due' && isForViewer(s, glob, viewer)) ?? null;

/** What the card's muted marker says while steps are still pending: their kinds, deduped, and how many steps in all. */
export interface UpcomingSteps {
  readonly kinds: readonly HumanStepKind[];
  readonly count: number;
}

export const upcomingSteps = (steps: readonly Pick<HumanStep, 'kind' | 'state'>[]): UpcomingSteps | null => {
  const pending = steps.filter((s) => s.state === 'pending');
  if (pending.length === 0) return null;
  return { kinds: [...new Set(pending.map((s) => s.kind))], count: pending.length };
};

/** The compact form on board and glob views: enough for the card, the filters and the status line, without detail text. */
export type CompactHumanStep = Pick<HumanStep, 'id' | 'kind' | 'title' | 'state' | 'who' | 'due' | 'blocks' | 'predicted' | 'action' | 'alternative' | 'unknownEnvironment'> &
  Partial<Pick<HumanStep, 'doneBy' | 'doneAt' | 'dismissedReason'>>;

export const compactStep = ({ id, kind, title, state, who, due, blocks, predicted, action, alternative, unknownEnvironment, doneBy, doneAt, dismissedReason }: HumanStep): CompactHumanStep => ({
  id,
  kind,
  title,
  state,
  who,
  due,
  blocks,
  ...(predicted === undefined ? {} : { predicted }),
  ...(action === undefined ? {} : { action }),
  ...(alternative === undefined ? {} : { alternative }),
  ...(unknownEnvironment === undefined ? {} : { unknownEnvironment }),
  // Only a dismissed step carries its closing facts here; a done step's are read from the full step.
  ...(state === 'dismissed' ? { doneBy, doneAt, dismissedReason: dismissedReason ?? null } : {}),
});

/** When a pending step falls due, in words (for tooltips). */
export const dueText = (due: HumanStepDue): string => {
  if (due === 'now') return 'now';
  if (due === 'after_merge') return 'after the merge';
  if (due === 'once') return 'once, when its script is on the branch';
  if (due === 'downstream') return 'when the change is released further down the pipeline';
  return `after the deploy to ${due.slice('after_deploy:'.length)}`;
};

/**
 * How far a block is from clearing: the work steps that hold it back. Only stored (work) steps count; the machine's own
 * steps (Merge blocks Reviewing until the merge happens) clear themselves with the glob's state.
 */
export interface BlockProgress {
  readonly open: number;
  /** Open and done steps for the block; dismissed ones were wrong and don't count. */
  readonly total: number;
}

export const blockProgress = (steps: readonly (Pick<HumanStep, 'state' | 'blocks'> & Partial<Pick<HumanStep, 'source' | 'predicted'>>)[], block: HumanStepBlock): BlockProgress => {
  // A prediction isn't work anyone can do before the merge, so it doesn't count then.
  const holding = steps.filter((s) => s.source !== 'machine' && s.state !== 'dismissed' && s.blocks.includes(block) && !(s.predicted === true && s.state === 'pending'));
  return { open: holding.filter(isOpenStep).length, total: holding.length };
};

/**
 * The real rollout steps still open that hold back sign-off (s15t228): what makes Merge and continue the way a same lands.
 * The investigator's placeholder is a prediction, not a step a person can run, so it doesn't count.
 */
export const openRolloutSteps = (
  stored: readonly Pick<StoredHumanStep, 'state' | 'kind' | 'blocks' | 'origin' | 'title'>[],
): number =>
  stored.filter(
    (s) =>
      s.state === 'open' &&
      s.kind === 'rollout' &&
      s.blocks.includes('sign_off') &&
      !(s.origin === 'investigation' && s.title === PREDICTED_ROLLOUT_TITLE),
  ).length;

/** The refusal and the status text while a glob's rollout holds back its sign-off: "Rollout pending (1 of 3)". */
export const rolloutPending = (progress: BlockProgress): string => `Rollout pending (${progress.open} of ${progress.total})`;

/** What a glob in Doing with rollout steps due says about review: it opens in Reviewing, once the steps are done. */
export const reviewOpensWhenDone = (progress: BlockProgress): string => `${rolloutPending(progress)}: review opens when they're done`;

/** The same, for stored steps (what the machine and the dependants read, with no glob to work due-ness out from). */
export const storedBlockProgress = (stored: readonly Pick<StoredHumanStep, 'state' | 'blocks'>[], block: HumanStepBlock): BlockProgress => {
  const holding = stored.filter((s) => s.state !== 'dismissed' && s.blocks.includes(block));
  return { open: holding.filter((s) => s.state === 'open').length, total: holding.length };
};

/** The list the glob sits in: a merged glob (in Reviewing) whose sign-off is held by open work steps stays in Doing. */
export const listWithSteps = (glob: Pick<Glob, 'status'>, progress: BlockProgress | null): List =>
  glob.status === 'reviewing' && progress !== null && progress.open > 0 ? 'doing' : listOf(glob.status);
