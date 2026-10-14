import type { DecisionOutcomeKind } from '@slop/core';
import type { SuggestionState } from './suggestion';

export type Choice = Exclude<DecisionOutcomeKind, 'closed'>;

/** What the Decide block's main (black) button does. */
export type DecideMain =
  /** Ask the model for a suggestion (`again`: one is already stored). */
  | { kind: 'suggest'; again: boolean }
  /** A suggestion is being written: the button waits. */
  | { kind: 'suggesting' }
  /** Fill the form with the suggested outcome and reason. */
  | { kind: 'apply' }
  /** The chosen outcome: the first press picks it, a press once it is picked submits it. */
  | { kind: 'outcome'; outcome: Choice };

export interface DecideButtons {
  main: DecideMain;
  /** Reject stays visible beside the split button once an outcome is chosen (unless it is the main). */
  rejectBeside: boolean;
  /** The outcomes folded into the ▾, in order. */
  menu: readonly Choice[];
  /** The ▾ also offers "Suggest again". */
  suggestAgain: boolean;
  /** The ▾ also offers "Clear" (an outcome is chosen). */
  clear: boolean;
}

const ORDER: readonly Choice[] = ['accept', 'accept_with_edits', 'retarget', 'needs_work', 'reject'];

/**
 * The Decide block's buttons: Suggest → Apply → the applied outcome as the main button, Reject beside it, the other
 * outcomes in the ▾. Without a suggestion to ask for (`canSuggest` false) Accept leads, so the ▾ is never alone.
 */
export const decideButtons = ({
  state,
  hasPrefill,
  canSuggest,
  choice,
}: {
  state: SuggestionState;
  hasPrefill: boolean;
  canSuggest: boolean;
  choice: Choice | null;
}): DecideButtons => {
  if (choice !== null) {
    return {
      main: { kind: 'outcome', outcome: choice },
      rejectBeside: choice !== 'reject',
      menu: ORDER.filter((o) => o !== choice && o !== 'reject'),
      suggestAgain: canSuggest && state !== 'working',
      clear: true,
    };
  }
  if (canSuggest && state === 'working') return { main: { kind: 'suggesting' }, rejectBeside: false, menu: ORDER, suggestAgain: false, clear: false };
  if (canSuggest && state === 'ready' && hasPrefill) return { main: { kind: 'apply' }, rejectBeside: false, menu: ORDER, suggestAgain: true, clear: false };
  if (canSuggest) {
    return { main: { kind: 'suggest', again: state !== 'none' }, rejectBeside: false, menu: ORDER, suggestAgain: false, clear: false };
  }
  return { main: { kind: 'outcome', outcome: 'accept' }, rejectBeside: false, menu: ORDER.filter((o) => o !== 'accept'), suggestAgain: false, clear: false };
};
