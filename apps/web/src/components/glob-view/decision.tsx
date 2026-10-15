import { decisionOf } from '@slop/core';
import { isLearning } from '../decision-outcomes';
import { DecisionAssessment, DecisionSection as DecisionBody } from '../decision-section';
import { Block } from './block';
import type { GlobViewContext } from './context';

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
