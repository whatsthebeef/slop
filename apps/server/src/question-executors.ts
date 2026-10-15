import type { EffectKind, GlobService } from '@slop/core';
import type { Executor } from './jobs/outbox.js';

/**
 * The outbox job behind "plan.md changed during the run" (`plan_changed_question`): raises the `merge` question when it still
 * applies. The question's key (`plan:vN`) makes a repeat change nothing; a glob that merged or was deleted since is dropped.
 */
export const questionExecutors = (globs: Pick<GlobService, 'raisePlanChanged'>): Partial<Record<EffectKind, Executor>> => ({
  plan_changed_question: async (effect) => {
    if (effect.kind !== 'plan_changed_question') return 'dropped';
    const raised = await globs.raisePlanChanged(effect.globId, effect.version);
    return raised === null || raised.ok ? 'done' : 'dropped';
  },
});
