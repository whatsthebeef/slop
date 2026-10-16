import { AFTER_MERGE_STAGE, DOWNSTREAM_STAGE, isOpenStep, stageOf } from '@slop/core';
import type { GlobView, ListedHumanStep } from './api';
import { needsRelease, isWorkStep } from './human-steps';
import { stripMarkdown } from './markdown-text';

/** What the "Arm system" label shows: its text and its plain-text tooltip. */
export interface ArmLabel {
  readonly text: string;
  readonly tip: string;
}

/**
 * The label for a glob with a step at release: always the plain "Arm system", the open step's title as the tooltip. A payload
 * without `arm` (an older server) but with an open release step gets the label from its steps; null when nobody has a step at release.
 */
export const armLabel = (glob: Pick<GlobView, 'arm' | 'humanSteps'>): ArmLabel | null => {
  if (glob.arm !== undefined) return { text: 'Arm system', tip: stripMarkdown(glob.arm.title) };
  const step = needsRelease(glob.humanSteps ?? []);
  return step === null ? null : { text: 'Arm system', tip: `A person has a step at release: ${stripMarkdown(step.title)}` };
};

/** One stage's open steps: `stage` is `after_merge` or an environment name. */
export interface StageGroup {
  readonly stage: string;
  readonly steps: readonly ListedHumanStep[];
}

/**
 * The steps grouped by stage, in promotion order: after the merge first, then the board's environments in its order; an
 * environment the board doesn't list comes last, in the order its steps come. A group without steps is left out.
 */
export const stageGroups = (steps: readonly ListedHumanStep[], environments: readonly string[]): StageGroup[] => {
  const order = [AFTER_MERGE_STAGE, ...environments];
  const known = new Map<string, ListedHumanStep[]>();
  const unknown = new Map<string, ListedHumanStep[]>();
  for (const step of steps) {
    const stage = stageOf(step.due);
    const into = order.includes(stage) ? known : unknown;
    into.set(stage, [...(into.get(stage) ?? []), step]);
  }
  return [...order.filter((s) => known.has(s)).map((s) => ({ stage: s, steps: known.get(s) ?? [] })), ...[...unknown].map(([stage, list]) => ({ stage, steps: list }))];
};

/** A group's quiet line: "After the deploy to demo: 2 steps, not due yet". */
export const groupText = (group: StageGroup): string => {
  const n = group.steps.length;
  const noun = `${String(n)} ${n === 1 ? 'step' : 'steps'}`;
  const where =
    group.stage === AFTER_MERGE_STAGE ? 'After the merge' : group.stage === DOWNSTREAM_STAGE ? 'Rest of the pipeline' : `After the deploy to ${group.stage}`;
  return `${where}: ${noun}, not due yet`;
};

/** A glob in Merging (or earlier) with a written step due after the merge: the merge comes first, the rollout after. */
export const hasAfterMergeStep = (steps: readonly ListedHumanStep[] | undefined): boolean =>
  (steps ?? []).some((s) => isOpenStep(s) && isWorkStep(s) && s.predicted !== true && s.due === 'after_merge');

/** What the status and toasts add while a glob with an after-merge step is merging. */
export const ROLLOUT_AFTER_MERGE_TEXT = 'the rollout step comes after';
