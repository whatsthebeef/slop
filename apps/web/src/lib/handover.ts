import { stripMarkdown } from '@slop/core';
import type { Action, Handover } from '@slop/core';
import type { GlobView } from './api';

/** The actions that hand a glob to a person or a machine; the brief is for whoever can take one. */
const HAND_OVER_ACTIONS: readonly Action[] = ['pick_up', 'take_over', 'start', 'start_anyway'];

/** The brief to show in the glob view, or null: it shows to the implementer and to anyone who can pick up, take over or start. */
export const handoverToShow = (
  glob: Pick<GlobView, 'handover' | 'implementer' | 'allowedActions'>,
): Handover | null => {
  const brief = glob.handover;
  if (brief == null) return null;
  const canHandOver = (glob.allowedActions ?? []).some((a) => HAND_OVER_ACTIONS.includes(a));
  return glob.implementer !== null || canHandOver ? brief : null;
};

/** Said in the Pick up (take_over included) / Start confirmation: "You're taking over because …". */
export const handoverConfirmation = (action: Action, brief: Handover): string => {
  const verb = action === 'take_over' ? 'taking over' : action === 'pick_up' ? 'picking this up' : 'starting this';
  return stripMarkdown(`You're ${verb} because: ${brief.why.join(' ')} First: ${brief.next}`);
};
