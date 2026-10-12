import type { DecisionAttributes } from './attributes.js';
import { UNPROCESSED } from './kb.js';
import type { KbItem } from './kb.js';
import {
  EVIDENCE_HEADING,
  contradictionLinks,
  dedupeAttributesOf,
  possiblyCoveredLinks,
  learningCatalog,
  learningDecision,
  learningDocument,
  learningDraft,
  learningEffectCheck,
  learningEvidence,
  learningExtraEvidence,
  learningFacts,
  learningLinks,
  learningMergeNote,
  learningOutcome,
  learningStaleness,
  learningStatus,
  learningTarget,
} from './learning.js';
import type { LearningArtifacts } from './learning.js';
import type { Glob, GlobLink } from './types.js';

/**
 * The KB item adapter's mapping (until part 6): a KB item from a learning's helpers (`kbItemFrom`), and back to the
 * glob's attributes, links and payload for the adapter's writes.
 */

/** The payload (plan.md) of a learning: its statement and evidence, or a proposed document's body. Kept exact so it parses back. */
export const proposalText = (item: Pick<KbItem, 'statement' | 'evidence' | 'document'>): string =>
  item.document !== null ? item.document.content : `${item.statement}${EVIDENCE_HEADING}${item.evidence}`;

/** The KB fields of a learning's decision attributes (the decision rows own scope, origin, channel, outcome and archived). */
export const kbAttributesOf = (item: KbItem): Partial<DecisionAttributes> => {
  const stale = item.staleSince !== null || item.staleReason !== null || item.staleDismissedAt !== null;
  return {
    kind: item.type,
    sourceGlobs: item.sourceGlobIds,
    target: { suggested: item.suggestedTarget, routed: item.target },
    evidenceCount: item.occurrenceCount,
    ...(item.agentSetVersion === null ? {} : { agentSetVersion: item.agentSetVersion }),
    ...(item.signal === null ? {} : { signal: item.signal }),
    ...(item.catalogCandidate ? { catalogCandidate: true as const } : {}),
    ...(item.catalogReason === null ? {} : { catalogReason: item.catalogReason }),
    ...(item.status === 'merged' || item.status === 'suppressed' || item.status === 'covered' ? { closedAs: item.status } : {}),
    ...(stale ? { stale: { since: item.staleSince, reason: item.staleReason, dismissedAt: item.staleDismissedAt } } : {}),
    ...(item.document === null
      ? {}
      : { document: { name: item.document.name, area: item.document.area, audience: item.document.audience, description: item.document.description } }),
    ...dedupeAttributesOf(item.coveredBy, item.possiblyCoveredBy, item.contradicts),
  };
};

/** The keys `kbAttributesOf` writes: a write replaces exactly these. */
export const KB_ATTRIBUTE_KEYS = [
  'kind',
  'sourceGlobs',
  'target',
  'agentSetVersion',
  'signal',
  'evidenceCount',
  'catalogCandidate',
  'catalogReason',
  'closedAs',
  'stale',
  'document',
  'coveredByText',
  'possiblyCoveredByText',
  'contradictsText',
] as const;

/** How a learning relates to others, as links: what closed it, a hint naming another learning, contradictions, pairs kept apart. */
export const kbLinksOf = (item: KbItem): GlobLink[] => {
  const links: GlobLink[] = [];
  if (item.duplicateOf !== null) links.push({ id: item.duplicateOf, kind: 'duplicate_of', source: 'pipeline' });
  if (item.suppressedBy !== null) links.push({ id: item.suppressedBy, kind: 'suppressed_by', source: 'pipeline' });
  if (item.coveredBy?.kind === 'item') links.push({ id: item.coveredBy.id, kind: 'covered_by', source: 'pipeline' });
  links.push(...possiblyCoveredLinks(item.possiblyCoveredBy), ...contradictionLinks(item.contradicts));
  for (const id of item.keptApartFrom) links.push({ id, kind: 'kept_apart_from', source: 'explicit' });
  return links;
};

/**
 * The KB item a learning is, from the glob and its artifacts by role, each field from its helper (`domain/learning.ts`).
 * Its pipeline fields are placeholders: `withProcessing` fills them in from its status and its jobs.
 */
export const kbItemFrom = (glob: Glob, a: LearningArtifacts): KbItem => {
  const facts = learningFacts(glob);
  const decision = learningDecision(glob, a);
  const target = learningTarget(glob);
  const catalog = learningCatalog(glob);
  const links = learningLinks(glob);
  const drafted = learningDraft(a);
  const stale = learningStaleness(glob);
  return {
    id: glob.id,
    boardId: glob.boardId,
    status: learningStatus(glob, a),
    type: facts.kind,
    statement: glob.summary,
    evidence: learningEvidence(glob, a),
    suggestedTarget: target.suggested,
    sourceGlobIds: facts.sourceGlobIds,
    source: facts.source,
    signal: facts.signal,
    agentSetVersion: facts.agentSetVersion,
    submittedBy: glob.creator,
    createdAt: glob.createdAt,
    decidedBy: decision.by,
    decidedAt: decision.at,
    decisionReason: decision.reason,
    document: learningDocument(glob, a),
    outcome: learningOutcome(a),
    ...UNPROCESSED,
    processing: 'drafted',
    target: target.routed,
    catalogCandidate: catalog.candidate,
    catalogReason: catalog.reason,
    occurrenceCount: facts.occurrenceCount,
    extraEvidence: learningExtraEvidence(a),
    duplicateOf: links.duplicateOf,
    suppressedBy: links.suppressedBy,
    coveredBy: links.coveredBy,
    possiblyCoveredBy: links.possiblyCoveredBy,
    contradicts: links.contradicts,
    draft: drafted?.draft ?? null,
    draftedAgainstVersion: drafted?.targetVersion ?? null,
    rationale: drafted?.rationale ?? null,
    staleSince: stale.since,
    staleReason: stale.reason,
    staleDismissedAt: stale.dismissedAt,
    keptApartFrom: links.keptApartFrom,
    mergeNote: learningMergeNote(a),
    effectCheck: learningEffectCheck(a),
    version: glob.version,
  };
};

/** A merge note as the attachment's readable text. */
export const mergeNoteText = (note: NonNullable<KbItem['mergeNote']>): string =>
  `Closed by ${note.by} at ${note.at}: this learning says "${note.quote}"; the other says "${note.survivorQuote}".`;
