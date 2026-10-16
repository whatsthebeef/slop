import type { DecisionOutcomeKind } from '../attributes.js';

/** What a decision's outcome is called. */
export const OUTCOME_TEXT: Record<DecisionOutcomeKind, string> = {
  accept: 'Accepted',
  accept_with_edits: 'Accepted with edits',
  retarget: 'Retargeted',
  needs_work: 'Needs work',
  reject: 'Rejected',
  closed: 'Closed by the pipeline',
};
