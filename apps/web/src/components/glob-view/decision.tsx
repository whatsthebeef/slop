import { decisionOf } from '@slop/core';
import type { AddRelationInput, DecideInput } from '@/lib/api';
import { DecisionAssessment, DecisionSection as DecisionBody } from '../decision-section';
import type { GlobViewContext } from './context';
import { AddRelation, relatedGroups, Row } from './related';

/** The decision section: only a decision glob has one. */
export const DecisionPanel = ({
  ctx,
  onDecide,
}: {
  ctx: GlobViewContext;
  onDecide: (input: DecideInput) => Promise<boolean>;
}) =>
  decisionOf(ctx.glob) === null ? null : (
    <DecisionBody
      board={ctx.board}
      glob={ctx.glob}
      busy={ctx.busy}
      onDecide={onDecide}
      onUpdate={ctx.onUpdate}
    />
  );

/** The older assessments of a decision glob that is not a replacement; the latest is in the Decide block. */
export const DecisionAssessmentPanel = ({ ctx }: { ctx: GlobViewContext }) => {
  const decision = decisionOf(ctx.glob);
  return decision !== null && decision.origin.kind !== 'replacement' ? (
    <DecisionAssessment glob={ctx.glob} />
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
