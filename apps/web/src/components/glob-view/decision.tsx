import { decisionOf } from '@slop/core';
import { useState } from 'react';
import type { AddRelationInput } from '@/lib/api';
import { isLearning } from '../decision-outcomes';
import { DecisionAssessment, DecisionSection as DecisionBody } from '../decision-section';
import { Block } from './block';
import type { GlobViewContext } from './context';
import { AddRelationForm, RelationsHeader, relatedGroups, Row } from './related';

/** The decision section: only a decision glob has one. */
export const DecisionPanel = ({ ctx }: { ctx: GlobViewContext }) =>
  decisionOf(ctx.glob) === null ? null : (
    <Block tone="person" actor="human" testId="decision-block" title={ctx.glob.status === 'signed_off' ? 'Decision' : 'Decision needed'}>
      <DecisionBody
        board={ctx.board}
        glob={ctx.glob}
        busy={ctx.busy}
        decide={ctx.decide ?? null}
        onUpdate={ctx.onUpdate}
      />
    </Block>
  );

/** The older assessments of a decision glob that is neither a replacement nor a learning (a learning's sit at the foot of its block). */
export const DecisionAssessmentPanel = ({ ctx }: { ctx: GlobViewContext }) => {
  const decision = decisionOf(ctx.glob);
  return decision !== null && decision.origin.kind !== 'replacement' && !isLearning(decision) ? (
    <DecisionAssessment glob={ctx.glob} all />
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
  const [toggled, setToggled] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const open = toggled ?? rows.length > 0;
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm" aria-label="Holds back" data-testid="holds-back">
      <RelationsHeader
        open={open}
        onToggle={() => setToggled(!open)}
        title="Holds back"
        count={rows.length}
        holding={0}
        addLabel="Holds back"
        onAdd={() => {
          setAdding(!(adding && open));
          setToggled(true);
        }}
        toggleTestId="holds-back-toggle"
      />
      {open && (
        <>
          {rows.length === 0 ? (
            <span className="text-xs text-muted-foreground">Nothing waits for this {ctx.glob.category === 'action' ? 'action' : 'decision'}.</span>
          ) : (
            <ul className="ml-4 list-disc">
              {rows.map((r) => (
                <Row key={r.relationId} boardId={ctx.glob.boardId} row={r} onDismiss={null} />
              ))}
            </ul>
          )}
          {adding && <AddRelationForm ctx={ctx} gates={['start', 'merge']} onAdd={onAddRelation} onClose={() => setAdding(false)} />}
        </>
      )}
    </section>
  );
};
