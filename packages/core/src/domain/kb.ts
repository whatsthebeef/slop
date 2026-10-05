/**
 * KB items (`s<board>k<n>`): proposed changes to a board's knowledge base or agent set. Nothing
 * reaches either without an admin's approval; rejected items are kept to suppress repeats.
 */
export const LEARNING_TYPES = ['decision', 'gotcha', 'pattern', 'agent-behaviour'] as const;
export type LearningType = (typeof LEARNING_TYPES)[number];

export const KB_ITEM_STATUSES = ['open', 'approved', 'rejected'] as const;
export type KbItemStatus = (typeof KB_ITEM_STATUSES)[number];

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
  /** For conditional writes (approve, reject). */
  readonly version: number;
}

export const isLearningType = (value: string): value is LearningType =>
  LEARNING_TYPES.some((t) => t === value);
