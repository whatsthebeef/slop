import type { BoardNotification, Artifact, ArtifactMeta, CodeReviewComment, ArtifactSummary, Board, BoardJob, Deploy, DomainEvent, EnvironmentDeploy, Glob, GlobPresence, GlobFilter, KbItem, KbSignalState, KnowledgeDoc, Member, ReviewFinding, ReviewSource, Store, SubLimitChange, TestRun, Tx, User } from '@slop/core';
import { NOTIFICATION_SEVERITIES, ARTIFACT_KINDS, ARTIFACT_KINDS_WITH_CONTENT, BOARD_JOBS, CODE_REVIEW_KINDS, DOMAIN_EVENT_TYPES, DEPLOY_STATES, DEPLOY_TRIGGERS, FINDING_CLASSES, FINDING_SEVERITIES, FINDING_SOURCES, FINDING_STATES, KB_ITEM_SOURCES, KB_ITEM_STATUSES, KB_PROCESSING_STATES, KB_STALE_REASONS, KNOWLEDGE_KINDS, KNOWLEDGE_LAYERS, LEARNING_TYPES, REVIEW_SOURCE_KINDS, REVIEW_SOURCE_STATES, SUB_LIMIT_OUTCOMES, TEST_RUN_KINDS } from '@slop/core';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase, PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
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
  effectCheckGlobs: row.effectCheckGlobs,
  deploy: row.deploy,
  readinessTicks: row.readinessTicks,
  baseChecks: row.baseChecks,
  version: row.version,
});

/** Narrows a stored string to one of a fixed set of values; a mismatch means a corrupt row. */
const oneOf = <T extends string>(values: readonly T[], value: string): T => {
  const found = values.find((v) => v === value);
  if (found === undefined) throw new Error(`Unexpected stored value: ${value}`);
  return found;
};

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

const toCodeReview = (row: typeof schema.codeReviewComments.$inferSelect): CodeReviewComment => ({
  id: row.id,
  boardId: row.boardId,
  globId: row.globId,
  prNumber: row.prNumber,
  externalId: row.externalId,
  kind: oneOf(CODE_REVIEW_KINDS, row.kind),
  author: row.author,
  commitSha: row.commitSha,
  path: row.path,
  line: row.line,
  body: row.body,
  url: row.url,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toKnowledge = (row: typeof schema.knowledge.$inferSelect): KnowledgeDoc => ({
  ...row,
  kind: oneOf(KNOWLEDGE_KINDS, row.kind),
  layer: oneOf(KNOWLEDGE_LAYERS, row.layer),
  updatedAt: row.updatedAt.toISOString(),
});

const toArtifact = (row: typeof schema.artifacts.$inferSelect): Artifact => ({
  ...row,
  kind: oneOf(ARTIFACT_KINDS, row.kind),
  createdAt: row.createdAt.toISOString(),
});

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

const toKbItem = (row: typeof schema.kbProposals.$inferSelect): KbItem => ({
  ...row,
  status: oneOf(KB_ITEM_STATUSES, row.status),
  type: oneOf(LEARNING_TYPES, row.type),
  source: oneOf(KB_ITEM_SOURCES, row.source),
  processing: oneOf(KB_PROCESSING_STATES, row.processing),
  createdAt: row.createdAt.toISOString(),
  decidedAt: row.decidedAt?.toISOString() ?? null,
  processAfter: row.processAfter?.toISOString() ?? null,
  staleSince: row.staleSince?.toISOString() ?? null,
  staleReason: row.staleReason === null ? null : oneOf(KB_STALE_REASONS, row.staleReason),
  staleDismissedAt: row.staleDismissedAt?.toISOString() ?? null,
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

/** The columns a KB item writes (everything but its ID, board and creation, which never change). */
const kbItemColumns = (item: KbItem) => ({
  status: item.status,
  statement: item.statement,
  // Mined items' figures and evidence are refreshed weekly while they are open.
  evidence: item.evidence,
  signal: item.signal,
  sourceGlobIds: [...item.sourceGlobIds],
  decidedBy: item.decidedBy,
  decidedAt: item.decidedAt === null ? null : new Date(item.decidedAt),
  decisionReason: item.decisionReason,
  outcome: item.outcome,
  processing: item.processing,
  processingError: item.processingError,
  processingAttempts: item.processingAttempts,
  processAfter: item.processAfter === null ? null : new Date(item.processAfter),
  target: item.target,
  catalogCandidate: item.catalogCandidate,
  catalogReason: item.catalogReason,
  occurrenceCount: item.occurrenceCount,
  extraEvidence: [...item.extraEvidence],
  duplicateOf: item.duplicateOf,
  suppressedBy: item.suppressedBy,
  coveredBy: item.coveredBy,
  possiblyCoveredBy: item.possiblyCoveredBy,
  contradicts: [...item.contradicts],
  draft: item.draft,
  draftedAgainstVersion: item.draftedAgainstVersion,
  rationale: item.rationale,
  staleSince: item.staleSince === null ? null : new Date(item.staleSince),
  staleReason: item.staleReason,
  staleDismissedAt: item.staleDismissedAt === null ? null : new Date(item.staleDismissedAt),
  keptApartFrom: [...item.keptApartFrom],
  mergeNote: item.mergeNote,
  effectCheck: item.effectCheck,
  version: item.version,
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

/** Postgres implementation of the core Store port. */
export class PgStore implements Store {
  constructor(private readonly db: Db) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction((t) => work(this.tx(t)));
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
        await t.delete(schema.codeReviewComments).where(eq(schema.codeReviewComments.globId, id));
        await t.delete(schema.reviewFindings).where(eq(schema.reviewFindings.globId, id));
        await t.delete(schema.reviewSources).where(eq(schema.reviewSources.globId, id));
        await t.delete(schema.artifacts).where(eq(schema.artifacts.globId, id));
        await t.delete(schema.globs).where(eq(schema.globs.id, id));
      },
      findGlobByCreationKey: async (boardId, key) => {
        const [row] = await t
          .select({ data: schema.globs.data })
          .from(schema.globs)
          .where(and(eq(schema.globs.boardId, boardId), eq(schema.globs.creationKey, key)));
        return row?.data ?? null;
      },
      listGlobs: async (boardId, filter: GlobFilter) => {
        const conditions = [eq(schema.globs.boardId, boardId)];
        if (filter.status !== undefined) conditions.push(inArray(schema.globs.status, [...filter.status]));
        if (filter.type !== undefined) conditions.push(eq(schema.globs.type, filter.type));
        if (filter.group !== undefined) conditions.push(eq(schema.globs.groupName, filter.group));
        if (filter.person !== undefined) {
          const person = or(eq(schema.globs.planner, filter.person), eq(schema.globs.implementer, filter.person));
          if (person !== undefined) conditions.push(person);
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
            version: board.version,
          })
          .where(and(eq(schema.boards.id, board.id), eq(schema.boards.version, expectedVersion)))
          .returning({ id: schema.boards.id });
        return rows.length === 1;
      },
      setSubLimit: async (boardId, from, to) => {
        const rows = await t
          .update(schema.boards)
          .set({ subMaxChangedLines: to })
          .where(and(eq(schema.boards.id, boardId), eq(schema.boards.subMaxChangedLines, from)))
          .returning({ id: schema.boards.id });
        return rows.length === 1;
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
        return rows.map(toArtifact).sort((a, b) => b.id - a.id);
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
          })
          .from(a)
          .innerJoin(schema.globs, eq(schema.globs.id, a.globId))
          .where(and(...conditions))
          .orderBy(a.globId, a.kind, a.label, desc(a.version));
        return rows.map(
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
          }),
        );
      },

      insertKbItem: async (item) => {
        const rows = await t
          .insert(schema.kbProposals)
          .values({ ...item, ...kbItemColumns(item), createdAt: new Date(item.createdAt) })
          .onConflictDoNothing()
          .returning({ id: schema.kbProposals.id });
        return rows.length === 1;
      },
      getKbItem: async (id) => {
        const [row] = await t.select().from(schema.kbProposals).where(eq(schema.kbProposals.id, id));
        return row === undefined ? null : toKbItem(row);
      },
      listKbItems: async (boardId, status) => {
        const conditions = [eq(schema.kbProposals.boardId, boardId)];
        if (status !== undefined) conditions.push(eq(schema.kbProposals.status, status));
        const rows = await t
          .select()
          .from(schema.kbProposals)
          .where(and(...conditions))
          .orderBy(asc(schema.kbProposals.createdAt), asc(schema.kbProposals.id));
        return rows.map(toKbItem);
      },
      listRecentKbItems: async (boardId, statuses, limit) => {
        const where = and(eq(schema.kbProposals.boardId, boardId), inArray(schema.kbProposals.status, [...statuses]));
        const rows = await t
          .select()
          .from(schema.kbProposals)
          .where(where)
          // Newest by decision (an item joins the decided group when decided); closed items have none.
          .orderBy(desc(sql`coalesce(${schema.kbProposals.decidedAt}, ${schema.kbProposals.createdAt})`), desc(schema.kbProposals.id))
          .limit(limit);
        const [counted] = await t.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(schema.kbProposals).where(where);
        return { items: rows.map(toKbItem), total: counted?.total ?? 0 };
      },
      nextKbItemToProcess: async (now) => {
        const [row] = await t
          .select()
          .from(schema.kbProposals)
          .where(
            and(
              eq(schema.kbProposals.status, 'open'),
              inArray(schema.kbProposals.processing, ['pending', 'routed']),
              or(isNull(schema.kbProposals.processAfter), lte(schema.kbProposals.processAfter, new Date(now))),
            ),
          )
          .orderBy(asc(schema.kbProposals.createdAt), asc(schema.kbProposals.id))
          .limit(1);
        return row === undefined ? null : toKbItem(row);
      },
      updateKbItem: async (item, expectedVersion) => {
        const rows = await t
          .update(schema.kbProposals)
          .set(kbItemColumns(item))
          .where(and(eq(schema.kbProposals.id, item.id), eq(schema.kbProposals.version, expectedVersion)))
          .returning({ id: schema.kbProposals.id });
        return rows.length === 1;
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

      upsertCodeReviewComment: async (comment) => {
        const c = schema.codeReviewComments;
        const rows = await t
          .insert(c)
          .values({ ...comment, createdAt: new Date(comment.createdAt), updatedAt: new Date(comment.updatedAt) })
          .onConflictDoUpdate({
            target: c.externalId,
            set: {
              kind: sql`excluded.kind`,
              body: sql`excluded.body`,
              url: sql`excluded.url`,
              commitSha: sql`excluded.commit_sha`,
              path: sql`excluded.path`,
              line: sql`excluded.line`,
              updatedAt: sql`excluded.updated_at`,
            },
            // An edit replaces the stored copy unless that is newer (a late redelivery) or was deleted, and only when it
            // differs.
            setWhere: sql`${c.deletedAt} is null and ${c.updatedAt} <= excluded.updated_at and (${c.kind}, ${c.body}, ${c.url}, ${c.commitSha}, ${c.path}, ${c.line}, ${c.updatedAt}) is distinct from (excluded.kind, excluded.body, excluded.url, excluded.commit_sha, excluded.path, excluded.line, excluded.updated_at)`,
          })
          .returning({ id: c.id });
        return rows.length === 1;
      },
      deleteCodeReviewComment: async (externalId, at) => {
        const c = schema.codeReviewComments;
        // A tombstone, not a delete: a late redelivery of the item must not store it again.
        const [row] = await t
          .update(c)
          .set({ deletedAt: new Date(at) })
          .where(and(eq(c.externalId, externalId), isNull(c.deletedAt)))
          .returning();
        return row === undefined ? null : toCodeReview(row);
      },
      listCodeReviewComments: async (boardId, globIds) => {
        if (globIds.length === 0) return [];
        const c = schema.codeReviewComments;
        const rows = await t
          .select()
          .from(c)
          .where(and(eq(c.boardId, boardId), inArray(c.globId, [...globIds]), isNull(c.deletedAt)))
          .orderBy(asc(c.createdAt), asc(c.id));
        return rows.map(toCodeReview);
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

      listBoardEvents: async (boardId, since, types) => {
        const e = schema.events;
        const conditions = [eq(schema.globs.boardId, boardId), gte(e.at, new Date(since))];
        if (types !== undefined) {
          if (types.length === 0) return [];
          conditions.push(inArray(e.type, [...types]));
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
        await t.insert(schema.outbox).values(effects.map((effect) => ({ kind: effect.kind, globId: effect.globId, effect })));
        // Wake the job runner after commit.
        await t.execute(sql`select pg_notify('slop_outbox', '')`);
      },
    };
  }
}
