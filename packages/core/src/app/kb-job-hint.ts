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
