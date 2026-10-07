import { LlmUnavailable } from './intake-service.js';
import type { Llm, LlmRequest } from './intake-service.js';

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
