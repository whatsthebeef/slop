import type { Action, HumanStepViewer } from '@slop/core';
import type { GlobView } from './api';
import { actionPresentation, presentedActions } from './action-presentation';
import type { ActionIcon } from './action-presentation';
import { viewMainAction } from './main-action';

/** One move the glob can make: a state-machine action into a neighbouring list. */
export interface CardMove {
  readonly action: Action;
  /** `none`: the action runs in place and the card stays in its list (Fix conflict), so it has no ▸ and no ghost piece. */
  readonly direction: 'left' | 'right' | 'none';
  /** A first click only arms the button ("Confirm fix conflict"); a second one within CONFIRM_MS runs it. */
  readonly confirm: boolean;
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
 * Pick up. Start now (start_anyway), Retry and take_over stay in the glob view's More menu, and Pick up covers take_over.
 */
export const cardActions = (glob: GlobView, viewer?: HumanStepViewer): Action[] => {
  // No moves while slop is still creating the glob's branch and PR: a second action then would race the setup.
  if (glob.provisioning === 'pending') return [];
  // Outside Planning the only button is Fix conflict, and only while it is the glob view's main action too.
  if (glob.list !== 'planning')
    return (glob.allowedActions ?? []).includes('resolve_conflict') && viewMainAction(glob, viewer) === 'resolve_conflict' ? ['resolve_conflict'] : [];
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
export const cardMoves = (glob: GlobView, viewer?: HumanStepViewer): { move: CardMove; target: CardList }[] =>
  cardActions(glob, viewer).map((action) => {
    const { label: name, tip, icon } = actionPresentation(action, glob);
    // Fix conflict runs in place (the card stays in its list) and asks for a second click, as Merge does.
    if (action === 'resolve_conflict')
      return {
        target: glob.list,
        move: { action, direction: 'none' as const, confirm: true, label: name, description: `${name} ${glob.id}: ${tip}`, icon },
      };
    return {
      target: 'doing' as const,
      move: { action, direction: 'right' as const, confirm: false, label: `${name} ▸`, description: `${name} ${glob.id}: ${tip}`, icon },
    };
  });
