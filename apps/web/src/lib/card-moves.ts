import type { Action } from '@slop/core';
import type { GlobView } from './api';
import { actionPresentation, presentedActions } from './action-presentation';
import type { ActionIcon } from './action-presentation';

/** One move the glob can make: a state-machine action into a neighbouring list. */
export interface CardMove {
  readonly action: Action;
  readonly direction: 'left' | 'right';
  /** The verb on the button, e.g. "Pick up ▸". */
  readonly label: string;
  /** What it does, for screen readers and the tooltip. */
  readonly description: string;
  /** Who does the work, from actionPresentation; decorative, since the description says it in words. */
  readonly icon: ActionIcon | null;
}

export type CardList = 'planning' | 'doing' | 'reviewing' | 'signed_off';

/**
 * The actions the card offers for a glob in Planning, in order: the one common action, or for a same both Start and
 * Pick up. Start now (start_anyway), Retry and Take over stay in the glob view's More menu, and Pick up covers take_over.
 */
export const cardActions = (glob: Pick<GlobView, 'type' | 'list' | 'allowedActions' | 'provisioning' | 'status' | 'implementer' | 'pr'>): Action[] => {
  // No moves while slop is still creating the glob's branch and PR: a second action then would race the setup.
  if (glob.provisioning === 'pending' || glob.list !== 'planning') return [];
  const allowed = presentedActions(glob.allowedActions ?? []);
  const pickUp = (['pick_up', 'take_over'] as const).find((a) => allowed.includes(a));
  const start = allowed.includes('start') ? 'start' : undefined;
  const pick = <T,>(...options: (T | undefined)[]): T[] => {
    const first = options.find((o) => o !== undefined);
    return first === undefined ? [] : [first];
  };
  if (glob.type === 'same') {
    const both = [start, pickUp].filter((a): a is Action => a !== undefined);
    return both.length > 0 ? both : pick<Action>(allowed.includes('retrigger') ? 'retrigger' : undefined);
  }
  if (glob.type === 'super') return pick<Action>(pickUp);
  return pick<Action>(start, allowed.includes('retrigger') ? 'retrigger' : undefined, pickUp);
};

/** The moves a glob can make from its card, each a state-machine action it allows: right takes a glob from Planning into Doing. */
export const cardMoves = (glob: GlobView): { move: CardMove; target: CardList }[] =>
  cardActions(glob).map((action) => {
    const { label: name, tip, icon } = actionPresentation(action, glob);
    return {
      target: 'doing' as const,
      move: { action, direction: 'right' as const, label: `${name} ▸`, description: `${name} ${glob.id}: ${tip}`, icon },
    };
  });
