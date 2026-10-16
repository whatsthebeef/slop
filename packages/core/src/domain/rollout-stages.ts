import { PREDICTED_ROLLOUT_TITLE, defaultStepBlocks, isOpenStep } from './human-steps.js';
import type { HumanStep, HumanStepBlock, HumanStepDue, StoredHumanStep } from './human-steps.js';
import type { RolloutStep } from './rollout.js';
import type { Board } from './types.js';

/**
 * Rollout stages: the places a change has to be rolled out, in promotion order. The first is "after the merge" (the base
 * branch); the others are the board's environments, in the order the board lists them. A rollout step belongs to the
 * stage its `due` names, and the "Arm system" label names the first stage that still has an open step.
 */

/** The stage key of steps due after the merge (they are named after the board's base branch for people). */
export const AFTER_MERGE_STAGE = 'after_merge';

/** The stage a step belongs to: `after_merge`, or the environment of an `after_deploy:<env>` step. A step due now, or once, counts as after the merge. */
export const stageOf = (due: HumanStepDue): string => (due.startsWith('after_deploy:') ? due.slice('after_deploy:'.length) : AFTER_MERGE_STAGE);

/** The stages in promotion order: after the merge, then each of the board's environments. */
export const rolloutStages = (board: Pick<Board, 'environments'>): string[] => [AFTER_MERGE_STAGE, ...board.environments.map((e) => e.name)];

/** When a step written in a `## Rollout` section falls due and what it holds back: its `env` and `blocks`, else the defaults for its due. */
export const rolloutWhen = (step: Pick<RolloutStep, 'env' | 'blocks'> & { readonly once?: boolean }): { readonly due: HumanStepDue; readonly blocks: readonly HumanStepBlock[] } => {
  const due: HumanStepDue = step.once === true ? 'once' : step.env === null ? 'after_merge' : `after_deploy:${step.env}`;
  return { due, blocks: step.blocks ?? defaultStepBlocks(due) };
};

/** What the label shows: the stage's name (an environment, or the base branch for after-merge) and the title of its first open step. */
export interface Arm {
  readonly stage: string;
  readonly title: string;
}

type ArmStep = Pick<HumanStep, 'kind' | 'title' | 'state' | 'due' | 'source' | 'predicted'>;

/** An open written work step is what arms the system: not a machine step, not the investigator's prediction, not done or dismissed. */
const arms = (s: ArmStep): boolean => isOpenStep(s) && s.source === 'work' && s.predicted !== true && (s.kind === 'rollout' || s.due !== 'now');

/**
 * The first stage in `order` with an open, written work step, and that step's title; null when nothing is open. The
 * result's `stage` is a stage key (`after_merge` or an environment name). A step for an environment the board doesn't
 * list is in a stage after the listed ones, in the order the steps come.
 */
export const armOf = (steps: readonly ArmStep[], order: readonly string[]): Arm | null => {
  let best: { rank: number; arm: Arm } | null = null;
  for (const step of steps) {
    if (!arms(step)) continue;
    const stage = stageOf(step.due);
    const index = order.indexOf(stage);
    const rank = index === -1 ? order.length : index;
    if (best === null || rank < best.rank) best = { rank, arm: { stage, title: step.title } };
  }
  return best?.arm ?? null;
};

/** `armOf` for a board, as the views carry it: the after-merge stage is named by the base branch. */
export const armView = (steps: readonly ArmStep[], board: Pick<Board, 'environments' | 'baseBranch'>): Arm | null => {
  const arm = armOf(steps, rolloutStages(board));
  return arm === null ? null : { stage: arm.stage === AFTER_MERGE_STAGE ? board.baseBranch : arm.stage, title: arm.title };
};

/** Whether an open stored step would arm the system, for lists that only have the stored steps (the board's signed-off cap). */
export const armsStored = (s: Pick<StoredHumanStep, 'kind' | 'state' | 'due' | 'origin' | 'title'>): boolean =>
  s.state === 'open' && !(s.origin === 'investigation' && s.title === PREDICTED_ROLLOUT_TITLE) && (s.kind === 'rollout' || s.due !== 'now');
