import type {
  AttachmentFile,
  HumanStepBlock,
  RelationGate,
  RelationSource,
  RelationUntil,
  HumanStepScript,
  GlobOutcome,
  SizeEstimate,
  SizeCalibration,
  CalibrationValue,
  SizeForecast,
  SizeRecord,
  Investigation,
  StoredSizeProposal,
  SizeThreshold,
  PlanFeatures,
  ChatAction,
  ChatCitation,
  PageContext,
  NotificationAction,
  NotificationClears,
  ReviewBoardSettings,
  BaseChecks,
  Board,
  BoardJobResult,
  DeployIntegration,
  DomainEvent,
  Effect,
  Environment,
  Glob,
  KnowledgePageBasis,
  KnowledgePageSections,
  KnowledgePageVersion,
  Provenance,
  InboxSuggestion,
  SignalFigures,
  TypeSignals,
} from '@slop/core';
import { AGENT_KB_APPROVALS, CONTEXT_SETTING_KEYS, SIZE_DECISIONS, SIZE_OUTCOMES, CATEGORIES, CONFIDENCES, SLOP_TYPES, SNAPSHOT_SOURCES, AUTHORITY_TIERS, DEPENDENCY_CAUSES, BOARD_JOBS, DECISION_SOURCE_KINDS, DECISION_SOURCE_STATES, DEPLOY_STATES, DEPLOY_TRIGGERS, HUMAN_STEP_KINDS, STORED_STEP_STATES, RELATION_GATES, RELATION_SOURCES, RELATION_UNTILS, EFFECT_CHECK_GLOBS_DEFAULT, KNOWLEDGE_PAGE_INTERVAL_DEFAULT, KNOWLEDGE_PAGE_REASONS, KNOWLEDGE_PAGE_VERDICTS, EMBEDDING_DIMENSIONS, FINDING_CLASSES, FINDING_SEVERITIES, FINDING_SOURCES, FINDING_STATES, INBOX_SOURCE_TYPES, INBOX_STATES, INBOX_STATUSES, ITEM_STATES, ITEM_STATUSES, KNOWLEDGE_LAYERS, REPLACE_STATES, REVIEW_SOURCE_KINDS, REVIEW_SOURCE_STATES, SOURCE_TYPES, SUB_LIMIT_OUTCOMES, SUB_LIMIT_STEP, RISK_AREA_SOURCES, RISK_AREA_CHANGE_KINDS, RISK_AREA_CAUSES, ESCALATION_CRITERIA, ESCALATION_OUTCOMES, REVIEW_CATEGORIES, REVIEW_FEEDBACK_SOURCES, REVIEW_SEVERITIES, REVIEW_VERDICTS } from '@slop/core';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  foreignKey,
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
  subMaxChangedLines: integer('sub_max_changed_lines').notNull().default(5000),
  /** The step the learned limit moves by now (see `sub-limit.ts`); starts at 500. */
  subLimitStep: integer('sub_limit_step').notNull().default(SUB_LIMIT_STEP),
  /** Effect checks: globs compared on each side of an approved change. */
  effectCheckGlobs: integer('effect_check_globs').notNull().default(EFFECT_CHECK_GLOBS_DEFAULT),
  /** Which KB items an admin's agent may approve: 'docs' or 'docs_and_agent_files'. */
  agentKbApproval: text('agent_kb_approval', { enum: AGENT_KB_APPROVALS }).notNull().default('docs'),
  /** Slop starts an investigate-only run by itself on a Planning glob intake flagged as big. */
  autoInvestigate: boolean('auto_investigate').notNull().default(true),
  /** The knowledge page regenerates at most this often (minutes). */
  knowledgePageIntervalMinutes: integer('knowledge_page_interval_minutes').notNull().default(KNOWLEDGE_PAGE_INTERVAL_DEFAULT),
  /** The independent reviewer's settings; a missing key reads as its default (`reviewSettingsOf`). */
  reviewSettings: jsonb('review_settings').$type<Partial<ReviewBoardSettings>>().notNull().default({}),
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

/**
 * Per person and board: where the board sits in their board bar (null: not in it) and when they last opened it.
 * Personal: never listed to other members. Goes with the membership.
 */
export const boardSessions = pgTable(
  'board_sessions',
  {
    email: text('email').notNull(),
    boardId: integer('board_id').notNull(),
    position: integer('position'),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.email, t.boardId] }),
    foreignKey({ columns: [t.boardId, t.email], foreignColumns: [members.boardId, members.email] }).onDelete('cascade'),
    uniqueIndex('board_sessions_position_idx').on(t.email, t.position).where(sql`${t.position} is not null`),
  ],
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
    /** Which runner executes it (`laneOf(kind)` at insert). */
    lane: text('lane').notNull().default('default'),
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
  (t) => [
    index('outbox_lane_pending_idx').on(t.lane, t.state, t.runAfter),
    // A glob's newest job of a kind (the KB items' pipeline fields, and the one-unclaimed-job check on queueing).
    index('outbox_glob_kind_idx').on(t.globId, t.kind, t.id),
  ],
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
    /** File attachments: the stored file's facts (`AttachmentFile`); null on every other artifact. */
    file: jsonb('file').$type<AttachmentFile>(),
  },
  (t) => [
    uniqueIndex('artifacts_version_idx').on(t.globId, t.kind, t.label, t.version),
    index('artifacts_file_key_idx').using('btree', sql`(${t.file}->>'key')`).where(sql`${t.file} is not null`),
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

/** Work steps: what a person must do on a glob that the state machine doesn't imply (a rollout, a step someone added). */
export const humanSteps = pgTable(
  'human_steps',
  {
    id: text('id').primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    globId: text('glob_id').notNull(),
    kind: text('kind', { enum: HUMAN_STEP_KINDS }).notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    who: text('who').notNull(),
    due: text('due').notNull(),
    state: text('state', { enum: STORED_STEP_STATES }).notNull(),
    blocks: jsonb('blocks').$type<readonly HumanStepBlock[]>().notNull(),
    check: text('check'),
    script: jsonb('script').$type<HumanStepScript>(),
    origin: text('origin').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    doneBy: text('done_by'),
    doneAt: timestamp('done_at', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),
  },
  (t) => [index('human_steps_glob_idx').on(t.globId), index('human_steps_board_idx').on(t.boardId, t.state)],
);

/**
 * One glob held back by another (`from` can't pass `gate` until `to` reaches `until`). `to_glob` has no foreign key: a deleted
 * glob leaves the row, so the view can say it was deleted; `from_glob` rows go with their glob.
 */
export const relations = pgTable(
  'relations',
  {
    id: text('id').primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    fromGlob: text('from_glob').notNull(),
    toGlob: text('to_glob').notNull(),
    gate: text('gate', { enum: RELATION_GATES }).$type<RelationGate>().notNull(),
    until: text('until', { enum: RELATION_UNTILS }).$type<RelationUntil>().notNull(),
    reason: text('reason'),
    evidence: jsonb('evidence').$type<readonly string[]>().notNull().default(sql`'[]'::jsonb`),
    source: text('source', { enum: RELATION_SOURCES }).$type<RelationSource>().notNull(),
    /** The group a group-wide relation was set for (its name as then spelled). */
    group: text('group'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedPlanHash: text('dismissed_plan_hash'),
    overriddenAt: timestamp('overridden_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('relations_from_to_gate_idx').on(t.fromGlob, t.toGlob, t.gate),
    index('relations_board_idx').on(t.boardId),
    index('relations_from_idx').on(t.fromGlob),
    index('relations_to_idx').on(t.toGlob),
  ],
);

/** The status messages a person has acknowledged on a glob (the card's line, the Now panel); the key names the situation, so a new one shows again. */
export const statusDismissals = pgTable(
  'status_dismissals',
  {
    userEmail: text('user_email').notNull(),
    globId: text('glob_id').notNull(),
    key: text('key').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userEmail, t.globId, t.key] })],
);

/** Reviews queued for splitting into findings: a local review artifact. */
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
    /** The source's own text; local reviews are read from their artifact. */
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
    resolved: boolean('resolved').notNull().default(false),
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

/**
 * How often each choice was returned to an agent or chat, per day and glob (`''` when the retrieval had none). One
 * counter row per combination, pruned after `CHOICE_USAGE_RETENTION_DAYS`; the weekly mining run reads it.
 */
export const choiceUsage = pgTable(
  'choice_usage',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    decisionId: bigint('decision_id', { mode: 'number' })
      .notNull()
      .references(() => decisions.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    globId: text('glob_id').notNull().default(''),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.decisionId, t.day, t.globId] }), index('choice_usage_board_day_idx').on(t.boardId, t.day)],
);

/**
 * How often knowledge items of each source type and ranking tier were returned to an agent or chat, per day. One
 * counter row per combination, pruned after `CHOICE_USAGE_RETENTION_DAYS`; the context report reads it.
 */
export const contextRetrievals = pgTable(
  'context_retrievals',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    sourceType: text('source_type', { enum: SOURCE_TYPES }).notNull(),
    tier: text('tier', { enum: AUTHORITY_TIERS }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.day, t.sourceType, t.tier] })],
);

/** A board's stored context settings (one row per key that differs from the default; the core clamps to the bounds on read). */
export const contextSettings = pgTable(
  'context_settings',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: doublePrecision('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.key] })],
);

/** Every move of a context setting (and every reset), with the value before and after and the evidence for it. */
export const contextSettingChanges = pgTable(
  'context_setting_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    key: text('key', { enum: CONTEXT_SETTING_KEYS }).notNull(),
    before: doublePrecision('before').notNull(),
    after: doublePrecision('after').notNull(),
    outcome: text('outcome').notNull(),
    evidence: text('evidence').notNull(),
  },
  (t) => [index('context_setting_changes_board_at_idx').on(t.boardId, t.at)],
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
    /** The step the move used before weighting; rows from before steps were learned were fixed at 250. */
    step: integer('step').notNull().default(250),
  },
  (t) => [uniqueIndex('sub_limit_changes_outcome_idx').on(t.boardId, t.globId, t.outcome)],
);

/** What the LLM cost: one row per priced piece of work (a review), summed per board and month for the board's spend line. */
export const llmSpend = pgTable(
  'llm_spend',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    globId: text('glob_id'),
    /** What the spend was for, such as `review`. */
    source: text('source').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    /** Null when the model has no price: the tokens are kept, the cost is not known. */
    costUsd: doublePrecision('cost_usd'),
    /** Where to look it up, such as the review artifact's version. */
    ref: text('ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('llm_spend_board_created_idx').on(t.boardId, t.createdAt)],
);

/** The board's generated knowledge page, one row per regeneration (the page is data; an earlier version can be read back). */
export const knowledgePageVersions = pgTable(
  'knowledge_page_versions',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    reason: text('reason', { enum: KNOWLEDGE_PAGE_REASONS }).notNull(),
    sections: jsonb('sections').$type<KnowledgePageSections>().notNull(),
    /** Which sections this version rewrote. */
    changed: jsonb('changed').$type<KnowledgePageVersion['changed']>().notNull(),
    /** What the version was built from, for the next regeneration's nothing-changed check and delta. */
    basis: jsonb('basis').$type<KnowledgePageBasis>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.version] })],
);

/** Admins' and POs' Pin / Not key verdicts on decision globs (undoing one deletes its row). */
export const knowledgePageFeedback = pgTable(
  'knowledge_page_feedback',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    globId: text('glob_id').notNull(),
    verdict: text('verdict', { enum: KNOWLEDGE_PAGE_VERDICTS }).notNull(),
    by: text('by').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.globId] })],
);

/** People's verdicts on the independent reviewer's inline comments (wrong, thumbs-down), read by the weekly mining. */
export const reviewFeedback = pgTable(
  'review_feedback',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    globId: text('glob_id').notNull(),
    artifactVersion: integer('artifact_version').notNull(),
    fingerprint: text('fingerprint').notNull(),
    severity: text('severity', { enum: REVIEW_SEVERITIES }).notNull(),
    category: text('category', { enum: REVIEW_CATEGORIES }).notNull(),
    title: text('title').notNull(),
    path: text('path').notNull(),
    line: integer('line'),
    verdict: text('verdict', { enum: REVIEW_VERDICTS }).notNull(),
    source: text('source', { enum: REVIEW_FEEDBACK_SOURCES }).notNull(),
    githubCommentId: bigint('github_comment_id', { mode: 'number' }).notNull(),
    actor: text('actor'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('review_feedback_comment_idx').on(t.githubCommentId, t.source),
    index('review_feedback_board_created_idx').on(t.boardId, t.createdAt),
  ],
);

/** The dependency path patterns a board learned a weight for (spec, Dependencies); a pattern without a row has the catalog default. */
export const dependencyRules = pgTable(
  'dependency_rules',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    pattern: text('pattern').notNull(),
    weight: doublePrecision('weight').notNull(),
    cleanCount: integer('clean_count').notNull().default(0),
    conflictCount: integer('conflict_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.pattern] })],
);

/** Each move of a dependency rule, once per board, glob, pattern and cause (resets have no glob, so repeat). */
export const dependencyRuleChanges = pgTable(
  'dependency_rule_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    pattern: text('pattern').notNull(),
    fromWeight: doublePrecision('from_weight').notNull(),
    toWeight: doublePrecision('to_weight').notNull(),
    cause: text('cause', { enum: DEPENDENCY_CAUSES }).notNull(),
    globId: text('glob_id'),
    evidence: text('evidence').notNull(),
  },
  (t) => [uniqueIndex('dependency_rule_changes_outcome_idx').on(t.boardId, t.globId, t.pattern, t.cause)],
);

/** What the size check judged about a glob (spec, Intake): the estimate with its evidence, the flag and the suggested cut. */
export const globSizeChecks = pgTable(
  'glob_size_checks',
  {
    globId: text('glob_id')
      .primaryKey()
      .references(() => globs.id, { onDelete: 'cascade' }),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    planHash: text('plan_hash').notNull(),
    estimate: jsonb('estimate').$type<SizeEstimate>().notNull(),
    evidence: jsonb('evidence').$type<readonly string[]>().notNull(),
    threshold: jsonb('threshold').$type<SizeThreshold>().notNull(),
    flagged: boolean('flagged').notNull(),
    reasons: jsonb('reasons').$type<readonly string[]>().notNull(),
    proposal: jsonb('proposal').$type<StoredSizeProposal>(),
    decision: text('decision', { enum: SIZE_DECISIONS }),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('glob_size_checks_board_idx').on(t.boardId)],
);

/** The board's learned size threshold; no row means the default. */
export const sizeThresholds = pgTable('size_thresholds', {
  boardId: integer('board_id')
    .primaryKey()
    .references(() => boards.id, { onDelete: 'cascade' }),
  maxTasks: integer('max_tasks').notNull(),
  maxParts: integer('max_parts').notNull(),
});

/** A board's risk areas (spec, Intake): kinds of work that need a review; defaults are seeded lazily, learned ones come from outcomes. */
export const boardRiskAreas = pgTable(
  'board_risk_areas',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    pathPatterns: jsonb('path_patterns').$type<string[]>().notNull(),
    why: text('why').notNull(),
    source: text('source', { enum: RISK_AREA_SOURCES }).notNull(),
    strength: integer('strength').notNull().default(0),
    cleanCount: integer('clean_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.name] })],
);

/** The risk areas' history: each change with the glob and outcome that caused it (a reset has no glob). */
export const riskAreaChanges = pgTable(
  'risk_area_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** Null for a reset, or a change whose paths no area covers. */
    areaName: text('area_name'),
    kind: text('kind', { enum: RISK_AREA_CHANGE_KINDS }).notNull(),
    globId: text('glob_id'),
    cause: text('cause', { enum: RISK_AREA_CAUSES }).notNull(),
  },
  (t) => [
    // Idempotent per glob, cause and area; rows without a glob or an area (resets, unscoped corrections) repeat freely.
    uniqueIndex('risk_area_changes_outcome_idx').on(t.boardId, t.globId, t.cause, t.areaName),
  ],
);

/** Escalation outcomes (spec, Subs and escalation): each recorded once per board, glob and outcome, with the criterion it moved and why. */
export const escalationRecords = pgTable(
  'escalation_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** Null for a reset. */
    globId: text('glob_id'),
    criterion: text('criterion', { enum: ESCALATION_CRITERIA }).notNull(),
    outcome: text('outcome', { enum: ESCALATION_OUTCOMES }).notNull(),
    weight: integer('weight').notNull(),
    cause: text('cause').notNull(),
  },
  (t) => [uniqueIndex('escalation_records_outcome_idx').on(t.boardId, t.globId, t.outcome)],
);

/** A person's retype of a glob (spec, Intake): history for intake's type examples; a reset stamps `reset_at` and keeps the rows. */
export const typeCorrections = pgTable(
  'type_corrections',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    globId: text('glob_id').notNull(),
    fromType: text('from_type', { enum: SLOP_TYPES }).notNull(),
    toType: text('to_type', { enum: SLOP_TYPES }).notNull(),
    /** The person's email. */
    actor: text('actor').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** The plan's signals, narrowed by core (`TypeSignals`). */
    signals: jsonb('signals').$type<TypeSignals>().notNull(),
    resetAt: timestamp('reset_at', { withTimezone: true }),
  },
  (t) => [index('type_corrections_board_idx').on(t.boardId, t.at)],
);

/** The size threshold's history: each outcome recorded once per board and glob, with the threshold before and after it. */
export const sizeThresholdChanges = pgTable(
  'size_threshold_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    fromTasks: integer('from_tasks').notNull(),
    toTasks: integer('to_tasks').notNull(),
    fromParts: integer('from_parts').notNull(),
    toParts: integer('to_parts').notNull(),
    outcome: text('outcome', { enum: SIZE_OUTCOMES }).notNull(),
    globId: text('glob_id').notNull(),
    evidence: text('evidence').notNull(),
  },
  (t) => [uniqueIndex('size_threshold_changes_glob_idx').on(t.boardId, t.globId)],
);

/** The board's learned size calibration (weights, per-area factors, samples); no row means the defaults. */
export const sizeCalibrations = pgTable('size_calibrations', {
  boardId: integer('board_id')
    .primaryKey()
    .references(() => boards.id, { onDelete: 'cascade' }),
  state: jsonb('state').$type<SizeCalibration>().notNull(),
});

/** The calibration's history: each move with its cause as text, once per board, glob and cause. */
export const sizeCalibrationChanges = pgTable(
  'size_calibration_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    globId: text('glob_id').notNull(),
    kind: text('kind').notNull(),
    /** The area of an area factor, else null. */
    area: text('area'),
    from: jsonb('from').$type<CalibrationValue>().notNull(),
    to: jsonb('to').$type<CalibrationValue>().notNull(),
    cause: text('cause').notNull(),
  },
  (t) => [uniqueIndex('size_calibration_changes_outcome_idx').on(t.boardId, t.globId, t.cause)],
);

/** A glob's three size points (the forecast, the investigation's correction, the actual outcome), kept for calibration. */
export const globSizeRecords = pgTable(
  'glob_size_records',
  {
    globId: text('glob_id')
      .primaryKey()
      .references(() => globs.id, { onDelete: 'cascade' }),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    estimate: jsonb('estimate').$type<SizeForecast>().notNull(),
    investigation: jsonb('investigation').$type<Investigation>(),
    actual: jsonb('actual').$type<SizeRecord['actual']>().notNull(),
  },
  (t) => [index('glob_size_records_board_idx').on(t.boardId)],
);

/**
 * What intake saw and decided when a glob was created (spec, Intake), one row per (glob, version): never updated except
 * to fill a missing embedding. A plan rewritten before the glob starts adds the next version. The request's embedding
 * serves nearest-example retrieval at intake.
 */
export const intakeSnapshots = pgTable(
  'intake_snapshots',
  {
    globId: text('glob_id')
      .notNull()
      .references(() => globs.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    request: text('request').notNull(),
    title: text('title').notNull(),
    plan: text('plan').notNull(),
    creator: text('creator').notNull(),
    source: text('source', { enum: SNAPSHOT_SOURCES }).notNull(),
    type: text('type', { enum: SLOP_TYPES }).notNull(),
    category: text('category', { enum: CATEGORIES }).notNull(),
    groupName: text('group_name'),
    environment: text('environment'),
    categoryConfidence: text('category_confidence', { enum: CONFIDENCES }),
    reason: text('reason'),
    model: text('model'),
    promptVersion: integer('prompt_version'),
    features: jsonb('features').$type<PlanFeatures>().notNull(),
    /** The globs whose examples intake was shown. */
    examples: jsonb('examples').$type<string[]>().notNull(),
    backfilled: boolean('backfilled').notNull().default(false),
    /** Null until computed (no embedder, or it failed): the intake-outcome job fills it. */
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.globId, t.version] }),
    index('intake_snapshots_board_idx').on(t.boardId),
    index('intake_snapshots_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** A merged glob's outcome (spec, Intake): written at the merge and refreshed once, 14 days after it. */
export const globOutcomes = pgTable(
  'glob_outcomes',
  {
    globId: text('glob_id')
      .primaryKey()
      .references(() => globs.id, { onDelete: 'cascade' }),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    snapshotVersion: integer('snapshot_version').notNull(),
    outcome: jsonb('outcome').$type<GlobOutcome>().notNull(),
    final: boolean('final').notNull(),
    mergedAt: timestamp('merged_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('glob_outcomes_board_idx').on(t.boardId)],
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

/**
 * Decisions (spec, Decisions and supersession): one row per decision beside its knowledge item (`item_id`, which
 * search finds it by; deleting the item deletes the row), with its source, the verified quote and what replaced it.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    itemId: bigint('item_id', { mode: 'number' })
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    /** Null for a decision from an approved knowledge item. */
    globId: text('glob_id'),
    globGroup: text('glob_group'),
    statement: text('statement').notNull(),
    quote: text('quote').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    sourceKind: text('source_kind', { enum: DECISION_SOURCE_KINDS }).notNull(),
    sourceRef: text('source_ref').notNull(),
    sourceLabel: text('source_label').notNull(),
    sourceUrl: text('source_url'),
    /** The newer decision that replaces this one, in any `replace_state`. */
    replacedBy: bigint('replaced_by', { mode: 'number' }),
    replaceState: text('replace_state', { enum: REPLACE_STATES }),
    replaceOldQuote: text('replace_old_quote'),
    replaceNewQuote: text('replace_new_quote'),
    replaceReason: text('replace_reason'),
    /** When the supersession check ran; null while it is due. */
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    processAfter: timestamp('process_after', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('decisions_item_idx').on(t.itemId),
    index('decisions_board_idx').on(t.boardId, t.decidedAt),
    index('decisions_glob_idx').on(t.globId),
    index('decisions_source_idx').on(t.boardId, t.sourceRef),
    index('decisions_check_idx').on(t.checkedAt, t.processAfter),
  ],
);

/** The texts decisions are extracted from, with the hash of what was extracted last (a changed text is extracted again). */
export const decisionSources = pgTable(
  'decision_sources',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    sourceRef: text('source_ref').notNull(),
    contentHash: text('content_hash').notNull(),
    state: text('state', { enum: DECISION_SOURCE_STATES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Retry backoff, or a claimed source's lease. */
    processAfter: timestamp('process_after', { withTimezone: true }),
    lastError: text('last_error'),
    globId: text('glob_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('decision_sources_ref_idx').on(t.boardId, t.sourceRef),
    index('decision_sources_queue_idx').on(t.state, t.processAfter),
    index('decision_sources_glob_idx').on(t.globId),
  ],
);

/** One person's conversation with a board's records; a person has as many as they start. */
export const boardChats = pgTable(
  'board_chats',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('board_chats_person_idx').on(t.boardId, t.email, t.updatedAt)],
);

/** A conversation's questions and the assistant's cited answers, oldest first by id. */
export const boardChatMessages = pgTable(
  'board_chat_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    chatId: bigint('chat_id', { mode: 'number' })
      .notNull()
      .references(() => boardChats.id, { onDelete: 'cascade' }),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    citations: jsonb('citations').$type<ChatCitation[]>(),
    tools: jsonb('tools').$type<string[]>(),
    actions: jsonb('actions').$type<ChatAction[]>(),
    /** The model's text cited no source: shown as not from the board's records. */
    uncited: boolean('uncited').notNull().default(false),
    /** Nothing answered: the text names what was searched. */
    miss: boolean('miss').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('board_chat_messages_chat_idx').on(t.chatId, t.id)],
);

/**
 * A person's 👍/👎 on a chat answer, with a copy of the question and answer. `chat_id` and `message_id` have no foreign
 * key on purpose: members can delete their conversations, and a 👎 test case must outlive that.
 */
export const chatFeedback = pgTable(
  'chat_feedback',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    email: text('email').notNull(),
    rating: text('rating', { enum: ['up', 'down'] }).notNull(),
    note: text('note'),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    citations: jsonb('citations').$type<ChatCitation[]>(),
    tools: jsonb('tools').$type<string[]>(),
    page: jsonb('page').$type<PageContext>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('chat_feedback_message_idx').on(t.messageId, t.email), index('chat_feedback_board_idx').on(t.boardId, t.rating, t.createdAt)],
);

/**
 * The board inbox (spec, Inbox and ingest): pasted text with its summary step's state. The search item (`item_id`) is a
 * projection of the row, deleted on discard. A repeat paste of the same text is the same row (unique per board).
 */
export const inboxItems = pgTable(
  'inbox_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    /** Empty until given or written by the summary step. */
    title: text('title').notNull().default(''),
    text: text('text').notNull(),
    source: text('source').notNull().default('paste'),
    /** The source's own ID for the item (empty for a paste); with the board and source it is unique when set. */
    sourceRef: text('source_ref').notNull().default(''),
    sourceLabel: text('source_label').notNull().default(''),
    sourceType: text('source_type', { enum: INBOX_SOURCE_TYPES }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by'),
    contentHash: text('content_hash').notNull(),
    status: text('status', { enum: INBOX_STATUSES }).notNull().default('new'),
    summary: text('summary'),
    suggestions: jsonb('suggestions').$type<InboxSuggestion[]>().notNull().default([]),
    state: text('state', { enum: INBOX_STATES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Retry backoff, waiting for the model, or a claimed item's lease. */
    processAfter: timestamp('process_after', { withTimezone: true }),
    lastError: text('last_error'),
    itemId: bigint('item_id', { mode: 'number' }).references(() => knowledgeItems.id, { onDelete: 'set null' }),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('inbox_items_hash_idx').on(t.boardId, t.contentHash),
    uniqueIndex('inbox_items_source_ref_idx').on(t.boardId, t.source, t.sourceRef).where(sql`${t.sourceRef} <> ''`),
    index('inbox_items_board_idx').on(t.boardId, t.status, t.occurredAt),
    index('inbox_items_queue_idx').on(t.state, t.processAfter),
  ],
);

/** A board's integration tokens (spec, Inbox and ingest): only the hash of the secret is kept; one is active per board. */
export const integrationTokens = pgTable(
  'integration_tokens',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('integration_tokens_hash_idx').on(t.tokenHash),
    uniqueIndex('integration_tokens_active_idx').on(t.boardId).where(sql`${t.revokedAt} is null`),
  ],
);

/** An inbox item attached to a glob (globs are JSON rows, so no foreign key: `deleteGlob` removes the links). */
export const inboxLinks = pgTable(
  'inbox_links',
  {
    inboxId: bigint('inbox_id', { mode: 'number' })
      .notNull()
      .references(() => inboxItems.id, { onDelete: 'cascade' }),
    globId: text('glob_id').notNull(),
    /** The attachment the link put on the glob. */
    artifactId: bigint('artifact_id', { mode: 'number' }),
    linkedBy: text('linked_by'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.inboxId, t.globId] }), index('inbox_links_glob_idx').on(t.globId)],
);

/**
 * The code view's index of a board's base branch, rebuilt whenever the clone's base moves: one row per board naming the
 * indexed commit, then the tree, the import graph and the path history at that commit. Symbols (definitions and
 * references) will be another table keyed the same way, `(board_id, path, …)`, written in the same replace.
 */
export const codeIndex = pgTable('code_index', {
  boardId: integer('board_id')
    .primaryKey()
    .references(() => boards.id, { onDelete: 'cascade' }),
  commitSha: text('commit_sha').notNull(),
  fileCount: integer('file_count').notNull(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull(),
});

export const codeFiles = pgTable(
  'code_files',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    size: integer('size').notNull(),
    language: text('language'),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.path] })],
);

/** `from_path` imports `to_path`, both files of the indexed commit. */
export const codeImports = pgTable(
  'code_imports',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    fromPath: text('from_path').notNull(),
    toPath: text('to_path').notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.fromPath, t.toPath] }), index('code_imports_to_idx').on(t.boardId, t.toPath)],
);

/** The newest commits that changed each path of the indexed commit (`glob_id` read from the subject). */
export const codePathCommits = pgTable(
  'code_path_commits',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sha: text('sha').notNull(),
    subject: text('subject').notNull(),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
    /** Position in the base branch's log, 0 the newest: commits made in the same second still sort. */
    seq: integer('seq').notNull(),
    globId: text('glob_id'),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.path, t.sha] }), index('code_path_commits_path_idx').on(t.boardId, t.path, t.seq)],
);

/** Which code view operations each consumer calls (`mcp`, `chat`, and later the size check, reviewer and split), and how often they find nothing. */
export const codeViewUsage = pgTable(
  'code_view_usage',
  {
    boardId: integer('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    consumer: text('consumer').notNull(),
    op: text('op').notNull(),
    calls: integer('calls').notNull().default(0),
    emptyResults: integer('empty_results').notNull().default(0),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.consumer, t.op] })],
);
