import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';
import type { Category } from './types.js';

/**
 * Per-category fields of a glob, kept in the glob document (no column). Work globs reserve the field for later and accept
 * no keys; a decision glob carries its scope, where it came from and its outcome.
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

/** Where the decision's proposal came from: the engine behind it (a KB item), an inbox item, an extracted decision, or a person. */
export type DecisionOrigin =
  | { readonly kind: 'kb_item'; readonly id: string }
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
  /** The person, or `system` for the pipeline and the backfill. */
  readonly by: string;
  readonly at: string;
  readonly reason?: string;
  /** Needs work: the work glob that will make the change. */
  readonly linkedGlobId?: string;
  /** Needs work: the linked glob merged. */
  readonly workLanded?: true;
}

export interface DecisionAttributes {
  readonly scope: DecisionScope;
  readonly source: DecisionOrigin;
  readonly channel: DecisionChannel;
  readonly kbItemId: string | null;
  readonly outcome: DecisionOutcome | null;
  /** Broader-scope decision globs this one contradicts. */
  readonly conflictsWith?: readonly string[];
  /** Rejected or closed by the pipeline: hidden from the board and its counts. */
  readonly archived?: true;
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
  if (!isRecord(value)) return invalidInput('source must be an object');
  switch (value['kind']) {
    case 'manual':
      return ok({ kind: 'manual' });
    case 'kb_item': {
      const id = oneLine(value['id'], 'source.id');
      return id.ok ? ok({ kind: 'kb_item', id: id.value }) : id;
    }
    case 'inbox': {
      const id = value['id'];
      return typeof id === 'number' && Number.isInteger(id) && id > 0 ? ok({ kind: 'inbox', id }) : invalidInput('source.id must be an inbox item number');
    }
    case 'extracted': {
      const id = value['decisionId'];
      return typeof id === 'number' && Number.isInteger(id) && id > 0
        ? ok({ kind: 'extracted', decisionId: id })
        : invalidInput('source.decisionId must be a decision number');
    }
    default:
      return invalidInput('source.kind must be kb_item, inbox, extracted or manual');
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

const DECISION_KEYS = ['scope', 'source', 'channel', 'kbItemId', 'outcome', 'conflictsWith', 'archived'];

/** Checks a decision's attributes in full (what services and the backfill write). */
const validateDecision = (value: unknown): Result<DecisionAttributes> => {
  if (!isRecord(value)) return invalidInput('A decision needs attributes');
  const keys = unknownKeys(value, DECISION_KEYS, 'attributes');
  if (!keys.ok) return keys;
  const scope = validateScope(value['scope']);
  if (!scope.ok) return scope;
  const source = validateOrigin(value['source']);
  if (!source.ok) return source;
  const channel = DECISION_CHANNELS.find((c) => c === value['channel']);
  if (channel === undefined) return invalidInput(`channel must be one of ${DECISION_CHANNELS.join(', ')}`);
  let kbItemId: string | null = null;
  if (value['kbItemId'] !== null && value['kbItemId'] !== undefined) {
    const id = oneLine(value['kbItemId'], 'kbItemId');
    if (!id.ok) return id;
    kbItemId = id.value;
  }
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
  return ok({
    scope: scope.value,
    source: source.value,
    channel,
    kbItemId,
    outcome: outcome.value,
    ...(conflicts.length === 0 ? {} : { conflictsWith: conflicts }),
    ...(value['archived'] === true ? { archived: true as const } : {}),
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
