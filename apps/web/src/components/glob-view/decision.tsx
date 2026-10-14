import { decisionOf } from '@slop/core';
import type { SuggestionPrefill } from '@slop/core';
import type { AddRelationInput, DecideInput } from '@/lib/api';
import { DecisionAssessment, DecisionSection as DecisionBody } from '../decision-section';
import type { GlobViewContext } from './context';
import { AddRelation, relatedGroups, Row } from './related';

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

/** A decision's "Holds back" list: the globs that can't start (or merge) until it is decided, with Add. */
export const DecisionHoldsBack = ({
  ctx,
  onAddRelation,
}: {
  ctx: GlobViewContext;
  onAddRelation: (input: AddRelationInput) => Promise<boolean>;
}) => {
  const rows = relatedGroups(ctx.glob)?.holdsBack ?? [];
  return (
    <div className="grid gap-2 rounded border p-2 text-sm" data-testid="holds-back">
      <span className="font-medium">Holds back</span>
      {rows.length === 0 ? (
        <span className="text-xs text-muted-foreground">Nothing waits for this decision.</span>
      ) : (
        <ul className="ml-4 list-disc">
          {rows.map((r) => (
            <Row key={r.relationId} boardId={ctx.glob.boardId} row={r} onDismiss={null} />
          ))}
        </ul>
      )}
      <AddRelation ctx={ctx} label="Holds back…" gates={['start', 'merge']} onAdd={onAddRelation} />
    </div>
  );
};
