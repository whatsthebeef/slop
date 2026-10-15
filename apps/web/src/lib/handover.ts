import type { Action, Handover } from '@slop/core';
import type { GlobView } from './api';
import { stripMarkdown } from './markdown-text';

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

/** What a read brief is keyed by (see `handoverKey`): it changes when the situation does, so a new cause shows the full box again. */
export const handoverSignature = (brief: Handover): string => JSON.stringify([brief.why, brief.next]);

/** The collapsed box's one line: the first cause, with a count when there are more. */
export const handoverOneLine = (brief: Handover): string => {
  const [first = brief.next, ...rest] = brief.why;
  const line = stripMarkdown(first);
  return rest.length === 0 ? line : `${line} (+${String(rest.length)} more)`;
};

/** Said in the Pick up (take_over included) / Start confirmation: "You're taking over because …". */
export const handoverConfirmation = (action: Action, brief: Handover): string => {
  const verb = action === 'take_over' ? 'taking over' : action === 'pick_up' ? 'picking this up' : 'starting this';
  return stripMarkdown(`You're ${verb} because: ${brief.why.join(' ')} First: ${brief.next}`);
};
