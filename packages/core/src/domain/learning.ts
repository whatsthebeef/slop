import type { DecisionAttributes, DecisionOutcome, KnowledgeCoverage, KnowledgePossibleCoverage } from './attributes.js';
import { decisionOf } from './decision-glob.js';
import type { LearningAssessmentFacts } from './decision-glob.js';
import type { EffectCheck } from './effect-check.js';
import type { JsonValue, OutboxJob } from './events.js';
import { evidenceCount, kbStepOf, lastEvidenceAt, pipelineFrom } from './kb.js';
import type {
  ExtraEvidence,
  KbContradiction,
  KbCoverage,
  KbDraft,
  LearningSource,
  LearningStatus,
  KbMergeNote,
  KbOutcome,
  KbPossibleCoverage,
  KbStaleReason,
  KbStep,
  KbTarget,
  LearningType,
  PipelineState,
  ProposedDocument,
} from './kb.js';
import type { Artifact, ArtifactKind } from './knowledge.js';
import type { KbSignal } from './signals.js';
import type { Glob, GlobLink } from './types.js';

/**
 * A learning is a decision glob an agent submitted or slop mined (`s<board>k<n>`). These pure helpers read one value of a
 * learning each, from the glob and its artifacts (and, for its pipeline state, its outbox jobs), so every derived value
 * is worked out in exactly one place. The glob holds the statement (`summary`), the learning's fields (attributes), how it
 * relates to other learnings (`links`), its outcome and status (the decision rows); its artifacts hold the payload
 * (statement and evidence, or a proposed document), the draft, the approval's outcome, the effect check, and attachments
 * for evidence merged in from near-duplicates and the merge note.
 */

/** A decision glob that is a learning: one an agent submitted or slop mined (inbox, extracted and manual ones are not). */
export const isLearning = (glob: Glob): boolean => {
  const origin = decisionOf(glob)?.origin.kind;
  return origin === 'submitted' || origin === 'mined';
};

/** The artifact kinds a learning reads from. */
export const LEARNING_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'plan',
  'draft',
  'outcome',
  'effect_check',
  'attachment',
];

/** Between the statement and the evidence in a statement's payload. */
export const EVIDENCE_HEADING = '\n\n## Evidence\n\n';

/** The evidence in a statement's payload; a payload a person rewrote (no heading after the statement) is all evidence. */
export const evidenceOfPayload = (statement: string, payload: string): string =>
  payload.startsWith(`${statement}${EVIDENCE_HEADING}`)
    ? payload.slice(statement.length + EVIDENCE_HEADING.length)
    : payload;

/** The attachment labels a learning uses. */
export const MERGE_NOTE_LABEL = 'merge_note';
/** A document proposal's submission evidence (its payload is the document). */
export const DOCUMENT_EVIDENCE_LABEL = 'evidence';
export const EVIDENCE_PREFIX = 'evidence:';

/** The artifacts a learning reads from, by role. Only the latest version of each (kind, label) is given. */
export interface LearningArtifacts {
  readonly plan: Artifact | undefined;
  readonly draft: Artifact | undefined;
  readonly outcome: Artifact | undefined;
  readonly effectCheck: Artifact | undefined;
  readonly mergeNote: Artifact | undefined;
  readonly documentEvidence: Artifact | undefined;
  /** Evidence from near-duplicates, in the order it was added. */
  readonly extra: readonly Artifact[];
}

export const learningArtifactsOf = (
  globId: string,
  artifacts: readonly Artifact[],
): LearningArtifacts => {
  const own = artifacts.filter((a) => a.globId === globId);
  const one = (kind: Artifact['kind'], label = '') =>
    own.find((a) => a.kind === kind && a.label === label);
  return {
    plan: one('plan'),
    draft: one('draft'),
    outcome: one('outcome'),
    effectCheck: one('effect_check'),
    mergeNote: one('attachment', MERGE_NOTE_LABEL),
    documentEvidence: one('attachment', DOCUMENT_EVIDENCE_LABEL),
    // Each evidence label is written once, so its ID says when it was added.
    extra: own
      .filter((a) => a.kind === 'attachment' && a.label.startsWith(EVIDENCE_PREFIX))
      .sort((a, b) => a.id - b.id),
  };
};

/** A learning as read: its glob, its artifacts by role and its pipeline jobs. Raw rows; the helpers derive the values. */
export interface LearningRead {
  readonly glob: Glob;
  readonly artifacts: LearningArtifacts;
  readonly jobs: readonly OutboxJob[];
}

const attributesOf = (glob: Glob): DecisionAttributes | null => decisionOf(glob);

/** What a learning is and where it came from. */
export interface LearningFacts {
  readonly kind: LearningType;
  readonly source: LearningSource;
  /** Mined learnings: the signal that raised it and the figures behind it. */
  readonly signal: KbSignal | null;
  readonly agentSetVersion: number | null;
  readonly sourceGlobIds: readonly string[];
  /** 1 plus the near-duplicates merged into it. */
  readonly occurrenceCount: number;
}

export const learningFacts = (glob: Glob): LearningFacts => {
  const attributes = attributesOf(glob);
  return {
    kind: attributes?.kind ?? 'gotcha',
    source: attributes?.origin.kind === 'mined' ? 'mined' : 'submitted',
    signal: attributes?.signal ?? null,
    agentSetVersion: attributes?.agentSetVersion ?? null,
    sourceGlobIds: attributes?.sourceGlobs ?? [],
    occurrenceCount: attributes?.evidenceCount ?? 1,
  };
};

/** What an approval did (or an agent's rejection), from the outcome artifact; null when there is none or it was cleared. */
export const learningOutcome = (a: Pick<LearningArtifacts, 'outcome'>): KbOutcome | null =>
  a.outcome === undefined || a.outcome.content === ''
    ? null
    : (a.outcome.provenance.kbOutcome ?? null);

/**
 * A learning's status from its decision attributes and its outcome: closed by the pipeline (`closedAs`), rejected,
 * approved (an accept outcome, or an approval's outcome artifact when the decision was reopened to choose again), else
 * open (including needs work).
 */
export const learningStatusFrom = (
  attributes: DecisionAttributes | null,
  outcome: KbOutcome | null,
): LearningStatus => {
  if (attributes?.closedAs !== undefined) return attributes.closedAs;
  const kind = attributes?.outcome?.kind;
  if (kind === 'reject') return 'rejected';
  if (
    kind === 'accept' ||
    kind === 'accept_with_edits' ||
    (outcome !== null && outcome.kind !== 'rejected')
  )
    return 'approved';
  return 'open';
};

export const learningStatus = (glob: Glob, a: Pick<LearningArtifacts, 'outcome'>): LearningStatus =>
  learningStatusFrom(attributesOf(glob), learningOutcome(a));

const decidedOutcome = (outcome: DecisionOutcome | null | undefined): DecisionOutcome | null =>
  outcome !== undefined &&
  outcome !== null &&
  (outcome.kind === 'accept' || outcome.kind === 'accept_with_edits' || outcome.kind === 'reject')
    ? outcome
    : null;

/** Who decided a learning, when and why: from the decision's outcome, or (approved, then reopened to choose again) the approval's outcome artifact. */
export interface LearningDecision {
  readonly by: string | null;
  readonly at: string | null;
  readonly reason: string | null;
}

export const learningDecision = (
  glob: Glob,
  a: Pick<LearningArtifacts, 'outcome'>,
): LearningDecision => {
  const decided = decidedOutcome(attributesOf(glob)?.outcome);
  // Approved, but the decision was reopened to choose again: the approval's outcome artifact says who and when.
  const record = decided === null && learningStatus(glob, a) === 'approved' ? a.outcome : undefined;
  return {
    by: decided?.by ?? record?.provenance.actor ?? null,
    at: decided?.at ?? record?.createdAt ?? null,
    reason: decided?.reason ?? null,
  };
};

/** Where the submitter thinks a learning belongs, and where the pipeline (or an admin) routed it. */
export interface LearningTarget {
  readonly suggested: string | null;
  readonly routed: KbTarget | null;
}

export const learningTarget = (glob: Glob): LearningTarget => {
  const target = attributesOf(glob)?.target;
  return { suggested: target?.suggested ?? null, routed: target?.routed ?? null };
};

/** A whole-document proposal (`/kb-bootstrap`): its frontmatter from the attributes, its body from the payload. Null for a statement. */
export const learningDocument = (
  glob: Glob,
  a: Pick<LearningArtifacts, 'plan'>,
): ProposedDocument | null => {
  const meta = attributesOf(glob)?.document;
  return meta === undefined ? null : { ...meta, content: a.plan?.content ?? glob.summary };
};

/** The submission's evidence: from a statement's payload, or a document proposal's evidence attachment. */
export const learningEvidence = (
  glob: Glob,
  a: Pick<LearningArtifacts, 'plan' | 'documentEvidence'>,
): string =>
  attributesOf(glob)?.document === undefined
    ? evidenceOfPayload(glob.summary, a.plan?.content ?? glob.summary)
    : (a.documentEvidence?.content ?? '');

/** Evidence near-duplicates added, in the order it was added. */
export const learningExtraEvidence = (a: Pick<LearningArtifacts, 'extra'>): ExtraEvidence[] =>
  a.extra.map((e) => ({
    itemId:
      e.provenance.evidence?.itemId ?? e.label.slice(EVIDENCE_PREFIX.length).replace(/#\d+$/, ''),
    globIds: e.provenance.evidence?.globIds ?? [],
    evidence: e.content,
    submittedBy: e.provenance.actor,
    at: e.createdAt,
  }));

/** How much evidence a learning has (`evidenceCount`) and its freshest (`lastEvidenceAt`): the open queue's order. */
export interface LearningEvidenceSummary {
  readonly count: number;
  readonly lastAt: string;
}

/** The fields the open queue's order (`byEvidence`) reads. */
export const learningEvidenceOrder = (
  glob: Glob,
  a: Pick<LearningArtifacts, 'extra'>,
): {
  id: string;
  createdAt: string;
  occurrenceCount: number;
  sourceGlobIds: readonly string[];
  extraEvidence: readonly ExtraEvidence[];
  signal: KbSignal | null;
} => {
  const facts = learningFacts(glob);
  return {
    id: glob.id,
    createdAt: glob.createdAt,
    occurrenceCount: facts.occurrenceCount,
    sourceGlobIds: facts.sourceGlobIds,
    extraEvidence: learningExtraEvidence(a),
    signal: facts.signal,
  };
};

export const learningEvidenceSummary = (
  glob: Glob,
  a: Pick<LearningArtifacts, 'extra'>,
): LearningEvidenceSummary => {
  const order = learningEvidenceOrder(glob, a);
  return { count: evidenceCount(order), lastAt: lastEvidenceAt(order) };
};

const isRecord = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: JsonValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const hintOf = (link: GlobLink): Extract<KbPossibleCoverage, { kind: 'item' }> => {
  const d = isRecord(link.detail) ? link.detail : {};
  const claim = d['claim'] === 'duplicate' || d['claim'] === 'suppressed' ? d['claim'] : undefined;
  const tooShort =
    d['tooShort'] === 'quote' || d['tooShort'] === 'ownQuote' || d['tooShort'] === 'both'
      ? d['tooShort']
      : undefined;
  const also = d['alsoTarget'];
  const ownQuote = textOf(d['ownQuote']);
  const via = textOf(d['via']);
  return {
    kind: 'item',
    id: link.id,
    quote: textOf(d['quote']) ?? '',
    shortQuote: true,
    ...(claim === undefined ? {} : { claim }),
    ...(ownQuote === undefined ? {} : { ownQuote }),
    ...(tooShort === undefined ? {} : { tooShort }),
    ...(isRecord(also)
      ? { alsoTarget: { quote: textOf(also['quote']) ?? '', reason: textOf(also['reason']) ?? '' } }
      : {}),
    ...(via === undefined ? {} : { via }),
  };
};

/** The contradictions in their order: those naming a learning at their recorded positions, the text ones in the gaps. */
const contradictionsOf = (
  links: readonly GlobLink[],
  texts: readonly KbContradiction[],
): KbContradiction[] => {
  const named = links.filter((l) => l.kind === 'contradicts');
  const slots: (KbContradiction | undefined)[] = new Array<KbContradiction | undefined>(
    named.length + texts.length,
  ).fill(undefined);
  const unplaced: KbContradiction[] = [];
  for (const l of named) {
    const detail = isRecord(l.detail) ? l.detail : {};
    const entry: KbContradiction = { kind: 'item', ref: l.id, note: textOf(detail['note']) ?? '' };
    const position = detail['position'];
    if (
      typeof position === 'number' &&
      Number.isInteger(position) &&
      position >= 0 &&
      position < slots.length &&
      slots[position] === undefined
    )
      slots[position] = entry;
    else unplaced.push(entry);
  }
  const rest = [...unplaced, ...texts];
  return slots
    .map((slot) => slot ?? rest.shift())
    .filter((c): c is KbContradiction => c !== undefined);
};

/** An item hint as a link's detail (the ID is the link's): `hintOf` reads it back. */
const hintDetail = (hint: Extract<KbPossibleCoverage, { kind: 'item' }>): JsonValue => ({
  quote: hint.quote,
  shortQuote: true,
  ...(hint.claim === undefined ? {} : { claim: hint.claim }),
  ...(hint.ownQuote === undefined ? {} : { ownQuote: hint.ownQuote }),
  ...(hint.tooShort === undefined ? {} : { tooShort: hint.tooShort }),
  ...(hint.alsoTarget === undefined
    ? {}
    : { alsoTarget: { quote: hint.alsoTarget.quote, reason: hint.alsoTarget.reason } }),
  ...(hint.via === undefined ? {} : { via: hint.via }),
});

/** The link a hint naming another learning is stored as; none for a hint about a document's text (an attribute). */
export const possiblyCoveredLinks = (hint: KbPossibleCoverage | null): GlobLink[] =>
  hint?.kind === 'item'
    ? [{ id: hint.id, kind: 'possibly_covered_by', source: 'pipeline', detail: hintDetail(hint) }]
    : [];

/** The links contradictions naming a learning are stored as; `position` keeps their order among the text ones. */
export const contradictionLinks = (contradicts: readonly KbContradiction[]): GlobLink[] =>
  contradicts.flatMap((c, position): GlobLink[] =>
    c.kind === 'item'
      ? [{ id: c.ref, kind: 'contradicts', source: 'pipeline', detail: { note: c.note, position } }]
      : [],
  );

/** The attributes the text-side of coverage, hints and contradictions are stored as (the item side is links). */
export const dedupeAttributesOf = (
  coveredBy: KbCoverage | null,
  possiblyCoveredBy: KbPossibleCoverage | null,
  contradicts: readonly KbContradiction[],
): Partial<DecisionAttributes> => {
  const coveredByText: KnowledgeCoverage | null = coveredBy?.kind === 'knowledge' ? coveredBy : null;
  const possible: KnowledgePossibleCoverage | null =
    possiblyCoveredBy !== null && possiblyCoveredBy.kind !== 'item' ? possiblyCoveredBy : null;
  const contradictsText = contradicts.filter((c) => c.kind === 'knowledge');
  return {
    ...(coveredByText === null ? {} : { coveredByText }),
    ...(possible === null ? {} : { possiblyCoveredByText: possible }),
    ...(contradictsText.length === 0 ? {} : { contradictsText }),
  };
};

/** How a learning relates to others: what closed it, a hint that it may be said already, contradictions, pairs kept apart. */
export interface LearningLinks {
  /** `merged`: the open learning it was folded into. */
  readonly duplicateOf: string | null;
  /** `suppressed`: the rejected learning it matched. */
  readonly suppressedBy: string | null;
  /** `covered`: what already says it. */
  readonly coveredBy: KbCoverage | null;
  /** `open`: what may already say it (a hint for the admin). */
  readonly possiblyCoveredBy: KbPossibleCoverage | null;
  readonly contradicts: readonly KbContradiction[];
  /** Learnings an admin separated from this one by reopening a merge. */
  readonly keptApartFrom: readonly string[];
}

export const learningLinks = (glob: Glob): LearningLinks => {
  const attributes = attributesOf(glob);
  const links = glob.links ?? [];
  const linkOf = (kind: GlobLink['kind']) => links.find((l) => l.kind === kind);
  const coveredByItem = linkOf('covered_by');
  const hintLink = linkOf('possibly_covered_by');
  return {
    duplicateOf: linkOf('duplicate_of')?.id ?? null,
    suppressedBy: linkOf('suppressed_by')?.id ?? null,
    coveredBy:
      coveredByItem !== undefined
        ? { kind: 'item', id: coveredByItem.id }
        : (attributes?.coveredByText ?? null),
    possiblyCoveredBy:
      hintLink !== undefined ? hintOf(hintLink) : (attributes?.possiblyCoveredByText ?? null),
    contradicts: contradictionsOf(links, attributes?.contradictsText ?? []),
    keptApartFrom: links.filter((l) => l.kind === 'kept_apart_from').map((l) => l.id),
  };
};

/** A learning's drafted change, the target version it was drafted against, and why. */
export interface LearningDraft {
  readonly draft: KbDraft;
  readonly targetVersion: number | null;
  readonly rationale: string | null;
}

/** The draft, or null when there is none (never drafted, or cleared to be drafted again). */
export const learningDraft = (a: Pick<LearningArtifacts, 'draft'>): LearningDraft | null => {
  const meta = a.draft?.content === '' ? undefined : a.draft?.provenance.draft;
  const draft =
    a.draft !== undefined && meta !== undefined
      ? { section: meta.section, content: a.draft.content }
      : null;
  // Drafts stored before a field existed read it as null.
  return draft === null
    ? null
    : { draft, targetVersion: meta?.targetVersion ?? null, rationale: meta?.rationale ?? null };
};

/** Whether an approved change worked; null when there is no check or it was cleared. */
export const learningEffectCheck = (
  a: Pick<LearningArtifacts, 'effectCheck'>,
): EffectCheck | null =>
  a.effectCheck === undefined || a.effectCheck.content === ''
    ? null
    : (a.effectCheck.provenance.effectCheck ?? null);

/** The verified quotes the pipeline closed a learning on; null when there are none or they were cleared. */
export const learningMergeNote = (a: Pick<LearningArtifacts, 'mergeNote'>): KbMergeNote | null =>
  a.mergeNote === undefined || a.mergeNote.content === ''
    ? null
    : (a.mergeNote.provenance.mergeNote ?? null);

/** Weekly consolidation's stale flag, and when an admin last kept the learning. */
export interface LearningStaleness {
  readonly since: string | null;
  readonly reason: KbStaleReason | null;
  readonly dismissedAt: string | null;
}

export const learningStaleness = (glob: Glob): LearningStaleness => {
  const stale = attributesOf(glob)?.stale;
  return {
    since: stale?.since ?? null,
    reason: stale?.reason ?? null,
    dismissedAt: stale?.dismissedAt ?? null,
  };
};

/** Would hold for any project: a suggested change to slop's catalog, with why. */
export const learningCatalog = (
  glob: Glob,
): { readonly candidate: boolean; readonly reason: string | null } => {
  const attributes = attributesOf(glob);
  return {
    candidate: attributes?.catalogCandidate === true,
    reason: attributes?.catalogReason ?? null,
  };
};

/** The pipeline step a learning waits for (`kbStepOf`). */
export const learningStep = (
  glob: Glob,
  a: Pick<LearningArtifacts, 'outcome' | 'plan' | 'draft'>,
): KbStep | null =>
  kbStepOf({
    status: learningStatus(glob, a),
    document: learningDocument(glob, a),
    target: learningTarget(glob).routed,
    draft: learningDraft(a)?.draft ?? null,
  });

/** Where the pipeline is with a learning, from its next step's newest job (`pipelineFrom`). `jobs` may hold others' jobs. */
export const pipelineState = (
  glob: Glob,
  a: LearningArtifacts,
  jobs: readonly OutboxJob[],
): PipelineState => pipelineFrom(glob.id, learningStatus(glob, a), learningStep(glob, a), jobs);

/** What a learning's assessment reads (`assessmentOf`). */
export const learningAssessmentFacts = (read: LearningRead): LearningAssessmentFacts => {
  const { glob, artifacts: a } = read;
  const facts = learningFacts(glob);
  const links = learningLinks(glob);
  return {
    status: learningStatus(glob, a),
    coveredBy: links.coveredBy,
    possiblyCoveredBy: links.possiblyCoveredBy,
    contradicts: links.contradicts,
    catalogCandidate: learningCatalog(glob).candidate,
    staleSince: learningStaleness(glob).since,
    processing: pipelineState(glob, a, read.jobs).processing,
    document: learningDocument(glob, a),
    target: learningTarget(glob).routed,
    draft: learningDraft(a)?.draft ?? null,
    occurrenceCount: facts.occurrenceCount,
    sourceGlobIds: facts.sourceGlobIds,
  };
};
