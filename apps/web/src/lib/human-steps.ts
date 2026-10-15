import { blockProgress, dueText, isInFlight, isMerged, isOpenStep, yourTurn } from '@slop/core';
import type { Glob, HumanStepBlock, HumanStepScript, HumanStepViewer, MachineStep } from '@slop/core';
import type { ListedHumanStep } from './api';
import { globPath } from './glob-section';
import { readSectionOpen, writeSectionOpen } from './section-open';

/** What a step holds back when it is open: a due step that does is the viewer's main action. */
const BLOCKING: readonly HumanStepBlock[] = ['sign_off', 'reviewing', 'dependants'];

/** Steps the machine implies (Merge, Decide) have `machine:` IDs and are done by their own actions; only stored work steps are ticked here. */
export const isWorkStep = (step: Pick<ListedHumanStep, 'id'>): boolean => !step.id.startsWith('machine:');

export const isBlockingStep = (step: Pick<ListedHumanStep, 'blocks'>): boolean => step.blocks.some((b) => BLOCKING.includes(b));

type Subject = Pick<Glob, 'implementer' | 'planner'>;

/** The due, blocking work step that is the viewer's, or null: the glob view's main button and the status line's Your turn. */
export const blockingTurn = (steps: readonly ListedHumanStep[], glob: Subject, viewer: HumanStepViewer | undefined): ListedHumanStep | null =>
  viewer === undefined ? null : yourTurn(steps.filter((s) => isWorkStep(s) && isBlockingStep(s) && s.predicted !== true), glob, viewer);

/** The main button for a due blocking step: "Rollout" for a rollout, the step's title for other kinds. */
export const mainStep = (
  glob: Subject & { readonly humanSteps?: readonly ListedHumanStep[] },
  viewer: HumanStepViewer | undefined,
): { readonly step: ListedHumanStep; readonly label: string } | null => {
  const step = blockingTurn(glob.humanSteps ?? [], glob, viewer);
  return step === null ? null : { step, label: step.kind === 'rollout' ? 'Rollout' : step.title };
};

/** What the glob view says in place of a predicted rollout's title, state and actions: the run writes the real steps. */
export const PREDICTED_ROLLOUT_TEXT = 'Rollout predicted: the run writes the steps';

/** What a step is called in a sentence: a predicted rollout reads as a prediction, not as its placeholder title. */
const stepName = (step: Pick<ListedHumanStep, 'title' | 'predicted'>): string => (step.predicted === true ? PREDICTED_ROLLOUT_TEXT : step.title);

/** What a due step's main button does: copy its command, tick it, or wait (disabled, with why). Never just scroll to the section. */
export type StepMain =
  | { readonly kind: 'copy'; readonly label: string; readonly then: string }
  | { readonly kind: 'done'; readonly label: string; readonly text: string | null }
  | { readonly kind: 'wait'; readonly label: string; readonly reason: string };

/**
 * The main action for a due blocking step, by its kind. A step with a capability check is slop's to tick, so the button
 * is disabled with the reason; a script step copies its command (and offers Mark done after); any other step is
 * ticked with Mark done, with its text shown beside it.
 */
export const stepMain = (step: Pick<ListedHumanStep, 'title' | 'detail' | 'script' | 'check'>): StepMain => {
  if (step.check != null && step.check !== '') {
    return { kind: 'wait', label: 'Mark done', reason: `waits for ${step.check} to turn on; slop ticks this itself` };
  }
  if (step.script != null) return { kind: 'copy', label: 'Copy rollout command', then: 'Mark done' };
  const detail = step.detail?.trim();
  return { kind: 'done', label: 'Mark done', text: detail === undefined || detail === '' ? null : detail };
};

/**
 * The status line for a merged glob whose rollout still holds back its sign-off: "rollout 1/3" (steps done of all; the icon says
 * whose turn). It takes the place of "sign off" until the rollout is done. The tooltip lists every open step. Null when nothing
 * is open, the change isn't merged yet, or a deploy of it is still running (where the board tracks deploys, the machine isn't
 * done until it has deployed; the list's `machineSteps` say so, and an API without them reads as no deploy).
 */
export const rolloutLine = (
  glob: Glob,
  steps: readonly ListedHumanStep[],
  viewer: HumanStepViewer | undefined,
  machineSteps?: readonly MachineStep[],
): { readonly text: string; readonly tip: string; readonly turn: ListedHumanStep | null } | null => {
  if (!isMerged(glob)) return null;
  if (machineSteps?.some((s) => s.kind === 'deploy' && isInFlight(s)) === true) return null;
  const progress = blockProgress(steps, 'sign_off');
  if (progress.open === 0) return null;
  const turn = blockingTurn(steps, glob, viewer);
  const open = steps.filter((s) => s.source !== 'machine' && s.blocks.includes('sign_off') && isOpenStep(s));
  const [first] = open;
  const done = progress.total - progress.open;
  return {
    text: `rollout ${String(done)}/${String(progress.total)}`,
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
  steps.find((s) => isOpenStep(s) && isWorkStep(s) && s.predicted !== true && (s.kind === 'rollout' || s.due === 'after_merge')) ?? null;

/** Why a merged glob's labels can't be approved yet: the first sign-off-blocking step still open, or null when nothing holds them. */
export const approveHold = (glob: Glob & { readonly humanSteps?: readonly ListedHumanStep[] }): string | null => {
  if (glob.status !== 'reviewing') return null;
  const steps = glob.humanSteps ?? [];
  if (blockProgress(steps, 'sign_off').open === 0) return null;
  const first = steps.find((s) => s.source !== 'machine' && s.blocks.includes('sign_off') && isOpenStep(s));
  return `Waits for the rollout${first === undefined ? '' : `: ${stepName(first)}`}`;
};

/** One key for every glob: the viewer's last toggle of the Human steps section. */
const STORAGE_KEY = 'slop.human-steps-open';
export const readStepsOpen = (): boolean | null => readSectionOpen(STORAGE_KEY);
export const writeStepsOpen = (open: boolean): void => writeSectionOpen(STORAGE_KEY, open);

/** Starts expanded while a step is still to do (or the link asked for it); an all-done or empty list starts collapsed. */
export const defaultStepsOpen = (steps: readonly ListedHumanStep[]): boolean => steps.some((s) => s.state === 'due' || s.state === 'pending');

/** Who a step is for, in words. */
export const whoText = (who: string): string => (who === 'anyone' ? 'anyone' : who.includes('@') ? who : `the ${who}`);

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

/** The in-app link to a script's artifact (the artifacts section with it selected). */
export const scriptArtifactPath = (boardId: number, globId: string, script: Extract<HumanStepScript, { artifact: string }>): string =>
  globPath(boardId, globId, { section: 'artifacts', artifact: 'rollout_script', label: script.artifact });

/**
 * What the copy button copies. A repo path copies as it is. An artifact script copies its text when the server can
 * read it, and otherwise the link to it (the artifact kind arrives in a later part, so reading may be refused).
 */
export const scriptCopyText = async (
  boardId: number,
  globId: string,
  script: HumanStepScript,
  readScript: (globId: string, label: string) => Promise<string | null>,
  origin: string,
): Promise<string> => {
  if ('path' in script) return script.path;
  const text = await readScript(globId, script.artifact).catch(() => null);
  return text ?? `${origin}${scriptArtifactPath(boardId, globId, script)}`;
};

/** A new step as the form holds it. */
export interface StepDraft {
  readonly title: string;
  readonly detail: string;
  readonly who: string;
  readonly due: string;
}

export const EMPTY_DRAFT: StepDraft = { title: '', detail: '', who: 'anyone', due: 'after_merge' };

/** What the add form sends: trimmed, with empty optional fields left out; null while the title is empty. */
export const stepInput = (draft: StepDraft): { title: string; detail?: string; who?: string; due?: string } | null => {
  const title = draft.title.trim();
  if (title === '') return null;
  const detail = draft.detail.trim();
  const who = draft.who.trim();
  return { title, ...(detail === '' ? {} : { detail }), ...(who === '' ? {} : { who }), due: draft.due };
};

/** A dismissal needs a reason; null while it is blank. */
export const dismissReason = (text: string): string | null => (text.trim() === '' ? null : text.trim());
