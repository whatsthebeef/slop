import type { EffectCheck, ExtraEvidence, KbContradiction, KbCoverage, KbDraft, LearningWire, KbMergeNote, KbOutcome, KbPossibleCoverage, KbSignal, KbTarget, ProposedDocument } from '@slop/core';
import { KB_ITEM_STATUSES, KB_PROCESSING_STATES, KB_STALE_REASONS, LEARNING_TYPES } from '@slop/core';
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** The KB items table as it stood before the items became decision globs (migration 0049 drops it). */
export const kbProposals = pgTable(
  'kb_proposals',
  {
    id: text('id').primaryKey(),
    boardId: integer('board_id')
      .notNull()
      ,
    status: text('status', { enum: KB_ITEM_STATUSES }).notNull(),
    type: text('type', { enum: LEARNING_TYPES }).notNull(),
    statement: text('statement').notNull(),
    evidence: text('evidence').notNull(),
    suggestedTarget: text('suggested_target'),
    sourceGlobIds: jsonb('source_glob_ids').$type<string[]>().notNull(),
    source: text('source', { enum: ['submitted', 'mined'] }).notNull(),
    /** Mined items: the signal that raised it, with its figures. */
    signal: jsonb('signal').$type<KbSignal>(),
    agentSetVersion: integer('agent_set_version'),
    submittedBy: text('submitted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    /** A whole-document proposal (`/kb-bootstrap`). */
    document: jsonb('document').$type<ProposedDocument>(),
    /** What approving it did: kept as a learning, or applied to a document or agent file (with the version written). */
    outcome: jsonb('outcome').$type<KbOutcome>(),
    /** The background pipeline (routing and dedupe, then drafting): see `KbPipeline`. */
    processing: text('processing', { enum: KB_PROCESSING_STATES }).notNull().default('pending'),
    processingError: text('processing_error'),
    processingAttempts: integer('processing_attempts').notNull().default(0),
    /** Retry backoff, or a claimed item's lease. */
    processAfter: timestamp('process_after', { withTimezone: true }),
    target: jsonb('target').$type<KbTarget>(),
    catalogCandidate: boolean('catalog_candidate').notNull().default(false),
    catalogReason: text('catalog_reason'),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    extraEvidence: jsonb('extra_evidence').$type<ExtraEvidence[]>().notNull().default([]),
    duplicateOf: text('duplicate_of'),
    suppressedBy: text('suppressed_by'),
    coveredBy: jsonb('covered_by').$type<KbCoverage>(),
    possiblyCoveredBy: jsonb('possibly_covered_by').$type<KbPossibleCoverage>(),
    contradicts: jsonb('contradicts').$type<KbContradiction[]>().notNull().default([]),
    draft: jsonb('draft').$type<KbDraft>(),
    draftedAgainstVersion: integer('drafted_against_version'),
    rationale: text('rationale'),
    /** Weekly consolidation: a stale flag (never a closure), and when an admin last kept the item. */
    staleSince: timestamp('stale_since', { withTimezone: true }),
    staleReason: text('stale_reason', { enum: KB_STALE_REASONS }),
    staleDismissedAt: timestamp('stale_dismissed_at', { withTimezone: true }),
    /** Items an admin separated from this one by reopening a merge. */
    keptApartFrom: jsonb('kept_apart_from').$type<string[]>().notNull().default([]),
    /** Merged (by weekly consolidation or intake) or suppressed (intake): the verified quotes it closed on. */
    mergeNote: jsonb('merge_note').$type<KbMergeNote>(),
    /** Approved with a signal: whether the change worked, refreshed daily while watching. */
    effectCheck: jsonb('effect_check').$type<EffectCheck>(),
    version: integer('version').notNull(),
  },
  (t) => [
    index('kb_proposals_board_status_idx').on(t.boardId, t.status),
    index('kb_proposals_processing_idx').on(t.processing, t.createdAt),
  ],
);

/** A KB item as its row stood in the old table. */
export const kbProposalRow = (item: LearningWire): typeof kbProposals.$inferInsert => ({
  ...item,
  sourceGlobIds: [...item.sourceGlobIds],
  extraEvidence: [...item.extraEvidence],
  contradicts: [...item.contradicts],
  keptApartFrom: [...item.keptApartFrom],
  createdAt: new Date(item.createdAt),
  decidedAt: item.decidedAt === null ? null : new Date(item.decidedAt),
  processAfter: item.processAfter === null ? null : new Date(item.processAfter),
  staleSince: item.staleSince === null ? null : new Date(item.staleSince),
  staleDismissedAt: item.staleDismissedAt === null ? null : new Date(item.staleDismissedAt),
});
