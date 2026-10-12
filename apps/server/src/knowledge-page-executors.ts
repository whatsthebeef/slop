import type { EffectKind, KnowledgePageService } from '@slop/core';
import type { Executor } from './jobs/outbox.js';

/**
 * The knowledge page's outbox job (`regenerate_knowledge_page`, on the `llm` lane): writes the board's next page version.
 * A regeneration that comes too soon, or finds the model unusable, asks to run later without spending an attempt.
 */
export const knowledgePageExecutors = (page: Pick<KnowledgePageService, 'regenerate'>): Partial<Record<EffectKind, Executor>> => ({
  regenerate_knowledge_page: async (effect) => {
    if (effect.kind !== 'regenerate_knowledge_page') return 'dropped';
    return page.regenerate(effect.boardId, effect.full === true);
  },
});
