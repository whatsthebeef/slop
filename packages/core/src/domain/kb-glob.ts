import type { DecisionAttributes, DecisionOutcome, KnowledgeCoverage, KnowledgePossibleCoverage } from './attributes.js';
import { decisionOf } from './decision-glob.js';
import type { JsonValue } from './events.js';
import { UNPROCESSED } from './kb.js';
import type { ExtraEvidence, KbContradiction, KbCoverage, KbItem, KbItemStatus, KbPossibleCoverage } from './kb.js';
import type { Artifact } from './knowledge.js';
import type { Glob, GlobLink } from './types.js';

/**
 * A KB item *is* its decision glob (same `k` ID): pure mapping between the two shapes. The glob holds the statement
 * (`summary`), the item's fields (attributes), how it relates to other learnings (`links`), its outcome and status (the
 * decision rows); its artifacts hold the payload (statement and evidence, or a proposed document), the draft, the
 * approval's outcome, the effect check, and attachments for evidence merged in from near-duplicates and the merge note.
 */

/** A decision glob that is a KB learning: one an agent submitted or slop mined (inbox, extracted and manual ones are not). */
export const isKbGlob = (glob: Glob): boolean => {
  const origin = decisionOf(glob)?.origin.kind;
  return origin === 'submitted' || origin === 'mined';
};

/** Between the statement and the evidence in a statement's payload. */
export const EVIDENCE_HEADING = '\n\n## Evidence\n\n';

/** The payload (plan.md) of a learning: its statement and evidence, or a proposed document's body. Kept exact so it parses back. */
export const proposalText = (item: Pick<KbItem, 'statement' | 'evidence' | 'document'>): string =>
  item.document !== null ? item.document.content : `${item.statement}${EVIDENCE_HEADING}${item.evidence}`;

/** The evidence in a statement's payload; a payload a person rewrote (no heading after the statement) is all evidence. */
export const evidenceOfPayload = (statement: string, payload: string): string =>
  payload.startsWith(`${statement}${EVIDENCE_HEADING}`) ? payload.slice(statement.length + EVIDENCE_HEADING.length) : payload;

/** The attachment labels a learning uses. */
export const MERGE_NOTE_LABEL = 'merge_note';
/** A document proposal's submission evidence (its payload is the document). */
export const DOCUMENT_EVIDENCE_LABEL = 'evidence';
export const EVIDENCE_PREFIX = 'evidence:';

const isKnowledgePossible = (hint: KbPossibleCoverage): hint is KnowledgePossibleCoverage => hint.kind !== 'item';

/** The KB fields of a learning's decision attributes (the decision rows own scope, origin, channel, outcome and archived). */
export const kbAttributesOf = (item: KbItem): Partial<DecisionAttributes> => {
  const coveredByText: KnowledgeCoverage | null = item.coveredBy?.kind === 'knowledge' ? item.coveredBy : null;
  const possible = item.possiblyCoveredBy;
  const contradictsText = item.contradicts.filter((c) => c.kind === 'knowledge');
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
    ...(coveredByText === null ? {} : { coveredByText }),
    ...(possible !== null && isKnowledgePossible(possible) ? { possiblyCoveredByText: possible } : {}),
    ...(contradictsText.length === 0 ? {} : { contradictsText }),
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

/** An item hint as a link's detail (the ID is the link's). */
const hintDetail = (hint: Extract<KbPossibleCoverage, { kind: 'item' }>): JsonValue => ({
  quote: hint.quote,
  shortQuote: true,
  ...(hint.claim === undefined ? {} : { claim: hint.claim }),
  ...(hint.ownQuote === undefined ? {} : { ownQuote: hint.ownQuote }),
  ...(hint.tooShort === undefined ? {} : { tooShort: hint.tooShort }),
  ...(hint.alsoTarget === undefined ? {} : { alsoTarget: { quote: hint.alsoTarget.quote, reason: hint.alsoTarget.reason } }),
  ...(hint.via === undefined ? {} : { via: hint.via }),
});

/** How a learning relates to others, as links: what closed it, a hint naming another learning, contradictions, pairs kept apart. */
export const kbLinksOf = (item: KbItem): GlobLink[] => {
  const links: GlobLink[] = [];
  if (item.duplicateOf !== null) links.push({ id: item.duplicateOf, kind: 'duplicate_of', source: 'pipeline' });
  if (item.suppressedBy !== null) links.push({ id: item.suppressedBy, kind: 'suppressed_by', source: 'pipeline' });
  if (item.coveredBy?.kind === 'item') links.push({ id: item.coveredBy.id, kind: 'covered_by', source: 'pipeline' });
  const hint = item.possiblyCoveredBy;
  if (hint?.kind === 'item') links.push({ id: hint.id, kind: 'possibly_covered_by', source: 'pipeline', detail: hintDetail(hint) });
  // `position` keeps the contradictions' order across links and the text ones (`contradictsText`).
  item.contradicts.forEach((c, position) => {
    if (c.kind === 'item') links.push({ id: c.ref, kind: 'contradicts', source: 'pipeline', detail: { note: c.note, position } });
  });
  for (const id of item.keptApartFrom) links.push({ id, kind: 'kept_apart_from', source: 'explicit' });
  return links;
};

const isRecord = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: JsonValue | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

const hintOf = (link: GlobLink): Extract<KbPossibleCoverage, { kind: 'item' }> => {
  const d = isRecord(link.detail) ? link.detail : {};
  const claim = d['claim'] === 'duplicate' || d['claim'] === 'suppressed' ? d['claim'] : undefined;
  const tooShort = d['tooShort'] === 'quote' || d['tooShort'] === 'ownQuote' || d['tooShort'] === 'both' ? d['tooShort'] : undefined;
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
    ...(isRecord(also) ? { alsoTarget: { quote: textOf(also['quote']) ?? '', reason: textOf(also['reason']) ?? '' } } : {}),
    ...(via === undefined ? {} : { via }),
  };
};

/** The contradictions in their order: those naming a learning at their recorded positions, the text ones in the gaps. */
const contradictionsOf = (links: readonly GlobLink[], texts: readonly KbContradiction[]): KbContradiction[] => {
  const named = links.filter((l) => l.kind === 'contradicts');
  const slots: (KbContradiction | undefined)[] = new Array<KbContradiction | undefined>(named.length + texts.length).fill(undefined);
  const unplaced: KbContradiction[] = [];
  for (const l of named) {
    const detail = isRecord(l.detail) ? l.detail : {};
    const entry: KbContradiction = { kind: 'item', ref: l.id, note: textOf(detail['note']) ?? '' };
    const position = detail['position'];
    if (typeof position === 'number' && Number.isInteger(position) && position >= 0 && position < slots.length && slots[position] === undefined) slots[position] = entry;
    else unplaced.push(entry);
  }
  const rest = [...unplaced, ...texts];
  return slots.map((slot) => slot ?? rest.shift()).filter((c): c is KbContradiction => c !== undefined);
};

/** The artifacts a learning reads from, by role. Only the latest version of each (kind, label) is given. */
interface KbArtifacts {
  readonly plan: Artifact | undefined;
  readonly draft: Artifact | undefined;
  readonly outcome: Artifact | undefined;
  readonly effectCheck: Artifact | undefined;
  readonly mergeNote: Artifact | undefined;
  readonly documentEvidence: Artifact | undefined;
  /** Evidence from near-duplicates, in the order it was added. */
  readonly extra: readonly Artifact[];
}

const kbArtifactsOf = (globId: string, artifacts: readonly Artifact[]): KbArtifacts => {
  const own = artifacts.filter((a) => a.globId === globId);
  const one = (kind: Artifact['kind'], label = '') => own.find((a) => a.kind === kind && a.label === label);
  return {
    plan: one('plan'),
    draft: one('draft'),
    outcome: one('outcome'),
    effectCheck: one('effect_check'),
    mergeNote: one('attachment', MERGE_NOTE_LABEL),
    documentEvidence: one('attachment', DOCUMENT_EVIDENCE_LABEL),
    // Each evidence label is written once, so its ID says when it was added.
    extra: own.filter((a) => a.kind === 'attachment' && a.label.startsWith(EVIDENCE_PREFIX)).sort((a, b) => a.id - b.id),
  };
};

const decidedOutcome = (outcome: DecisionOutcome | null): DecisionOutcome | null =>
  outcome !== null && (outcome.kind === 'accept' || outcome.kind === 'accept_with_edits' || outcome.kind === 'reject') ? outcome : null;

/**
 * A learning's status, from its decision: closed by the pipeline (`closedAs`), rejected, approved (an accept outcome, or
 * an approval's outcome artifact when the decision was reopened to choose again), else open (including needs work).
 */
export const kbStatusOf = (attributes: DecisionAttributes, approvalRecorded: boolean): KbItemStatus => {
  if (attributes.closedAs !== undefined) return attributes.closedAs;
  const kind = attributes.outcome?.kind;
  if (kind === 'reject') return 'rejected';
  if (kind === 'accept' || kind === 'accept_with_edits' || approvalRecorded) return 'approved';
  return 'open';
};

/**
 * The KB item a decision glob is, from the glob and its artifacts (null for any other glob). Its pipeline fields are
 * placeholders: `withProcessing` fills them in from its status and its jobs.
 */
export const kbItemOf = (glob: Glob, artifacts: readonly Artifact[]): KbItem | null => {
  const attributes = decisionOf(glob);
  if (attributes === null || !isKbGlob(glob)) return null;
  const a = kbArtifactsOf(glob.id, artifacts);
  const kbOutcome = a.outcome?.content === '' ? undefined : a.outcome?.provenance.kbOutcome;
  const status = kbStatusOf(attributes, kbOutcome !== undefined && kbOutcome.kind !== 'rejected');
  const decided = decidedOutcome(attributes.outcome);
  // Approved, but the decision was reopened to choose again: the approval's outcome artifact says who and when.
  const record = decided === null && status === 'approved' ? a.outcome : undefined;
  const payload = a.plan?.content ?? glob.summary;
  const meta = attributes.document;
  const links = glob.links ?? [];
  const linkOf = (kind: GlobLink['kind']) => links.find((l) => l.kind === kind);
  const coveredByItem = linkOf('covered_by');
  const coveredBy: KbCoverage | null = coveredByItem !== undefined ? { kind: 'item', id: coveredByItem.id } : (attributes.coveredByText ?? null);
  const hintLink = linkOf('possibly_covered_by');
  const contradicts = contradictionsOf(links, attributes.contradictsText ?? []);
  const extraEvidence: ExtraEvidence[] = a.extra.map((e) => ({
    itemId: e.provenance.evidence?.itemId ?? e.label.slice(EVIDENCE_PREFIX.length).replace(/#\d+$/, ''),
    globIds: e.provenance.evidence?.globIds ?? [],
    evidence: e.content,
    submittedBy: e.provenance.actor,
    at: e.createdAt,
  }));
  const draftMeta = a.draft?.content === '' ? undefined : a.draft?.provenance.draft;
  const draft = a.draft !== undefined && draftMeta !== undefined ? { section: draftMeta.section, content: a.draft.content } : null;
  return {
    id: glob.id,
    boardId: glob.boardId,
    status,
    type: attributes.kind ?? 'gotcha',
    statement: glob.summary,
    evidence: meta === undefined ? evidenceOfPayload(glob.summary, payload) : (a.documentEvidence?.content ?? ''),
    suggestedTarget: attributes.target?.suggested ?? null,
    sourceGlobIds: attributes.sourceGlobs ?? [],
    source: attributes.origin.kind === 'mined' ? 'mined' : 'submitted',
    signal: attributes.signal ?? null,
    agentSetVersion: attributes.agentSetVersion ?? null,
    submittedBy: glob.creator,
    createdAt: glob.createdAt,
    decidedBy: decided?.by ?? record?.provenance.actor ?? null,
    decidedAt: decided?.at ?? record?.createdAt ?? null,
    decisionReason: decided?.reason ?? null,
    document: meta === undefined ? null : { ...meta, content: payload },
    outcome: kbOutcome ?? null,
    ...UNPROCESSED,
    processing: 'drafted',
    target: attributes.target?.routed ?? null,
    catalogCandidate: attributes.catalogCandidate === true,
    catalogReason: attributes.catalogReason ?? null,
    occurrenceCount: attributes.evidenceCount ?? 1,
    extraEvidence,
    duplicateOf: linkOf('duplicate_of')?.id ?? null,
    suppressedBy: linkOf('suppressed_by')?.id ?? null,
    coveredBy,
    possiblyCoveredBy: hintLink !== undefined ? hintOf(hintLink) : (attributes.possiblyCoveredByText ?? null),
    contradicts,
    draft,
    draftedAgainstVersion: draft === null ? null : (draftMeta?.targetVersion ?? null),
    rationale: draft === null ? null : (draftMeta?.rationale ?? null),
    staleSince: attributes.stale?.since ?? null,
    staleReason: attributes.stale?.reason ?? null,
    staleDismissedAt: attributes.stale?.dismissedAt ?? null,
    keptApartFrom: links.filter((l) => l.kind === 'kept_apart_from').map((l) => l.id),
    mergeNote: a.mergeNote?.content === '' ? null : (a.mergeNote?.provenance.mergeNote ?? null),
    effectCheck: a.effectCheck?.content === '' ? null : (a.effectCheck?.provenance.effectCheck ?? null),
    version: glob.version,
  };
};

/** A merge note as the attachment's readable text. */
export const mergeNoteText = (note: NonNullable<KbItem['mergeNote']>): string =>
  `Closed by ${note.by} at ${note.at}: this learning says "${note.quote}"; the other says "${note.survivorQuote}".`;
