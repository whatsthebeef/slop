import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';
import { KB_STALE_REASONS, LEARNING_TYPES } from './kb.js';
import type { KbContradiction, KbCoverage, KbPossibleCoverage, KbStaleReason, KbTarget, LearningType, ProposedDocument } from './kb.js';
import { KNOWLEDGE_KINDS } from './knowledge.js';
import type { KnowledgeKind } from './knowledge.js';
import { SIGNAL_KINDS } from './signals.js';
import type { KbSignal } from './signals.js';
import type { Category } from './types.js';

/**
 * Per-category fields of a glob, kept in the glob document (no column). Work globs reserve the field for later and accept
 * no keys; a decision glob carries its scope, where it came from and its outcome, and a KB item's decision glob also the
 * item's own fields (what kind of learning, its target, evidence count, staleness, how the pipeline closed it).
 */
export const SCOPE_KINDS = ['glob', 'future_work', 'area_group', 'project'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** What a decision governs. `ref` is a glob ID, a group name, or null (all future work, or the whole project). */
export type DecisionScope =
  | { readonly kind: 'glob'; readonly ref: string }
  /** Applies to globs created after the decision; `ref` narrows it to one group. */
  | { readonly kind: 'future_work'; readonly ref: string | null }
  | { readonly kind: 'area_group'; readonly ref: string }
  | { readonly kind: 'project'; readonly ref: null };

/**
 * Where the decision's proposal came from: a learning an agent submitted or slop mined (the decision *is* that KB item,
 * same ID), an inbox item, an extracted decision, or a person.
 */
export type DecisionOrigin =
  | { readonly kind: 'submitted' }
  | { readonly kind: 'mined' }
  | { readonly kind: 'inbox'; readonly id: number }
  | { readonly kind: 'extracted'; readonly decisionId: number }
  | { readonly kind: 'manual' };

/** How the proposal reached the board: an agent, slop's mining, the inbox, a person, or the backfill. */
export const DECISION_CHANNELS = ['agent', 'mined', 'inbox', 'human', 'migration'] as const;
export type DecisionChannel = (typeof DECISION_CHANNELS)[number];

/** The five things a person can do with a decision, and `closed` for the pipeline closing it without one. */
export const DECISION_OUTCOME_KINDS = ['accept', 'accept_with_edits', 'retarget', 'needs_work', 'reject', 'closed'] as const;
export type DecisionOutcomeKind = (typeof DECISION_OUTCOME_KINDS)[number];

export interface DecisionOutcome {
  readonly kind: DecisionOutcomeKind;
  /** The person, or `slop`/`system` for the pipeline and the backfill. */
  readonly by: string;
  readonly at: string;
  readonly reason?: string;
  /** Needs work: the work glob that will make the change. */
  readonly linkedGlobId?: string;
  /** Needs work: the linked glob merged. */
  readonly workLanded?: true;
}

/** How the KB pipeline closed a learning without a decision: folded into an open item, matched a rejected one, already said. */
export const DECISION_CLOSED_AS = ['merged', 'suppressed', 'covered'] as const;
export type DecisionClosedAs = (typeof DECISION_CLOSED_AS)[number];

/** Where a learning goes: where the submitter suggested, and where routing put it (null until routed). */
export interface DecisionTarget {
  readonly suggested: string | null;
  readonly routed: KbTarget | null;
}

/** Weekly consolidation's stale flag (`since`, `reason`) and when an admin last kept the learning anyway. */
export interface DecisionStale {
  readonly since: string | null;
  readonly reason: KbStaleReason | null;
  readonly dismissedAt: string | null;
}

/** A whole-document proposal's name and frontmatter; its body is the payload. */
export type DecisionDocument = Omit<ProposedDocument, 'content'>;

/** Coverage by text in a document or agent file (coverage by another learning is a `covered_by` link). */
export type KnowledgeCoverage = Extract<KbCoverage, { readonly kind: 'knowledge' }>;
/** A hint that a document's text may already say it (a hint naming another learning is a `possibly_covered_by` link). */
export type KnowledgePossibleCoverage = Exclude<KbPossibleCoverage, { readonly kind: 'item' }>;

export interface DecisionAttributes {
  readonly scope: DecisionScope;
  readonly origin: DecisionOrigin;
  readonly channel: DecisionChannel;
  readonly outcome: DecisionOutcome | null;
  /** Broader-scope decision globs this one contradicts. */
  readonly conflictsWith?: readonly string[];
  /** Rejected, closed by the pipeline, or an approval old enough to leave the board: hidden from the board and its counts. */
  readonly archived?: true;
  /** The kind of learning (a KB item's decision). */
  readonly kind?: LearningType;
  /** The globs that produced the learning; near-duplicates add theirs. */
  readonly sourceGlobs?: readonly string[];
  readonly target?: DecisionTarget;
  /** The board's agent-set version the submitting run used. */
  readonly agentSetVersion?: number;
  /** Mined learnings: the signal that raised it, with the figures behind it. */
  readonly signal?: KbSignal;
  /** 1 plus the near-duplicates merged into it. */
  readonly evidenceCount?: number;
  /** Would hold for any project: a suggested change to slop's catalog, with why. */
  readonly catalogCandidate?: true;
  readonly catalogReason?: string;
  /** Set when the pipeline closed it (with `archived` and a `closed` outcome); Reopen clears it. */
  readonly closedAs?: DecisionClosedAs;
  readonly stale?: DecisionStale;
  readonly document?: DecisionDocument;
  /** Closed as covered by a document's text (no learning to link to). */
  readonly coveredByText?: KnowledgeCoverage;
  readonly possiblyCoveredByText?: KnowledgePossibleCoverage;
  /** Contradictions with documents or agent files (contradictions with learnings are `contradicts` links). */
  readonly contradictsText?: readonly KbContradiction[];
}

/** Work globs have no attributes yet. */
export type WorkAttributes = Readonly<Record<string, never>>;
export type GlobAttributes = DecisionAttributes | WorkAttributes;

export const isDecisionAttributes = (value: GlobAttributes | undefined): value is DecisionAttributes =>
  value !== undefined && 'scope' in value;

/** Longest ref, ID or name in an attribute, in characters. */
export const ATTRIBUTE_TEXT_MAX = 200;
/** Longest outcome reason. */
export const OUTCOME_REASON_MAX = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const oneLine = (value: unknown, name: string, max = ATTRIBUTE_TEXT_MAX): Result<string> => {
  if (typeof value !== 'string') return invalidInput(`${name} must be a string`);
  const text = value.trim();
  if (text === '') return invalidInput(`${name} must not be empty`);
  if (text.length > max) return invalidInput(`${name} is longer than ${max} characters`);
  if (/[\0\r\n]/.test(text)) return invalidInput(`${name} must be one line`);
  return ok(text);
};

const unknownKeys = (value: Record<string, unknown>, allowed: readonly string[], name: string): Result<null> => {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? invalidInput(`${name} has unknown keys: ${extra.join(', ')}`) : ok(null);
};

const SCOPE_KEYS = ['kind', 'ref'];

/** Checks a scope: its kind and ref (a glob's existence on the board is the service's to check). */
export const validateScope = (value: unknown): Result<DecisionScope> => {
  if (!isRecord(value)) return invalidInput('scope must be an object with kind and ref');
  const keys = unknownKeys(value, SCOPE_KEYS, 'scope');
  if (!keys.ok) return keys;
  const kind = SCOPE_KINDS.find((k) => k === value['kind']);
  if (kind === undefined) return invalidInput(`scope.kind must be one of ${SCOPE_KINDS.join(', ')}`);
  const ref = value['ref'];
  if (kind === 'project') {
    return ref === null || ref === undefined ? ok({ kind, ref: null }) : invalidInput('A project scope has no ref');
  }
  if (kind === 'future_work' && (ref === null || ref === undefined)) return ok({ kind, ref: null });
  const text = oneLine(ref, `scope.ref of a ${kind} scope`);
  return text.ok ? ok({ kind, ref: text.value }) : text;
};

const validateOrigin = (value: unknown): Result<DecisionOrigin> => {
  if (!isRecord(value)) return invalidInput('origin must be an object');
  switch (value['kind']) {
    case 'manual':
    case 'submitted':
    case 'mined':
      return ok({ kind: value['kind'] });
    case 'inbox': {
      const id = value['id'];
      return typeof id === 'number' && Number.isInteger(id) && id > 0 ? ok({ kind: 'inbox', id }) : invalidInput('origin.id must be an inbox item number');
    }
    case 'extracted': {
      const id = value['decisionId'];
      return typeof id === 'number' && Number.isInteger(id) && id > 0
        ? ok({ kind: 'extracted', decisionId: id })
        : invalidInput('origin.decisionId must be a decision number');
    }
    default:
      return invalidInput('origin.kind must be submitted, mined, inbox, extracted or manual');
  }
};

const validateOutcome = (value: unknown): Result<DecisionOutcome | null> => {
  if (value === null || value === undefined) return ok(null);
  if (!isRecord(value)) return invalidInput('outcome must be an object or null');
  const keys = unknownKeys(value, ['kind', 'by', 'at', 'reason', 'linkedGlobId', 'workLanded'], 'outcome');
  if (!keys.ok) return keys;
  const kind = DECISION_OUTCOME_KINDS.find((k) => k === value['kind']);
  if (kind === undefined) return invalidInput(`outcome.kind must be one of ${DECISION_OUTCOME_KINDS.join(', ')}`);
  const by = oneLine(value['by'], 'outcome.by');
  if (!by.ok) return by;
  const at = oneLine(value['at'], 'outcome.at');
  if (!at.ok) return at;
  let reason: string | undefined;
  if (value['reason'] !== undefined) {
    if (typeof value['reason'] !== 'string' || value['reason'].length > OUTCOME_REASON_MAX) {
      return invalidInput(`outcome.reason must be text of at most ${OUTCOME_REASON_MAX} characters`);
    }
    reason = value['reason'];
  }
  let linkedGlobId: string | undefined;
  if (value['linkedGlobId'] !== undefined) {
    const linked = oneLine(value['linkedGlobId'], 'outcome.linkedGlobId');
    if (!linked.ok) return linked;
    linkedGlobId = linked.value;
  }
  if (value['workLanded'] !== undefined && value['workLanded'] !== true) return invalidInput('outcome.workLanded is true or absent');
  return ok({
    kind,
    by: by.value,
    at: at.value,
    ...(reason === undefined ? {} : { reason }),
    ...(linkedGlobId === undefined ? {} : { linkedGlobId }),
    ...(value['workLanded'] === true ? { workLanded: true as const } : {}),
  });
};

// The KB fields are written by slop itself (the pipeline, the migration), never by a client, so these guards check shape
// rather than limits.
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isString);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isKnowledgeKind = (value: unknown): value is KnowledgeKind => KNOWLEDGE_KINDS.some((k) => k === value);

const isKbTarget = (value: unknown): value is KbTarget => {
  if (!isRecord(value) || !isKnowledgeKind(value['kind']) || !isString(value['name']) || !isNullableString(value['section'])) return false;
  const meta = value['newDocument'];
  return meta === null || (isRecord(meta) && isString(meta['area']) && isStringList(meta['audience']) && isString(meta['description']));
};

const isTarget = (value: unknown): value is DecisionTarget =>
  isRecord(value) && isNullableString(value['suggested']) && (value['routed'] === null || isKbTarget(value['routed']));

const isSignal = (value: unknown): value is KbSignal => {
  if (!isRecord(value)) return false;
  const { window, figures } = value;
  return (
    isString(value['key']) &&
    SIGNAL_KINDS.some((k) => k === value['kind']) &&
    isNullableString(value['agent']) &&
    isString(value['label']) &&
    isRecord(window) &&
    isString(window['from']) &&
    isString(window['to']) &&
    isRecord(figures) &&
    ['affected', 'eligible', 'rate', 'count'].every((k) => typeof figures[k] === 'number') &&
    isStringList(value['globIds']) &&
    isStringList(value['examples']) &&
    isString(value['measuredAt'])
  );
};

const isStale = (value: unknown): value is DecisionStale =>
  isRecord(value) &&
  isNullableString(value['since']) &&
  (value['reason'] === null || KB_STALE_REASONS.some((r) => r === value['reason'])) &&
  isNullableString(value['dismissedAt']);

const isDocument = (value: unknown): value is DecisionDocument =>
  isRecord(value) && isString(value['name']) && isString(value['area']) && isStringList(value['audience']) && isString(value['description']);

const isKnowledgeRef = (value: Record<string, unknown>): boolean =>
  isKnowledgeKind(value['knowledgeKind']) && isString(value['name']) && isNullableString(value['section']);

const isCoverageText = (value: unknown): value is KnowledgeCoverage => isRecord(value) && value['kind'] === 'knowledge' && isKnowledgeRef(value);

const isPossibleCoverageText = (value: unknown): value is KnowledgePossibleCoverage =>
  isRecord(value) &&
  (value['kind'] === undefined || value['kind'] === 'knowledge') &&
  isKnowledgeRef(value) &&
  isString(value['quote']) &&
  isString(value['reason']);

const isContradictionText = (value: unknown): value is KbContradiction =>
  isRecord(value) && value['kind'] === 'knowledge' && isString(value['ref']) && isString(value['note']);

/** The KB fields of a decision, each checked when present; absent ones stay absent. */
const validateKbFields = (value: Record<string, unknown>): Result<Partial<DecisionAttributes>> => {
  const out: { -readonly [K in keyof DecisionAttributes]?: DecisionAttributes[K] } = {};
  const kind = value['kind'];
  if (kind !== undefined) {
    const learning = LEARNING_TYPES.find((t) => t === kind);
    if (learning === undefined) return invalidInput(`kind must be one of ${LEARNING_TYPES.join(', ')}`);
    out.kind = learning;
  }
  const sourceGlobs = value['sourceGlobs'];
  if (sourceGlobs !== undefined) {
    if (!isStringList(sourceGlobs)) return invalidInput('sourceGlobs must be a list of glob IDs');
    out.sourceGlobs = sourceGlobs;
  }
  const target = value['target'];
  if (target !== undefined) {
    if (!isTarget(target)) return invalidInput('target must have suggested (text or null) and routed (a target or null)');
    out.target = target;
  }
  const agentSetVersion = value['agentSetVersion'];
  if (agentSetVersion !== undefined) {
    if (!isCount(agentSetVersion)) return invalidInput('agentSetVersion must be a version number');
    out.agentSetVersion = agentSetVersion;
  }
  const signal = value['signal'];
  if (signal !== undefined) {
    if (!isSignal(signal)) return invalidInput('signal must be a mined signal');
    out.signal = signal;
  }
  const evidence = value['evidenceCount'];
  if (evidence !== undefined) {
    if (!isCount(evidence) || evidence < 1) return invalidInput('evidenceCount must be a positive whole number');
    out.evidenceCount = evidence;
  }
  if (value['catalogCandidate'] !== undefined) {
    if (value['catalogCandidate'] !== true) return invalidInput('catalogCandidate is true or absent');
    out.catalogCandidate = true;
  }
  const catalogReason = value['catalogReason'];
  if (catalogReason !== undefined) {
    if (!isString(catalogReason)) return invalidInput('catalogReason must be text');
    out.catalogReason = catalogReason;
  }
  const closedAs = value['closedAs'];
  if (closedAs !== undefined) {
    const closed = DECISION_CLOSED_AS.find((c) => c === closedAs);
    if (closed === undefined) return invalidInput(`closedAs must be one of ${DECISION_CLOSED_AS.join(', ')}`);
    out.closedAs = closed;
  }
  const stale = value['stale'];
  if (stale !== undefined) {
    if (!isStale(stale)) return invalidInput('stale must have since, reason and dismissedAt');
    out.stale = stale;
  }
  const document = value['document'];
  if (document !== undefined) {
    if (!isDocument(document)) return invalidInput('document must have name, area, audience and description');
    out.document = document;
  }
  const coveredByText = value['coveredByText'];
  if (coveredByText !== undefined) {
    if (!isCoverageText(coveredByText)) return invalidInput('coveredByText must name a document or agent file');
    out.coveredByText = coveredByText;
  }
  const possiblyCoveredByText = value['possiblyCoveredByText'];
  if (possiblyCoveredByText !== undefined) {
    if (!isPossibleCoverageText(possiblyCoveredByText)) return invalidInput('possiblyCoveredByText must name a document or agent file with a quote and reason');
    out.possiblyCoveredByText = possiblyCoveredByText;
  }
  const contradictsText = value['contradictsText'];
  if (contradictsText !== undefined) {
    if (!Array.isArray(contradictsText) || !contradictsText.every(isContradictionText)) {
      return invalidInput('contradictsText must be a list of contradictions with documents or agent files');
    }
    out.contradictsText = contradictsText;
  }
  return ok(out);
};

const KB_KEYS = [
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
];
const DECISION_KEYS = ['scope', 'origin', 'channel', 'outcome', 'conflictsWith', 'archived', ...KB_KEYS];

/** Checks a decision's attributes in full (what services and the backfill write). */
const validateDecision = (value: unknown): Result<DecisionAttributes> => {
  if (!isRecord(value)) return invalidInput('A decision needs attributes');
  const keys = unknownKeys(value, DECISION_KEYS, 'attributes');
  if (!keys.ok) return keys;
  const scope = validateScope(value['scope']);
  if (!scope.ok) return scope;
  const origin = validateOrigin(value['origin']);
  if (!origin.ok) return origin;
  const channel = DECISION_CHANNELS.find((c) => c === value['channel']);
  if (channel === undefined) return invalidInput(`channel must be one of ${DECISION_CHANNELS.join(', ')}`);
  const outcome = validateOutcome(value['outcome']);
  if (!outcome.ok) return outcome;
  const conflicts: string[] = [];
  const rawConflicts = value['conflictsWith'];
  if (rawConflicts !== undefined) {
    if (!Array.isArray(rawConflicts)) return invalidInput('conflictsWith must be a list of glob IDs');
    for (const entry of rawConflicts) {
      const id = oneLine(entry, 'conflictsWith entry');
      if (!id.ok) return id;
      if (!conflicts.includes(id.value)) conflicts.push(id.value);
    }
  }
  if (value['archived'] !== undefined && value['archived'] !== true) return invalidInput('archived is true or absent');
  const kb = validateKbFields(value);
  if (!kb.ok) return kb;
  return ok({
    scope: scope.value,
    origin: origin.value,
    channel,
    outcome: outcome.value,
    ...(conflicts.length === 0 ? {} : { conflictsWith: conflicts }),
    ...(value['archived'] === true ? { archived: true as const } : {}),
    ...kb.value,
  });
};

/** Checks a glob's attributes against its category's schema; unknown keys are refused. Absent work attributes are `{}`. */
export const validateAttributes = (category: Category, value: unknown): Result<GlobAttributes> => {
  if (category === 'decision') return validateDecision(value);
  if (value === undefined || value === null) return ok({});
  if (!isRecord(value)) return invalidInput('attributes must be an object');
  const keys = unknownKeys(value, [], `A ${category}'s attributes`);
  return keys.ok ? ok({}) : keys;
};

/**
 * What a client may send in an `attributes` PATCH: only `scope` (everything else is set by transitions and
 * services), and only on a decision.
 */
export const validateScopeEdit = (category: Category, value: unknown): Result<DecisionScope> => {
  if (category !== 'decision') return invalidInput(`A ${category} has no editable attributes`);
  if (!isRecord(value)) return invalidInput('attributes must be an object');
  const keys = unknownKeys(value, ['scope'], 'attributes');
  if (!keys.ok) return keys;
  return validateScope(value['scope']);
};

export const sameScope = (a: DecisionScope, b: DecisionScope): boolean => a.kind === b.kind && a.ref === b.ref;
