import { BUSY_WAITING_PREFIX, outboxBackoffMs } from '@slop/core';
import type { DecisionLearning } from '@slop/core';

/**
 * When an item waiting in the pipeline is tried next: `shortly` (queued, due now), `running` (its job is claimed and the
 * step is under way: `processAfter` is then the claim's lease, not a retry time), or the time of the next try after a
 * failed attempt. A claim is told from a backoff by how far off it is: further than the backoff its last failed attempt
 * set can only be the lease.
 */
export const nextTry = (
  item: Pick<DecisionLearning, 'processAfter' | 'processingAttempts' | 'processingError'>,
  now: number,
): 'shortly' | 'running' | Date => {
  if (item.processAfter === null) return 'shortly';
  const at = Date.parse(item.processAfter);
  if (at <= now) return 'shortly';
  const busy = item.processingError?.startsWith(BUSY_WAITING_PREFIX) === true;
  const backoff = outboxBackoffMs(Math.max(item.processingAttempts - 1, 0), 'llm');
  if (!busy && item.processingAttempts > 0 && at - now > backoff) return 'running';
  return new Date(at);
};
