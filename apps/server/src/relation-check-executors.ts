import { LlmUnavailable } from '@slop/core';
import type { EffectKind, RelationCheckService } from '@slop/core';
import type { Executor } from './jobs/outbox.js';

/** An unusable model (credentials, busy) is waited out without spending an attempt; the next try is this much later. */
const MODEL_WAIT_MS = 5 * 60_000;

/**
 * The post-merge relation check (`check_relations_after_merge`, on the `llm` lane): judges each relation of a merged glob from its
 * diff and the code index, asking the model only when they cannot say. The generation check is the outbox's; `run` itself drops a
 * glob that has not merged. A model that gave no usable answer throws and the runner retries (3 attempts); an unavailable model
 * waits without spending one. The verdicts git reached are stored by then, so a retry only asks about what is left.
 */
export const relationCheckExecutors = (check: Pick<RelationCheckService, 'run'>): Partial<Record<EffectKind, Executor>> => ({
  check_relations_after_merge: async (effect, glob) => {
    if (effect.kind !== 'check_relations_after_merge' || glob === null) return 'dropped';
    try {
      return await check.run(effect.globId);
    } catch (error) {
      if (error instanceof LlmUnavailable) return { state: 'pending', retryAfterMs: MODEL_WAIT_MS, reason: error.message };
      throw error;
    }
  },
});
