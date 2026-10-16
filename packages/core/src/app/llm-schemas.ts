import type { LlmSchema } from './intake-service.js';

/**
 * The JSON Schema of each pipeline step's answer (structured outputs: the model can only answer in this shape, so the
 * answer always parses). Plain objects: core has no schema library. The model API wants `additionalProperties: false`
 * and every property listed in `required`, so an optional value is a required one that may be null. What an answer
 * means (quotes found in the shown text, IDs that exist) is still checked by each step's own narrowing.
 */
type Schema = Readonly<Record<string, unknown>>;

const str: Schema = { type: 'string' };
const bool: Schema = { type: 'boolean' };
const int: Schema = { type: 'integer' };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const oneOf = (...values: readonly string[]): Schema => ({ type: 'string', enum: values });
const array = (items: Schema): Schema => ({ type: 'array', items });
const object = (properties: Readonly<Record<string, Schema>>): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const named = (name: string, schema: Schema): LlmSchema => ({ name, schema });

const RELATIONS = ['same fact', 'related topic only', 'unrelated', 'contradicts'] as const;

export const KB_ROUTE_SCHEMA = named(
  'kb_route',
  object({
    target: object({
      kind: oneOf('document', 'agent_file', 'local_run', 'merge_policy'),
      name: str,
      section: nullable(str),
      newDocument: nullable(object({ area: str, audience: array(str), description: str })),
    }),
    catalogCandidate: bool,
    catalogReason: nullable(str),
  }),
);

const quotedClaim = object({ id: str, quote: str, newQuote: str });

export const KB_DEDUPE_SCHEMA = named(
  'kb_dedupe',
  object({
    fact: str,
    checked: array(object({ ref: str, relation: oneOf(...RELATIONS) })),
    suppressedBy: nullable(quotedClaim),
    duplicateOf: nullable(quotedClaim),
    coveredBy: nullable({
      anyOf: [
        object({ kind: oneOf('item'), id: str, quote: str }),
        object({ kind: oneOf('target'), quote: str, reason: str }),
      ],
    }),
    contradicts: array(object({ kind: oneOf('item', 'target'), ref: str, quote: str, note: str })),
  }),
);

/** `content` is text: a section's markdown, a document's body, or (local-run spec, merge policy) the JSON object as text. */
export const KB_DRAFT_SCHEMA = named(
  'kb_draft',
  object({ section: nullable(str), content: str, rationale: str }),
);

export const KB_PAIRS_SCHEMA = named(
  'kb_pairs',
  object({ pairs: array(object({ a: str, b: str })) }),
);

export const KB_VERIFY_SCHEMA = named(
  'kb_verify',
  object({
    fact: str,
    relation: oneOf(...RELATIONS),
    quoteA: nullable(str),
    quoteB: nullable(str),
  }),
);

export const DECISION_EXTRACT_SCHEMA = named(
  'decision_extract',
  object({
    decisions: array(
      object({ statement: str, quote: str, decidedBy: nullable(str), decidedAt: nullable(str) }),
    ),
  }),
);

export const DECISION_SUPERSEDE_SCHEMA = named(
  'decision_supersede',
  object({
    replaces: array(
      object({ id: int, sameSubject: bool, oldQuote: str, newQuote: str, reason: str }),
    ),
  }),
);

export const FINDINGS_SPLIT_SCHEMA = named(
  'findings_split',
  object({
    findings: array(
      object({
        severity: oneOf('in_scope', 'suggestion', 'unknown'),
        path: nullable(str),
        line: nullable(str),
        quote: str,
        text: str,
        resolved: bool,
      }),
    ),
  }),
);

/** The class is any of the pipeline's finding classes, so the caller passes its list. */
export const findingClassSchema = (classes: readonly string[]): LlmSchema =>
  named('finding_class', object({ class: oneOf(...classes), note: str }));

export const INBOX_SUMMARY_SCHEMA = named(
  'inbox_summary',
  object({
    title: str,
    kind: oneOf('meeting', 'thread', 'doc'),
    summary: str,
    suggestions: array(object({ globId: str, reason: str })),
  }),
);

export const INTAKE_SCHEMA = named(
  'intake',
  object({
    title: str,
    plan: str,
    type: oneOf('sub', 'same', 'super'),
    typeReason: str,
    category: oneOf('task', 'bug'),
    group: nullable(str),
    categoryConfidence: oneOf('high', 'medium', 'low'),
    categoryReason: str,
    autoTrigger: bool,
    autoTriggerQuote: nullable(str),
    files: array(str),
    prerequisites: array(object({ id: str, gate: oneOf('start', 'merge', 'sign_off'), sentence: str })),
    questions: array(
      object({ kind: oneOf('type', 'environment', 'scope', 'acceptance'), text: str, options: array(str), blocking: oneOf('start', 'none') }),
    ),
  }),
);

/** The relation scan's answer: one verdict per glob ID in a numbered sentence (`sentence` is the index it was shown under). */
export const RELATION_SCAN_SCHEMA = named(
  'relation_scan',
  object({
    decisions: array(
      object({
        id: str,
        sentence: int,
        verdict: oneOf('prerequisite', 'history', 'context', 'unsure'),
        gate: oneOf('start', 'merge', 'sign_off'),
      }),
    ),
  }),
);

export const RELATION_CHECK_SCHEMA = named(
  'relation_check',
  object({
    verdicts: array(object({ id: str, verdict: oneOf('needed', 'not_needed', 'unsure'), reason: str })),
  }),
);

export const INTAKE_GROUP_SCHEMA = named('intake_group', object({ group: nullable(str) }));

export const SIZE_JUDGE_SCHEMA = named(
  'size_judge',
  object({ independentParts: int, parallelParts: int, reason: str }),
);

export const SIZE_PROPOSE_SCHEMA = named(
  'size_propose',
  object({
    workstreams: array(
      object({ name: str, goal: str, files: array(str), plan: str, needs: array(int) }),
    ),
  }),
);

export const SUB_LIMIT_SCHEMA = named(
  'sub_limit_cause',
  object({ caused: bool, quote: nullable(str) }),
);

export const DEPENDENCY_EDGES_SCHEMA = named(
  'dependency_edges',
  object({
    edges: array(
      object({
        id: str,
        kind: oneOf('needs', 'decision'),
        symbol: nullable(str),
        addedBy: nullable(str),
        confidence: { type: 'number' },
        reason: str,
        question: nullable(str),
        files: array(str),
      }),
    ),
  }),
);

export const KNOWLEDGE_PAGE_SCHEMA = named(
  'knowledge_page_section',
  object({
    groups: array(
      object({
        area: str,
        entries: array(object({ text: str, rationale: str, globIds: array(str), key: bool })),
      }),
    ),
  }),
);

export const SUGGESTION_SCHEMA = named(
  'suggestion',
  object({
    action: oneOf('approve', 'approve_with_edit', 'merge_into', 'reject'),
    reason: str,
    editedDraft: nullable(str),
    mergeInto: nullable(str),
    mergedText: nullable(str),
    checkSignal: nullable(str),
    checkReason: nullable(str),
  }),
);

export const ROLLOUT_SCHEMA = named(
  'rollout_decision',
  object({
    decision: oneOf('none', 'steps', 'ask'),
    reason: nullable(str),
    rollout: nullable(str),
    question: nullable(str),
  }),
);

export const REVIEW_VERDICTS_SCHEMA = named(
  'review_verdicts',
  object({ verdicts: array(object({ index: int, keep: bool, reason: str })) }),
);

export const REVIEW_FINDINGS_SCHEMA = named(
  'review_findings',
  object({
    summary: str,
    findings: array(
      object({
        file: str,
        line: int,
        severity: oneOf('high', 'medium', 'low'),
        category: oneOf('logic', 'bug', 'convention', 'security', 'privacy'),
        title: str,
        explanation: str,
        suggestedFix: str,
      }),
    ),
  }),
);
