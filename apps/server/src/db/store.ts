import type { ContextSettingChange, KnowledgePageVersion, OutboxJob, IntakeSnapshot, BoardNotification, Category, SlopType, ChatMessage, ChatThread, Artifact, Candidate, Decision, DecisionSource, InboxItem, InboxLink, IntegrationToken, KnowledgeItem, SearchQuery, ArtifactMeta, ArtifactSummary, Board, BoardJob, Deploy, DomainEvent, EnvironmentDeploy, Glob, GlobPresence, GlobFilter, HumanStepDue, StoredHumanStep, KbSignalState, KnowledgeDoc, Member, Relation, RelationPatch, ReviewFinding, ReviewSource, SizeCheck, SizeThresholdChange, SizeCalibrationChange, SizeRecord, TypeCorrection, EscalationRecord, DependencyRuleChange, RiskArea, RiskAreaChange, Store, SubLimitChange, TestRun, Tx, User } from '@slop/core';
import { AGENT_SET_COMMIT_DELAY_MS, CONTEXT_SETTING_KEYS, NO_GLOB, laneOf, resolveContextSettings, isClearedAttachment, AREAS, DEFAULT_SIZE_CALIBRATION, GLOB_OWNED_SOURCES, suggestionsOf, NOTIFICATION_SEVERITIES, ARTIFACT_KINDS, ARTIFACT_KINDS_WITH_CONTENT, BOARD_JOBS, DOMAIN_EVENT_TYPES, DEPLOY_STATES, DEPLOY_TRIGGERS, isHumanStepDue, FINDING_CLASSES, FINDING_SEVERITIES, FINDING_SOURCES, FINDING_STATES, KNOWLEDGE_KINDS, KNOWLEDGE_LAYERS, REVIEW_SOURCE_KINDS, REVIEW_SOURCE_STATES, DEFAULT_SIZE_THRESHOLD, SIZE_DECISIONS, SIZE_OUTCOMES, SUB_LIMIT_OUTCOMES, DEPENDENCY_CAUSES, RISK_AREA_SOURCES, RISK_AREA_CHANGE_KINDS, RISK_AREA_CAUSES, ESCALATION_CRITERIA, ESCALATION_OUTCOMES, TEST_RUN_KINDS, reviewSettingsOf } from '@slop/core';
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase, PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { requestMetrics } from '../request-metrics.js';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
type DbTx = PgTransaction<PostgresJsQueryResultHKT, typeof schema>;
type Executor = Db | DbTx;

export interface Database {
  readonly db: Db;
  close(): Promise<void>;
}

export const connect = (url: string): Database => {
  const client = postgres(url, { max: 10, onnotice: () => undefined });
  return { db: drizzle(client, { schema }), close: () => client.end() };
};

export const runMigrations = async (url: string, folder: string): Promise<void> => {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
};

const toBoard = (row: typeof schema.boards.$inferSelect): Board => ({
  id: row.id,
  name: row.name,
  repo: row.repo,
  baseBranch: row.baseBranch,
  timeZone: row.timeZone,
  defaultRoutineOwner: row.defaultRoutineOwner,
  environments: row.environments,
  sensitivePaths: row.sensitivePaths,
  agentSetVersion: row.agentSetVersion,
  agentCatalogHash: row.agentCatalogHash,
  runNoProgressHours: row.runNoProgressHours,
  runReadyHours: row.runReadyHours,
  runStartMinutes: row.runStartMinutes,
  runRespondMinutes: row.runRespondMinutes,
  subMaxChangedLines: row.subMaxChangedLines,
  subLimitStep: row.subLimitStep,
  effectCheckGlobs: row.effectCheckGlobs,
  agentKbApproval: row.agentKbApproval,
  autoInvestigate: row.autoInvestigate,
  knowledgePageIntervalMinutes: row.knowledgePageIntervalMinutes,
  review: reviewSettingsOf(row.reviewSettings),
  deploy: row.deploy,
  readinessTicks: row.readinessTicks,
  baseChecks: row.baseChecks,
  version: row.version,
});

const toKnowledgePage = (row: typeof schema.knowledgePageVersions.$inferSelect): KnowledgePageVersion => ({
  boardId: row.boardId,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  reason: row.reason,
  sections: row.sections,
  changed: row.changed,
  basis: row.basis,
});

/** Narrows a stored string to one of a fixed set of values; a mismatch means a corrupt row. */
const oneOf = <T extends string>(values: readonly T[], value: string): T => {
  const found = values.find((v) => v === value);
  if (found === undefined) throw new Error(`Unexpected stored value: ${value}`);
  return found;
};

const toDependencyChange = (row: typeof schema.dependencyRuleChanges.$inferSelect): DependencyRuleChange => ({
  id: row.id,
  boardId: row.boardId,
  at: row.at.toISOString(),
  pattern: row.pattern,
  from: row.fromWeight,
  to: row.toWeight,
  cause: oneOf(DEPENDENCY_CAUSES, row.cause),
  globId: row.globId,
  evidence: row.evidence,
});

const toSubLimitChange = (row: typeof schema.subLimitChanges.$inferSelect): SubLimitChange => ({
  id: row.id,
  boardId: row.boardId,
  at: row.at.toISOString(),
  fromLines: row.fromLines,
  toLines: row.toLines,
  outcome: oneOf(SUB_LIMIT_OUTCOMES, row.outcome),
  globId: row.globId,
  changedLines: row.changedLines,
  evidence: row.evidence,
  step: row.step,
});

const toContextSettingChange = (row: typeof schema.contextSettingChanges.$inferSelect): ContextSettingChange => ({
  id: row.id,
  boardId: row.boardId,
  at: row.at.toISOString(),
  key: oneOf(CONTEXT_SETTING_KEYS, row.key),
  before: row.before,
  after: row.after,
  outcome: row.outcome,
  evidence: row.evidence,
});

const toRiskArea = (row: typeof schema.boardRiskAreas.$inferSelect): RiskArea => ({
  boardId: row.boardId,
  name: row.name,
  pathPatterns: row.pathPatterns,
  why: row.why,
  source: oneOf(RISK_AREA_SOURCES, row.source),
  strength: row.strength,
  cleanCount: row.cleanCount,
  updatedAt: row.updatedAt.toISOString(),
});

const toRiskAreaChange = (row: typeof schema.riskAreaChanges.$inferSelect): RiskAreaChange => ({
  id: row.id,
  boardId: row.boardId,
  at: row.at.toISOString(),
  areaName: row.areaName,
  kind: oneOf(RISK_AREA_CHANGE_KINDS, row.kind),
  globId: row.globId,
  cause: oneOf(RISK_AREA_CAUSES, row.cause),
});

const toEscalationRecord = (row: typeof schema.escalationRecords.$inferSelect): EscalationRecord => ({
  id: row.id,
  boardId: row.boardId,
  at: row.at.toISOString(),
  globId: row.globId,
  criterion: oneOf(ESCALATION_CRITERIA, row.criterion),
  outcome: oneOf(ESCALATION_OUTCOMES, row.outcome),
  weight: row.weight,
  cause: row.cause,
});

const toTypeCorrection = (row: typeof schema.typeCorrections.$inferSelect): TypeCorrection => ({
  id: row.id,
  boardId: row.boardId,
  globId: row.globId,
  fromType: row.fromType,
  toType: row.toType,
  actor: row.actor,
  at: row.at.toISOString(),
  signals: row.signals,
  resetAt: row.resetAt === null ? null : row.resetAt.toISOString(),
});

const toSizeCheck = (row: typeof schema.globSizeChecks.$inferSelect): SizeCheck => ({
  globId: row.globId,
  boardId: row.boardId,
  planHash: row.planHash,
  estimate: row.estimate,
  evidence: row.evidence,
  threshold: row.threshold,
  flagged: row.flagged,
  reasons: row.reasons,
  proposal: row.proposal,
  decision: row.decision === null ? null : oneOf(SIZE_DECISIONS, row.decision),
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toSizeThresholdChange = (row: typeof schema.sizeThresholdChanges.$inferSelect): SizeThresholdChange => ({
  id: row.id,
  boardId: row.boardId,
  at: row.at.toISOString(),
  from: { maxTasks: row.fromTasks, maxParts: row.fromParts },
  to: { maxTasks: row.toTasks, maxParts: row.toParts },
  outcome: oneOf(SIZE_OUTCOMES, row.outcome),
  globId: row.globId,
  evidence: row.evidence,
});

const toSizeCalibrationChange = (row: typeof schema.sizeCalibrationChanges.$inferSelect): SizeCalibrationChange => ({
  id: row.id,
  boardId: row.boardId,
  at: row.at.toISOString(),
  globId: row.globId,
  kind: oneOf(['area_factor', 'weights'] as const, row.kind),
  area: row.area === null ? null : oneOf(AREAS, row.area),
  from: row.from,
  to: row.to,
  cause: row.cause,
});

const toSizeRecord = (row: typeof schema.globSizeRecords.$inferSelect): SizeRecord => ({
  globId: row.globId,
  boardId: row.boardId,
  recordedAt: row.recordedAt.toISOString(),
  estimate: row.estimate,
  investigation: row.investigation,
  actual: row.actual,
});

const toIntakeSnapshot = (row: typeof schema.intakeSnapshots.$inferSelect): IntakeSnapshot => ({
  globId: row.globId,
  version: row.version,
  boardId: row.boardId,
  request: row.request,
  title: row.title,
  plan: row.plan,
  creator: row.creator,
  source: row.source,
  decisions: {
    type: row.type,
    category: row.category,
    group: row.groupName,
    environment: row.environment,
    categoryConfidence: row.categoryConfidence,
    reason: row.reason,
    model: row.model,
    promptVersion: row.promptVersion,
  },
  features: row.features,
  examples: row.examples,
  backfilled: row.backfilled,
  createdAt: row.createdAt.toISOString(),
});

const toDeploy = (row: typeof schema.deploys.$inferSelect): Deploy => ({
  ...row,
  state: oneOf(DEPLOY_STATES, row.state),
  trigger: oneOf(DEPLOY_TRIGGERS, row.trigger),
  requestedAt: row.requestedAt.toISOString(),
  runningSince: row.runningSince?.toISOString() ?? null,
  startedAt: row.startedAt?.toISOString() ?? null,
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

const deployRow = (d: Deploy): typeof schema.deploys.$inferInsert => ({
  ...d,
  requestedAt: new Date(d.requestedAt),
  runningSince: d.runningSince === null ? null : new Date(d.runningSince),
  startedAt: d.startedAt === null ? null : new Date(d.startedAt),
  finishedAt: d.finishedAt === null ? null : new Date(d.finishedAt),
});

const humanStepDue = (value: string): HumanStepDue => {
  if (!isHumanStepDue(value)) throw new Error(`Unknown human step due ${value}`);
  return value;
};

const toHumanStep = (row: typeof schema.humanSteps.$inferSelect): StoredHumanStep => ({
  id: row.id,
  boardId: row.boardId,
  globId: row.globId,
  kind: row.kind,
  title: row.title,
  detail: row.detail,
  who: row.who,
  due: humanStepDue(row.due),
  state: row.state,
  blocks: row.blocks,
  check: row.check,
  script: row.script,
  origin: row.origin,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  doneBy: row.doneBy,
  doneAt: row.doneAt?.toISOString() ?? null,
  dismissedReason: row.dismissedReason,
});

const humanStepRow = (h: StoredHumanStep): typeof schema.humanSteps.$inferInsert => ({
  ...h,
  createdAt: new Date(h.createdAt),
  doneAt: h.doneAt === null ? null : new Date(h.doneAt),
});

const toRelation = (row: typeof schema.relations.$inferSelect): Relation => ({
  id: row.id,
  boardId: row.boardId,
  from: row.fromGlob,
  to: row.toGlob,
  gate: row.gate,
  until: row.until,
  reason: row.reason,
  evidence: row.evidence,
  source: row.source,
  dismissedAt: row.dismissedAt?.toISOString() ?? null,
  dismissedPlanHash: row.dismissedPlanHash,
  overriddenAt: row.overriddenAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const relationRow = (r: Relation): typeof schema.relations.$inferInsert => ({
  id: r.id,
  boardId: r.boardId,
  fromGlob: r.from,
  toGlob: r.to,
  gate: r.gate,
  until: r.until,
  reason: r.reason,
  evidence: r.evidence,
  source: r.source,
  dismissedAt: r.dismissedAt === null ? null : new Date(r.dismissedAt),
  dismissedPlanHash: r.dismissedPlanHash,
  overriddenAt: r.overriddenAt === null ? null : new Date(r.overriddenAt),
  createdAt: new Date(r.createdAt),
});

const toEnvironmentDeploy = (row: typeof schema.environmentDeploys.$inferSelect): EnvironmentDeploy => ({
  ...row,
  at: row.at.toISOString(),
});

const toPresence = (row: typeof schema.globEnvironments.$inferSelect): GlobPresence => ({
  ...row,
  checkedAt: row.checkedAt.toISOString(),
  since: row.since?.toISOString() ?? null,
});

const presenceRow = (p: GlobPresence): typeof schema.globEnvironments.$inferInsert => ({
  ...p,
  checkedAt: new Date(p.checkedAt),
  since: p.since === null ? null : new Date(p.since),
});

const toTestRun = (row: typeof schema.testRuns.$inferSelect): TestRun => ({
  ...row,
  kind: oneOf(TEST_RUN_KINDS, row.kind),
  finishedAt: row.finishedAt.toISOString(),
});

const toNotification = (row: typeof schema.boardNotifications.$inferSelect): BoardNotification => ({
  id: row.id,
  boardId: row.boardId,
  source: row.source,
  severity: oneOf(NOTIFICATION_SEVERITIES, row.severity),
  title: row.title,
  detail: row.detail,
  link: row.link,
  action: row.action,
  since: row.since.toISOString(),
  clears: row.clears,
});

const toKnowledge = (row: typeof schema.knowledge.$inferSelect): KnowledgeDoc => ({
  ...row,
  kind: oneOf(KNOWLEDGE_KINDS, row.kind),
  layer: oneOf(KNOWLEDGE_LAYERS, row.layer),
  updatedAt: row.updatedAt.toISOString(),
});

type AttachmentFileFacts = NonNullable<typeof schema.artifacts.$inferSelect['file']>;
const fileFactsOf = ({ fileName, contentType, size, state, reason }: AttachmentFileFacts) => ({ fileName, contentType, size, state, reason });

const toArtifact = ({ file, ...row }: typeof schema.artifacts.$inferSelect): Artifact => ({
  ...row,
  kind: oneOf(ARTIFACT_KINDS, row.kind),
  createdAt: row.createdAt.toISOString(),
  // Absent (not null) on text and link attachments, so those artifacts read as before.
  ...(file === null ? {} : { file }),
});

/** Keeps only the latest version of each artifact (per glob, kind and label). */
const latestVersion = (a: typeof schema.artifacts) =>
  sql`not exists (select 1 from artifacts newer where newer.glob_id = ${a.globId} and newer.kind = ${a.kind} and newer.label = ${a.label} and newer.version > ${a.version})`;

const toReviewSource = (row: typeof schema.reviewSources.$inferSelect): ReviewSource => ({
  ...row,
  kind: oneOf(REVIEW_SOURCE_KINDS, row.kind),
  state: oneOf(REVIEW_SOURCE_STATES, row.state),
  processAfter: row.processAfter?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const toFinding = (row: typeof schema.reviewFindings.$inferSelect): ReviewFinding => ({
  ...row,
  source: oneOf(FINDING_SOURCES, row.source),
  severity: oneOf(FINDING_SEVERITIES, row.severity),
  class: row.class === null ? null : oneOf(FINDING_CLASSES, row.class),
  state: oneOf(FINDING_STATES, row.state),
  processAfter: row.processAfter?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  classifiedAt: row.classifiedAt?.toISOString() ?? null,
});

const toKbSignal = (row: typeof schema.kbSignals.$inferSelect): KbSignalState => ({
  ...row,
  lastMeasuredAt: row.lastMeasuredAt?.toISOString() ?? null,
  raisedAt: row.raisedAt?.toISOString() ?? null,
});
// The job's state stays out: only the job itself reads it (`getBoardJobState`).
const toBoardJob = (row: typeof schema.boardJobs.$inferSelect): BoardJob => ({
  boardId: row.boardId,
  job: oneOf(BOARD_JOBS, row.job),
  lastResult: row.lastResult,
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
  runningUntil: row.runningUntil?.toISOString() ?? null,
});

const globColumns = (glob: Glob) => ({
  boardId: glob.boardId,
  version: glob.version,
  status: glob.status,
  type: glob.type,
  groupName: glob.group,
  planner: glob.planner,
  implementer: glob.implementer,
  data: glob,
  updatedAt: new Date(glob.updatedAt),
});

const toKnowledgeItem = (row: typeof schema.knowledgeItems.$inferSelect): KnowledgeItem => ({
  id: row.id,
  boardId: row.boardId,
  sourceType: row.sourceType,
  externalRef: row.externalRef,
  title: row.title,
  occurredAt: row.occurredAt.toISOString(),
  authority: row.authority,
  status: row.status,
  supersededBy: row.supersededBy,
  globIds: row.globIds,
  globGroup: row.globGroup,
  externalUrl: row.externalUrl,
  contentHash: row.contentHash,
  state: row.state,
  attempts: row.attempts,
  processAfter: row.processAfter?.toISOString() ?? null,
  lastError: row.lastError,
});

const toDecision = (row: typeof schema.decisions.$inferSelect): Decision => ({
  id: row.id,
  boardId: row.boardId,
  itemId: row.itemId,
  globId: row.globId,
  group: row.globGroup,
  statement: row.statement,
  quote: row.quote,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt.toISOString(),
  sourceKind: row.sourceKind,
  sourceRef: row.sourceRef,
  sourceLabel: row.sourceLabel,
  sourceUrl: row.sourceUrl,
  replacedBy: row.replacedBy,
  replaceState: row.replaceState,
  replaceOldQuote: row.replaceOldQuote,
  replaceNewQuote: row.replaceNewQuote,
  replaceReason: row.replaceReason,
  checkedAt: row.checkedAt?.toISOString() ?? null,
  attempts: row.attempts,
  processAfter: row.processAfter?.toISOString() ?? null,
  lastError: row.lastError,
  createdAt: row.createdAt.toISOString(),
});

const toDecisionSource = (row: typeof schema.decisionSources.$inferSelect): DecisionSource => ({
  boardId: row.boardId,
  sourceRef: row.sourceRef,
  contentHash: row.contentHash,
  state: row.state,
  attempts: row.attempts,
  processAfter: row.processAfter?.toISOString() ?? null,
  lastError: row.lastError,
  globId: row.globId,
  updatedAt: row.updatedAt.toISOString(),
});

const toChatThread = (row: typeof schema.boardChats.$inferSelect): ChatThread => ({
  id: row.id,
  boardId: row.boardId,
  email: row.email,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toChatMessage = (row: typeof schema.boardChatMessages.$inferSelect): ChatMessage => ({
  id: row.id,
  chatId: row.chatId,
  boardId: row.boardId,
  email: row.email,
  role: row.role,
  content: row.content,
  citations: row.citations,
  tools: row.tools,
  actions: row.actions,
  ...(row.uncited ? { uncited: true } : {}),
  ...(row.miss ? { miss: true } : {}),
  createdAt: row.createdAt.toISOString(),
});

const toInboxItem = (row: typeof schema.inboxItems.$inferSelect): InboxItem => ({
  id: row.id,
  boardId: row.boardId,
  title: row.title,
  text: row.text,
  source: row.source,
  sourceRef: row.sourceRef,
  sourceLabel: row.sourceLabel,
  sourceType: row.sourceType,
  occurredAt: row.occurredAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  createdBy: row.createdBy,
  contentHash: row.contentHash,
  status: row.status,
  summary: row.summary,
  suggestions: suggestionsOf(row.suggestions),
  state: row.state,
  attempts: row.attempts,
  processAfter: row.processAfter?.toISOString() ?? null,
  lastError: row.lastError,
  itemId: row.itemId,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});

const toIntegrationToken = (row: typeof schema.integrationTokens.$inferSelect): IntegrationToken => ({
  id: row.id,
  boardId: row.boardId,
  tokenHash: row.tokenHash,
  createdAt: row.createdAt.toISOString(),
  createdBy: row.createdBy,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

const toInboxLink = (row: typeof schema.inboxLinks.$inferSelect): InboxLink => ({
  inboxId: row.inboxId,
  globId: row.globId,
  artifactId: row.artifactId,
  linkedBy: row.linkedBy,
  linkedAt: row.linkedAt.toISOString(),
});

const supersededItems = alias(schema.knowledgeItems, 'superseding');

/** What a candidate query selects: the chunk, its item's facts and the title of the item that replaced it. */
const candidateColumns = (relevance: SQL<number>) => ({
  chunkId: schema.chunks.id,
  itemId: schema.knowledgeItems.id,
  header: schema.chunks.header,
  text: schema.chunks.text,
  relevance,
  sourceType: schema.knowledgeItems.sourceType,
  title: schema.knowledgeItems.title,
  occurredAt: schema.knowledgeItems.occurredAt,
  authority: schema.knowledgeItems.authority,
  status: schema.knowledgeItems.status,
  supersededByTitle: supersededItems.title,
  supersededByAt: supersededItems.occurredAt,
  globIds: schema.knowledgeItems.globIds,
  globGroup: schema.knowledgeItems.globGroup,
  externalUrl: schema.knowledgeItems.externalUrl,
});

const toCandidate = (
  row: { relevance: number; occurredAt: Date; supersededByAt: Date | null } & Omit<Candidate, 'relevance' | 'occurredAt' | 'supersededByAt'>,
): Candidate => ({
  ...row,
  supersededByAt: row.supersededByAt?.toISOString() ?? null,
  // A zero vector has no cosine similarity (NaN): it matches nothing.
  relevance: Number.isFinite(row.relevance) ? Math.min(1, Math.max(0, row.relevance)) : 0,
  occurredAt: row.occurredAt.toISOString(),
});

/** The filters every search shares: one board, and the query's date range, glob, group and source types. */
const searchFilters = (q: SearchQuery): SQL[] => {
  const i = schema.knowledgeItems;
  const conditions = [eq(schema.chunks.boardId, q.boardId), eq(i.boardId, q.boardId)];
  if (q.from !== undefined) conditions.push(gte(i.occurredAt, new Date(q.from)));
  if (q.to !== undefined) conditions.push(lte(i.occurredAt, new Date(q.to)));
  if (q.globId !== undefined) conditions.push(sql`${i.globIds} @> ARRAY[${q.globId}]::text[]`);
  if (q.group !== undefined) conditions.push(eq(i.globGroup, q.group));
  if (q.sourceTypes !== undefined && q.sourceTypes.length > 0) conditions.push(inArray(i.sourceType, [...q.sourceTypes]));
  return conditions;
};

/** The words of a query as a full-text query, and as a plain substring (identifiers, paths) and trigram match. */
const keywordMatch = (query: string) => {
  const c = schema.chunks;
  const tsquery = sql`websearch_to_tsquery('english', ${query})`;
  const contains = sql`${c.text} ilike ${`%${query.replace(/[\\%_]/g, '\\$&')}%`}`;
  const similar = sql`${query} <% ${c.text}`;
  const relevance = sql<number>`greatest(
    case when ${c.tsv} @@ ${tsquery} then ts_rank_cd(${c.tsv}, ${tsquery}, 32) else 0 end,
    case when ${contains} then 1 else 0 end,
    word_similarity(${query}, ${c.text})
  )::float8`.mapWith(Number);
  return { relevance, matches: sql`(${c.tsv} @@ ${tsquery} or ${contains} or ${similar})` };
};

const vectorText = (embedding: readonly number[]): string => `[${embedding.join(',')}]`;

/** Postgres implementation of the core Store port. */
/** How long a board's overlap recheck waits, so the pushes and merges of a burst share one run. */
const RECHECK_DELAY_MS = 5000;

export class PgStore implements Store {
  constructor(private readonly db: Db) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return requestMetrics.db(() => this.db.transaction((t) => work(this.tx(t))));
  }

  private tx(t: Executor): Tx {
    return {
      getGlob: async (id) => {
        const [row] = await t.select({ data: schema.globs.data }).from(schema.globs).where(eq(schema.globs.id, id));
        return row?.data ?? null;
      },
      getGlobs: async (ids) => {
        if (ids.length === 0) return [];
        const rows = await t.select({ data: schema.globs.data }).from(schema.globs).where(inArray(schema.globs.id, [...new Set(ids)]));
        return rows.map((r) => r.data);
      },
      globFacts: async (ids) => {
        if (ids.length === 0) return [];
        const g = schema.globs;
        // The IDs travel as one JSON parameter: a report can name more globs than Postgres's 65,535 bind parameters.
        const wanted = JSON.stringify([...new Set(ids)]);
        return t
          .select({ id: g.id, boardId: g.boardId, planner: g.planner, category: sql<Category>`${g.data} ->> 'category'`, type: sql<SlopType>`${g.type}` })
          .from(g)
          .where(sql`${g.id} in (select jsonb_array_elements_text(${wanted}::jsonb))`);
      },
      insertGlob: async (glob, creationKey) => {
        const rows = await t
          .insert(schema.globs)
          .values({ id: glob.id, creationKey, ...globColumns(glob) })
          .onConflictDoNothing()
          .returning({ id: schema.globs.id });
        return rows.length === 1;
      },
      updateGlob: async (glob, expectedVersion) => {
        const rows = await t
          .update(schema.globs)
          .set(globColumns(glob))
          .where(and(eq(schema.globs.id, glob.id), eq(schema.globs.version, expectedVersion)))
          .returning({ id: schema.globs.id });
        return rows.length === 1;
      },
      deleteGlob: async (id) => {
        await t.delete(schema.globEnvironments).where(eq(schema.globEnvironments.globId, id));
        await t.delete(schema.testRuns).where(eq(schema.testRuns.globId, id));
        await t.delete(schema.reviewFindings).where(eq(schema.reviewFindings.globId, id));
        await t.delete(schema.reviewSources).where(eq(schema.reviewSources.globId, id));
        await t.delete(schema.humanSteps).where(eq(schema.humanSteps.globId, id));
        // Its own relations go; the ones pointing at it stay, so a glob that waited on it can say it was deleted.
        await t.delete(schema.relations).where(eq(schema.relations.fromGlob, id));
        await t.delete(schema.statusDismissals).where(eq(schema.statusDismissals.globId, id));
        await t.delete(schema.artifacts).where(eq(schema.artifacts.globId, id));
        // Older decisions that this glob's decisions replaced stand again; its own rows go with their items below.
        const d = schema.decisions;
        const released = await t
          .update(d)
          .set({ replacedBy: null, replaceState: null })
          .where(inArray(d.replacedBy, t.select({ id: d.id }).from(d).where(eq(d.globId, id))))
          .returning({ itemId: d.itemId });
        if (released.length > 0) {
          await t
            .update(schema.knowledgeItems)
            .set({ status: 'active', supersededBy: null })
            .where(inArray(schema.knowledgeItems.id, released.map((r) => r.itemId)));
        }
        await t.delete(schema.decisionSources).where(eq(schema.decisionSources.globId, id));
        // Pasted items stay; one whose last glob went is only kept.
        const l = schema.inboxLinks;
        const unlinked = await t.delete(l).where(eq(l.globId, id)).returning({ inboxId: l.inboxId });
        if (unlinked.length > 0) {
          const n = schema.inboxItems;
          await t
            .update(n)
            .set({ status: 'kept', version: sql`${n.version} + 1` })
            .where(
              and(
                inArray(n.id, unlinked.map((u) => u.inboxId)),
                eq(n.status, 'attached'),
                sql`not exists (select 1 from ${l} where ${l.inboxId} = ${n.id})`,
              ),
            );
        }
        // Its own search items go with it; a learning or document it fed only loses the link.
        const i = schema.knowledgeItems;
        const linked = sql`${i.globIds} @> ARRAY[${id}]::text[]`;
        await t.delete(i).where(and(linked, inArray(i.sourceType, [...GLOB_OWNED_SOURCES])));
        await t.update(i).set({ globIds: sql`array_remove(${i.globIds}, ${id})` }).where(linked);
        await t.delete(schema.globs).where(eq(schema.globs.id, id));
      },
      findGlobByCreationKey: async (boardId, key) => {
        const [row] = await t
          .select({ data: schema.globs.data })
          .from(schema.globs)
          .where(and(eq(schema.globs.boardId, boardId), eq(schema.globs.creationKey, key)));
        return row?.data ?? null;
      },
      findGlobsByCreationKeyPrefix: async (boardId, prefix) => {
        const rows = await t
          .select({ data: schema.globs.data })
          .from(schema.globs)
          .where(and(eq(schema.globs.boardId, boardId), sql`starts_with(${schema.globs.creationKey}, ${prefix})`));
        return rows.map((r) => r.data);
      },
      listGlobs: async (boardId, filter: GlobFilter) => {
        const conditions = [eq(schema.globs.boardId, boardId)];
        // Work by default: decision globs are listed only when asked for. Category lives in the document, not a column.
        if (filter.include !== 'all') {
          const decision = sql`${schema.globs.data}->>'category' = 'decision'`;
          conditions.push(filter.include === 'decisions' ? decision : sql`${schema.globs.data}->>'category' is distinct from 'decision'`);
        }
        if (filter.status !== undefined) conditions.push(inArray(schema.globs.status, [...filter.status]));
        if (filter.type !== undefined) conditions.push(eq(schema.globs.type, filter.type));
        if (filter.group !== undefined) conditions.push(eq(schema.globs.groupName, filter.group));
        if (filter.person !== undefined) {
          const person = or(eq(schema.globs.planner, filter.person), eq(schema.globs.implementer, filter.person));
          if (person !== undefined) conditions.push(person);
        }
        if (filter.origins !== undefined) {
          conditions.push(inArray(sql`${schema.globs.data}->'attributes'->'origin'->>'kind'`, [...filter.origins]));
        }
        const rows = await t
          .select({ data: schema.globs.data })
          .from(schema.globs)
          .where(and(...conditions))
          .orderBy(schema.globs.updatedAt);
        return rows.map((r) => r.data);
      },
      nextNumber: async (boardId, letter) => {
        const [row] = await t
          .insert(schema.idCounters)
          .values({ boardId, letter, n: 1 })
          .onConflictDoUpdate({
            target: [schema.idCounters.boardId, schema.idCounters.letter],
            set: { n: sql`${schema.idCounters.n} + 1` },
          })
          .returning({ n: schema.idCounters.n });
        if (row === undefined) throw new Error('Counter update returned nothing');
        return row.n;
      },

      getBoard: async (id) => {
        const [row] = await t.select().from(schema.boards).where(eq(schema.boards.id, id));
        return row === undefined ? null : toBoard(row);
      },
      insertBoard: async (input) => {
        const [row] = await t
          .insert(schema.boards)
          .values({ ...input, environments: [...input.environments], sensitivePaths: [...input.sensitivePaths], version: 1 })
          .returning();
        if (row === undefined) throw new Error('Board insert returned nothing');
        return toBoard(row);
      },
      updateBoard: async (board, expectedVersion) => {
        const rows = await t
          .update(schema.boards)
          .set({
            name: board.name,
            repo: board.repo,
            baseBranch: board.baseBranch,
            timeZone: board.timeZone,
            defaultRoutineOwner: board.defaultRoutineOwner,
            environments: [...board.environments],
            sensitivePaths: [...board.sensitivePaths],
            agentSetVersion: board.agentSetVersion,
            agentCatalogHash: board.agentCatalogHash,
            runNoProgressHours: board.runNoProgressHours,
            runReadyHours: board.runReadyHours,
            runStartMinutes: board.runStartMinutes,
            runRespondMinutes: board.runRespondMinutes,
            deploy: board.deploy,
            readinessTicks: board.readinessTicks,
            // Not the learned sub limit: `setSubLimit` writes it, so a settings save doesn't undo a learned move.
            effectCheckGlobs: board.effectCheckGlobs,
            agentKbApproval: board.agentKbApproval,
            autoInvestigate: board.autoInvestigate,
            knowledgePageIntervalMinutes: board.knowledgePageIntervalMinutes,
            reviewSettings: { ...board.review, ignoredPaths: [...board.review.ignoredPaths] },
            version: board.version,
          })
          .where(and(eq(schema.boards.id, board.id), eq(schema.boards.version, expectedVersion)))
          .returning({ id: schema.boards.id });
        return rows.length === 1;
      },
      setSubLimit: async (boardId, from, to, step) => {
        const rows = await t
          .update(schema.boards)
          .set(step === undefined ? { subMaxChangedLines: to } : { subMaxChangedLines: to, subLimitStep: step })
          .where(and(eq(schema.boards.id, boardId), eq(schema.boards.subMaxChangedLines, from)))
          .returning({ id: schema.boards.id });
        return rows.length === 1;
      },
      insertKnowledgePageVersion: async (v) => {
        const rows = await t
          .insert(schema.knowledgePageVersions)
          .values({ ...v, createdAt: new Date(v.createdAt) })
          .onConflictDoNothing()
          .returning({ version: schema.knowledgePageVersions.version });
        return rows.length === 1;
      },
      latestKnowledgePageVersion: async (boardId) => {
        const p = schema.knowledgePageVersions;
        const [row] = await t.select().from(p).where(eq(p.boardId, boardId)).orderBy(desc(p.version)).limit(1);
        return row === undefined ? null : toKnowledgePage(row);
      },
      getKnowledgePageVersion: async (boardId, version) => {
        const p = schema.knowledgePageVersions;
        const [row] = await t.select().from(p).where(and(eq(p.boardId, boardId), eq(p.version, version)));
        return row === undefined ? null : toKnowledgePage(row);
      },
      listKnowledgePageVersions: async (boardId, limit) => {
        const p = schema.knowledgePageVersions;
        const rows = await t
          .select({ version: p.version, createdAt: p.createdAt, reason: p.reason })
          .from(p)
          .where(eq(p.boardId, boardId))
          .orderBy(desc(p.version))
          .limit(limit);
        return rows.map((r) => ({ version: r.version, createdAt: r.createdAt.toISOString(), reason: r.reason }));
      },
      listKnowledgePageFeedback: async (boardId) => {
        const f = schema.knowledgePageFeedback;
        const rows = await t.select().from(f).where(eq(f.boardId, boardId)).orderBy(desc(f.at), f.globId);
        return rows.map((r) => ({ boardId: r.boardId, globId: r.globId, verdict: r.verdict, by: r.by, at: r.at.toISOString() }));
      },
      saveKnowledgePageFeedback: async (feedback) => {
        const values = { ...feedback, at: new Date(feedback.at) };
        await t
          .insert(schema.knowledgePageFeedback)
          .values(values)
          .onConflictDoUpdate({ target: [schema.knowledgePageFeedback.boardId, schema.knowledgePageFeedback.globId], set: values });
      },
      deleteKnowledgePageFeedback: async (boardId, globId) => {
        const f = schema.knowledgePageFeedback;
        await t.delete(f).where(and(eq(f.boardId, boardId), eq(f.globId, globId)));
      },
      insertLlmSpend: async (row) => {
        await t.insert(schema.llmSpend).values({ ...row, createdAt: new Date(row.createdAt) });
      },
      sumLlmSpend: async (boardId, from, to) => {
        const s = schema.llmSpend;
        const rows = await t
          .select({ source: s.source, usd: sql<number>`coalesce(sum(${s.costUsd}), 0)::float8`, unpriced: sql<number>`(count(*) filter (where ${s.costUsd} is null))::int`, priced: sql<number>`(count(${s.costUsd}))::int` })
          .from(s)
          .where(and(eq(s.boardId, boardId), gte(s.createdAt, new Date(from)), lte(s.createdAt, new Date(to))))
          .groupBy(s.source);
        const bySource: Record<string, number> = {};
        const unpricedBySource: Record<string, number> = {};
        let usd = 0;
        let unpricedCalls = 0;
        for (const r of rows) {
          // Like the in-memory store, a source with no priced (or no unpriced) rows is left out of that map.
          if (r.priced > 0) bySource[r.source] = r.usd;
          if (r.unpriced > 0) unpricedBySource[r.source] = r.unpriced;
          usd += r.usd;
          unpricedCalls += r.unpriced;
        }
        return { usd, unpricedCalls, bySource, unpricedBySource };
      },
      insertReviewFeedback: async (row) => {
        const rows = await t
          .insert(schema.reviewFeedback)
          .values({ ...row, createdAt: new Date(row.createdAt) })
          .onConflictDoNothing()
          .returning({ id: schema.reviewFeedback.id });
        return rows.length === 1;
      },
      listReviewFeedback: async (boardId, since, until) => {
        const f = schema.reviewFeedback;
        const rows = await t
          .select()
          .from(f)
          .where(and(eq(f.boardId, boardId), gte(f.createdAt, new Date(since)), lte(f.createdAt, new Date(until))))
          .orderBy(asc(f.createdAt), asc(f.id));
        return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
      },
      insertSubLimitChange: async (change) => {
        const rows = await t
          .insert(schema.subLimitChanges)
          .values({ ...change, at: new Date(change.at) })
          .onConflictDoNothing()
          .returning({ id: schema.subLimitChanges.id });
        return rows.length === 1;
      },
      listSubLimitChanges: async (boardId) =>
        (
          await t
            .select()
            .from(schema.subLimitChanges)
            .where(eq(schema.subLimitChanges.boardId, boardId))
            .orderBy(desc(schema.subLimitChanges.at), desc(schema.subLimitChanges.id))
        ).map(toSubLimitChange),
      listDependencyRules: async (boardId) =>
        (await t.select().from(schema.dependencyRules).where(eq(schema.dependencyRules.boardId, boardId))).map((r) => ({
          boardId: r.boardId,
          pattern: r.pattern,
          weight: r.weight,
          cleanCount: r.cleanCount,
          conflictCount: r.conflictCount,
          updatedAt: r.updatedAt.toISOString(),
        })),
      upsertDependencyRule: async (rule) => {
        const values = { ...rule, updatedAt: new Date(rule.updatedAt) };
        await t
          .insert(schema.dependencyRules)
          .values(values)
          .onConflictDoUpdate({ target: [schema.dependencyRules.boardId, schema.dependencyRules.pattern], set: values });
      },
      deleteDependencyRules: async (boardId, pattern) => {
        await t
          .delete(schema.dependencyRules)
          .where(
            pattern === undefined
              ? eq(schema.dependencyRules.boardId, boardId)
              : and(eq(schema.dependencyRules.boardId, boardId), eq(schema.dependencyRules.pattern, pattern)),
          );
      },
      insertDependencyRuleChange: async (change) => {
        const rows = await t
          .insert(schema.dependencyRuleChanges)
          .values({ boardId: change.boardId, at: new Date(change.at), pattern: change.pattern, fromWeight: change.from, toWeight: change.to, cause: change.cause, globId: change.globId, evidence: change.evidence })
          .onConflictDoNothing()
          .returning({ id: schema.dependencyRuleChanges.id });
        return rows.length === 1;
      },
      listDependencyRuleChanges: async (boardId) =>
        (
          await t
            .select()
            .from(schema.dependencyRuleChanges)
            .where(eq(schema.dependencyRuleChanges.boardId, boardId))
            .orderBy(desc(schema.dependencyRuleChanges.at), desc(schema.dependencyRuleChanges.id))
        ).map(toDependencyChange),
      listRiskAreas: async (boardId) =>
        (await t.select().from(schema.boardRiskAreas).where(eq(schema.boardRiskAreas.boardId, boardId)).orderBy(schema.boardRiskAreas.name)).map(toRiskArea),
      putRiskArea: async (area) => {
        const values = { ...area, pathPatterns: [...area.pathPatterns], updatedAt: new Date(area.updatedAt) };
        await t
          .insert(schema.boardRiskAreas)
          .values(values)
          .onConflictDoUpdate({ target: [schema.boardRiskAreas.boardId, schema.boardRiskAreas.name], set: values });
      },
      deleteRiskArea: async (boardId, name) => {
        await t.delete(schema.boardRiskAreas).where(and(eq(schema.boardRiskAreas.boardId, boardId), eq(schema.boardRiskAreas.name, name)));
      },
      insertRiskAreaChange: async (change) => {
        const rows = await t
          .insert(schema.riskAreaChanges)
          .values({ ...change, at: new Date(change.at) })
          .onConflictDoNothing()
          .returning({ id: schema.riskAreaChanges.id });
        return rows.length === 1;
      },
      listRiskAreaChanges: async (boardId) =>
        (
          await t
            .select()
            .from(schema.riskAreaChanges)
            .where(eq(schema.riskAreaChanges.boardId, boardId))
            .orderBy(desc(schema.riskAreaChanges.at), desc(schema.riskAreaChanges.id))
        ).map(toRiskAreaChange),
      insertEscalationRecord: async (record) => {
        const rows = await t
          .insert(schema.escalationRecords)
          .values({ ...record, at: new Date(record.at) })
          .onConflictDoNothing()
          .returning({ id: schema.escalationRecords.id });
        return rows.length === 1;
      },
      listEscalationRecords: async (boardId) =>
        (
          await t
            .select()
            .from(schema.escalationRecords)
            .where(eq(schema.escalationRecords.boardId, boardId))
            .orderBy(desc(schema.escalationRecords.at), desc(schema.escalationRecords.id))
        ).map(toEscalationRecord),
      insertTypeCorrection: async (correction) => {
        await t.insert(schema.typeCorrections).values({ ...correction, at: new Date(correction.at) });
      },
      listTypeCorrections: async (boardId, options) => {
        const query = t
          .select()
          .from(schema.typeCorrections)
          .where(options?.all === true ? eq(schema.typeCorrections.boardId, boardId) : and(eq(schema.typeCorrections.boardId, boardId), isNull(schema.typeCorrections.resetAt)))
          .orderBy(desc(schema.typeCorrections.at), desc(schema.typeCorrections.id));
        return (await (options?.limit === undefined ? query : query.limit(options.limit))).map(toTypeCorrection);
      },
      resetTypeCorrections: async (boardId, at) =>
        (
          await t
            .update(schema.typeCorrections)
            .set({ resetAt: new Date(at) })
            .where(and(eq(schema.typeCorrections.boardId, boardId), isNull(schema.typeCorrections.resetAt)))
            .returning({ id: schema.typeCorrections.id })
        ).length,
      getSizeCheck: async (globId) => {
        const [row] = await t.select().from(schema.globSizeChecks).where(eq(schema.globSizeChecks.globId, globId));
        return row === undefined ? null : toSizeCheck(row);
      },
      listSizeChecks: async (boardId) =>
        (await t.select().from(schema.globSizeChecks).where(eq(schema.globSizeChecks.boardId, boardId))).map(toSizeCheck),
      upsertSizeCheck: async (check) => {
        const c = schema.globSizeChecks;
        const { globId, decidedAt, createdAt, updatedAt, ...rest } = check;
        const values = { ...rest, decidedAt: decidedAt === null ? null : new Date(decidedAt), createdAt: new Date(createdAt), updatedAt: new Date(updatedAt) };
        await t.insert(c).values({ globId, ...values }).onConflictDoUpdate({ target: c.globId, set: values });
      },
      updateSizeAssessment: async (check) => {
        const c = schema.globSizeChecks;
        const { globId, decision, decidedBy, decidedAt, createdAt, updatedAt, ...rest } = check;
        const set = { ...rest, updatedAt: new Date(updatedAt) };
        // On conflict only the assessment columns are written: a decision committed meanwhile stays.
        await t
          .insert(c)
          .values({ globId, ...set, decision, decidedBy, decidedAt: decidedAt === null ? null : new Date(decidedAt), createdAt: new Date(createdAt) })
          .onConflictDoUpdate({ target: c.globId, set });
      },
      getSizeThreshold: async (boardId) => {
        const [row] = await t.select().from(schema.sizeThresholds).where(eq(schema.sizeThresholds.boardId, boardId));
        return row === undefined ? DEFAULT_SIZE_THRESHOLD : { maxTasks: row.maxTasks, maxParts: row.maxParts };
      },
      setSizeThreshold: async (boardId, from, to) => {
        const s = schema.sizeThresholds;
        const values = { maxTasks: to.maxTasks, maxParts: to.maxParts };
        // A board with no row holds the default, so the insert is the first move; an existing row moves only from `from`.
        const [existing] = await t.select().from(s).where(eq(s.boardId, boardId));
        const held = existing === undefined ? DEFAULT_SIZE_THRESHOLD : { maxTasks: existing.maxTasks, maxParts: existing.maxParts };
        if (held.maxTasks !== from.maxTasks || held.maxParts !== from.maxParts) return false;
        const rows = await t
          .insert(s)
          .values({ boardId, ...values })
          .onConflictDoUpdate({ target: s.boardId, set: values, setWhere: and(eq(s.maxTasks, from.maxTasks), eq(s.maxParts, from.maxParts)) })
          .returning({ boardId: s.boardId });
        return rows.length === 1;
      },
      insertSizeThresholdChange: async (change) => {
        const { from, to, ...rest } = change;
        const rows = await t
          .insert(schema.sizeThresholdChanges)
          .values({ ...rest, at: new Date(change.at), fromTasks: from.maxTasks, toTasks: to.maxTasks, fromParts: from.maxParts, toParts: to.maxParts })
          .onConflictDoNothing()
          .returning({ id: schema.sizeThresholdChanges.id });
        return rows.length === 1;
      },
      listSizeThresholdChanges: async (boardId) =>
        (
          await t
            .select()
            .from(schema.sizeThresholdChanges)
            .where(eq(schema.sizeThresholdChanges.boardId, boardId))
            .orderBy(desc(schema.sizeThresholdChanges.at), desc(schema.sizeThresholdChanges.id))
        ).map(toSizeThresholdChange),
      getSizeCalibration: async (boardId) => {
        const [row] = await t.select().from(schema.sizeCalibrations).where(eq(schema.sizeCalibrations.boardId, boardId));
        return row === undefined ? DEFAULT_SIZE_CALIBRATION : row.state;
      },
      setSizeCalibration: async (boardId, calibration) => {
        const c = schema.sizeCalibrations;
        await t.insert(c).values({ boardId, state: calibration }).onConflictDoUpdate({ target: c.boardId, set: { state: calibration } });
      },
      insertSizeCalibrationChange: async (change) => {
        const rows = await t
          .insert(schema.sizeCalibrationChanges)
          .values({ ...change, at: new Date(change.at) })
          .onConflictDoNothing()
          .returning({ id: schema.sizeCalibrationChanges.id });
        return rows.length === 1;
      },
      listSizeCalibrationChanges: async (boardId) =>
        (
          await t
            .select()
            .from(schema.sizeCalibrationChanges)
            .where(eq(schema.sizeCalibrationChanges.boardId, boardId))
            .orderBy(desc(schema.sizeCalibrationChanges.at), desc(schema.sizeCalibrationChanges.id))
        ).map(toSizeCalibrationChange),
      getSizeRecord: async (globId) => {
        const [row] = await t.select().from(schema.globSizeRecords).where(eq(schema.globSizeRecords.globId, globId));
        return row === undefined ? null : toSizeRecord(row);
      },
      upsertSizeRecord: async (record) => {
        const r = schema.globSizeRecords;
        const { globId, recordedAt, ...rest } = record;
        const values = { ...rest, recordedAt: new Date(recordedAt) };
        await t.insert(r).values({ globId, ...values }).onConflictDoUpdate({ target: r.globId, set: values });
      },
      listSizeRecords: async (boardId) =>
        (await t.select().from(schema.globSizeRecords).where(eq(schema.globSizeRecords.boardId, boardId))).map(toSizeRecord),
      setBaseChecks: async (boardId, baseChecks) => {
        await t.update(schema.boards).set({ baseChecks }).where(eq(schema.boards.id, boardId));
      },
      getNotification: async (id) => {
        const [row] = await t.select().from(schema.boardNotifications).where(eq(schema.boardNotifications.id, id));
        return row === undefined ? null : toNotification(row);
      },
      saveNotification: async (n) => {
        const values = { ...n, since: new Date(n.since) };
        await t.insert(schema.boardNotifications).values(values).onConflictDoUpdate({ target: schema.boardNotifications.id, set: values });
      },
      deleteNotification: async (id) =>
        (await t.delete(schema.boardNotifications).where(eq(schema.boardNotifications.id, id)).returning({ id: schema.boardNotifications.id })).length > 0,
      listNotifications: async (boardId) =>
        (
          await t
            .select()
            .from(schema.boardNotifications)
            .where(or(eq(schema.boardNotifications.boardId, boardId), isNull(schema.boardNotifications.boardId)))
        ).map(toNotification),
      listAllBoards: async () => (await t.select().from(schema.boards).orderBy(schema.boards.id)).map(toBoard),
      listBoards: async (email) => {
        const rows = await t
          .select({ board: schema.boards })
          .from(schema.boards)
          .innerJoin(schema.members, eq(schema.members.boardId, schema.boards.id))
          .where(eq(schema.members.email, email))
          .orderBy(schema.boards.id);
        return rows.map((r) => toBoard(r.board));
      },

      getMember: async (boardId, email) => {
        const [row] = await t
          .select()
          .from(schema.members)
          .where(and(eq(schema.members.boardId, boardId), eq(schema.members.email, email)));
        return row ?? null;
      },
      listMembers: async (boardId): Promise<Member[]> =>
        t.select().from(schema.members).where(eq(schema.members.boardId, boardId)).orderBy(schema.members.email),
      upsertMember: async (member) => {
        await t
          .insert(schema.members)
          .values(member)
          .onConflictDoUpdate({
            target: [schema.members.boardId, schema.members.email],
            set: { role: member.role },
          });
      },
      deleteMember: async (boardId, email) => {
        await t.delete(schema.members).where(and(eq(schema.members.boardId, boardId), eq(schema.members.email, email)));
      },
      lockBoardSessions: async (email) => {
        await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`board_sessions:${email}`}))`);
      },
      listBoardSessions: async (email) =>
        (
          await t
            .select({ boardId: schema.boardSessions.boardId, position: schema.boardSessions.position, lastViewedAt: schema.boardSessions.lastViewedAt })
            .from(schema.boardSessions)
            .where(eq(schema.boardSessions.email, email))
            .orderBy(schema.boardSessions.boardId)
        ).map((r) => ({ boardId: r.boardId, position: r.position, lastViewedAt: r.lastViewedAt?.toISOString() ?? null })),
      touchBoardSession: async (email, boardId, at) => {
        // Inserting for a non-member would break the foreign key, so only members' rows are written.
        if ((await t.select({ email: schema.members.email }).from(schema.members).where(and(eq(schema.members.boardId, boardId), eq(schema.members.email, email)))).length === 0) return;
        await t
          .insert(schema.boardSessions)
          .values({ email, boardId, lastViewedAt: new Date(at) })
          .onConflictDoUpdate({ target: [schema.boardSessions.email, schema.boardSessions.boardId], set: { lastViewedAt: new Date(at) } });
      },
      setBoardSessionPosition: async (email, boardId, position) => {
        await t
          .insert(schema.boardSessions)
          .values({ email, boardId, position })
          .onConflictDoUpdate({ target: [schema.boardSessions.email, schema.boardSessions.boardId], set: { position } });
      },

      getUser: async (email): Promise<User | null> => {
        const [row] = await t.select().from(schema.users).where(eq(schema.users.email, email));
        return row === undefined ? null : { email: row.email, name: row.name, active: row.active };
      },
      upsertUser: async (user) => {
        await t
          .insert(schema.users)
          .values(user)
          .onConflictDoUpdate({ target: schema.users.email, set: { name: user.name, active: user.active } });
      },

      listKnowledge: async (boardId, kinds) => {
        const conditions = [eq(schema.knowledge.boardId, boardId)];
        if (kinds !== undefined) conditions.push(inArray(schema.knowledge.kind, [...kinds]));
        const rows = await t.select().from(schema.knowledge).where(and(...conditions)).orderBy(asc(schema.knowledge.name));
        return rows.map(toKnowledge);
      },
      getKnowledge: async (boardId, kind, name) => {
        const [row] = await t
          .select()
          .from(schema.knowledge)
          .where(and(eq(schema.knowledge.boardId, boardId), eq(schema.knowledge.kind, kind), eq(schema.knowledge.name, name)));
        return row === undefined ? null : toKnowledge(row);
      },
      getKnowledgeVersion: async (boardId, kind, name, version) => {
        const [row] = await t
          .select()
          .from(schema.knowledgeHistory)
          .where(
            and(
              eq(schema.knowledgeHistory.boardId, boardId),
              eq(schema.knowledgeHistory.kind, kind),
              eq(schema.knowledgeHistory.name, name),
              eq(schema.knowledgeHistory.version, version),
            ),
          );
        return row === undefined ? null : toKnowledge(row);
      },
      saveKnowledge: async (doc) => {
        const key = and(
          eq(schema.knowledge.boardId, doc.boardId),
          eq(schema.knowledge.kind, doc.kind),
          eq(schema.knowledge.name, doc.name),
        );
        const [previous] = await t.select().from(schema.knowledge).where(key);
        if (previous !== undefined) {
          const { boardId, kind, name, version, area, audience, description, content, layer, source, updatedBy, updatedAt } = previous;
          await t
            .insert(schema.knowledgeHistory)
            .values({ boardId, kind, name, version, area, audience, description, content, layer, source, updatedBy, updatedAt });
        }
        const values = { ...doc, audience: [...doc.audience], updatedAt: new Date(doc.updatedAt) };
        await t
          .insert(schema.knowledge)
          .values(values)
          .onConflictDoUpdate({ target: [schema.knowledge.boardId, schema.knowledge.kind, schema.knowledge.name], set: values });
      },
      deleteKnowledge: async (boardId, kind, name) => {
        await t
          .delete(schema.knowledge)
          .where(and(eq(schema.knowledge.boardId, boardId), eq(schema.knowledge.kind, kind), eq(schema.knowledge.name, name)));
      },

      insertArtifact: async (input) => {
        // Serialise versions per glob so concurrent writers get distinct numbers.
        await t.execute(sql`select pg_advisory_xact_lock(hashtext(${input.globId}))`);
        const [last] = await t
          .select({ version: schema.artifacts.version })
          .from(schema.artifacts)
          .where(and(eq(schema.artifacts.globId, input.globId), eq(schema.artifacts.kind, input.kind), eq(schema.artifacts.label, input.label)))
          .orderBy(desc(schema.artifacts.version))
          .limit(1);
        const [row] = await t
          .insert(schema.artifacts)
          .values({ ...input, version: (last?.version ?? 0) + 1, createdAt: new Date(input.createdAt) })
          .returning();
        if (row === undefined) throw new Error('Artifact insert returned nothing');
        return toArtifact(row);
      },
      listArtifacts: async (globId, kind) => {
        const conditions = [eq(schema.artifacts.globId, globId)];
        if (kind !== undefined) conditions.push(eq(schema.artifacts.kind, kind));
        const rows = await t
          .selectDistinctOn([schema.artifacts.kind, schema.artifacts.label])
          .from(schema.artifacts)
          .where(and(...conditions))
          .orderBy(schema.artifacts.kind, schema.artifacts.label, desc(schema.artifacts.version));
        return rows.map(toArtifact).filter((a) => !isClearedAttachment(a)).sort((a, b) => b.id - a.id);
      },
      lockGlobArtifacts: async (globId) => {
        await t.execute(sql`select pg_advisory_xact_lock(hashtext(${globId}))`);
      },
      findFileArtifact: async (key) => {
        const [row] = await t
          .select()
          .from(schema.artifacts)
          .where(and(sql`${schema.artifacts.file}->>'key' = ${key}`, latestVersion(schema.artifacts)));
        return row === undefined ? null : toArtifact(row);
      },
      listPendingFileArtifacts: async (globId) => {
        const a = schema.artifacts;
        const rows = await t
          .select()
          .from(a)
          .where(and(sql`${a.file}->>'state' = 'pending'`, latestVersion(a), globId === undefined ? undefined : eq(a.globId, globId)))
          .orderBy(asc(a.id));
        return rows.map(toArtifact);
      },
      artifactVersions: async (globId, kind, label) => {
        const rows = await t
          .select()
          .from(schema.artifacts)
          .where(and(eq(schema.artifacts.globId, globId), eq(schema.artifacts.kind, kind), eq(schema.artifacts.label, label)))
          .orderBy(asc(schema.artifacts.version));
        return rows.map(toArtifact);
      },
      listArtifactSummaries: async (boardId, globIds) => {
        if (globIds.length === 0) return [];
        const a = schema.artifacts;
        const conditions = [eq(schema.globs.boardId, boardId), inArray(a.globId, [...globIds])];
        // The latest version of each (glob, kind, label), with the count of all versions; no content.
        const rows = await t
          .selectDistinctOn([a.globId, a.kind, a.label], {
            globId: a.globId,
            kind: a.kind,
            label: a.label,
            version: a.version,
            versions: sql<number>`count(*) over (partition by ${a.globId}, ${a.kind}, ${a.label})`.mapWith(Number),
            commitSha: a.commitSha,
            createdAt: a.createdAt,
            provenance: a.provenance,
            content: a.content,
            link: a.link,
            file: a.file,
          })
          .from(a)
          .innerJoin(schema.globs, eq(schema.globs.id, a.globId))
          .where(and(...conditions))
          .orderBy(a.globId, a.kind, a.label, desc(a.version));
        return rows.filter((row) => !isClearedAttachment(row)).map(
          (row): ArtifactSummary => ({
            globId: row.globId,
            kind: oneOf(ARTIFACT_KINDS, row.kind),
            label: row.label,
            version: row.version,
            versions: row.versions,
            commitSha: row.commitSha,
            createdAt: row.createdAt.toISOString(),
            by: row.provenance.by,
            actor: row.provenance.actor,
            ...(row.provenance.independentReview === undefined ? {} : { review: row.provenance.independentReview }),
            ...(row.file === null ? {} : { file: fileFactsOf(row.file) }),
          }),
        );
      },

      latestArtifacts: async (globIds, kinds) => {
        if (globIds.length === 0 || kinds.length === 0) return [];
        const a = schema.artifacts;
        const rows = await t
          .selectDistinctOn([a.globId, a.kind, a.label])
          .from(a)
          .where(and(inArray(a.globId, [...globIds]), inArray(a.kind, [...kinds])))
          .orderBy(a.globId, a.kind, a.label, desc(a.version));
        return rows.map(toArtifact);
      },
      latestOutboxJobs: async (globIds, kinds) => {
        if (globIds.length === 0 || kinds.length === 0) return [];
        const o = schema.outbox;
        const rows = await t
          .selectDistinctOn([o.globId, o.kind], { id: o.id, effect: o.effect, state: o.state, attempts: o.attempts, lastError: o.lastError, runAfter: o.runAfter })
          .from(o)
          .where(and(inArray(o.globId, [...globIds]), inArray(o.kind, [...kinds])))
          .orderBy(o.globId, o.kind, desc(o.id));
        return rows.map(
          (row): OutboxJob => ({
            id: row.id,
            globId: row.effect.globId,
            kind: row.effect.kind,
            state: row.state,
            attempts: row.attempts,
            lastError: row.lastError,
            runAfter: row.runAfter.toISOString(),
          }),
        );
      },

      listHumanSteps: async (boardId, globIds) => {
        if (globIds.length === 0) return [];
        const h = schema.humanSteps;
        const rows = await t
          .select()
          .from(h)
          .where(and(eq(h.boardId, boardId), inArray(h.globId, [...globIds])))
          .orderBy(h.createdAt, h.id);
        return rows.map(toHumanStep);
      },
      listOpenHumanSteps: async (boardId) => {
        const h = schema.humanSteps;
        const rows = await t.select().from(h).where(and(eq(h.boardId, boardId), eq(h.state, 'open'))).orderBy(h.createdAt, h.id);
        return rows.map(toHumanStep);
      },
      saveHumanSteps: async (steps) => {
        for (const step of steps) {
          const row = humanStepRow(step);
          await t.insert(schema.humanSteps).values(row).onConflictDoUpdate({ target: schema.humanSteps.id, set: row });
        }
      },
      listRelations: async (boardId) =>
        (await t.select().from(schema.relations).where(eq(schema.relations.boardId, boardId)).orderBy(schema.relations.createdAt, schema.relations.id)).map(toRelation),
      listRelationsFrom: async (globIds) => {
        if (globIds.length === 0) return [];
        // One JSON parameter, not one per ID: a long list would pass Postgres's parameter limit.
        const r = schema.relations;
        const rows = await t
          .select()
          .from(r)
          .where(sql`${r.fromGlob} in (select jsonb_array_elements_text(${JSON.stringify(globIds)}::jsonb))`)
          .orderBy(r.createdAt, r.id);
        return rows.map(toRelation);
      },
      listRelationsTo: async (globIds) => {
        if (globIds.length === 0) return [];
        const r = schema.relations;
        const rows = await t
          .select()
          .from(r)
          .where(sql`${r.toGlob} in (select jsonb_array_elements_text(${JSON.stringify(globIds)}::jsonb))`)
          .orderBy(r.createdAt, r.id);
        return rows.map(toRelation);
      },
      insertRelation: async (relation) => {
        const rows = await t.insert(schema.relations).values(relationRow(relation)).onConflictDoNothing().returning({ id: schema.relations.id });
        return rows.length === 1;
      },
      updateRelation: async (id, patch: RelationPatch) => {
        const set: Partial<typeof schema.relations.$inferInsert> = {};
        if (patch.until !== undefined) set.until = patch.until;
        if (patch.reason !== undefined) set.reason = patch.reason;
        if (patch.evidence !== undefined) set.evidence = patch.evidence;
        if (patch.dismissedAt !== undefined) set.dismissedAt = patch.dismissedAt === null ? null : new Date(patch.dismissedAt);
        if (patch.dismissedPlanHash !== undefined) set.dismissedPlanHash = patch.dismissedPlanHash;
        if (patch.overriddenAt !== undefined) set.overriddenAt = patch.overriddenAt === null ? null : new Date(patch.overriddenAt);
        if (Object.keys(set).length > 0) await t.update(schema.relations).set(set).where(eq(schema.relations.id, id));
      },
      deleteRelation: async (id) => {
        await t.delete(schema.relations).where(eq(schema.relations.id, id));
      },
      deleteRelationsFrom: async (globId) => {
        await t.delete(schema.relations).where(eq(schema.relations.fromGlob, globId));
      },
      lockBoardRelations: async (boardId) => {
        await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`board_relations:${boardId}`}))`);
      },
      listStatusDismissals: async (email, boardId) => {
        const d = schema.statusDismissals;
        return t
          .select({ globId: d.globId, key: d.key })
          .from(d)
          .innerJoin(schema.globs, eq(schema.globs.id, d.globId))
          .where(and(eq(d.userEmail, email), eq(schema.globs.boardId, boardId)))
          .orderBy(d.at, d.key);
      },
      addStatusDismissal: async (email, globId, key, at) => {
        await t.insert(schema.statusDismissals).values({ userEmail: email, globId, key, at: new Date(at) }).onConflictDoNothing();
      },
      removeStatusDismissal: async (email, globId, key) => {
        const d = schema.statusDismissals;
        await t.delete(d).where(and(eq(d.userEmail, email), eq(d.globId, globId), eq(d.key, key)));
      },
      getDeploy: async (id) => {
        const [row] = await t.select().from(schema.deploys).where(eq(schema.deploys.id, id));
        return row === undefined ? null : toDeploy(row);
      },
      saveDeploys: async (deploys) => {
        // Sequential: a transaction holds a single connection.
        for (const d of deploys) {
          const row = deployRow(d);
          await t.insert(schema.deploys).values(row).onConflictDoUpdate({ target: schema.deploys.id, set: row });
        }
      },
      listDeploys: async (boardId, filter) => {
        const conditions = [eq(schema.deploys.boardId, boardId)];
        if (filter.environment !== undefined) conditions.push(eq(schema.deploys.environment, filter.environment));
        if (filter.states !== undefined) conditions.push(inArray(schema.deploys.state, [...filter.states]));
        if (filter.globIds !== undefined) {
          if (filter.globIds.length === 0) return [];
          conditions.push(inArray(schema.deploys.globId, [...filter.globIds]));
        }
        const query = t
          .select()
          .from(schema.deploys)
          .where(and(...conditions))
          .orderBy(desc(schema.deploys.requestedAt), desc(schema.deploys.id));
        const rows = filter.limit === undefined ? await query : await query.limit(filter.limit);
        return rows.map(toDeploy);
      },
      latestDeploys: async (boardId, globIds) => {
        if (globIds.length === 0) return [];
        const rows = await t
          .selectDistinctOn([schema.deploys.globId])
          .from(schema.deploys)
          .where(and(eq(schema.deploys.boardId, boardId), inArray(schema.deploys.globId, [...globIds])))
          .orderBy(schema.deploys.globId, desc(schema.deploys.requestedAt), desc(schema.deploys.id));
        return rows.map(toDeploy);
      },
      lockDeployQueue: async (boardId, environment) => {
        await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`deploys:${String(boardId)}:${environment}`}))`);
      },
      findDeployByProviderRef: async (providerRef) => {
        const [row] = await t.select().from(schema.deploys).where(eq(schema.deploys.providerRef, providerRef));
        return row === undefined ? null : toDeploy(row);
      },

      insertEnvironmentDeploy: async (deploy) => {
        const rows = await t
          .insert(schema.environmentDeploys)
          .values({ ...deploy, at: new Date(deploy.at) })
          .onConflictDoNothing()
          .returning({ id: schema.environmentDeploys.id });
        return rows.length === 1;
      },
      latestEnvironmentDeploy: async (boardId, environment) => {
        const d = schema.environmentDeploys;
        const [row] = await t
          .select()
          .from(d)
          .where(and(eq(d.boardId, boardId), eq(d.environment, environment), eq(d.succeeded, true)))
          .orderBy(desc(d.at), desc(d.id))
          .limit(1);
        return row === undefined ? null : toEnvironmentDeploy(row);
      },
      listGlobPresence: async (boardId, filter) => {
        const g = schema.globEnvironments;
        const conditions = [eq(g.boardId, boardId)];
        if (filter.environment !== undefined) conditions.push(eq(g.environment, filter.environment));
        if (filter.contained !== undefined) conditions.push(eq(g.contained, filter.contained));
        if (filter.globIds !== undefined) {
          if (filter.globIds.length === 0) return [];
          conditions.push(inArray(g.globId, [...filter.globIds]));
        }
        const rows = await t.select().from(g).where(and(...conditions)).orderBy(g.globId, g.environment);
        return rows.map(toPresence);
      },
      saveGlobPresence: async (rows) => {
        const g = schema.globEnvironments;
        // One statement; a key given twice keeps its last row (one upsert can't touch a row twice).
        const byKey = new Map(rows.map((p) => [`${p.globId}:${p.environment}`, presenceRow(p)]));
        if (byKey.size === 0) return;
        await t
          .insert(g)
          .values([...byKey.values()])
          .onConflictDoUpdate({
            target: [g.globId, g.environment],
            set: {
              boardId: sql`excluded.board_id`,
              mergeSha: sql`excluded.merge_sha`,
              contained: sql`excluded.contained`,
              checkedSha: sql`excluded.checked_sha`,
              checkedAt: sql`excluded.checked_at`,
              since: sql`excluded.since`,
            },
          });
      },
      lockEnvironment: async (boardId, environment) => {
        await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`environments:${String(boardId)}:${environment}`}))`);
      },
      insertTestRun: async (run) => {
        const rows = await t
          .insert(schema.testRuns)
          .values({ ...run, finishedAt: new Date(run.finishedAt) })
          .onConflictDoNothing()
          .returning({ id: schema.testRuns.id });
        return rows.length === 1;
      },
      listTestRuns: async (boardId, filter) => {
        const r = schema.testRuns;
        const matches = [];
        if (filter.globIds !== undefined && filter.globIds.length > 0) matches.push(inArray(r.globId, [...filter.globIds]));
        for (const c of filter.commits ?? []) {
          // Either side may be a short SHA (lower-cased on the way in).
          matches.push(
            and(
              isNull(r.globId),
              eq(r.environment, c.environment),
              sql`(starts_with(${r.sha}, ${c.sha}) or starts_with(${c.sha}, ${r.sha}))`,
            ),
          );
        }
        if (matches.length === 0) return [];
        const rows = await t
          .select()
          .from(r)
          .where(and(eq(r.boardId, boardId), or(...matches)))
          .orderBy(desc(r.finishedAt), desc(r.id));
        return rows.map(toTestRun);
      },

      insertReviewSource: async (input) => {
        const rows = await t
          .insert(schema.reviewSources)
          .values({ ...input, createdAt: new Date(input.createdAt) })
          .onConflictDoNothing()
          .returning();
        const [row] = rows;
        return row === undefined ? null : toReviewSource(row);
      },
      getReviewSource: async (id) => {
        const [row] = await t.select().from(schema.reviewSources).where(eq(schema.reviewSources.id, id));
        return row === undefined ? null : toReviewSource(row);
      },
      listReviewSources: async (globId) => {
        const rows = await t
          .select()
          .from(schema.reviewSources)
          .where(eq(schema.reviewSources.globId, globId))
          .orderBy(asc(schema.reviewSources.createdAt), asc(schema.reviewSources.id));
        return rows.map(toReviewSource);
      },
      nextReviewSourceToSplit: async (now) => {
        const r = schema.reviewSources;
        const [row] = await t
          .select()
          .from(r)
          .where(and(eq(r.state, 'pending'), or(isNull(r.processAfter), lte(r.processAfter, new Date(now)))))
          .orderBy(asc(r.createdAt), asc(r.id))
          .limit(1);
        return row === undefined ? null : toReviewSource(row);
      },
      updateReviewSource: async (source, expectedVersion) => {
        const rows = await t
          .update(schema.reviewSources)
          .set({
            state: source.state,
            attempts: source.attempts,
            processAfter: source.processAfter === null ? null : new Date(source.processAfter),
            error: source.error,
            version: source.version,
          })
          .where(and(eq(schema.reviewSources.id, source.id), eq(schema.reviewSources.version, expectedVersion)))
          .returning({ id: schema.reviewSources.id });
        return rows.length === 1;
      },
      getArtifact: async (id) => {
        const [row] = await t.select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
        return row === undefined ? null : toArtifact(row);
      },
      insertFindings: async (findings, createdAt) => {
        if (findings.length === 0) return 0;
        const rows = await t
          .insert(schema.reviewFindings)
          .values(findings.map((f) => ({ ...f, createdAt: new Date(createdAt) })))
          .onConflictDoNothing({
            target: [schema.reviewFindings.globId, schema.reviewFindings.source, schema.reviewFindings.fingerprint],
          })
          .returning({ id: schema.reviewFindings.id });
        return rows.length;
      },
      getFinding: async (id) => {
        const [row] = await t.select().from(schema.reviewFindings).where(eq(schema.reviewFindings.id, id));
        return row === undefined ? null : toFinding(row);
      },
      nextFindingToClassify: async (now) => {
        const f = schema.reviewFindings;
        const [row] = await t
          .select()
          .from(f)
          .where(and(eq(f.state, 'pending'), or(isNull(f.processAfter), lte(f.processAfter, new Date(now)))))
          .orderBy(asc(f.createdAt), asc(f.id))
          .limit(1);
        return row === undefined ? null : toFinding(row);
      },
      updateFinding: async (finding, expectedVersion) => {
        const rows = await t
          .update(schema.reviewFindings)
          .set({
            class: finding.class,
            classNote: finding.classNote,
            state: finding.state,
            attempts: finding.attempts,
            processAfter: finding.processAfter === null ? null : new Date(finding.processAfter),
            error: finding.error,
            classifiedAt: finding.classifiedAt === null ? null : new Date(finding.classifiedAt),
            version: finding.version,
          })
          .where(and(eq(schema.reviewFindings.id, finding.id), eq(schema.reviewFindings.version, expectedVersion)))
          .returning({ id: schema.reviewFindings.id });
        return rows.length === 1;
      },
      listFindings: async (globId) => {
        const rows = await t
          .select()
          .from(schema.reviewFindings)
          .where(eq(schema.reviewFindings.globId, globId))
          .orderBy(asc(schema.reviewFindings.createdAt), asc(schema.reviewFindings.id));
        return rows.map(toFinding);
      },
      listBoardFindings: async (boardId, since, until) => {
        const f = schema.reviewFindings;
        const r = schema.reviewSources;
        // Windowed by the review's time: a backfill or a delayed split creates findings long after it.
        const rows = await t
          .select({ finding: f })
          .from(f)
          .innerJoin(r, eq(r.id, f.sourceId))
          .where(and(eq(f.boardId, boardId), gte(r.createdAt, new Date(since)), lte(r.createdAt, new Date(until))))
          .orderBy(asc(r.createdAt), asc(f.id));
        return rows.map((row) => toFinding(row.finding));
      },

      listBoardEvents: async (boardId, since, types, globIds) => {
        const e = schema.events;
        const conditions = [eq(schema.globs.boardId, boardId), gte(e.at, new Date(since))];
        if (types !== undefined) {
          if (types.length === 0) return [];
          conditions.push(inArray(e.type, [...types]));
        }
        if (globIds !== undefined) {
          if (globIds.length === 0) return [];
          conditions.push(inArray(e.globId, [...globIds]));
        }
        const rows = await t
          .select({ globId: e.globId, type: e.type, actor: e.actor, at: e.at, data: e.data })
          .from(e)
          .innerJoin(schema.globs, eq(schema.globs.id, e.globId))
          .where(and(...conditions))
          .orderBy(asc(e.at), asc(e.id));
        // An event type this code doesn't know (written by newer code) is left out rather than failing the read.
        return rows.flatMap((row): DomainEvent[] => {
          const type = DOMAIN_EVENT_TYPES.find((known) => known === row.type);
          return type === undefined ? [] : [{ type, globId: row.globId, actor: row.actor, at: row.at.toISOString(), data: row.data }];
        });
      },
      listEventsUntil: async (until, types, dataKeys) => {
        if (types.length === 0) return [];
        const e = schema.events;
        // Only the data keys the caller reads leave the database: payloads such as a glob's whole creation record stay behind.
        const keys = sql.join(dataKeys.map((k) => sql`${k}`), sql`, `);
        const data =
          dataKeys.length === 0
            ? sql<DomainEvent['data']>`'{}'::jsonb`.mapWith(e.data)
            : sql<DomainEvent['data']>`(select coalesce(jsonb_object_agg(k, ${e.data} -> k), '{}'::jsonb) from unnest(array[${keys}]::text[]) as k where ${e.data} -> k is not null)`.mapWith(e.data);
        const rows = await t
          .select({ globId: e.globId, type: e.type, actor: e.actor, at: e.at, data })
          .from(e)
          .where(and(inArray(e.type, [...types]), lt(e.at, new Date(until))))
          .orderBy(asc(e.at), asc(e.id));
        return rows.flatMap((row): DomainEvent[] => {
          const type = DOMAIN_EVENT_TYPES.find((known) => known === row.type);
          return type === undefined ? [] : [{ type, globId: row.globId, actor: row.actor, at: row.at.toISOString(), data: row.data }];
        });
      },
      listArtifactMeta: async (boardId, kinds, since) => {
        if (kinds.length === 0) return [];
        const a = schema.artifacts;
        const withContent = sql.join(ARTIFACT_KINDS_WITH_CONTENT.map((k) => sql`${k}`), sql`, `);
        const rows = await t
          .select({
            id: a.id,
            globId: a.globId,
            kind: a.kind,
            label: a.label,
            version: a.version,
            commitSha: a.commitSha,
            provenance: a.provenance,
            createdAt: a.createdAt,
            content: sql<string | null>`case when ${a.kind} in (${withContent}) then ${a.content} end`,
          })
          .from(a)
          .innerJoin(schema.globs, eq(schema.globs.id, a.globId))
          .where(and(eq(schema.globs.boardId, boardId), inArray(a.kind, [...kinds]), gte(a.createdAt, new Date(since))))
          .orderBy(asc(a.createdAt), asc(a.id));
        return rows.map((row): ArtifactMeta => ({ ...row, kind: oneOf(ARTIFACT_KINDS, row.kind), createdAt: row.createdAt.toISOString() }));
      },
      listKbSignals: async (boardId) =>
        (await t.select().from(schema.kbSignals).where(eq(schema.kbSignals.boardId, boardId)).orderBy(asc(schema.kbSignals.key))).map(toKbSignal),
      upsertKbSignal: async (state) => {
        const columns = {
          itemId: state.itemId,
          lastFigures: state.lastFigures,
          lastMeasuredAt: state.lastMeasuredAt === null ? null : new Date(state.lastMeasuredAt),
          raisedAt: state.raisedAt === null ? null : new Date(state.raisedAt),
          belowThresholdRuns: state.belowThresholdRuns,
        };
        await t
          .insert(schema.kbSignals)
          .values({ boardId: state.boardId, key: state.key, ...columns })
          .onConflictDoUpdate({ target: [schema.kbSignals.boardId, schema.kbSignals.key], set: columns });
      },
      recordChoiceUsage: async (boardId, itemIds, globId, day) => {
        if (itemIds.length === 0) return;
        const u = schema.choiceUsage;
        const d = schema.decisions;
        // Items that aren't choices have no decisions row and drop out of the join.
        const choices = await t
          .select({ id: d.id })
          .from(d)
          .where(and(eq(d.boardId, boardId), inArray(d.itemId, [...itemIds])));
        if (choices.length === 0) return;
        await t
          .insert(u)
          .values(choices.map((c) => ({ boardId, decisionId: c.id, day, globId: globId ?? NO_GLOB, count: 1 })))
          .onConflictDoUpdate({ target: [u.decisionId, u.day, u.globId], set: { count: sql`${u.count} + 1` } });
      },
      listChoiceUsage: async (boardId, fromDay) => {
        const u = schema.choiceUsage;
        const rows = await t.select().from(u).where(and(eq(u.boardId, boardId), gte(u.day, fromDay)));
        return rows.map(({ decisionId, day, globId, count }) => ({ decisionId, day, globId, count }));
      },
      pruneChoiceUsage: async (boardId, beforeDay) => {
        const u = schema.choiceUsage;
        await t.delete(u).where(and(eq(u.boardId, boardId), lt(u.day, beforeDay)));
      },
      recordContextRetrievals: async (boardId, day, rows) => {
        if (rows.length === 0) return;
        const r = schema.contextRetrievals;
        // A fixed order, so two searches touching the same pairs take their row locks the same way and can't deadlock.
        const ordered = [...rows].sort((a, b) => a.sourceType.localeCompare(b.sourceType) || a.tier.localeCompare(b.tier));
        await t
          .insert(r)
          .values(ordered.map((row) => ({ boardId, day, sourceType: row.sourceType, tier: row.tier, count: row.count })))
          .onConflictDoUpdate({ target: [r.boardId, r.day, r.sourceType, r.tier], set: { count: sql`${r.count} + excluded.count` } });
      },
      listContextRetrievals: async (boardId, fromDay) => {
        const r = schema.contextRetrievals;
        const rows = await t.select().from(r).where(and(eq(r.boardId, boardId), gte(r.day, fromDay)));
        return rows.map(({ day, sourceType, tier, count }) => ({ day, sourceType, tier, count }));
      },
      pruneContextRetrievals: async (boardId, beforeDay) => {
        const r = schema.contextRetrievals;
        await t.delete(r).where(and(eq(r.boardId, boardId), lt(r.day, beforeDay)));
      },
      getContextSettings: async (boardId) => {
        const rows = await t.select().from(schema.contextSettings).where(eq(schema.contextSettings.boardId, boardId));
        return resolveContextSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
      },
      setContextSetting: async (boardId, key, value, at) => {
        const columns = { value, updatedAt: new Date(at) };
        await t
          .insert(schema.contextSettings)
          .values({ boardId, key, ...columns })
          .onConflictDoUpdate({ target: [schema.contextSettings.boardId, schema.contextSettings.key], set: columns });
      },
      resetContextSetting: async (boardId, key) => {
        await t.delete(schema.contextSettings).where(and(eq(schema.contextSettings.boardId, boardId), eq(schema.contextSettings.key, key)));
      },
      insertContextSettingChange: async (change) => {
        const [row] = await t
          .insert(schema.contextSettingChanges)
          .values({ ...change, at: new Date(change.at) })
          .returning();
        if (row === undefined) throw new Error('Context setting change was not stored');
        return toContextSettingChange(row);
      },
      listContextSettingChanges: async (boardId) =>
        (
          await t
            .select()
            .from(schema.contextSettingChanges)
            .where(eq(schema.contextSettingChanges.boardId, boardId))
            .orderBy(desc(schema.contextSettingChanges.at), desc(schema.contextSettingChanges.id))
        ).map(toContextSettingChange),
      getBoardJob: async (boardId, job) => {
        const [row] = await t
          .select()
          .from(schema.boardJobs)
          .where(and(eq(schema.boardJobs.boardId, boardId), eq(schema.boardJobs.job, job)));
        return row === undefined ? null : toBoardJob(row);
      },
      claimBoardJob: async (boardId, job, now, leaseMs) => {
        const j = schema.boardJobs;
        const until = new Date(Date.parse(now) + leaseMs);
        // Takes the lease only when nobody holds it: the conditional update returns nothing otherwise.
        const [row] = await t
          .insert(j)
          .values({ boardId, job, runningUntil: until })
          .onConflictDoUpdate({
            target: [j.boardId, j.job],
            set: { runningUntil: until },
            setWhere: or(isNull(j.runningUntil), lte(j.runningUntil, new Date(now))),
          })
          .returning();
        return row === undefined ? null : toBoardJob(row);
      },
      finishBoardJob: async (job, lease) => {
        const j = schema.boardJobs;
        // A run that outlived its lease leaves the next holder's lease and result alone.
        const rows = await t
          .update(j)
          .set({ lastRunAt: job.lastRunAt === null ? null : new Date(job.lastRunAt), lastResult: job.lastResult, runningUntil: null })
          .where(and(eq(j.boardId, job.boardId), eq(j.job, job.job), eq(j.runningUntil, new Date(lease))))
          .returning({ boardId: j.boardId });
        return rows.length > 0;
      },
      getBoardJobState: async (boardId, job) => {
        const [row] = await t
          .select({ state: schema.boardJobs.state })
          .from(schema.boardJobs)
          .where(and(eq(schema.boardJobs.boardId, boardId), eq(schema.boardJobs.job, job)));
        return row?.state ?? null;
      },
      setBoardJobState: async (boardId, job, state) => {
        const j = schema.boardJobs;
        await t
          .insert(j)
          .values({ boardId, job, state })
          .onConflictDoUpdate({ target: [j.boardId, j.job], set: { state } });
      },
      lockBoardJob: async (boardId, job) => {
        await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`board_jobs:${String(boardId)}:${job}`}))`);
      },

      itemHashes: async (boardId) => {
        const i = schema.knowledgeItems;
        const rows = await t.select({ ref: i.externalRef, hash: i.contentHash }).from(i).where(eq(i.boardId, boardId));
        return new Map(rows.map((r) => [r.ref, r.hash]));
      },
      replaceItem: async (item, chunks) => {
        const i = schema.knowledgeItems;
        // Two syncs of one item (the startup backfill and a dirty re-sync) take turns.
        await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`search_item:${String(item.boardId)}:${item.externalRef}`}))`);
        const columns = {
          sourceType: item.sourceType,
          title: item.title,
          occurredAt: new Date(item.occurredAt),
          authority: item.authority,
          status: item.status,
          supersededBy: item.supersededBy,
          globIds: [...item.globIds],
          globGroup: item.globGroup,
          externalUrl: item.externalUrl,
          contentHash: item.contentHash,
          state: item.state,
          attempts: 0,
          processAfter: null,
          lastError: null,
        };
        const [row] = await t
          .insert(i)
          .values({ boardId: item.boardId, externalRef: item.externalRef, ...columns })
          .onConflictDoUpdate({ target: [i.boardId, i.externalRef], set: columns })
          .returning({ id: i.id });
        if (row === undefined) throw new Error('Item upsert returned nothing');
        await t.delete(schema.chunks).where(eq(schema.chunks.itemId, row.id));
        if (chunks.length > 0) {
          await t
            .insert(schema.chunks)
            .values(chunks.map((c) => ({ itemId: row.id, boardId: item.boardId, position: c.position, header: c.header, text: c.text })));
        }
      },
      deleteItemsNotIn: async (boardId, sourceType, refs) => {
        const i = schema.knowledgeItems;
        const gone = await t
          .delete(i)
          .where(and(eq(i.boardId, boardId), eq(i.sourceType, sourceType), refs.size === 0 ? undefined : notInArray(i.externalRef, [...refs])))
          .returning({ id: i.id });
        return gone.length;
      },
      nextItemToSummarise: async (now) => {
        const i = schema.knowledgeItems;
        const [row] = await t
          .select()
          .from(i)
          .where(and(eq(i.state, 'pending_summary'), or(isNull(i.processAfter), lte(i.processAfter, new Date(now)))))
          .orderBy(asc(i.occurredAt), asc(i.id))
          .limit(1);
        return row === undefined ? null : toKnowledgeItem(row);
      },
      setItemProgress: async (id, progress) => {
        await t
          .update(schema.knowledgeItems)
          .set({
            attempts: progress.attempts,
            processAfter: progress.processAfter === null ? null : new Date(progress.processAfter),
            lastError: progress.lastError,
          })
          .where(eq(schema.knowledgeItems.id, id));
      },
      chunksToEmbed: async (limit) => {
        const c = schema.chunks;
        return t.select({ id: c.id, header: c.header, text: c.text }).from(c).where(isNull(c.embedding)).orderBy(asc(c.id)).limit(limit);
      },
      setEmbeddings: async (rows) => {
        for (const row of rows) {
          await t
            .update(schema.chunks)
            .set({ embedding: [...row.embedding], embeddedAt: sql`now()` })
            .where(eq(schema.chunks.id, row.id));
        }
      },
      keywordCandidates: async (q, limit) => {
        const { relevance, matches } = keywordMatch(q.query);
        const rows = await t
          .select(candidateColumns(relevance))
          .from(schema.chunks)
          .innerJoin(schema.knowledgeItems, eq(schema.knowledgeItems.id, schema.chunks.itemId))
          .leftJoin(supersededItems, eq(supersededItems.id, schema.knowledgeItems.supersededBy))
          .where(and(...searchFilters(q), matches))
          .orderBy(desc(relevance), asc(schema.chunks.id))
          .limit(limit);
        return rows.map(toCandidate);
      },
      vectorCandidates: async (q, embedding, limit) => {
        const c = schema.chunks;
        const distance = sql`${c.embedding} <=> ${vectorText(embedding)}::vector`;
        const rows = await t
          .select(candidateColumns(sql<number>`(1 - (${distance}))::float8`.mapWith(Number)))
          .from(c)
          .innerJoin(schema.knowledgeItems, eq(schema.knowledgeItems.id, c.itemId))
          .leftJoin(supersededItems, eq(supersededItems.id, schema.knowledgeItems.supersededBy))
          .where(and(...searchFilters(q), sql`${c.embedding} is not null`))
          .orderBy(distance, asc(c.id))
          .limit(limit);
        return rows.map(toCandidate);
      },
      changeCandidates: async (q, limit) => {
        const word = q.query.trim() === '' ? null : keywordMatch(q.query.trim());
        const rows = await t
          .select(candidateColumns(word === null ? sql<number>`1::float8`.mapWith(Number) : word.relevance))
          .from(schema.chunks)
          .innerJoin(schema.knowledgeItems, eq(schema.knowledgeItems.id, schema.chunks.itemId))
          .leftJoin(supersededItems, eq(supersededItems.id, schema.knowledgeItems.supersededBy))
          .where(and(...searchFilters({ ...q, sourceTypes: ['change_summary'] }), word === null ? undefined : word.matches))
          .orderBy(desc(schema.knowledgeItems.occurredAt), asc(schema.chunks.id))
          .limit(limit);
        return rows.map(toCandidate);
      },
      listLatestArtifacts: async (boardId) => {
        const a = schema.artifacts;
        const rows = await t
          .selectDistinctOn([a.globId, a.kind, a.label], getTableColumns(a))
          .from(a)
          .innerJoin(schema.globs, eq(schema.globs.id, a.globId))
          .where(eq(schema.globs.boardId, boardId))
          .orderBy(a.globId, a.kind, a.label, desc(a.version));
        return rows.map(toArtifact);
      },

      insertIntakeSnapshot: async (snapshot, embedding) => {
        const d = snapshot.decisions;
        const inserted = await t
          .insert(schema.intakeSnapshots)
          .values({
            globId: snapshot.globId,
            version: snapshot.version,
            boardId: snapshot.boardId,
            request: snapshot.request,
            title: snapshot.title,
            plan: snapshot.plan,
            creator: snapshot.creator,
            source: snapshot.source,
            type: d.type,
            category: d.category,
            groupName: d.group,
            environment: d.environment,
            categoryConfidence: d.categoryConfidence,
            reason: d.reason,
            model: d.model,
            promptVersion: d.promptVersion,
            features: snapshot.features,
            examples: [...snapshot.examples],
            backfilled: snapshot.backfilled,
            embedding: embedding === null ? null : [...embedding],
            createdAt: new Date(snapshot.createdAt),
          })
          .onConflictDoNothing()
          .returning({ globId: schema.intakeSnapshots.globId });
        return inserted.length > 0;
      },
      listLatestIntakeSnapshots: async (boardId) => {
        const n = schema.intakeSnapshots;
        const rows = await t
          .selectDistinctOn([n.globId], getTableColumns(n))
          .from(n)
          .where(eq(n.boardId, boardId))
          .orderBy(n.globId, desc(n.version));
        return rows.map(toIntakeSnapshot);
      },
      snapshotsToEmbed: async (boardId, limit) => {
        const n = schema.intakeSnapshots;
        return t
          .select({ globId: n.globId, version: n.version, request: n.request })
          .from(n)
          .where(and(eq(n.boardId, boardId), isNull(n.embedding)))
          .orderBy(asc(n.createdAt), asc(n.globId), asc(n.version))
          .limit(limit);
      },
      setSnapshotEmbedding: async (globId, version, embedding) => {
        const n = schema.intakeSnapshots;
        await t
          .update(n)
          .set({ embedding: [...embedding] })
          .where(and(eq(n.globId, globId), eq(n.version, version), isNull(n.embedding)));
      },
      nearestIntakeSnapshots: async (boardId, embedding, limit) => {
        const n = schema.intakeSnapshots;
        const distance = sql<number>`(${n.embedding} <=> ${vectorText(embedding)}::vector)::float8`.mapWith(Number);
        return t
          .select({ globId: n.globId, version: n.version, distance })
          .from(n)
          .where(and(eq(n.boardId, boardId), sql`${n.embedding} is not null`))
          .orderBy(distance, asc(n.globId))
          .limit(limit);
      },
      upsertGlobOutcome: async (outcome) => {
        const o = schema.globOutcomes;
        const values = {
          boardId: outcome.boardId,
          snapshotVersion: outcome.snapshotVersion,
          outcome,
          final: outcome.final,
          mergedAt: new Date(outcome.mergedAt),
          recordedAt: new Date(outcome.recordedAt),
        };
        await t.insert(o).values({ globId: outcome.globId, ...values }).onConflictDoUpdate({ target: o.globId, set: values });
      },
      listGlobOutcomes: async (boardId, globIds) => {
        if (globIds?.length === 0) return [];
        const o = schema.globOutcomes;
        const rows = await t
          .select({ outcome: o.outcome })
          .from(o)
          .where(globIds === undefined ? eq(o.boardId, boardId) : and(eq(o.boardId, boardId), inArray(o.globId, [...globIds])));
        return rows.map((r) => r.outcome);
      },
      listDecisions: async (boardId) => {
        const d = schema.decisions;
        const rows = await t.select().from(d).where(eq(d.boardId, boardId)).orderBy(asc(d.decidedAt), asc(d.id));
        return rows.map(toDecision);
      },
      getDecision: async (id) => {
        const [row] = await t.select().from(schema.decisions).where(eq(schema.decisions.id, id));
        return row === undefined ? null : toDecision(row);
      },
      upsertDecision: async (decision) => {
        const d = schema.decisions;
        const facts = {
          globId: decision.globId,
          globGroup: decision.group,
          statement: decision.statement,
          quote: decision.quote,
          decidedBy: decision.decidedBy,
          decidedAt: new Date(decision.decidedAt),
          sourceKind: decision.sourceKind,
          sourceRef: decision.sourceRef,
          sourceLabel: decision.sourceLabel,
          sourceUrl: decision.sourceUrl,
        };
        // A conflict updates the facts only: supersession state and check progress stay.
        const [row] = await t
          .insert(d)
          .values({ boardId: decision.boardId, itemId: decision.itemId, createdAt: new Date(decision.createdAt), ...facts })
          .onConflictDoUpdate({ target: d.itemId, set: facts })
          .returning();
        if (row === undefined) throw new Error('Decision upsert returned nothing');
        return toDecision(row);
      },
      updateDecision: async (id, patch) => {
        const set: Partial<typeof schema.decisions.$inferInsert> = {};
        if (patch.replacedBy !== undefined) set.replacedBy = patch.replacedBy;
        if (patch.replaceState !== undefined) set.replaceState = patch.replaceState;
        if (patch.replaceOldQuote !== undefined) set.replaceOldQuote = patch.replaceOldQuote;
        if (patch.replaceNewQuote !== undefined) set.replaceNewQuote = patch.replaceNewQuote;
        if (patch.replaceReason !== undefined) set.replaceReason = patch.replaceReason;
        if (patch.checkedAt !== undefined) set.checkedAt = patch.checkedAt === null ? null : new Date(patch.checkedAt);
        if (patch.attempts !== undefined) set.attempts = patch.attempts;
        if (patch.processAfter !== undefined) set.processAfter = patch.processAfter === null ? null : new Date(patch.processAfter);
        if (patch.lastError !== undefined) set.lastError = patch.lastError;
        if (Object.keys(set).length === 0) return;
        await t.update(schema.decisions).set(set).where(eq(schema.decisions.id, id));
      },
      deleteDecision: async (id) => {
        const [row] = await t.select({ itemId: schema.decisions.itemId }).from(schema.decisions).where(eq(schema.decisions.id, id));
        // The item's delete cascades to the decision row and the item's chunks.
        if (row !== undefined) await t.delete(schema.knowledgeItems).where(eq(schema.knowledgeItems.id, row.itemId));
      },
      nextDecisionToCheck: async (now) => {
        const d = schema.decisions;
        const [row] = await t
          .select()
          .from(d)
          .where(and(isNull(d.checkedAt), or(isNull(d.processAfter), lte(d.processAfter, new Date(now)))))
          .orderBy(asc(d.createdAt), asc(d.id))
          .limit(1);
        return row === undefined ? null : toDecision(row);
      },
      setItemSupersession: async (itemId, status, supersededBy) => {
        await t.update(schema.knowledgeItems).set({ status, supersededBy }).where(eq(schema.knowledgeItems.id, itemId));
      },
      getItemByRef: async (boardId, externalRef) => {
        const i = schema.knowledgeItems;
        const [row] = await t
          .select({ id: i.id, status: i.status, supersededBy: i.supersededBy, contentHash: i.contentHash })
          .from(i)
          .where(and(eq(i.boardId, boardId), eq(i.externalRef, externalRef)));
        return row ?? null;
      },
      getDecisionSource: async (boardId, sourceRef) => {
        const s = schema.decisionSources;
        const [row] = await t.select().from(s).where(and(eq(s.boardId, boardId), eq(s.sourceRef, sourceRef)));
        return row === undefined ? null : toDecisionSource(row);
      },
      listDecisionSources: async (boardId) => {
        const rows = await t.select().from(schema.decisionSources).where(eq(schema.decisionSources.boardId, boardId));
        return rows.map(toDecisionSource);
      },
      upsertDecisionSource: async (source) => {
        const s = schema.decisionSources;
        const columns = {
          contentHash: source.contentHash,
          state: source.state,
          attempts: source.attempts,
          processAfter: source.processAfter === null ? null : new Date(source.processAfter),
          lastError: source.lastError,
          globId: source.globId,
          updatedAt: new Date(source.updatedAt),
        };
        await t
          .insert(s)
          .values({ boardId: source.boardId, sourceRef: source.sourceRef, ...columns })
          .onConflictDoUpdate({ target: [s.boardId, s.sourceRef], set: columns });
      },
      deleteDecisionSource: async (boardId, sourceRef) => {
        const s = schema.decisionSources;
        await t.delete(s).where(and(eq(s.boardId, boardId), eq(s.sourceRef, sourceRef)));
      },
      nextDecisionSourceToExtract: async (now) => {
        const s = schema.decisionSources;
        const [row] = await t
          .select()
          .from(s)
          .where(and(eq(s.state, 'pending'), or(isNull(s.processAfter), lte(s.processAfter, new Date(now)))))
          .orderBy(asc(s.updatedAt), asc(s.sourceRef))
          .limit(1);
        return row === undefined ? null : toDecisionSource(row);
      },

      listChatMessages: async (chatId, limit) => {
        const m = schema.boardChatMessages;
        const rows = await t.select().from(m).where(eq(m.chatId, chatId)).orderBy(desc(m.id)).limit(limit);
        return rows.reverse().map(toChatMessage);
      },
      addChatMessage: async (message) => {
        const [row] = await t
          .insert(schema.boardChatMessages)
          .values({
            ...message,
            citations: message.citations === null ? null : [...message.citations],
            tools: message.tools == null ? null : [...message.tools],
            actions: message.actions == null ? null : [...message.actions],
            uncited: message.uncited === true,
            miss: message.miss === true,
            createdAt: new Date(message.createdAt),
          })
          .returning();
        if (row === undefined) throw new Error('chat message insert returned no row');
        return toChatMessage(row);
      },
      listChats: async (boardId, email, limit) => {
        const c = schema.boardChats;
        const rows = await t.select().from(c).where(and(eq(c.boardId, boardId), eq(c.email, email))).orderBy(desc(c.updatedAt), desc(c.id)).limit(limit);
        return rows.map(toChatThread);
      },
      getChat: async (chatId) => {
        const [row] = await t.select().from(schema.boardChats).where(eq(schema.boardChats.id, chatId));
        return row === undefined ? null : toChatThread(row);
      },
      createChat: async (chat) => {
        const [row] = await t
          .insert(schema.boardChats)
          .values({ ...chat, createdAt: new Date(chat.createdAt), updatedAt: new Date(chat.createdAt) })
          .returning();
        if (row === undefined) throw new Error('chat insert returned no row');
        return toChatThread(row);
      },
      touchChat: async (chatId, at) => {
        await t.update(schema.boardChats).set({ updatedAt: new Date(at) }).where(eq(schema.boardChats.id, chatId));
      },
      deleteChat: async (chatId) => {
        await t.delete(schema.boardChats).where(eq(schema.boardChats.id, chatId));
      },
      insertInboxItem: async (input) => {
        const n = schema.inboxItems;
        const [created] = await t
          .insert(n)
          .values({
            boardId: input.boardId,
            title: input.title,
            text: input.text,
            source: input.source,
            sourceRef: input.sourceRef,
            sourceLabel: input.sourceLabel,
            sourceType: input.sourceType,
            occurredAt: new Date(input.occurredAt),
            createdAt: new Date(input.createdAt),
            createdBy: input.createdBy,
            contentHash: input.contentHash,
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.state === undefined ? {} : { state: input.state }),
            updatedAt: new Date(input.createdAt),
          })
          .onConflictDoNothing()
          .returning();
        if (created !== undefined) return { item: toInboxItem(created), created: true };
        // The same source ref (an integration's delivery), or the same text, is in the inbox already (or a racing insert got there first).
        const [bySource] =
          input.sourceRef === ''
            ? []
            : await t.select().from(n).where(and(eq(n.boardId, input.boardId), eq(n.source, input.source), eq(n.sourceRef, input.sourceRef)));
        const [existing] =
          bySource !== undefined
            ? [bySource]
            : await t.select().from(n).where(and(eq(n.boardId, input.boardId), eq(n.contentHash, input.contentHash)));
        if (existing === undefined) throw new Error('Inbox item insert returned nothing');
        return { item: toInboxItem(existing), created: false };
      },
      getActiveIntegrationToken: async (boardId) => {
        const k = schema.integrationTokens;
        const [row] = await t.select().from(k).where(and(eq(k.boardId, boardId), isNull(k.revokedAt)));
        return row === undefined ? null : toIntegrationToken(row);
      },
      findIntegrationToken: async (tokenHash) => {
        const k = schema.integrationTokens;
        const [row] = await t.select().from(k).where(eq(k.tokenHash, tokenHash));
        return row === undefined ? null : toIntegrationToken(row);
      },
      insertIntegrationToken: async (token) => {
        await t.insert(schema.integrationTokens).values({
          boardId: token.boardId,
          tokenHash: token.tokenHash,
          createdAt: new Date(token.createdAt),
          createdBy: token.createdBy,
        });
      },
      revokeIntegrationTokens: async (boardId, at) => {
        const k = schema.integrationTokens;
        await t.update(k).set({ revokedAt: new Date(at) }).where(and(eq(k.boardId, boardId), isNull(k.revokedAt)));
      },
      getInboxItem: async (boardId, id) => {
        const n = schema.inboxItems;
        const [row] = await t.select().from(n).where(and(eq(n.boardId, boardId), eq(n.id, id)));
        return row === undefined ? null : toInboxItem(row);
      },
      getInboxItemBySource: async (boardId, source, sourceRef) => {
        const n = schema.inboxItems;
        const [row] = await t.select().from(n).where(and(eq(n.boardId, boardId), eq(n.source, source), eq(n.sourceRef, sourceRef)));
        return row === undefined ? null : toInboxItem(row);
      },
      listInboxItems: async (boardId, statuses) => {
        const n = schema.inboxItems;
        const rows = await t
          .select()
          .from(n)
          .where(and(eq(n.boardId, boardId), statuses === undefined ? undefined : inArray(n.status, [...statuses])))
          .orderBy(desc(n.occurredAt), desc(n.id));
        return rows.map(toInboxItem);
      },
      updateInboxItem: async (item, expectedVersion) => {
        const n = schema.inboxItems;
        const rows = await t
          .update(n)
          .set({
            title: item.title,
            text: item.text,
            contentHash: item.contentHash,
            sourceLabel: item.sourceLabel,
            occurredAt: new Date(item.occurredAt),
            sourceType: item.sourceType,
            status: item.status,
            summary: item.summary,
            suggestions: [...item.suggestions],
            state: item.state,
            attempts: item.attempts,
            processAfter: item.processAfter === null ? null : new Date(item.processAfter),
            lastError: item.lastError,
            itemId: item.itemId,
            version: expectedVersion + 1,
            updatedAt: new Date(item.updatedAt),
          })
          .where(and(eq(n.id, item.id), eq(n.version, expectedVersion)))
          .returning({ id: n.id });
        return rows.length === 1;
      },
      nextInboxItemToProcess: async (now) => {
        const n = schema.inboxItems;
        const [row] = await t
          .select()
          .from(n)
          .where(and(eq(n.state, 'pending'), ne(n.status, 'discarded'), or(isNull(n.processAfter), lte(n.processAfter, new Date(now)))))
          .orderBy(asc(n.createdAt), asc(n.id))
          .limit(1);
        return row === undefined ? null : toInboxItem(row);
      },
      insertInboxLink: async (link) => {
        const rows = await t
          .insert(schema.inboxLinks)
          .values({ ...link, linkedAt: new Date(link.linkedAt) })
          .onConflictDoNothing()
          .returning({ id: schema.inboxLinks.inboxId });
        return rows.length === 1;
      },
      deleteInboxLink: async (inboxId, globId) => {
        const l = schema.inboxLinks;
        const rows = await t.delete(l).where(and(eq(l.inboxId, inboxId), eq(l.globId, globId))).returning({ id: l.inboxId });
        return rows.length === 1;
      },
      listInboxLinks: async (boardId) => {
        const rows = await t
          .select({ link: getTableColumns(schema.inboxLinks) })
          .from(schema.inboxLinks)
          .innerJoin(schema.inboxItems, eq(schema.inboxItems.id, schema.inboxLinks.inboxId))
          .where(eq(schema.inboxItems.boardId, boardId))
          .orderBy(asc(schema.inboxLinks.linkedAt));
        return rows.map((r) => toInboxLink(r.link));
      },
      listInboxForGlob: async (globId) => {
        const rows = await t
          .select({ item: getTableColumns(schema.inboxItems) })
          .from(schema.inboxLinks)
          .innerJoin(schema.inboxItems, eq(schema.inboxItems.id, schema.inboxLinks.inboxId))
          .where(eq(schema.inboxLinks.globId, globId))
          .orderBy(asc(schema.inboxLinks.linkedAt));
        return rows.map((r) => toInboxItem(r.item));
      },
      setItemLinks: async (itemId, globIds, globGroup) => {
        await t.update(schema.knowledgeItems).set({ globIds: [...globIds], globGroup }).where(eq(schema.knowledgeItems.id, itemId));
      },
      deleteItemByRef: async (boardId, externalRef) => {
        const i = schema.knowledgeItems;
        // The item's delete cascades to its chunks, and sets the inbox row's item_id to null.
        await t.delete(i).where(and(eq(i.boardId, boardId), eq(i.externalRef, externalRef)));
      },

      appendEvents: async (events) => {
        if (events.length === 0) return;
        await t.insert(schema.events).values(
          events.map((e) => ({ globId: e.globId, type: e.type, actor: e.actor, at: new Date(e.at), data: e.data })),
        );
      },
      deleteEvents: async (globId) => {
        await t.delete(schema.events).where(eq(schema.events.globId, globId));
      },
      enqueueEffects: async (effects) => {
        if (effects.length === 0) return;
        const rows: (typeof schema.outbox.$inferInsert)[] = [];
        for (const effect of effects) {
          if (effect.kind === 'recheck_overlaps') {
            // One pending recheck per board (not yet claimed) is enough: it reads the board when it runs. A burst of
            // merges and pushes is delayed a few seconds so it runs once.
            const [pending] = await t
              .select({ id: schema.outbox.id })
              .from(schema.outbox)
              .where(sql`${schema.outbox.kind} = 'recheck_overlaps' and ${schema.outbox.globId} = ${effect.globId} and ${schema.outbox.state} = 'pending' and ${schema.outbox.attempts} = 0`)
              .limit(1);
            if (pending !== undefined || rows.some((r) => r.kind === 'recheck_overlaps' && r.globId === effect.globId)) continue;
            rows.push({ kind: effect.kind, lane: laneOf(effect.kind), globId: effect.globId, effect, runAfter: new Date(Date.now() + RECHECK_DELAY_MS) });
            continue;
          }
          if (effect.kind === 'commit_agent_set') {
            // One unclaimed commit job per board, and every bump pushes it out again: the commit follows the last bump of a batch.
            const jobs = schema.outbox;
            const runAfter = new Date(Date.now() + AGENT_SET_COMMIT_DELAY_MS);
            const updated = await t
              .update(jobs)
              .set({ runAfter })
              .where(and(eq(jobs.kind, effect.kind), eq(jobs.globId, effect.globId), eq(jobs.state, 'pending'), eq(jobs.attempts, 0)))
              .returning({ id: jobs.id });
            if (updated.length > 0 || rows.some((r) => r.kind === effect.kind && r.globId === effect.globId)) continue;
            rows.push({ kind: effect.kind, lane: laneOf(effect.kind), globId: effect.globId, effect, runAfter });
            continue;
          }
          if (effect.kind === 'regenerate_knowledge_page') {
            // One unclaimed regeneration per board: it reads the board when it runs. A waiting one (it asked to run later
            // for the minimum interval) stays unclaimed; a Rebuild upgrades it and makes it due now.
            const jobs = schema.outbox;
            const [pending] = await t
              .select({ id: jobs.id, full: sql<boolean>`coalesce(${jobs.effect}->>'full' = 'true', false)` })
              .from(jobs)
              .where(and(eq(jobs.kind, effect.kind), eq(jobs.globId, effect.globId), eq(jobs.state, 'pending'), eq(jobs.attempts, 0)))
              .limit(1);
            if (pending !== undefined) {
              if (effect.full === true && !pending.full) await t.update(jobs).set({ effect, runAfter: new Date() }).where(eq(jobs.id, pending.id));
              continue;
            }
            const queued = rows.findIndex((r) => r.kind === effect.kind && r.globId === effect.globId);
            if (queued >= 0) {
              if (effect.full === true) rows[queued] = { kind: effect.kind, lane: laneOf(effect.kind), globId: effect.globId, effect };
              continue;
            }
          }
          if (effect.kind === 'kb_route' || effect.kind === 'kb_draft' || effect.kind === 'suggest_decision' || effect.kind === 'write_rollout_steps') {
            // One unclaimed KB pipeline job per item and kind: it re-reads the item when it runs. A claimed one (running,
            // or backing off after a failure) gets a sibling: it may have committed its step before this change, and
            // would then finish without it.
            const [pending] = await t
              .select({ id: schema.outbox.id })
              .from(schema.outbox)
              .where(and(eq(schema.outbox.kind, effect.kind), eq(schema.outbox.globId, effect.globId), eq(schema.outbox.state, 'pending'), eq(schema.outbox.attempts, 0)))
              .limit(1);
            if (pending !== undefined || rows.some((r) => r.kind === effect.kind && r.globId === effect.globId)) continue;
          }
          // An on-demand review (it has a requestId) is always queued, and neither dedupes nor cancels the automatic ones.
          if (effect.kind === 'review_change' && effect.requestId === undefined) {
            // One review job per glob, stage and reviewed commit (a repeated webhook or reconcile queues none). A newer
            // pre-merge head cancels the jobs for older ones that haven't finished.
            const jobs = schema.outbox;
            const same = sql`${jobs.kind} = 'review_change' and ${jobs.globId} = ${effect.globId} and ${jobs.effect}->>'stage' = ${effect.stage} and ${jobs.effect}->>'requestId' is null`;
            const [existing] = await t
              .select({ id: jobs.id })
              .from(jobs)
              .where(sql`${same} and ${jobs.effect}->>'sha' = ${effect.sha} and ${jobs.state} in ('pending', 'done')`)
              .limit(1);
            if (existing !== undefined || rows.some((r) => r.effect.kind === 'review_change' && r.effect.requestId === undefined && r.globId === effect.globId && r.effect.stage === effect.stage && r.effect.sha === effect.sha)) continue;
            if (effect.stage === 'pre_merge') {
              await t
                .update(jobs)
                .set({ state: 'dropped', lastError: 'A newer commit replaced the reviewed head' })
                .where(sql`${same} and ${jobs.effect}->>'sha' <> ${effect.sha} and ${jobs.state} = 'pending'`);
            }
          }
          rows.push({ kind: effect.kind, lane: laneOf(effect.kind), globId: effect.globId, effect });
        }
        if (rows.length === 0) return;
        await t.insert(schema.outbox).values(rows);
        // Wake the job runner after commit.
        await t.execute(sql`select pg_notify('slop_outbox', '')`);
      },
    };
  }
}
