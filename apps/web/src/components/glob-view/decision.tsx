import { decisionOf } from '@slop/core';
import type { SuggestionPrefill } from '@slop/core';
import type { DecideInput } from '@/lib/api';
import { DecisionAssessment, DecisionSection as DecisionBody } from '../decision-section';
import type { GlobViewContext } from './context';

/** The decision section: only a decision glob has one. */
export const DecisionPanel = ({
  ctx,
  onDecide,
  applied,
}: {
  ctx: GlobViewContext;
  onDecide: (input: DecideInput) => Promise<boolean>;
  applied: SuggestionPrefill | null;
}) =>
  decisionOf(ctx.glob) === null ? null : (
    <DecisionBody
      board={ctx.board}
      glob={ctx.glob}
      busy={ctx.busy}
      onDecide={onDecide}
      onUpdate={ctx.onUpdate}
      applied={applied}
    />
  );

/** The assessment of a decision glob that is not a replacement; admins and POs can suggest from it. */
export const DecisionAssessmentPanel = ({
  ctx,
  onApply,
}: {
  ctx: GlobViewContext;
  onApply: (prefill: SuggestionPrefill) => void;
}) => {
  const decision = decisionOf(ctx.glob);
  return decision !== null && decision.origin.kind !== 'replacement' ? (
    <DecisionAssessment
      glob={ctx.glob}
      canSuggest={ctx.board.role === 'admin' || ctx.board.role === 'po'}
      onApply={onApply}
    />
  ) : null;
};
