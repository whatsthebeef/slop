import type { ContextDiffLine } from './agent-set.js';
import type { EffectCheck } from './effect-check.js';
import type { KnowledgeKind } from './knowledge.js';
import type { KbSignal } from './signals.js';

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
 * (`pending`), routed and waiting for its draft (`routed`), drafted, or given up on after repeated
 * LLM failures (`failed`: routing failed when it has no target, drafting failed when it has one;
 * the item stays open and can still be decided by hand). A drafted item whose target changes goes
 * back to `routed` to be drafted again.
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

/**
 * An open item the dedupe step thinks may already be said: a hint for the admin, never a decision. `quote` is the
 * sentence it found (checked against the text it was shown). Either the target's own text (stored before `kind`
 * existed, so it has none), or another item on a quote too short to close the item on (`longEnoughQuote`): an
 * approved item that may cover it (no `claim`, stored before `claim` existed), an open item it may repeat
 * (`claim: 'duplicate'`) or a rejected item it may match (`claim: 'suppressed'`). For those two, `quote` is from
 * that item's statement and `ownQuote` from the item's own; both were found verbatim, and one was too short.
 */
export type KbPossibleCoverage =
  | {
      readonly kind?: 'knowledge';
      readonly knowledgeKind: KnowledgeKind;
      readonly name: string;
      readonly section: string | null;
      readonly quote: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'item';
      readonly id: string;
      readonly quote: string;
      readonly shortQuote: true;
      readonly claim?: 'duplicate' | 'suppressed';
      readonly ownQuote?: string;
      /** For a `claim`: which quote was too short, the other item's (`quote`), the item's own (`ownQuote`) or both. */
      readonly tooShort?: 'quote' | 'ownQuote' | 'both';
      /** The target's text may say it too (a hint this one hides): the sentence found there and the model's reason. */
      readonly alsoTarget?: { readonly quote: string; readonly reason: string };
      /**
       * Carried from an item merged into this one on intake (its ID): `ownQuote` is from that item's statement. Only a
       * `claim: 'suppressed'` hint is carried, and never with `alsoTarget`.
       */
      readonly via?: string;
    };

/** Something an open item contradicts: another item (by ID) or a document or agent file (by name). */
export interface KbContradiction {
  readonly kind: 'item' | 'knowledge';
  readonly ref: string;
  readonly note: string;
}

/**
 * A drafted change: the new text of one section of the target (`section` is the heading it
 * replaces, or null to append `content` as a new section), or a new document's whole body. For an
 * agent-set file the target text is the board's layer (its overlay, or the whole file it owns).
 */
export interface KbDraft {
  readonly section: string | null;
  readonly content: string;
}

/**
 * What approving an item's draft would change, computed against the target's current text: the
 * line diff with context, and whether the target moved since the draft was made (`stale`; the
 * draft is then redone before it can be approved).
 */
export interface DraftPreview {
  /** The target's current version (0: the document or overlay doesn't exist yet). */
  readonly version: number;
  readonly stale: boolean;
  readonly diff: readonly ContextDiffLine[];
}

/**
 * A KB item as the Knowledge page lists it: open drafted items carry their preview, and every item its evidence
 * count and freshest evidence (the open queue's order, worked out in core).
 */
export interface KbItemView extends KbItem {
  readonly preview: DraftPreview | null;
  readonly evidenceCount: number;
  readonly lastEvidenceAt: string;
}

/** The newest items of a history group (decided, or closed by the pipeline) and how many there are in all. */
export interface KbItemPage {
  readonly items: readonly KbItemView[];
  readonly total: number;
}

/**
 * The Knowledge page's proposals: every open item, by evidence (`byEvidence`), and the newest decided and
 * closed items (bounded, since they only grow).
 */
export interface KbProposalList {
  readonly open: readonly KbItemView[];
  readonly decided: KbItemPage;
  readonly closed: KbItemPage;
}

/** How many decided and closed items the Knowledge page lists by default, and at most. */
export const KB_HISTORY_PAGE = 50;
export const KB_HISTORY_MAX = 1000;

/** `submitted` by an agent through `submit_learning`; `mined` from signals by slop's weekly mining job. */
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
  /** Mined items: the signal that raised it and the figures behind it (refreshed weekly while open). */
  readonly signal: KbSignal | null;
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
  /**
   * The last routing or drafting failure; set when `failed`, and while retrying. While the LLM is
   * unavailable it is `LLM_WAITING_PREFIX` plus the reason instead: the item waits, no attempt counted.
   */
  readonly processingError: string | null;
  /** Failed attempts at the current stage (routing, then drafting). */
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
  /** `open`: the target's text that may already say it (flagged for the admin, who decides). */
  readonly possiblyCoveredBy: KbPossibleCoverage | null;
  /** Open items that conflict with active knowledge or approved items. */
  readonly contradicts: readonly KbContradiction[];
  /** The drafted change, the target version it was drafted against (0: none yet), and why, in one line. */
  readonly draft: KbDraft | null;
  readonly draftedAgainstVersion: number | null;
  readonly rationale: string | null;
  /**
   * `open`: when weekly consolidation flagged it stale, and why (`staleReason`). Only a flag for the admin, who
   * rejects or keeps it; new evidence clears it.
   */
  readonly staleSince: string | null;
  readonly staleReason: KbStaleReason | null;
  /** When an admin last kept a stale item: it isn't flagged again for `STALE_KEEP_MS`. */
  readonly staleDismissedAt: string | null;
  /** Items an admin separated from this one by reopening a merge: consolidation never merges them again. */
  readonly keptApartFrom: readonly string[];
  /**
   * `merged` (by weekly consolidation or intake dedupe) or `suppressed` (by intake dedupe): the verified quotes it
   * closed on.
   */
  readonly mergeNote: KbMergeNote | null;
  /** `approved` with a signal: whether the change worked (`EffectCheck`), refreshed daily while watching. */
  readonly effectCheck: EffectCheck | null;
  /** For conditional writes (approve, reject). */
  readonly version: number;
}

/** Why consolidation flagged an open item stale (a documented rule, never a model's say-so). */
export const KB_STALE_REASONS = ['no_recent_evidence', 'signal_below_threshold'] as const;
export type KbStaleReason = (typeof KB_STALE_REASONS)[number];

/**
 * What closed an item, and on which words: its own (`quote`, from its statement) and the other item's
 * (`survivorQuote`), each found verbatim in that statement, and when. `by: 'consolidation'`: weekly consolidation
 * merged it into the survivor. `by: 'intake'`: intake dedupe merged it into an open item (`duplicateOf`) or
 * suppressed it against a rejected one (`suppressedBy`, whose words `survivorQuote` then holds).
 */
export interface KbMergeNote {
  readonly by: 'consolidation' | 'intake';
  readonly quote: string;
  readonly survivorQuote: string;
  readonly at: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** An open item with no evidence newer than this is flagged stale (in days for the Knowledge page's wording). */
export const STALE_AFTER_DAYS = 60;
export const STALE_AFTER_MS = STALE_AFTER_DAYS * DAY_MS;
/** A mined item whose signal has been below its threshold this many weekly runs in a row is flagged stale. */
export const STALE_BELOW_THRESHOLD_RUNS = 4;
/** Keeping a stale item ("Not stale") suppresses the flag this long. */
export const STALE_KEEP_DAYS = 60;
export const STALE_KEEP_MS = STALE_KEEP_DAYS * DAY_MS;

/** How much evidence an item has: its occurrences (it and its near-duplicates), or its source globs if more. */
export const evidenceCount = (item: Pick<KbItem, 'occurrenceCount' | 'sourceGlobIds'>): number =>
  Math.max(item.occurrenceCount, item.sourceGlobIds.length);

/** The newest evidence an item has: its submission, a near-duplicate merged into it, or its signal's last measurement. */
export const lastEvidenceAt = (item: Pick<KbItem, 'createdAt' | 'extraEvidence' | 'signal'>): string => {
  const times = [item.createdAt, ...item.extraEvidence.map((e) => e.at), ...(item.signal === null ? [] : [item.signal.measuredAt])];
  return times.reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest));
};

/**
 * The open queue's order: the most evidence first (repeats are the strongest sign a rule is missing), then the
 * freshest evidence, so an item that keeps coming back rises instead of sinking under new ones; then the oldest.
 */
export const byEvidence = (a: KbItem, b: KbItem): number =>
  evidenceCount(b) - evidenceCount(a) ||
  Date.parse(lastEvidenceAt(b)) - Date.parse(lastEvidenceAt(a)) ||
  Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
  a.id.localeCompare(b.id);

/**
 * Whether an open item is stale at `now`, and why: no evidence newer than `STALE_AFTER_MS`, or (a mined item)
 * its signal below its threshold for `STALE_BELOW_THRESHOLD_RUNS` runs in a row (`belowThresholdRuns`, null
 * when it has no signal row). Null while an admin's Keep holds, and for anything not open.
 */
export const staleReasonAt = (
  item: Pick<KbItem, 'status' | 'createdAt' | 'extraEvidence' | 'signal' | 'staleDismissedAt'>,
  now: string,
  belowThresholdRuns: number | null,
): KbStaleReason | null => {
  if (item.status !== 'open') return null;
  const at = Date.parse(now);
  if (item.staleDismissedAt !== null && at - Date.parse(item.staleDismissedAt) < STALE_KEEP_MS) return null;
  if (at - Date.parse(lastEvidenceAt(item)) >= STALE_AFTER_MS) return 'no_recent_evidence';
  if (item.signal !== null && belowThresholdRuns !== null && belowThresholdRuns >= STALE_BELOW_THRESHOLD_RUNS) {
    return 'signal_below_threshold';
  }
  return null;
};

/**
 * Starts `processingError` while an item waits for the LLM to be usable again (expired sign-in,
 * no model access): not a failed attempt, so the card says "Waiting" rather than "failed".
 */
export const LLM_WAITING_PREFIX = 'AI unavailable: ';

/** Starts `processingError` while an item waits out a busy Bedrock (throttling, "unable to process"): no attempt is spent. */
export const BUSY_WAITING_PREFIX = 'Waiting: Bedrock busy';

/**
 * What Bedrock's transient errors say, as recorded when an item failed on them before they were
 * told apart from real failures (the SDK's messages for throttling, service-unavailable and
 * model-not-ready), plus the busy wait message itself.
 */
const BUSY_ERROR = /unable to process your request|too many requests|throttl|rate exceeded|service unavailable|model is not ready|waiting: bedrock busy/i;

/** Whether a `failed` item failed only because Bedrock was busy. */
export const failedBecauseBusy = (item: Pick<KbItem, 'processing' | 'processingError'>): boolean =>
  item.processing === 'failed' && item.processingError !== null && BUSY_ERROR.test(item.processingError);

/** Why an open item is waiting for the LLM, or null when it isn't. */
export const llmWaitingReason = (item: Pick<KbItem, 'processing' | 'processingError'>): string | null =>
  (item.processing === 'pending' || item.processing === 'routed') && item.processingError?.startsWith(LLM_WAITING_PREFIX) === true
    ? item.processingError.slice(LLM_WAITING_PREFIX.length)
    : null;

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
  | 'possiblyCoveredBy'
  | 'contradicts'
  | 'draft'
  | 'draftedAgainstVersion'
  | 'rationale'
  | 'staleSince'
  | 'staleReason'
  | 'staleDismissedAt'
  | 'keptApartFrom'
  | 'mergeNote'
  | 'effectCheck'
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
  possiblyCoveredBy: null,
  contradicts: [],
  draft: null,
  draftedAgainstVersion: null,
  rationale: null,
  staleSince: null,
  staleReason: null,
  staleDismissedAt: null,
  keptApartFrom: [],
  mergeNote: null,
  effectCheck: null,
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

/** Who acted on a decision: an agent signed in as the admin, recorded inside the outcome (no column of its own). */
export type KbVia = 'agent';

/**
 * What an approval did: kept the statement as an approved learning (served by `get_conventions`),
 * or wrote a document or agent-set file, recording the version it created.
 */
export type KbOutcome =
  | { readonly kind: 'learning'; readonly via?: KbVia }
  | {
      /** A rejection made by an agent (a person's rejection leaves the outcome empty). */
      readonly kind: 'rejected';
      readonly via: KbVia;
    }
  | {
      readonly kind: 'applied';
      /** Set when an agent made the decision on the admin's behalf (MCP `decide_kb_item`). */
      readonly via?: KbVia;
      readonly target: KnowledgeKind;
      readonly name: string;
      readonly version: number;
      /**
       * An agent-set file: the first agent-set version with the change (the effect check's basis), the board's version
       * after the approval. Absent when the approval changed nothing (its check goes by time), on documents and on
       * approvals recorded before effect checks.
       */
      readonly agentSetVersion?: number;
    };

/**
 * The item with its draft cleared, back in the queue to be drafted again (its target changed, or
 * an admin chose another target). Routing isn't repeated: the target stands.
 */
export const needsDraft = (item: KbItem, target: KbTarget | null = item.target): KbItem => ({
  ...item,
  target,
  processing: 'routed',
  processingError: null,
  processingAttempts: 0,
  processAfter: null,
  draft: null,
  draftedAgainstVersion: null,
  rationale: null,
  version: item.version + 1,
});
