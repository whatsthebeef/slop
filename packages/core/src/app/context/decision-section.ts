import { decisionViews } from '../../domain/decisions.js';
import type { DecisionView } from '../../domain/decisions.js';
import { applicableDecisions, scopedDecision } from '../../domain/decision-glob.js';
import type { ScopedDecision } from '../../domain/decision-glob.js';
import type { Glob } from '../../domain/types.js';
import type { Tx } from '../../ports.js';

/** The accepted decisions that govern a work glob, each with its one-line statement read from its plan.md. */
export const governingDecisions = async (tx: Tx, glob: Glob): Promise<ScopedDecision[]> => {
  const decisions = applicableDecisions(await tx.listGlobs(glob.boardId, { include: 'decisions' }), glob);
  const scoped: ScopedDecision[] = [];
  for (const decision of decisions) {
    const entry = scopedDecision(decision, (await tx.listArtifacts(decision.id, 'plan'))[0]?.content);
    if (entry !== null) scoped.push(entry);
  }
  return scoped;
};

/** What `get_context` tells an agent about conflicting sources. */
export const AUTHORITY_STATEMENT =
  'When sources disagree: merged code and the implementation record win, then current choices (newest first), then plan.md, then older discussion. Replaced choices are history: read them for why, not for what to do. Accepted decisions in scopedDecisions govern this glob by their scope, broadest first.';


/** The most decisions one context bundle carries. */
export const CONTEXT_DECISIONS = 30;

/** The decisions taken on a glob, current ones first, up to `CONTEXT_DECISIONS`. */
export const decisionsOfGlob = async (tx: Tx, glob: Glob): Promise<DecisionView[]> => {
  const allDecisions = await tx.listDecisions(glob.boardId);
  return (
    decisionViews(
      allDecisions.filter((d) => d.globId === glob.id),
      allDecisions,
    )
      // Current first (stable: each group stays newest first).
      .sort((a, b) => Number(a.status === 'superseded') - Number(b.status === 'superseded'))
      .slice(0, CONTEXT_DECISIONS)
  );
};
