import { holdWords, OTHER_BOARD_GLOB } from '@slop/core';
import type { Action, RelationGate } from '@slop/core';
import type { GlobView } from './api';

/** The actions that force a held step through: each overrides the relations of its gate and is logged with who and why. */
export type AnywayAction = 'start_anyway' | 'merge_anyway' | 'sign_off_anyway';

const GATE: Readonly<Record<AnywayAction, RelationGate>> = { start_anyway: 'start', merge_anyway: 'merge', sign_off_anyway: 'sign_off' };

/**
 * Whether the action asks for a reason before it runs. Start now does only on a glob in Planning that is held (the same action also
 * hands a picked-up glob to the machine, where nothing is overridden).
 */
export const anywayOf = (action: Action, glob: Pick<GlobView, 'status'>): AnywayAction | null =>
  action === 'merge_anyway' || action === 'sign_off_anyway' ? action : action === 'start_anyway' && glob.status === 'planning' ? action : null;

/** Merge anyway and Sign off anyway need the reason; Start now takes one if given. */
export const reasonRequired = (action: AnywayAction): boolean => action !== 'start_anyway';

const TITLES: Readonly<Record<AnywayAction, string>> = { start_anyway: 'Start now', merge_anyway: 'Merge anyway', sign_off_anyway: 'Sign off anyway' };
const DOING: Readonly<Record<AnywayAction, string>> = {
  start_anyway: 'starting without that',
  merge_anyway: 'merging without that',
  sign_off_anyway: 'signing off without that',
};

/** What the relations of this gate hold the glob for, in the Related section's words ("can't merge until s15t246 is merged and rolled out"). */
export const heldFor = (action: AnywayAction, glob: Pick<GlobView, 'relations'>): string[] =>
  (glob.relations?.holding ?? [])
    .filter((h) => h.gate === GATE[action])
    .map((h) => holdWords({ gate: h.gate, until: h.until, to: h.external?.hidden === true ? OTHER_BOARD_GLOB : h.to }, h.external?.hidden === true));

/** The confirmation's title and sentence: it names what the glob is held for and says what happens to those relations. */
export const anywayConfirmation = (action: AnywayAction, glob: Pick<GlobView, 'relations'>): { title: string; says: string; ask: string } => {
  const held = heldFor(action, glob);
  const holds = held.length === 0 ? 'Something holds this back.' : `It ${held.join('; ')}.`;
  return {
    title: TITLES[action],
    says: `${holds} You are ${DOING[action]}; those relations are marked overridden and slop records who did it.`,
    ask: reasonRequired(action) ? 'Why? (required)' : 'Why? (optional)',
  };
};
