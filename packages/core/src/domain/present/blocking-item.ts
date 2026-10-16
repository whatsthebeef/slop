import { decisionOf } from '../decision-glob.js';
import { listOf } from '../matrix.js';
import type { HumanStepViewer } from '../human-steps.js';
import type { Role } from '../types.js';
import type { PresentableGlob } from './facts.js';
import { mainStep } from './human-steps.js';
import { holdingQuestionsOf } from './open-questions.js';

/** The block of the glob view that holds the glob's progress for the viewer: its buttons are then the only way forward. */
export type BlockingItem =
  | { readonly kind: 'decision' }
  | { readonly kind: 'question'; readonly id: string }
  | { readonly kind: 'step'; readonly id: string }
  | { readonly kind: 'label' };

/** In Planning the blocks show their content only: the glob-wide Pick up / Start is the one action. */
export const blocksReadOnly = (glob: Pick<PresentableGlob, 'status'>): boolean =>
  glob.status === 'planning';

/**
 * The first block that holds the glob's progress for this viewer, or null: a picked-up decision's outcome, an open question that
 * holds the start or the merge, a due step that blocks sign-off, merge or dependants, or a review label still to approve (in Reviewing).
 * While one exists the actions row shows no primary button and no ▾; in Planning there is none (the blocks have no buttons).
 * `learningOpen` is false for a learning whose outcome is already in (a closed KB item has nothing left to decide).
 */
export const blockingItem = (
  glob: PresentableGlob,
  role: Role,
  viewer: HumanStepViewer | undefined,
  learningOpen = true,
): BlockingItem | null => {
  if (blocksReadOnly(glob)) return null;
  if (
    decisionOf(glob) !== null &&
    glob.status !== 'signed_off' &&
    learningOpen &&
    ((glob.allowedActions ?? []).includes('decide') || role === 'admin' || role === 'po')
  ) {
    return { kind: 'decision' };
  }
  const [question] = holdingQuestionsOf(glob);
  if (question !== undefined) return { kind: 'question', id: question.id };
  const step = mainStep(glob, viewer);
  if (step !== null) return { kind: 'step', id: step.step.id };
  if (
    listOf(glob.status) === 'reviewing' &&
    Object.values(glob.labels).some((state) => state !== 'approved')
  )
    return { kind: 'label' };
  return null;
};
