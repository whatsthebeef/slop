import type { DomainEvent, Effect, Environment, Glob, Provenance } from '@slop/core';
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
  runNoProgressHours: integer('run_no_progress_hours').notNull().default(2),
  runReadyHours: integer('run_ready_hours').notNull().default(8),
  subMaxChangedLines: integer('sub_max_changed_lines').notNull().default(300),
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
