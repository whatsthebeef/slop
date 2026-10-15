import { parseInvestigation } from '../../domain/investigation.js';
import type { Artifact } from '../../domain/knowledge.js';

export interface InvestigationSummary {
  readonly version: number;
  readonly createdAt: string;
  /** The run that made it (null for a person's push). */
  readonly runId: string | null;
  /** Set when the block did not validate: the text is kept but there is nothing to compare, so refresh. */
  readonly validation: string | null;
  readonly planHash: string | null;
  readonly baseCommit: string | null;
  /** Paths the investigation expects to create, modify or delete (the relevant files to check the base for changes). */
  readonly files: readonly string[];
  readonly riskTier: string | null;
  readonly confidence: string | null;
  readonly needsHuman: boolean | null;
}

export const investigationSummary = (a: Artifact): InvestigationSummary => {
  const parsed = parseInvestigation(a.content);
  return {
    version: a.version,
    createdAt: a.createdAt,
    runId: a.provenance.runId,
    validation: a.provenance.validation ?? null,
    planHash: parsed.ok ? parsed.investigation.planHash : null,
    baseCommit: parsed.ok ? parsed.investigation.baseCommit : null,
    files: parsed.ok ? parsed.investigation.files.map((f) => f.path) : [],
    riskTier: parsed.ok ? parsed.investigation.riskTier : null,
    confidence: parsed.ok ? parsed.investigation.confidence : null,
    needsHuman: parsed.ok ? parsed.investigation.needsHuman.needed : null,
  };
};
