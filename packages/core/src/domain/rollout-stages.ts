import { PREDICTED_ROLLOUT_TITLE, defaultStepBlocks, isOpenStep } from './human-steps.js';
import type { HumanStep, HumanStepBlock, HumanStepDue, StoredHumanStep } from './human-steps.js';
import type { RolloutStep } from './rollout.js';
import type { Board } from './types.js';

/**
 * Rollout stages: the places a change has to be rolled out, in promotion order. The first is "after the merge" (the base
 * branch); then the board's dev environments, in the order the board lists them; the last is "downstream", the rest of the
 * pipeline (int, staging, prod), which slop never tracks and a person ticks. A rollout step belongs to the stage its `due`
 * names. "Arm system" shows while any rollout step is open; it names no environment.
 */

/** The stage key of steps due after the merge (they are named after the board's base branch for people). */
export const AFTER_MERGE_STAGE = 'after_merge';

/** The stage key of downstream steps: the rest of the pipeline after the dev environments. Not an environment of the board. */
export const DOWNSTREAM_STAGE = 'downstream';

/** The stage a step belongs to: `downstream`, the environment of an `after_deploy:<env>` step, or `after_merge`. A step due now, or once, counts as after the merge. */
export const stageOf = (due: HumanStepDue): string =>
  due === 'downstream' ? DOWNSTREAM_STAGE : due.startsWith('after_deploy:') ? due.slice('after_deploy:'.length) : AFTER_MERGE_STAGE;

/** The stages of the board in promotion order: after the merge, then each of its dev environments (downstream is not one). */
export const rolloutStages = (board: Pick<Board, 'environments'>): string[] => [AFTER_MERGE_STAGE, ...board.environments.map((e) => e.name)];

/** When a step written in a `## Rollout` section falls due and what it holds back: its `env` and `blocks`, else the defaults for its due. */
export const rolloutWhen = (
  step: Pick<RolloutStep, 'env' | 'blocks'> & { readonly once?: boolean; readonly downstream?: readonly string[] | null },
): { readonly due: HumanStepDue; readonly blocks: readonly HumanStepBlock[] } => {
  // A downstream step holds nothing back whatever it says: slop never sees the deploys it waits for.
  if (step.downstream != null) return { due: 'downstream', blocks: [] };
  const due: HumanStepDue = step.once === true ? 'once' : step.env === null ? 'after_merge' : `after_deploy:${step.env}`;
  return { due, blocks: step.blocks ?? defaultStepBlocks(due) };
};

/** What the label shows: plain "Arm system", and the title of the open step behind it. */
export interface Arm {
  readonly title: string;
}

type ArmStep = Pick<HumanStep, 'kind' | 'title' | 'state' | 'due' | 'source' | 'predicted'>;

/** An open written work step is what arms the system: not a machine step, not the investigator's prediction, not done or dismissed. */
const arms = (s: ArmStep): boolean => isOpenStep(s) && s.source === 'work' && s.predicted !== true && (s.kind === 'rollout' || s.due !== 'now');

/**
 * The title of the first open, written work step, in promotion order (after the merge and dev environments in the order the
 * steps come, downstream last); null when nothing is open. A step for an environment the board doesn't list sorts with the
 * steps before downstream.
 */
export const armOf = (steps: readonly ArmStep[]): Arm | null => {
  const open = steps.filter(arms);
  const first = open.find((s) => s.due !== 'downstream') ?? open[0];
  return first === undefined ? null : { title: first.title };
};

/** `armOf` as the views carry it. */
export const armView = (steps: readonly ArmStep[]): Arm | null => armOf(steps);

/** Whether an open stored step would arm the system, for lists that only have the stored steps (the board's signed-off cap). */
export const armsStored = (s: Pick<StoredHumanStep, 'kind' | 'state' | 'due' | 'origin' | 'title'>): boolean =>
  s.state === 'open' && !(s.origin === 'investigation' && s.title === PREDICTED_ROLLOUT_TITLE) && (s.kind === 'rollout' || s.due !== 'now');
