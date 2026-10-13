import type { EffectKind, SuggestService } from '@slop/core';
import type { Executor } from './jobs/outbox.js';

/** Suggest's outbox job (`suggest_decision`, on the `llm` lane): one model call that stores a recommendation for a decision glob. */
export const suggestExecutors = (suggest: Pick<SuggestService, 'run'>): Partial<Record<EffectKind, Executor>> => ({
  suggest_decision: async (effect) => (effect.kind === 'suggest_decision' ? suggest.run(effect.globId) : 'dropped'),
});
