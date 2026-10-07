import { LlmUnavailable } from '@slop/core';
import type { Llm, LlmRequest } from '@slop/core';

/** What slop last learned about the LLM: unknown until a call ends, then ok or down with the fix. */
export type LlmHealthState =
  | { readonly state: 'unknown' }
  | { readonly state: 'ok'; readonly since: string }
  | { readonly state: 'down'; readonly reason: string; readonly fix: string; readonly since: string };

/**
 * Tracks whether slop can use its LLM, from the calls it makes anyway (no probing). Every Bedrock
 * instance is wrapped by `track`: a success marks it ok, an `LlmUnavailable` marks it down with the
 * reason and fix; other failures (throttling, timeouts, model errors) say nothing about access and
 * leave the state alone. One state for all instances: they share credentials, which is what fails
 * in practice. The listener runs once per change (a new state, or a different reason while down).
 */
export class LlmHealth {
  private current: LlmHealthState = { state: 'unknown' };

  constructor(
    private readonly onChange: (state: LlmHealthState) => void = () => undefined,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  state(): LlmHealthState {
    return this.current;
  }

  /** True while the last call that said anything about access failed it (the KB pipeline pauses on this). */
  isDown(): boolean {
    return this.current.state === 'down';
  }

  /** The LLM port, recording each call's outcome here and passing results and errors through unchanged. */
  track(llm: Llm): Llm {
    return {
      complete: async (request: LlmRequest) => {
        try {
          const answer = await llm.complete(request);
          this.record({ state: 'ok', since: this.now() });
          return answer;
        } catch (error) {
          if (error instanceof LlmUnavailable) {
            this.record({ state: 'down', reason: error.reason, fix: error.fix, since: this.now() });
          }
          throw error;
        }
      },
    };
  }

  private record(next: LlmHealthState): void {
    const previous = this.current;
    const same =
      previous.state === next.state && (previous.state !== 'down' || next.state !== 'down' || previous.reason === next.reason);
    if (same) return;
    this.current = next;
    this.onChange(next);
  }
}
