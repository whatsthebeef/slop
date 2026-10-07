import type {
  BaseChecks,
  Board,
  DeployIntegration,
  DomainEvent,
  Effect,
  Environment,
  ExtraEvidence,
  Glob,
  KbContradiction,
  KbPossibleCoverage,
  KbCoverage,
  KbDraft,
  KbOutcome,
  KbTarget,
  Provenance,
  ProposedDocument,
} from '@slop/core';
import { DEPLOY_STATES, DEPLOY_TRIGGERS, KB_ITEM_STATUSES, KB_PROCESSING_STATES, KNOWLEDGE_LAYERS, LEARNING_TYPES } from '@slop/core';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  email: text('email').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  cognitoSub: text('cognito_sub'),
  githubUsername: text('github_username'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const boards = pgTable('boards', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  repo: text('repo'),
  baseBranch: text('base_branch').notNull(),
  timeZone: text('time_zone').notNull(),
  defaultRoutineOwner: text('default_routine_owner'),
  environments: jsonb('environments').$type<Environment[]>().notNull(),
  sensitivePaths: jsonb('sensitive_paths').$type<string[]>().notNull(),
  agentSetVersion: integer('agent_set_version').notNull().default(0),
  /** The catalog agent set's hash the board's agent-set version last followed. */
  agentCatalogHash: text('agent_catalog_hash'),
  runNoProgressHours: integer('run_no_progress_hours').notNull().default(2),
  runReadyHours: integer('run_ready_hours').notNull().default(8),
  runStartMinutes: integer('run_start_minutes').notNull().default(30),
  subMaxChangedLines: integer('sub_max_changed_lines').notNull().default(2000),
  /** How branch deploys run (CodeBuild or GitHub Actions); null when the board has none. */
  deploy: jsonb('deploy').$type<DeployIntegration>(),
  /** The latest check result on the base branch head; written by check events, not by settings changes. */
  baseChecks: jsonb('base_checks').$type<BaseChecks>(),
  /** Readiness items slop can't check, ticked by an admin. */
  readinessTicks: jsonb('readiness_ticks').$type<Board['readinessTicks']>().notNull().default({}),
  version: integer('version').notNull(),
});

export const members = pgTable(
  'members',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    email: text('email')
      .notNull()
      .references(() => users.email),
    role: text('role', { enum: ['admin', 'dev', 'qa', 'po'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.email] }), index('members_email_idx').on(t.email)],
);

/** The glob document plus the columns used for filtering and conditional writes. */
export const globs = pgTable(
  'globs',
  {
    id: text('id').primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    type: text('type').notNull(),
    groupName: text('group_name'),
    planner: text('planner').notNull(),
    implementer: text('implementer'),
    creationKey: text('creation_key'),
    data: jsonb('data').$type<Glob>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('globs_board_status_idx').on(t.boardId, t.status),
    uniqueIndex('globs_creation_key_idx').on(t.boardId, t.creationKey),
  ],
);

export const idCounters = pgTable(
  'id_counters',
  {
    boardId: integer('board_id').notNull(),
    letter: text('letter').notNull(),
    n: integer('n').notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.letter] })],
);

/** The append-only event log; reports and aging are derived from it. */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    globId: text('glob_id').notNull(),
    type: text('type').notNull(),
    actor: text('actor'),
    at: timestamp('at', { withTimezone: true }).notNull(),
    data: jsonb('data').$type<DomainEvent['data']>().notNull(),
  },
  (t) => [index('events_glob_idx').on(t.globId, t.id)],
);

/** Side effects written with the state change and executed by the job runner. */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    globId: text('glob_id').notNull(),
    effect: jsonb('effect').$type<Effect>().notNull(),
    state: text('state', { enum: ['pending', 'done', 'dropped', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('outbox_pending_idx').on(t.state, t.runAfter)],
);

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  email: text('email')
    .notNull()
    .references(() => users.email),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Recent errors for the System page. */
export const errors = pgTable('errors', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  task: text('task').notNull(),
  message: text('message').notNull(),
});

/** Inbound webhook deliveries already handled, for deduplication (GitHub delivery IDs, source event IDs). */
export const deliveries = pgTable('deliveries', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  event: text('event').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Current version of each knowledge document and agent-set file, per board. */
export const knowledge = pgTable(
  'knowledge',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    area: text('area'),
    audience: jsonb('audience').$type<string[]>().notNull(),
    description: text('description').notNull(),
    content: text('content').notNull(),
    /** Agent-set rows: `overlay` (the board's additions to a catalog file) or `file` (a whole board file). */
    layer: text('layer', { enum: KNOWLEDGE_LAYERS }).notNull().default('file'),
    version: integer('version').notNull(),
    source: text('source').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.kind, t.name] })],
);

/** Every earlier version of knowledge documents. */
export const knowledgeHistory = pgTable(
  'knowledge_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    area: text('area'),
    audience: jsonb('audience').$type<string[]>().notNull(),
    description: text('description').notNull(),
    content: text('content').notNull(),
    layer: text('layer', { enum: KNOWLEDGE_LAYERS }).notNull().default('file'),
    source: text('source').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('knowledge_history_doc_idx').on(t.boardId, t.kind, t.name, t.version)],
);

/** Glob artifacts as versioned text records (binaries will go to S3). */
export const artifacts = pgTable(
  'artifacts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    globId: text('glob_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    link: text('link'),
    commitSha: text('commit_sha'),
    provenance: jsonb('provenance').$type<Provenance>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('artifacts_version_idx').on(t.globId, t.kind, t.label, t.version)],
);

/** KB items (`s<board>k<n>`): learnings submitted by agents (later also mined), awaiting an admin's decision. */
export const kbProposals = pgTable(
  'kb_proposals',
  {
    id: text('id').primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    status: text('status', { enum: KB_ITEM_STATUSES }).notNull(),
    type: text('type', { enum: LEARNING_TYPES }).notNull(),
    statement: text('statement').notNull(),
    evidence: text('evidence').notNull(),
    suggestedTarget: text('suggested_target'),
    sourceGlobIds: jsonb('source_glob_ids').$type<string[]>().notNull(),
    source: text('source', { enum: ['submitted', 'mined'] }).notNull(),
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
    version: integer('version').notNull(),
  },
  (t) => [
    index('kb_proposals_board_status_idx').on(t.boardId, t.status),
    index('kb_proposals_processing_idx').on(t.processing, t.createdAt),
  ],
);

/** Branch deploys: one row per request, queued per environment (one running, one waiting). */
export const deploys = pgTable(
  'deploys',
  {
    id: text('id').primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    environment: text('environment').notNull(),
    globId: text('glob_id').notNull(),
    sha: text('sha').notNull(),
    state: text('state', { enum: DEPLOY_STATES }).notNull(),
    trigger: text('trigger', { enum: DEPLOY_TRIGGERS }).notNull(),
    requestedBy: text('requested_by'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    runningSince: timestamp('running_since', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    providerRef: text('provider_ref'),
    url: text('url'),
    error: text('error'),
  },
  (t) => [
    index('deploys_board_env_state_idx').on(t.boardId, t.environment, t.state),
    index('deploys_glob_requested_idx').on(t.globId, t.requestedAt),
    uniqueIndex('deploys_provider_ref_idx').on(t.providerRef),
    // The queue's invariant, as a backstop to the per-environment lock: one running, one waiting.
    uniqueIndex('deploys_one_running_idx').on(t.boardId, t.environment).where(sql`${t.state} = 'running'`),
    uniqueIndex('deploys_one_waiting_idx').on(t.boardId, t.environment).where(sql`${t.state} = 'waiting'`),
  ],
);
