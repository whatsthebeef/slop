import { LlmUnavailable } from '@slop/core';
import type { EffectKind, RelationScanService } from '@slop/core';
import type { Executor } from './jobs/outbox.js';

/** An unusable model (credentials, busy) is waited out without spending an attempt; the next try is this much later. */
const MODEL_WAIT_MS = 5 * 60_000;

/**
 * The automatic relation pass's outbox job (`scan_relations`, on the `llm` lane): re-reads the glob and runs the pass. Gen-less: it
 * carries no generation, so only a deleted glob makes it stale. A pass with no usable model answer throws, and the runner retries it
 * (3 attempts); an unavailable model waits without spending one.
 */
export const relationScanExecutors = (scan: Pick<RelationScanService, 'run'>): Partial<Record<EffectKind, Executor>> => ({
  scan_relations: async (effect, glob) => {
    if (effect.kind !== 'scan_relations' || glob === null) return 'dropped';
    try {
      return await scan.run(effect.globId);
    } catch (error) {
      if (error instanceof LlmUnavailable) return { state: 'pending', retryAfterMs: MODEL_WAIT_MS, reason: error.message };
      throw error;
    }
  },
});
