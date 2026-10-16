import {
  HUMAN_STEP_GROUP,
  HUMAN_STEP_GROUP_LABEL,
  blockProgress,
  dueText,
  isMerged,
  isOpenStep,
  yourTurn,
} from '../human-steps.js';
import { isInFlight } from '../machine-steps.js';
import { listOf } from '../matrix.js';
import type { Glob } from '../types.js';
import type { HumanStepBlock, HumanStepGroup, HumanStepViewer } from '../human-steps.js';
import type { MachineStep } from '../machine-steps.js';
import type { PresentableGlob, ListedHumanStep } from './facts.js';
import { stripMarkdown } from './text.js';

/** What a step holds back when it is open: a due step that does is the viewer's main action. */
const BLOCKING: readonly HumanStepBlock[] = ['sign_off', 'reviewing', 'dependants'];

/** Steps the machine implies (Merge, Decide) have `machine:` IDs and are done by their own actions; only stored work steps are ticked here. */
export const isWorkStep = (step: Pick<ListedHumanStep, 'id'>): boolean =>
  !step.id.startsWith('machine:');

/**
 * The group a person sees a step in. A machine step takes its kind's group; a stored work step is a Do (a rollout, a once step, an old work kind)
 * unless it is a decision, an answer or a review label.
 */
export const stepGroup = (step: Pick<ListedHumanStep, 'id' | 'kind'>): HumanStepGroup => {
  const group = HUMAN_STEP_GROUP[step.kind];
  return isWorkStep(step) && group === 'housekeeping' ? 'do' : group;
};

/** Slop's own next move (Merge, Fix conflict, Upload, Retry, Pick up): the primary action and the corner status show it, never a step block. */
export const isHousekeeping = (step: Pick<ListedHumanStep, 'id' | 'kind'>): boolean =>
  stepGroup(step) === 'housekeeping';

/** The steps the glob view lists as blocks: Decide, Answer and Do only. */
export const personSteps = (steps: readonly ListedHumanStep[]): ListedHumanStep[] =>
  steps.filter((s) => !isHousekeeping(s));

/** The label a step carries: Decide, Answer or Do. */
export const stepGroupLabel = (step: Pick<ListedHumanStep, 'id' | 'kind'>): string => {
  const group = stepGroup(step);
  return group === 'housekeeping' ? step.kind.replace(/_/g, ' ') : HUMAN_STEP_GROUP_LABEL[group];
};

export const isBlockingStep = (step: Pick<ListedHumanStep, 'blocks'>): boolean =>
  step.blocks.some((b) => BLOCKING.includes(b));

type Subject = Pick<Glob, 'implementer' | 'planner'>;

/** The due, blocking work step that is the viewer's, or null: the glob view's main button and the status line's Your turn. */
export const blockingTurn = (
  steps: readonly ListedHumanStep[],
  glob: Subject,
  viewer: HumanStepViewer | undefined,
): ListedHumanStep | null =>
  viewer === undefined
    ? null
    : yourTurn(
        steps.filter((s) => isWorkStep(s) && isBlockingStep(s) && s.predicted !== true),
        glob,
        viewer,
      );

/** The main button for a due blocking step: "Rollout" for a rollout, the step's title for other kinds. */
export const mainStep = (
  glob: Subject & { readonly humanSteps?: readonly ListedHumanStep[] },
  viewer: HumanStepViewer | undefined,
): { readonly step: ListedHumanStep; readonly label: string } | null => {
  const step = blockingTurn(glob.humanSteps ?? [], glob, viewer);
  return step === null
    ? null
    : { step, label: step.kind === 'rollout' ? 'Rollout' : stripMarkdown(step.title) };
};

/** What the glob view says in place of a predicted rollout's title, state and actions: the run writes the real steps. */
export const PREDICTED_ROLLOUT_TEXT = 'Rollout predicted: the run writes the steps';

/** What a step is called in a sentence: a predicted rollout reads as a prediction, not as its placeholder title. */
const stepName = (step: Pick<ListedHumanStep, 'title' | 'predicted'>): string =>
  step.predicted === true ? PREDICTED_ROLLOUT_TEXT : stripMarkdown(step.title);

/** What a due step's main button does: copy its command, tick it, or wait (disabled, with why). Never just scroll to the section. */
export type StepMain =
  | { readonly kind: 'copy'; readonly label: string; readonly then: string }
  | { readonly kind: 'done'; readonly label: string }
  | { readonly kind: 'wait'; readonly label: string; readonly reason: string };

/**
 * The main action for a due blocking step, by its kind. A step with a capability check is slop's to tick, so the button
 * is disabled with the reason; a script step copies its command (and offers Mark done after); any other step is
 * ticked with Mark done (its text is shown once, in the due-steps block).
 */
export const stepMain = (step: Pick<ListedHumanStep, 'script' | 'check'>): StepMain => {
  if (step.check != null && step.check !== '') {
    return {
      kind: 'wait',
      label: 'Mark done',
      reason: `waits for ${step.check} to turn on; slop ticks this itself`,
    };
  }
  if (step.script != null)
    return { kind: 'copy', label: 'Copy rollout command', then: 'Mark done' };
  return { kind: 'done', label: 'Mark done' };
};

/**
 * The status line for a merged glob whose rollout still holds back its sign-off: "rollout" (the icon says whose turn; the tooltip
 * counts the steps done). It takes the place of "sign off" until the rollout is done. The tooltip lists every open step. Null when nothing
 * is open, the change isn't merged yet, or a deploy of it is still running (where the board tracks deploys, the machine isn't
 * done until it has deployed; the list's `machineSteps` say so, and an API without them reads as no deploy).
 */
export const rolloutLine = (
  glob: Glob,
  steps: readonly ListedHumanStep[],
  viewer: HumanStepViewer | undefined,
  machineSteps?: readonly MachineStep[],
): {
  readonly text: string;
  readonly tip: string;
  readonly turn: ListedHumanStep | null;
} | null => {
  if (!isMerged(glob)) return null;
  if (machineSteps?.some((s) => s.kind === 'deploy' && isInFlight(s)) === true) return null;
  const progress = blockProgress(steps, 'sign_off');
  if (progress.open === 0) return null;
  const turn = blockingTurn(steps, glob, viewer);
  const open = steps.filter(
    (s) => s.source !== 'machine' && s.blocks.includes('sign_off') && isOpenStep(s),
  );
  const [first] = open;
  const done = progress.total - progress.open;
  return {
    text: 'rollout',
    tip: [
      `Merged; ${String(done)} of ${String(progress.total)} rollout steps done${first === undefined ? '' : `: ${stepName(first)}`}`,
      ...open.slice(1).map(stepName),
    ].join('\n'),
    turn,
  };
};

/**
 * The first open step that needs a person at release: a written (not predicted) rollout step, or any work step due after the
 * merge. A done or dismissed step is not open. Null when nobody has a step at release; the card's "Arm system" label.
 */
export const needsRelease = (steps: readonly ListedHumanStep[]): ListedHumanStep | null =>
  steps.find(
    (s) =>
      isOpenStep(s) &&
      isWorkStep(s) &&
      s.predicted !== true &&
      (s.kind === 'rollout' || s.due === 'after_merge'),
  ) ?? null;

/** Why a merged glob's labels can't be approved yet: the first sign-off-blocking step still open, or null when nothing holds them. */
export const approveHold = (
  glob: Glob & { readonly humanSteps?: readonly ListedHumanStep[] },
): string | null => {
  if (glob.status !== 'reviewing') return null;
  const steps = glob.humanSteps ?? [];
  if (blockProgress(steps, 'sign_off').open === 0) return null;
  const first = steps.find(
    (s) => s.source !== 'machine' && s.blocks.includes('sign_off') && isOpenStep(s),
  );
  return `Waits for the rollout${first === undefined ? '' : `: ${stepName(first)}`}`;
};

/**
 * Whether review (the QA, CR and FR blocks and their actions) is open: the glob is in Reviewing, or signed off with its labels
 * kept. A merged glob whose rollout steps are due stays in Doing, and nothing review-related shows until they are done.
 */
export const reviewOpen = (
  glob: Pick<PresentableGlob, 'status'> & Partial<Pick<PresentableGlob, 'list'>>,
): boolean => {
  const list = glob.list ?? listOf(glob.status);
  return list === 'reviewing' || list === 'signed_off';
};

/** The stored work steps that are due now (not predicted): shown as the full block at the top of the glob view. */
export const dueWorkSteps = (steps: readonly ListedHumanStep[]): ListedHumanStep[] =>
  steps.filter((s) => isWorkStep(s) && s.state === 'due' && s.predicted !== true);

/** A step that isn't due yet: a pending work step, which collapses into one quiet line. */
export const isQuietStep = (step: ListedHumanStep): boolean =>
  isWorkStep(step) && step.state === 'pending' && step.predicted !== true;

/** Whether the glob view opens with the steps block at the top: some step is due. */
export const hasDueSteps = (steps: readonly ListedHumanStep[] | undefined): boolean =>
  dueWorkSteps(personSteps(steps ?? []).filter((s) => !isDismissedStep(s))).length > 0;

/** Who a step is for, in words. */
export const whoText = (who: string): string =>
  who === 'anyone' ? 'anyone' : who.includes('@') ? who : `the ${who}`;

/** The state as the section shows it: when a pending step falls due, who ticked a done one. */
export const stateText = (step: ListedHumanStep): string => {
  if (step.predicted === true) return 'predicted by the investigator';
  switch (step.state) {
    case 'due':
      return 'due now';
    case 'pending':
      return `due ${dueText(step.due)}`;
    case 'done':
      return `done${step.doneBy == null ? '' : ` by ${step.doneBy}`}${step.doneAt == null ? '' : ` on ${step.doneAt.slice(0, 10)}`}`;
    case 'dismissed':
      return 'dismissed';
  }
};

/** The command that runs a repo script: `bash <path>`, which works whether or not the file is executable. */
export const scriptRunCommand = (path: string): string => `bash ${path}`;

/** Whether a command runs the repo script at `path`: `bash <path>`, `sh <path>`, `./<path>` or the bare path, with or without flags. */
export const runsScript = (command: string, path: string): boolean => {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:(?:bash|sh|zsh)\\s+)?(?:\\./)?${escaped}(?:\\s|$)`).test(command.trim());
};

/** A command that sets up a run (checkout, pull, sign-in, export, cd); the script runs after the leading ones. */
const SETUP_COMMAND =
  /^\s*(?:git\s+(?:checkout|switch|pull|fetch|merge)\b|cd\b|aws\s+sso\s+login\b|gh\s+auth\s+login\b|export\b)/;

/** One line of a step's Run list: the command, and whether it runs the step's script (it then carries the "View script" link). */
export interface RunLine {
  readonly command: string;
  readonly script: boolean;
}

/**
 * A step's Run list in the order a person runs it. Commands that already run the script's path are shown as written (the script is
 * not added again); otherwise the script's run command goes after the leading setup commands and before the rest.
 */
export const runLines = (commands: readonly string[], scriptPath: string | null): RunLine[] => {
  if (scriptPath === null) return commands.map((command) => ({ command, script: false }));
  const lines = commands.map((command) => ({ command, script: runsScript(command, scriptPath) }));
  if (lines.some((line) => line.script)) return lines;
  const at = commands.findIndex((command) => !SETUP_COMMAND.test(command));
  const run = { command: scriptRunCommand(scriptPath), script: true };
  return at === -1 ? [...lines, run] : [...lines.slice(0, at), run, ...lines.slice(at)];
};

/** Where a repo script is on GitHub: at the base branch once the glob has merged (the squash commit is there), else at the PR's head; null without a repo. */
export const scriptSourceUrl = (
  repo: string | null | undefined,
  path: string,
  ref: string | null | undefined,
): string | null =>
  repo == null || repo === '' || ref == null || ref === ''
    ? null
    : `https://github.com/${repo}/blob/${ref}/${path}`;

/** Steps a person dismissed: kept in the data, listed apart from the live ones, and never counted. */
export const isDismissedStep = (step: Pick<ListedHumanStep, 'state'>): boolean =>
  step.state === 'dismissed';

/** Who dismissed a step and when, in words: "by ann@x.com on 2026-10-15"; empty when the step predates the record. */
export const dismissalText = (step: Pick<ListedHumanStep, 'doneBy' | 'doneAt'>): string =>
  `${step.doneBy == null ? '' : `by ${step.doneBy}`}${step.doneAt == null ? '' : `${step.doneBy == null ? '' : ' '}on ${step.doneAt.slice(0, 10)}`}`;
