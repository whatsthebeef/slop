import type {
  NotificationAction,
  NotificationClears,
  BaseChecks,
  Board,
  BoardJobResult,
  DeployIntegration,
  DomainEvent,
  EffectCheck,
  Effect,
  Environment,
  ExtraEvidence,
  Glob,
  KbContradiction,
  KbMergeNote,
  KbPossibleCoverage,
  KbCoverage,
  KbDraft,
  KbOutcome,
  KbSignal,
  KbTarget,
  Provenance,
  ProposedDocument,
  SignalFigures,
} from '@slop/core';
import { AUTHORITY_TIERS, BOARD_JOBS, DEPLOY_STATES, DEPLOY_TRIGGERS, EFFECT_CHECK_GLOBS_DEFAULT, EMBEDDING_DIMENSIONS, FINDING_CLASSES, FINDING_SEVERITIES, FINDING_SOURCES, FINDING_STATES, ITEM_STATES, ITEM_STATUSES, KB_ITEM_STATUSES, KB_PROCESSING_STATES, KB_STALE_REASONS, KNOWLEDGE_LAYERS, LEARNING_TYPES, REVIEW_SOURCE_KINDS, REVIEW_SOURCE_STATES, SOURCE_TYPES, SUB_LIMIT_OUTCOMES } from '@slop/core';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
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
  runRespondMinutes: integer('run_respond_minutes').notNull().default(30),
  /** The learned sub size limit (`sub_limit_changes` holds its history); not an admin setting. */
  subMaxChangedLines: integer('sub_max_changed_lines').notNull().default(2000),
  /** Effect checks: globs compared on each side of an approved change. */
  effectCheckGlobs: integer('effect_check_globs').notNull().default(EFFECT_CHECK_GLOBS_DEFAULT),
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

/** Reviews queued for splitting into findings: a local review artifact, or one CodeRabbit inline comment. */
export const reviewSources = pgTable(
  'review_sources',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    globId: text('glob_id').notNull(),
    kind: text('kind', { enum: REVIEW_SOURCE_KINDS }).notNull(),
    artifactId: bigint('artifact_id', { mode: 'number' }),
    externalId: text('external_id'),
    commitSha: text('commit_sha'),
    agentSetVersion: integer('agent_set_version'),
    /** CodeRabbit comments only; local reviews are read from their artifact. */
    content: text('content'),
    path: text('path'),
    line: text('line'),
    state: text('state', { enum: REVIEW_SOURCE_STATES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Retry backoff, or a claimed source's lease. */
    processAfter: timestamp('process_after', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('review_sources_artifact_idx').on(t.artifactId),
    uniqueIndex('review_sources_external_idx').on(t.externalId),
    index('review_sources_queue_idx').on(t.state, t.processAfter),
    index('review_sources_glob_idx').on(t.globId),
  ],
);

/** Classified review findings per glob and commit (spec, self-improvement signals). */
export const reviewFindings = pgTable(
  'review_findings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    globId: text('glob_id').notNull(),
    sourceId: bigint('source_id', { mode: 'number' })
      .notNull()
      .references(() => reviewSources.id, { onDelete: 'cascade' }),
    source: text('source', { enum: FINDING_SOURCES }).notNull(),
    commitSha: text('commit_sha'),
    agentSetVersion: integer('agent_set_version'),
    severity: text('severity', { enum: FINDING_SEVERITIES }).notNull(),
    round: integer('round'),
    path: text('path'),
    line: text('line'),
    text: text('text').notNull(),
    fingerprint: text('fingerprint').notNull(),
    class: text('class', { enum: FINDING_CLASSES }),
    classNote: text('class_note'),
    state: text('state', { enum: FINDING_STATES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    processAfter: timestamp('process_after', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    classifiedAt: timestamp('classified_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('review_findings_fingerprint_idx').on(t.globId, t.source, t.fingerprint),
    index('review_findings_queue_idx').on(t.state, t.processAfter),
    index('review_findings_board_created_idx').on(t.boardId, t.createdAt),
    index('review_findings_glob_idx').on(t.globId),
  ],
);

/** Mined-signal state per board and signal key, so a signal isn't raised again every week (re-raise rules). */
export const kbSignals = pgTable(
  'kb_signals',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    itemId: text('item_id'),
    lastFigures: jsonb('last_figures').$type<SignalFigures>(),
    lastMeasuredAt: timestamp('last_measured_at', { withTimezone: true }),
    raisedAt: timestamp('raised_at', { withTimezone: true }),
    belowThresholdRuns: integer('below_threshold_runs').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.key] })],
);

/** Per-board self-improvement jobs (mining, later consolidation and effect checks): last run and a lease. */
export const boardJobs = pgTable(
  'board_jobs',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    job: text('job', { enum: BOARD_JOBS }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastResult: jsonb('last_result').$type<BoardJobResult>(),
    /** Set while a server runs the job; another server doesn't start it before then. */
    runningUntil: timestamp('running_until', { withTimezone: true }),
    /** What the job keeps between runs (consolidation's checked pairs), narrowed by core. */
    state: jsonb('state').$type<unknown>(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.job] })],
);

/**
 * The learned sub size limit's history: each sub outcome recorded, once per board, glob and outcome (so the hourly
 * job is idempotent), with the limit before and after it.
 */
export const subLimitChanges = pgTable(
  'sub_limit_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    fromLines: integer('from_lines').notNull(),
    toLines: integer('to_lines').notNull(),
    outcome: text('outcome', { enum: SUB_LIMIT_OUTCOMES }).notNull(),
    globId: text('glob_id').notNull(),
    /** Null when neither the gate verdict nor the merge commit gave a count (it is evidence only). */
    changedLines: integer('changed_lines'),
    evidence: text('evidence').notNull(),
  },
  (t) => [uniqueIndex('sub_limit_changes_outcome_idx').on(t.boardId, t.globId, t.outcome)],
);

/** Deploys pipelines report to release and integration environments (`slop.ci` events): the commit each one ran. */
export const environmentDeploys = pgTable(
  'environment_deploys',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    environment: text('environment').notNull(),
    sha: text('sha').notNull(),
    ref: text('ref'),
    succeeded: boolean('succeeded').notNull(),
    url: text('url'),
    eventId: text('event_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // A redelivered event is recorded once per board.
    uniqueIndex('environment_deploys_event_idx').on(t.boardId, t.eventId),
    index('environment_deploys_board_env_at_idx').on(t.boardId, t.environment, t.at),
  ],
);

/** Whether a release or integration environment held a glob's merge commit when last checked (containment). */
export const globEnvironments = pgTable(
  'glob_environments',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    globId: text('glob_id').notNull(),
    environment: text('environment').notNull(),
    mergeSha: text('merge_sha').notNull(),
    contained: boolean('contained').notNull(),
    checkedSha: text('checked_sha').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    since: timestamp('since', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.globId, t.environment] }),
    index('glob_environments_board_env_idx').on(t.boardId, t.environment, t.contained),
  ],
);

/** ATF runs reported by pipelines: on a glob's branch, or against the commit an environment ran. */
export const testRuns = pgTable(
  'test_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** Set for a branch run; null for a run against an environment. */
    globId: text('glob_id'),
    environment: text('environment'),
    sha: text('sha').notNull(),
    passed: integer('passed').notNull(),
    failed: integer('failed').notNull(),
    skipped: integer('skipped').notNull().default(0),
    url: text('url'),
    eventId: text('event_id').notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('test_runs_event_idx').on(t.boardId, t.eventId),
    index('test_runs_board_env_sha_idx').on(t.boardId, t.environment, t.sha),
    index('test_runs_glob_idx').on(t.globId),
  ],
);

/** CodeRabbit's summary, reviews and comments on a glob's PR, stored verbatim (R3); not the classification queue. */
export const codeReviewComments = pgTable(
  'code_review_comments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    globId: text('glob_id').notNull(),
    prNumber: integer('pr_number').notNull(),
    externalId: text('external_id').notNull(),
    kind: text('kind').notNull(),
    author: text('author').notNull(),
    commitSha: text('commit_sha'),
    path: text('path'),
    line: text('line'),
    body: text('body').notNull(),
    url: text('url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    /** Set when the code host deleted it: the row stays as a tombstone so a late redelivery can't bring it back. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('code_review_comments_external_idx').on(t.externalId),
    index('code_review_comments_glob_idx').on(t.globId),
    index('code_review_comments_board_glob_idx').on(t.boardId, t.globId),
  ],
);

/** Board notifications: board-wide incidents that need a person, one per board and source. No version. */
export const boardNotifications = pgTable(
  'board_notifications',
  {
    id: text('id').primaryKey(),
    /** Null: for every board. */
    boardId: integer('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    link: text('link'),
    action: jsonb('action').$type<NotificationAction>(),
    since: timestamp('since', { withTimezone: true }).notNull(),
    clears: jsonb('clears').$type<NotificationClears>().notNull(),
  },
  (t) => [index('board_notifications_board_idx').on(t.boardId)],
);

/** Postgres full-text vector; only ever generated by the database (`chunks.tsv`). */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * The search store (spec, Knowledge and context): one row per indexed source item, derived from slop's own material
 * and rebuildable from it. `external_ref` is the stable key the indexer syncs by.
 */
export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    sourceType: text('source_type', { enum: SOURCE_TYPES }).notNull(),
    externalRef: text('external_ref').notNull(),
    title: text('title').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    authority: text('authority', { enum: AUTHORITY_TIERS }).notNull(),
    status: text('status', { enum: ITEM_STATUSES }).notNull().default('active'),
    /** The item that replaced this one (superseded items). */
    supersededBy: bigint('superseded_by', { mode: 'number' }),
    /** Linked globs: filter metadata, never part of a chunk header. */
    globIds: text('glob_ids').array().notNull().default(sql`'{}'::text[]`),
    globGroup: text('glob_group'),
    externalUrl: text('external_url'),
    /** Reserved for large originals kept in S3 (`body_key`); unused so far, chunks hold the text. */
    body: text('body'),
    bodyKey: text('body_key'),
    contentHash: text('content_hash').notNull(),
    /** `pending_summary`: a merged change waiting for its "why" (retry state below, as the other pipelines keep it). */
    state: text('state', { enum: ITEM_STATES }).notNull().default('ready'),
    attempts: integer('attempts').notNull().default(0),
    processAfter: timestamp('process_after', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('knowledge_items_ref_idx').on(t.boardId, t.externalRef),
    index('knowledge_items_board_source_idx').on(t.boardId, t.sourceType, t.occurredAt),
    index('knowledge_items_globs_idx').using('gin', t.globIds),
    index('knowledge_items_pending_idx').on(t.state, t.processAfter),
  ],
);

export const chunks = pgTable(
  'chunks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    itemId: bigint('item_id', { mode: 'number' })
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    /** Denormalised from the item so searches filter by board without a join first. */
    boardId: integer('board_id').notNull(),
    position: integer('position').notNull(),
    header: text('header').notNull(),
    text: text('text').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', header || ' ' || text)`),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chunks_item_position_idx').on(t.itemId, t.position),
    index('chunks_board_idx').on(t.boardId),
    index('chunks_tsv_idx').using('gin', t.tsv),
    index('chunks_text_trgm_idx').using('gin', t.text.op('gin_trgm_ops')),
    index('chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('chunks_unembedded_idx').on(t.id).where(sql`${t.embedding} is null`),
  ],
);
