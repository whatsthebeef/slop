import type { Effect } from '../domain/events.js';
import { parseId } from '../domain/ids.js';
import type { Hint } from '../ports.js';

/**
 * The live hint for a pipeline job the outbox settled (failed, retrying, or waiting with a new reason): the board's
 * Knowledge page refetches. Null for any other effect.
 */
export const kbJobHint = (effect: Effect): Hint | null => {
  if (effect.kind !== 'kb_route' && effect.kind !== 'kb_draft') return null;
  const parsed = parseId(effect.globId);
  return parsed === null ? null : { kind: 'board.kb', boardId: parsed.boardId };
};

/**
 * The live hint for a recommendation job the outbox settled without storing one (failed, retrying, or waiting with a new
 * reason): the glob refetches, so its status stops spinning or shows why it waits. A stored recommendation announces itself.
 */
export const suggestJobHint = (effect: Effect): Hint | null => {
  if (effect.kind !== 'suggest_decision') return null;
  const parsed = parseId(effect.globId);
  return parsed === null ? null : { kind: 'glob.artifacts', boardId: parsed.boardId, globId: effect.globId };
};
