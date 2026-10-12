import { evidenceCount } from './kb.js';
import type { DraftPreview, KbContradiction, KbCoverage, KbDraft, KbItem, KbItemStatus, KbPossibleCoverage, KbProcessing, KbTarget, LearningType, ProposedDocument } from './kb.js';
import { isDecisionAttributes } from './attributes.js';
import type { DecisionAttributes, DecisionScope, ScopeKind } from './attributes.js';
import type { Glob } from './types.js';

/**
 * Pure helpers for decision globs: what a decision governs (scope), whether it applies to a work glob, the keys that make
 * creating one idempotent, and the deterministic assessment shown in its review section.
 */

/** A decision's title is the first line of its statement, cut to this many characters. */
export const DECISION_TITLE_MAX = 120;

const firstLine = (text: string, max: number): string => {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};

export const decisionGlobTitle = (statement: string): string => firstLine(statement, DECISION_TITLE_MAX) || 'Untitled decision';

/** The glob's decision attributes, or null for a work glob (or a legacy glob without any). */
export const decisionOf = (glob: Glob): DecisionAttributes | null =>
  glob.category === 'decision' && isDecisionAttributes(glob.attributes) ? glob.attributes : null;

export const isDecisionGlob = (glob: Glob): boolean => glob.category === 'decision';

/** Rejected or closed by the pipeline: hidden from the board and its counts. */
export const isArchivedDecision = (glob: Glob): boolean => decisionOf(glob)?.archived === true;

/** How far a scope reaches; a broader scope outranks a narrower one when two decisions disagree. */
export const SCOPE_RANK: Readonly<Record<ScopeKind, number>> = { glob: 0, future_work: 1, area_group: 2, project: 3 };

export const scopeLabel = (scope: DecisionScope): string => {
  switch (scope.kind) {
    case 'glob':
      return `glob ${scope.ref}`;
    case 'future_work':
      return scope.ref === null ? 'future work' : `future work in ${scope.ref}`;
    case 'area_group':
      return `group ${scope.ref}`;
    case 'project':
      return 'the whole project';
  }
};

/** The idempotency keys of decision globs, one per proposal source, so any creation is safe to repeat. */
export const kbItemKey = (itemId: string): string => `kb:${itemId}`;
export const inboxKey = (inboxId: number): string => `inbox:${String(inboxId)}`;
export const extractedKey = (decisionId: number): string => `decision:${String(decisionId)}`;

/**
 * Where a submitted learning applies unless an admin says otherwise: a decision learning governs the project, anything
 * else the work that comes after it. Editable afterwards.
 */
export const defaultScope = (type: LearningType): DecisionScope =>
  type === 'decision' ? { kind: 'project', ref: null } : { kind: 'future_work', ref: null };

/** An accepted decision binds: accepted (with or without edits), or whose needs-work glob merged; not archived. */
export const isAccepted = (glob: Glob): boolean => {
  const attributes = decisionOf(glob);
  if (attributes === null || attributes.archived === true || attributes.outcome === null) return false;
  if (glob.status !== 'reviewing' && glob.status !== 'signed_off') return false;
  const { kind, workLanded } = attributes.outcome;
  return kind === 'accept' || kind === 'accept_with_edits' || (kind === 'needs_work' && workLanded === true);
};

/** Whether an accepted decision governs a work glob, by its scope. Future work means globs created after the decision. */
export const appliesTo = (decision: Glob, work: Glob): boolean => {
  const attributes = decisionOf(decision);
  if (attributes === null || !isAccepted(decision) || work.category === 'decision') return false;
  const { scope } = attributes;
  switch (scope.kind) {
    case 'glob':
      return scope.ref === work.id;
    case 'future_work':
      return decision.createdAt <= work.createdAt && (scope.ref === null || scope.ref === work.group);
    case 'area_group':
      return work.group !== null && scope.ref === work.group;
    case 'project':
      return true;
  }
};

/** The accepted decisions that govern `work`, broadest first (then oldest), so the widest rule reads before its exceptions. */
export const applicableDecisions = (decisions: readonly Glob[], work: Glob): Glob[] =>
  decisions
    .filter((d) => appliesTo(d, work))
    .sort(
      (a, b) =>
        SCOPE_RANK[decisionOf(b)?.scope.kind ?? 'glob'] - SCOPE_RANK[decisionOf(a)?.scope.kind ?? 'glob'] ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

/** A decision as `get_context` serves it to the glob it governs. */
export interface ScopedDecision {
  readonly id: string;
  readonly title: string;
  readonly scope: DecisionScope;
  /** The statement, one line. */
  readonly statement: string;
  readonly outcome: string;
}

export const scopedDecision = (decision: Glob): ScopedDecision | null => {
  const attributes = decisionOf(decision);
  if (attributes === null) return null;
  return {
    id: decision.id,
    title: decision.title,
    scope: attributes.scope,
    statement: firstLine(decision.summary, 300),
    outcome: attributes.outcome?.kind ?? 'open',
  };
};

/** The `Decisions` attachment a new glob gets: IDs, scope and a one-line statement each (not inline text). */
export const DECISIONS_LABEL = 'Decisions';
export const decisionsAttachment = (decisions: readonly ScopedDecision[]): string =>
  `Accepted decisions that govern this glob (read them with get_context or get_glob):\n\n${decisions
    .map((d) => `- ${d.id} (${scopeLabel(d.scope)}): ${d.statement}`)
    .join('\n')}\n`;

/**
 * The broader decision globs an open item contradicts: `contradicts` entries that name another item with a decision glob
 * whose scope outranks this one's. Purely structural; the contradiction itself is the pipeline's finding.
 */
export const broaderConflicts = (
  scope: DecisionScope,
  item: Pick<KbItem, 'contradicts'>,
  globOfItem: (itemId: string) => Glob | undefined,
): string[] => {
  const found: string[] = [];
  for (const c of item.contradicts) {
    if (c.kind !== 'item') continue;
    const other = globOfItem(c.ref);
    const theirs = other === undefined ? null : decisionOf(other);
    if (other !== undefined && theirs !== null && SCOPE_RANK[theirs.scope.kind] > SCOPE_RANK[scope.kind] && !found.includes(other.id)) found.push(other.id);
  }
  return found;
};

export type SuggestedOutcome = 'accept' | 'needs_work' | 'reject';

/** What a learning's assessment reads (each field as on the KB item it was taken from). */
export interface LearningAssessmentFacts {
  readonly status: KbItemStatus;
  readonly coveredBy: KbCoverage | null;
  readonly possiblyCoveredBy: KbPossibleCoverage | null;
  readonly contradicts: readonly KbContradiction[];
  readonly catalogCandidate: boolean;
  readonly staleSince: string | null;
  readonly processing: KbProcessing;
  readonly document: ProposedDocument | null;
  readonly target: KbTarget | null;
  readonly draft: KbDraft | null;
  readonly occurrenceCount: number;
  readonly sourceGlobIds: readonly string[];
}

export interface AssessmentInput {
  readonly attributes: DecisionAttributes;
  readonly item: LearningAssessmentFacts | null;
  readonly preview: DraftPreview | null;
  /** Broader-scope decision globs this one contradicts. */
  readonly conflicts: readonly string[];
}

export interface Assessment {
  readonly markdown: string;
  readonly suggested: SuggestedOutcome | null;
}

const targetText = (item: LearningAssessmentFacts): string => {
  if (item.document !== null) return `new or updated document \`${item.document.name}\``;
  if (item.target === null) return item.processing === 'failed' ? 'none (routing failed)' : 'not routed yet';
  const section = item.target.section === null ? '' : `, section "${item.target.section}"`;
  return `${item.target.kind} \`${item.target.name}\`${section}`;
};

const changeText = (item: LearningAssessmentFacts, preview: DraftPreview | null): string => {
  if (item.document !== null) return 'a whole document';
  if (preview === null) return item.draft === null ? 'no draft yet' : 'a draft (no preview available)';
  const added = preview.diff.filter((l) => l.op === 'added').length;
  const removed = preview.diff.filter((l) => l.op === 'removed').length;
  return `+${String(added)} / -${String(removed)} lines against version ${String(preview.version)}`;
};

/**
 * The assessment shown in a decision's review section: what is proposed, where, how big the change is, what flags the
 * pipeline raised, and an outcome suggested by fixed rules (covered: reject; contradicts: needs work; drafted with no
 * flags: accept). Deterministic, so it is reproducible and costs nothing; a person still chooses.
 */
export const assessmentOf = (input: AssessmentInput): Assessment => {
  const { attributes, item, preview, conflicts } = input;
  const flags: string[] = [];
  let suggested: SuggestedOutcome | null = null;
  if (item !== null) {
    if (item.status !== 'open') flags.push(`The knowledge item is ${item.status}${item.coveredBy === null ? '' : ' (already covered)'}.`);
    if (item.possiblyCoveredBy !== null) flags.push('May already be covered by existing knowledge.');
    for (const c of item.contradicts) flags.push(`Contradicts ${c.kind === 'item' ? `item ${c.ref}` : c.ref}: ${c.note}`);
    if (item.catalogCandidate) flags.push('Would hold for any project: a candidate for the catalog.');
    if (preview?.stale === true) flags.push('Stale draft: the target changed since it was drafted; it is drafted again before it can be accepted.');
    if (item.staleSince !== null) flags.push('No recent evidence: weekly consolidation flagged it stale.');
    if (item.processing === 'failed') flags.push('The pipeline gave up on it; decide by hand or retry it on the Knowledge page.');
  }
  for (const id of conflicts) flags.push(`Conflicts with ${id} (broader scope).`);

  if (item !== null && (item.coveredBy !== null || item.possiblyCoveredBy !== null || item.status === 'covered')) suggested = 'reject';
  else if ((item !== null && item.contradicts.length > 0) || conflicts.length > 0) suggested = 'needs_work';
  // Only an open learning can be accepted: a decided or closed one has nothing left to accept, whatever its fields say.
  else if (item?.status === 'open' && flags.length === 0 && (item.document !== null || (item.processing === 'drafted' && item.draft !== null))) suggested = 'accept';

  const lines = [
    '## Assessment',
    '',
    `- Scope: ${scopeLabel(attributes.scope)}`,
    `- Channel: ${attributes.channel}`,
  ];
  if (item !== null) {
    lines.push(`- Target: ${targetText(item)}`);
    lines.push(`- Change: ${changeText(item, preview)}`);
    lines.push(`- Evidence: ${String(evidenceCount(item))} occurrence(s) across ${item.sourceGlobIds.length === 0 ? 'no globs' : item.sourceGlobIds.join(', ')}`);
  } else {
    lines.push('- Change: none (this decision has no knowledge item; accepting records the outcome only)');
  }
  lines.push('', '### Flags', '', ...(flags.length === 0 ? ['None.'] : flags.map((f) => `- ${f}`)));
  lines.push(
    '',
    '### Suggested outcome',
    '',
    suggested === null
      ? 'None: not enough to suggest one yet.'
      : suggested === 'accept'
        ? 'Accept: drafted, with no flags.'
        : suggested === 'needs_work'
          ? 'Needs work: it contradicts existing knowledge or a broader decision.'
          : 'Reject: it appears to be covered already.',
  );
  return { markdown: `${lines.join('\n')}\n`, suggested };
};
