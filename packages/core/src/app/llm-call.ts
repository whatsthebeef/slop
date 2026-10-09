import { LlmUnavailable } from './intake-service.js';
import type { Llm, LlmRequest } from './intake-service.js';
import { BUSY_WAITING_PREFIX } from '../domain/kb.js';

/**
 * One LLM call with a deadline, for the background pipelines; a timeout rejects with a readable
 * reason, recorded like any other failure.
 */
export const completeWithDeadline = async (llm: Llm, request: Omit<LlmRequest, 'signal'>, timeoutMs: number): Promise<string> => {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await llm.complete({ ...request, signal });
  } catch (error) {
    // An unusable LLM stays unusable when the deadline also fired: the item waits, no attempt counted.
    if (error instanceof LlmUnavailable) throw error;
    if (signal.aborted) throw new Error(`The model did not answer within ${timeoutMs / 1000} s`, { cause: error });
    throw error;
  }
};

/** Waits (minutes) after consecutive busy answers for one item: 1, 2, 4, 8, then 15. */
const BUSY_WAIT_MINUTES = [1, 2, 4, 8, 15] as const;

/**
 * How long an item waits after a busy answer from the LLM, growing with the item's consecutive busy
 * answers (kept in memory: a restart starts over at a minute) with up to 25% jitter, so items that
 * were throttled together don't all come back at once. A success or a real failure `clear`s it.
 */
export class BusyBackoff {
  private readonly streaks = new Map<string | number, number>();

  constructor(private readonly random: () => number = Math.random) {}

  next(key: string | number): number {
    const streak = this.streaks.get(key) ?? 0;
    this.streaks.set(key, streak + 1);
    const minutes = BUSY_WAIT_MINUTES[Math.min(streak, BUSY_WAIT_MINUTES.length - 1)] ?? 15;
    return Math.round(minutes * 60_000 * (1 + 0.25 * this.random()));
  }

  clear(key: string | number): void {
    this.streaks.delete(key);
  }
}

/** The text of `Waiting: Bedrock busy (retrying at HH:MM)` for the card and the item's error. */
export const busyMessage = (retryAt: string): string => {
  const at = new Date(retryAt);
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${BUSY_WAITING_PREFIX} (retrying at ${hh}:${mm} UTC)`;
};
