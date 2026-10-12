import { kbStepOfKind, LLM_WAITING_PREFIX } from '@slop/core';
import type { EffectKind, KbPipeline } from '@slop/core';
import type { Executor } from './jobs/outbox.js';

/** While the KB models are down, how often one job calls them to find out whether they work again. */
export const PROBE_MS = 60_000;

/** Why a job waits for the next probe: the waiting wording the Knowledge page reads (`llmWaitingReason`). */
export const PROBE_WAIT_REASON = `${LLM_WAITING_PREFIX}the KB models are down; trying again once a probe gets through`;

/**
 * The KB pipeline's outbox jobs (`kb_route`, `kb_draft`, on the `llm` lane): each runs its step of one item
 * (`KbPipeline.runStep`). While the pipeline's models are down (expired sign-in, no model access) only one job a
 * `PROBE_MS` calls them: that call is the probe, and the first success marks them up again. The rest wait without
 * spending an attempt, with a waiting reason the Knowledge page shows.
 */
export const kbExecutors = (
  pipeline: Pick<KbPipeline, 'runStep'>,
  models: { isDown(): boolean },
  now: () => number = Date.now,
): Partial<Record<EffectKind, Executor>> => {
  /**
   * When the last call while down ended (ms), so the next probe waits PROBE_MS from the call that found the models
   * down. Stamped after the call, whatever it did.
   */
  let lastProbe = Number.NEGATIVE_INFINITY;
  const run: Executor = async (effect) => {
    const step = kbStepOfKind(effect.kind);
    if (step === null) return 'dropped';
    if (models.isDown()) {
      const waited = now() - lastProbe;
      // The card shows it waiting (not retrying now), whatever error it last had.
      if (waited < PROBE_MS) return { state: 'pending', retryAfterMs: PROBE_MS - waited, reason: PROBE_WAIT_REASON };
    }
    // Only a call made while the models were down is a probe; when they are up, jobs run back to back.
    const probing = models.isDown();
    try {
      return await pipeline.runStep(effect.globId, step);
    } finally {
      if (probing || models.isDown()) lastProbe = now();
    }
  };
  return { kb_route: run, kb_draft: run };
};
