import { LlmBusy, LlmUnavailable } from '@slop/core';
import type { Embedder, Llm, LlmRequest } from '@slop/core';

/** What slop last learned about a model: unknown until a call ends, then ok or down with the fix. */
export type LlmHealthState =
  | { readonly state: 'unknown' }
  | { readonly state: 'ok'; readonly since: string }
  | { readonly state: 'down'; readonly reason: string; readonly fix: string; readonly since: string };

/** This many busy answers within this window from one model raise the throttling warning. */
export const BUSY_WARNING_COUNT = 10;
export const BUSY_WINDOW_MS = 10 * 60_000;

const SEVERITY = { unknown: 0, ok: 1, down: 2 } as const;

/**
 * Tracks whether slop can use its LLMs, from the calls it makes anyway (no probing), per model ID:
 * every Bedrock instance is wrapped by `track` with its model. A success marks that model ok, an
 * `LlmUnavailable` marks it down with the reason and fix; other failures (`LlmBusy` throttling, timeouts,
 * model errors) say nothing about access and leave it alone. Per model, so access denied to one
 * model (Opus not enabled, Haiku fine) can't flip the state with every intake call. The listener
 * runs once per change of a model's state (a new state, or a different reason while down).
 */
export class LlmHealth {
  private readonly models = new Map<string, LlmHealthState>();
  private readonly busyAt = new Map<string, number[]>();
  private readonly throttled = new Set<string>();

  constructor(
    private readonly onChange: (model: string, state: LlmHealthState) => void = () => undefined,
    private readonly now: () => string = () => new Date().toISOString(),
    /** Called when a model starts or stops being throttled (many busy answers in a row, then a success). */
    private readonly onThrottled: (model: string, throttled: boolean) => void = () => undefined,
  ) {}

  /** The worst state across the models (down before ok before unknown), for `/api/health`. */
  state(): LlmHealthState {
    let worst: LlmHealthState = { state: 'unknown' };
    for (const state of this.models.values()) if (SEVERITY[state.state] > SEVERITY[worst.state]) worst = state;
    return worst;
  }

  /** True while any of `models` (all tracked models when omitted) is down; the KB pipeline pauses on its own models. */
  isDown(models?: readonly string[]): boolean {
    const keys = models ?? [...this.models.keys()];
    return keys.some((model) => this.models.get(model)?.state === 'down');
  }

  /** The LLM port for `model`, recording each call's outcome here and passing results and errors through unchanged. */
  track(llm: Llm, model: string): Llm {
    return {
      complete: async (request: LlmRequest) => {
        try {
          const answer = await llm.complete(request);
          this.record(model, { state: 'ok', since: this.now() });
          this.setThrottled(model, false);
          return answer;
        } catch (error) {
          this.noteFailure(model, error);
          throw error;
        }
      },
    };
  }

  /** The embedder for `model`, recording each call's outcome here like `track` (a success is ok, `LlmUnavailable` is down). */
  trackEmbedder(embedder: Embedder, model: string): Embedder {
    return {
      model: embedder.model,
      dimensions: embedder.dimensions,
      embed: async (texts, signal) => {
        try {
          const vectors = await embedder.embed(texts, signal);
          this.record(model, { state: 'ok', since: this.now() });
          this.setThrottled(model, false);
          return vectors;
        } catch (error) {
          this.noteFailure(model, error);
          throw error;
        }
      },
    };
  }

  /**
   * A busy answer (throttling, overload) says nothing about access: the model stays as it was. Many in a row
   * (`BUSY_WARNING_COUNT` within `BUSY_WINDOW_MS`) warn that the model is being throttled, until a call succeeds.
   */
  private noteFailure(model: string, error: unknown): void {
    if (error instanceof LlmBusy) {
      const nowMs = Date.parse(this.now());
      const recent = [...(this.busyAt.get(model) ?? []).filter((at) => nowMs - at < BUSY_WINDOW_MS), nowMs];
      this.busyAt.set(model, recent);
      if (recent.length >= BUSY_WARNING_COUNT) this.setThrottled(model, true);
    } else if (error instanceof LlmUnavailable) {
      this.record(model, { state: 'down', reason: error.reason, fix: error.fix, since: this.now() });
    }
  }

  private setThrottled(model: string, throttled: boolean): void {
    if (!throttled) this.busyAt.delete(model);
    if (this.throttled.has(model) === throttled) return;
    if (throttled) this.throttled.add(model);
    else this.throttled.delete(model);
    this.onThrottled(model, throttled);
  }

  private record(model: string, next: LlmHealthState): void {
    const previous = this.models.get(model) ?? { state: 'unknown' };
    const same =
      previous.state === next.state && (previous.state !== 'down' || next.state !== 'down' || previous.reason === next.reason);
    if (same) return;
    this.models.set(model, next);
    this.onChange(model, next);
  }
}
