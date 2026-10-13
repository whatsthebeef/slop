import type { Action, Handover } from '@slop/core';
import type { GlobView } from './api';

/** The actions that hand a glob to a person or a machine; the brief is for whoever can take one. */
const HAND_OVER_ACTIONS: readonly Action[] = ['pick_up', 'take_over', 'start', 'start_anyway'];

/** One key for every glob: the briefs a viewer has read, glob ID to the brief's signature. */
const STORAGE_KEY = 'slop.handover-acknowledged';

/** The brief to show in the glob view, or null: it shows to the implementer and to anyone who can pick up, take over or start. */
export const handoverToShow = (
  glob: Pick<GlobView, 'handover' | 'implementer' | 'allowedActions'>,
): Handover | null => {
  const brief = glob.handover;
  if (brief == null) return null;
  const canHandOver = (glob.allowedActions ?? []).some((a) => HAND_OVER_ACTIONS.includes(a));
  return glob.implementer !== null || canHandOver ? brief : null;
};

/** What a read brief is remembered by: it changes when the situation does, so a new cause shows the full box again. */
export const handoverSignature = (brief: Handover): string => JSON.stringify([brief.why, brief.next]);

/** The collapsed box's one line: the first cause, with a count when there are more. */
export const handoverOneLine = (brief: Handover): string => {
  const [first = brief.next, ...rest] = brief.why;
  return rest.length === 0 ? first : `${first} (+${String(rest.length)} more)`;
};

/** Said in the Pick up / Take over / Start confirmation: "You're taking over because …". */
export const handoverConfirmation = (action: Action, brief: Handover): string => {
  const verb = action === 'take_over' ? 'taking over' : action === 'pick_up' ? 'picking this up' : 'starting this';
  return `You're ${verb} because: ${brief.why.join(' ')} First: ${brief.next}`;
};

const readAll = (): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string'));
  } catch {
    return {};
  }
};

/** True once the viewer acknowledged this brief (the same causes and next step) on this glob. */
export const readHandoverAcknowledged = (globId: string, brief: Handover): boolean =>
  readAll()[globId] === handoverSignature(brief);

export const writeHandoverAcknowledged = (globId: string, brief: Handover | null): void => {
  try {
    const others = Object.entries(readAll()).filter(([id]) => id !== globId);
    const all = Object.fromEntries(brief === null ? others : [...others, [globId, handoverSignature(brief)]]);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Private mode or blocked storage: the acknowledgement just isn't remembered.
  }
};
