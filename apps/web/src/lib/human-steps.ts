import { scriptRunCommand } from '@slop/core';
import type { HumanStepScript } from '@slop/core';
import type { ListedHumanStep } from './api';
import { globPath } from './glob-section';
import { readSectionOpen, writeSectionOpen } from './section-open';

export {
  PREDICTED_ROLLOUT_TEXT,
  approveHold,
  blockingTurn,
  dismissalText,
  dueWorkSteps,
  hasDueSteps,
  isBlockingStep,
  isDismissedStep,
  isHousekeeping,
  isQuietStep,
  isWorkStep,
  mainStep,
  needsRelease,
  personSteps,
  reviewOpen,
  rolloutLine,
  scriptRunCommand,
  scriptSourceUrl,
  stateText,
  stepGroup,
  stepGroupLabel,
  stepMain,
  whoText,
} from '@slop/core';
export type { StepMain } from '@slop/core';

/** One key for every glob: the viewer's last toggle of the Human steps section. */
const STORAGE_KEY = 'slop.human-steps-open';
export const readStepsOpen = (): boolean | null => readSectionOpen(STORAGE_KEY);
export const writeStepsOpen = (open: boolean): void => writeSectionOpen(STORAGE_KEY, open);

/** Starts expanded while a step is still to do (or the link asked for it); an all-done or empty list starts collapsed. */
export const defaultStepsOpen = (steps: readonly ListedHumanStep[]): boolean => steps.some((s) => s.state === 'due' || s.state === 'pending');

/** The in-app link to a script's artifact (the artifacts section with it selected). */
export const scriptArtifactPath = (boardId: number, globId: string, script: Extract<HumanStepScript, { artifact: string }>): string =>
  globPath(boardId, globId, { section: 'artifacts', artifact: 'rollout_script', label: script.artifact });

/**
 * What the copy button copies. A repo path copies as the command that runs it (`bash <path>`). An artifact script copies its text when the server can
 * read it, and otherwise the link to it (the artifact kind arrives in a later part, so reading may be refused).
 */
export const scriptCopyText = async (
  boardId: number,
  globId: string,
  script: HumanStepScript,
  readScript: (globId: string, label: string) => Promise<string | null>,
  origin: string,
): Promise<string> => {
  if ('path' in script) return scriptRunCommand(script.path);
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

