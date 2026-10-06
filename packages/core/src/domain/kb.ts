import type { KnowledgeKind } from './knowledge.js';

/**
 * KB items (`s<board>k<n>`): proposed changes to a board's knowledge base or agent set. Nothing
 * reaches either without an admin's approval; rejected items are kept to suppress repeats.
 */
export const LEARNING_TYPES = ['decision', 'gotcha', 'pattern', 'agent-behaviour'] as const;
export type LearningType = (typeof LEARNING_TYPES)[number];

/**
 * `open` items wait for an admin; `approved` and `rejected` are decisions. The pipeline closes
 * three more without a decision: `merged` (a near-duplicate folded into another open item),
 * `suppressed` (matched a rejected item) and `covered` (already in approved knowledge).
 */
export const KB_ITEM_STATUSES = ['open', 'approved', 'rejected', 'merged', 'suppressed', 'covered'] as const;
export type KbItemStatus = (typeof KB_ITEM_STATUSES)[number];

/**
 * Where the background pipeline is with an item: waiting to be routed and deduplicated
 * (`pending`), routed, drafted (step 3), or given up on after repeated LLM failures (`failed`;
 * the item stays open and can still be decided by hand).
 */
export const KB_PROCESSING_STATES = ['pending', 'routed', 'drafted', 'failed'] as const;
export type KbProcessing = (typeof KB_PROCESSING_STATES)[number];

/** The frontmatter proposed for a new document a learning is routed to (its content comes with the draft). */
export interface NewDocumentMeta {
  readonly area: string;
  readonly audience: readonly string[];
  readonly description: string;
}

/**
 * Where an item belongs: a board document or agent-set file (for agent-set files, always the
 * board's overlay), and the heading it belongs under (null: the whole new document, or append).
 */
export interface KbTarget {
  readonly kind: KnowledgeKind;
  readonly name: string;
  readonly section: string | null;
  /** Set when the target is a document the board doesn't have yet. */
  readonly newDocument: NewDocumentMeta | null;
}

/** Evidence a near-duplicate added to this item. */
export interface ExtraEvidence {
  readonly itemId: string;
  readonly globIds: readonly string[];
  readonly evidence: string;
  readonly submittedBy: string;
  readonly at: string;
}

/** What made a `covered` item redundant: an approved item, or text already in a document or agent file. */
export type KbCoverage =
  | { readonly kind: 'item'; readonly id: string }
  | { readonly kind: 'knowledge'; readonly knowledgeKind: KnowledgeKind; readonly name: string; readonly section: string | null };

/** Something an open item contradicts: another item (by ID) or a document or agent file (by name). */
export interface KbContradiction {
  readonly kind: 'item' | 'knowledge';
  readonly ref: string;
  readonly note: string;
}

/** A drafted change (step 3): one section's new text, or a whole new document. */
export interface KbDraft {
  readonly section: string | null;
  readonly content: string;
}

/** `submitted` by an agent through `submit_learning`; `mined` from signals by slop's jobs (later). */
export const KB_ITEM_SOURCES = ['submitted', 'mined'] as const;
export type KbItemSource = (typeof KB_ITEM_SOURCES)[number];

export interface KbItem {
  readonly id: string;
  readonly boardId: number;
  readonly status: KbItemStatus;
  readonly type: LearningType;
  readonly statement: string;
  readonly evidence: string;
  /** Where the submitter thinks it belongs (a document, area or agent definition). */
  readonly suggestedTarget: string | null;
  /** The globs that produced it; near-duplicates add theirs later. */
  readonly sourceGlobIds: readonly string[];
  readonly source: KbItemSource;
  /** The board's agent-set version the submitting run used (`.claude/slop-agent-set.json`). */
  readonly agentSetVersion: number | null;
  readonly submittedBy: string;
  readonly createdAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  /** A whole-document proposal (`/kb-bootstrap`); null for a statement. */
  readonly document: ProposedDocument | null;
  /** Set when approved. */
  readonly outcome: KbOutcome | null;
  readonly processing: KbProcessing;
  /** The last routing failure; set when `failed`. */
  readonly processingError: string | null;
  /** Failed routing attempts so far. */
  readonly processingAttempts: number;
  /** A pending item isn't picked up before this (retry backoff, or a claimed item's lease). */
  readonly processAfter: string | null;
  readonly target: KbTarget | null;
  /** Would hold for any project: a suggested change to slop's `catalog/`, with why. */
  readonly catalogCandidate: boolean;
  readonly catalogReason: string | null;
  /** 1 plus the near-duplicates merged into it (and later submissions it already covered). */
  readonly occurrenceCount: number;
  readonly extraEvidence: readonly ExtraEvidence[];
  /** `merged`: the open item it was folded into. */
  readonly duplicateOf: string | null;
  /** `suppressed`: the rejected item it matched. */
  readonly suppressedBy: string | null;
  /** `covered`: what already says it. */
  readonly coveredBy: KbCoverage | null;
  /** Open items that conflict with active knowledge or approved items. */
  readonly contradicts: readonly KbContradiction[];
  /** Step 3: the drafted change, the target version it was drafted against, and why. */
  readonly draft: KbDraft | null;
  readonly draftedAgainstVersion: number | null;
  readonly rationale: string | null;
  /** For conditional writes (approve, reject). */
  readonly version: number;
}

/** The pipeline fields of a newly submitted item. */
export const UNPROCESSED: Pick<
  KbItem,
  | 'processing'
  | 'processingError'
  | 'processingAttempts'
  | 'processAfter'
  | 'target'
  | 'catalogCandidate'
  | 'catalogReason'
  | 'occurrenceCount'
  | 'extraEvidence'
  | 'duplicateOf'
  | 'suppressedBy'
  | 'coveredBy'
  | 'contradicts'
  | 'draft'
  | 'draftedAgainstVersion'
  | 'rationale'
> = {
  processing: 'pending',
  processingError: null,
  processingAttempts: 0,
  processAfter: null,
  target: null,
  catalogCandidate: false,
  catalogReason: null,
  occurrenceCount: 1,
  extraEvidence: [],
  duplicateOf: null,
  suppressedBy: null,
  coveredBy: null,
  contradicts: [],
  draft: null,
  draftedAgainstVersion: null,
  rationale: null,
};

export const isLearningType = (value: string): value is LearningType =>
  LEARNING_TYPES.some((t) => t === value);

/**
 * A whole document proposed through `submit_learning` (`/kb-bootstrap`). Approving it creates or
 * updates the board document `name`, with this frontmatter.
 */
export interface ProposedDocument {
  readonly name: string;
  readonly area: string;
  readonly audience: readonly string[];
  readonly description: string;
  /** The document body, without frontmatter. */
  readonly content: string;
}

/**
 * What an approval did: kept the statement as an approved learning (served by `get_conventions`),
 * or wrote a document or agent-set file, recording the version it created.
 */
export type KbOutcome =
  | { readonly kind: 'learning' }
  | {
      readonly kind: 'applied';
      readonly target: KnowledgeKind;
      readonly name: string;
      readonly version: number;
    };
