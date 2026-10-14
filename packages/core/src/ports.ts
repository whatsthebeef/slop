import type { BoardSession } from './domain/board-sessions.js';
import type { Deploy, DeployState } from './domain/deploys.js';
import type { StoredHumanStep } from './domain/human-steps.js';
import type { EnvironmentDeploy, GlobPresence, NewEnvironmentDeploy } from './domain/environments.js';
import type { DecisionOrigin } from './domain/attributes.js';
import type { DomainEvent, DomainEventType, Effect, EffectKind, OutboxJob } from './domain/events.js';
import type { EnvironmentCommit, NewTestRun, TestRun } from './domain/test-runs.js';
import type { BoardNotification } from './domain/notifications.js';
import type { ChatMessage, ChatThread, NewChatMessage, NewChatThread } from './domain/chat.js';
import type { Decision, DecisionPatch, DecisionSource, NewDecision } from './domain/decisions.js';
import type { InboxItem, InboxLink, InboxStatus, NewInboxItem } from './domain/inbox.js';
import type { IntegrationToken } from './domain/integration-tokens.js';
import type { Candidate, ItemStatus, KnowledgeItem, NewChunk, NewKnowledgeItem, PendingChunk, SearchQuery, SourceType } from './domain/search.js';
import type { DiffSummary } from './domain/sub-gate.js';
import type { GlobReportFacts } from './domain/time-tracking.js';
import type { NewFinding, NewReviewSource, ReviewFinding, ReviewSource } from './domain/findings.js';
import type { IdLetter } from './domain/ids.js';
import type { GlobOutcome, IntakeSnapshot } from './domain/intake-learning.js';
import type { KnowledgePageFeedback, KnowledgePageHistoryEntry, KnowledgePageVersion } from './domain/knowledge-page.js';
import type { Artifact, ArtifactKind, ArtifactSummary, KnowledgeDoc, KnowledgeKind } from './domain/knowledge.js';
import type { ChoiceUsageRow, ContextRetrievalRow } from './domain/choice-usage.js';
import type { ContextSettingChange, ContextSettingKey, ContextSettings, NewContextSettingChange } from './domain/context-settings.js';
import type { ArtifactMeta, BoardJob, BoardJobName, KbSignalState, ManifestChange, MergedCommit } from './domain/signals.js';
import type { NewSizeCalibrationChange, SizeCalibration, SizeCalibrationChange, SizeRecord } from './domain/size-forecast.js';
import type { NewSizeThresholdChange, SizeCheck, SizeThreshold, SizeThresholdChange } from './domain/size-check.js';
import type { EscalationRecord, NewEscalationRecord } from './domain/escalation-learning.js';
import type { NewRiskAreaChange, RiskArea, RiskAreaChange } from './domain/risk-area.js';
import type { NewReviewFeedback, ReviewFeedback } from './domain/review-feedback.js';
import type { LlmSpend, SpendSummary } from './domain/spend.js';
import type { NewSubLimitChange, SubLimitChange } from './domain/sub-limit.js';
import type { NewTypeCorrection, TypeCorrection } from './domain/type-learning.js';
import type { DependencyDefaults, DependencyRule, DependencyRuleChange, NewDependencyRuleChange } from './domain/dependency-rules.js';
import type { BaseChecks, Board, Glob, Member, Relation, RelationPatch, Role, Status, SlopType, User } from './domain/types.js';

/**
 * Which globs a listing includes: `work` (the default: features, tasks and bugs, so every consumer that treats a glob as
 * work is unchanged), `decisions` (decision globs only) or `all`. Anything that must see decisions asks for them.
 */
export type GlobInclude = 'work' | 'decisions' | 'all';

export interface GlobFilter {
  readonly include?: GlobInclude;
  readonly status?: readonly Status[];
  readonly type?: SlopType;
  readonly group?: string;
  readonly person?: string;
  /** Decision globs whose proposal came from one of these (`submitted` and `mined`: the KB items). */
  readonly origins?: readonly DecisionOrigin['kind'][];
}

export interface DeployFilter {
  readonly environment?: string;
  readonly states?: readonly DeployState[];
  readonly globIds?: readonly string[];
  readonly limit?: number;
}

export interface PresenceFilter {
  readonly environment?: string;
  readonly globIds?: readonly string[];
  readonly contained?: boolean;
}

/** Test runs to list: the branch runs of these globs, and the environment runs at these commits (either may be short). */
export interface TestRunFilter {
  readonly globIds?: readonly string[];
  readonly commits?: readonly EnvironmentCommit[];
}

/** Store access inside one transaction. Glob writes are conditional on the glob's version. */
export interface Tx {
  getGlob(id: string): Promise<Glob | null>;
  /** The globs with these IDs, in no particular order (missing ones are left out). */
  getGlobs(ids: readonly string[]): Promise<Glob[]>;
  /**
   * Just what a time report needs (id, board, planner, category, type) for the globs with these IDs, missing ones left
   * out. Takes any number of IDs: they go to the database as one parameter, not one each.
   */
  globFacts(ids: readonly string[]): Promise<GlobReportFacts[]>;
  /** Inserts a new glob; returns false if the ID already exists. */
  insertGlob(glob: Glob, creationKey: string | null): Promise<boolean>;
  /** Writes `glob` if the stored version is still `expectedVersion`; returns false otherwise. */
  updateGlob(glob: Glob, expectedVersion: number): Promise<boolean>;
  /**
   * Deletes the glob with its artifacts, review sources, findings, environment presence, branch test runs and its items
   * in the search store (an item shared with other globs, a learning, only loses the link).
   * Its decisions go with it; decisions it took that older ones point at are released (their `replacedBy` cleared and
   * the item active again). Inbox items attached to it only lose the link (and become `kept` with their last one).
   */
  deleteGlob(id: string): Promise<void>;
  findGlobByCreationKey(boardId: number, key: string): Promise<Glob | null>;
  /** The board's globs whose creation key starts with `prefix`, in no particular order. */
  findGlobsByCreationKeyPrefix(boardId: number, prefix: string): Promise<Glob[]>;
  listGlobs(boardId: number, filter: GlobFilter): Promise<Glob[]>;
  /** Atomically returns the next number for a board's ID letter. */
  nextNumber(boardId: number, letter: IdLetter): Promise<number>;

  getBoard(id: number): Promise<Board | null>;
  insertBoard(board: Omit<Board, 'id' | 'version' | 'agentSetVersion' | 'agentCatalogHash' | 'runNoProgressHours' | 'runReadyHours' | 'runStartMinutes' | 'runRespondMinutes' | 'subMaxChangedLines' | 'subLimitStep' | 'effectCheckGlobs' | 'agentKbApproval' | 'autoInvestigate' | 'knowledgePageIntervalMinutes' | 'review' | 'deploy' | 'readinessTicks'>): Promise<Board>;
  updateBoard(board: Board, expectedVersion: number): Promise<boolean>;
  /**
   * Sets the board's learned sub size limit to `to` if it is still `from`; returns false otherwise. It has no board
   * version, and `updateBoard` doesn't write it: settings saves don't overwrite a learned move.
   */
  setSubLimit(boardId: number, from: number, to: number, step?: number): Promise<boolean>;
  /** Records a sub-limit outcome; false when the board already has that glob's outcome (the learning is idempotent). */
  insertSubLimitChange(change: NewSubLimitChange): Promise<boolean>;
  /** Adds a row to the LLM spend ledger (what a call or review cost, or its tokens when the model has no price). */
  insertLlmSpend(row: Omit<LlmSpend, 'id'>): Promise<void>;
  /** The board's priced spend and its unpriced calls over the period, by source. */
  sumLlmSpend(boardId: number, from: string, to: string): Promise<SpendSummary>;
  /** Stores a person's verdict on a review comment; false when that comment already has one from that source (idempotent). */
  insertReviewFeedback(row: NewReviewFeedback): Promise<boolean>;
  /** The board's review feedback created in the window, oldest first. */
  listReviewFeedback(boardId: number, since: string, until: string): Promise<ReviewFeedback[]>;
  /** The board's learned dependency rules (path patterns whose overlap weight moved), and their history, newest first. */
  listDependencyRules(boardId: number): Promise<DependencyRule[]>;
  upsertDependencyRule(rule: DependencyRule): Promise<void>;
  /** Drops one learned rule (or all of the board's with no pattern): the catalog default applies again. */
  deleteDependencyRules(boardId: number, pattern?: string): Promise<void>;
  /** False when the board already recorded this glob's outcome for the pattern and cause. */
  insertDependencyRuleChange(change: NewDependencyRuleChange): Promise<boolean>;
  listDependencyRuleChanges(boardId: number): Promise<DependencyRuleChange[]>;
  /** A board's recorded sub-limit outcomes, newest first. */
  listSubLimitChanges(boardId: number): Promise<SubLimitChange[]>;
  /** The board's risk areas (empty until `RiskAreaService` seeds the defaults). */
  listRiskAreas(boardId: number): Promise<RiskArea[]>;
  /** Writes a risk area, replacing the board's one of the same name. */
  putRiskArea(area: RiskArea): Promise<void>;
  deleteRiskArea(boardId: number, name: string): Promise<void>;
  /** Records a risk-area change; false when the board already has one for that glob, cause and area (the learning is idempotent). */
  insertRiskAreaChange(change: NewRiskAreaChange): Promise<boolean>;
  /** A board's risk-area history, newest first. */
  listRiskAreaChanges(boardId: number): Promise<RiskAreaChange[]>;
  /** Records an escalation outcome; false when the board already has one for that glob and outcome (the learning is idempotent). */
  insertEscalationRecord(record: NewEscalationRecord): Promise<boolean>;
  /** A board's escalation history, newest first. */
  listEscalationRecords(boardId: number): Promise<EscalationRecord[]>;
  /** Records a person's retype with the plan's signals (history: the same glob can be retyped again). */
  insertTypeCorrection(correction: NewTypeCorrection): Promise<void>;
  /** A board's type corrections, newest first: only those not reset unless `all`; at most `limit`. */
  listTypeCorrections(boardId: number, options?: { readonly limit?: number; readonly all?: boolean }): Promise<TypeCorrection[]>;
  /** Stamps the board's live corrections as reset at `at` (they stay as history); returns how many. */
  resetTypeCorrections(boardId: number, at: string): Promise<number>;
  /** The glob's size check (spec, Intake), or null when none was made. */
  getSizeCheck(globId: string): Promise<SizeCheck | null>;
  /** The board's size checks. */
  listSizeChecks(boardId: number): Promise<SizeCheck[]>;
  /** Writes the glob's size check, replacing an earlier one. */
  upsertSizeCheck(check: SizeCheck): Promise<void>;
  /** Writes a re-assessment of the glob's size check without touching its decision columns (a concurrent Keep whole survives). */
  updateSizeAssessment(check: SizeCheck): Promise<void>;
  /** The board's learned size threshold (the default until it has moved). */
  getSizeThreshold(boardId: number): Promise<SizeThreshold>;
  /** Sets the threshold to `to` if it is still `from`; returns false otherwise. */
  setSizeThreshold(boardId: number, from: SizeThreshold, to: SizeThreshold): Promise<boolean>;
  /** Records a size-threshold outcome; false when the board already has that glob's (the learning is idempotent). */
  insertSizeThresholdChange(change: NewSizeThresholdChange): Promise<boolean>;
  /** A board's recorded size-threshold outcomes, newest first. */
  listSizeThresholdChanges(boardId: number): Promise<SizeThresholdChange[]>;
  /** The board's size calibration (the defaults until it has moved). */
  getSizeCalibration(boardId: number): Promise<SizeCalibration>;
  /** Replaces the board's size calibration. */
  setSizeCalibration(boardId: number, calibration: SizeCalibration): Promise<void>;
  /** Records a calibration move; false when the board already has one for that glob with that cause (idempotent). */
  insertSizeCalibrationChange(change: NewSizeCalibrationChange): Promise<boolean>;
  /** A board's calibration moves, newest first. */
  listSizeCalibrationChanges(boardId: number): Promise<SizeCalibrationChange[]>;
  /** The glob's three-point size record, or null when none was made. */
  getSizeRecord(globId: string): Promise<SizeRecord | null>;
  /** Writes the glob's size record (one per glob). */
  upsertSizeRecord(record: SizeRecord): Promise<void>;
  /** The board's size records. */
  listSizeRecords(boardId: number): Promise<SizeRecord[]>;
  /** Records the base branch's latest check result. It has no board version: check results arrive on their own. */
  setBaseChecks(boardId: number, baseChecks: BaseChecks): Promise<void>;
  /** Board notifications have no version: sources raise and clear them on their own. */
  getNotification(id: string): Promise<BoardNotification | null>;
  saveNotification(notification: BoardNotification): Promise<void>;
  /** True when it existed. */
  deleteNotification(id: string): Promise<boolean>;
  /** The board's own notifications and the global ones. */
  listNotifications(boardId: number): Promise<BoardNotification[]>;
  listBoards(email: string): Promise<Board[]>;
  /** Every board, for background jobs. */
  listAllBoards(): Promise<Board[]>;

  getMember(boardId: number, email: string): Promise<Member | null>;
  listMembers(boardId: number): Promise<Member[]>;
  upsertMember(member: Member): Promise<void>;
  deleteMember(boardId: number, email: string): Promise<void>;

  /** Serialises a person's board-session writes until the transaction ends (a no-op where transactions don't overlap). */
  lockBoardSessions(email: string): Promise<void>;
  /** A person's sessions on the boards they belong to (a board they never opened or added has none). */
  listBoardSessions(email: string): Promise<BoardSession[]>;
  /** Records when the person last opened the board; leaves its place in the bar alone. Ignored for a non-member. */
  touchBoardSession(email: string, boardId: number, at: string): Promise<void>;
  /**
   * Gives the person's session on the board this number in the bar, or null to take it out; no other session changes.
   * Creates the session if it doesn't exist yet (with no view time). The board must be one the person belongs to, and a
   * number is held by one session at a time.
   */
  setBoardSessionPosition(email: string, boardId: number, position: number | null): Promise<void>;

  getUser(email: string): Promise<User | null>;
  upsertUser(user: User): Promise<void>;

  listKnowledge(boardId: number, kinds?: readonly KnowledgeKind[]): Promise<KnowledgeDoc[]>;
  getKnowledge(boardId: number, kind: KnowledgeKind, name: string): Promise<KnowledgeDoc | null>;
  /** An earlier version of a document (from its history), or null. */
  getKnowledgeVersion(boardId: number, kind: KnowledgeKind, name: string, version: number): Promise<KnowledgeDoc | null>;
  /** Writes the document's current version and keeps the previous ones as history. */
  saveKnowledge(doc: KnowledgeDoc): Promise<void>;
  deleteKnowledge(boardId: number, kind: KnowledgeKind, name: string): Promise<void>;

  /** Appends an artifact; its version is the next for the glob, kind and label. */
  insertArtifact(artifact: Omit<Artifact, 'id' | 'version'>): Promise<Artifact>;
  /** Latest version of each artifact (per kind and label), optionally of one kind. */
  listArtifacts(globId: string, kind?: ArtifactKind): Promise<Artifact[]>;
  /**
   * Takes the glob's artifact lock for the rest of the transaction (the one `insertArtifact` takes). A state change of a
   * file takes it first and then reads the file's latest version, so it decides on what is committed, not on a stale read.
   */
  lockGlobArtifacts(globId: string): Promise<void>;
  /** The latest version of the file attachment whose object key this is (null when none, or when a later upload replaced the key). */
  findFileArtifact(key: string): Promise<Artifact | null>;
  /** The latest versions of file attachments still `pending`, oldest first; one glob's when `globId` is given. */
  listPendingFileArtifacts(globId?: string): Promise<Artifact[]>;
  artifactVersions(globId: string, kind: ArtifactKind, label: string): Promise<Artifact[]>;
  /** Content-free summaries of the latest version of each artifact on the given globs of a board. */
  listArtifactSummaries(boardId: number, globIds: readonly string[]): Promise<ArtifactSummary[]>;
  /** The latest version of each artifact (per glob, kind and label) of the given globs, of the given kinds, with content: one read for many globs. */
  latestArtifacts(globIds: readonly string[], kinds: readonly ArtifactKind[]): Promise<Artifact[]>;
  /** The newest outbox job (any state) per glob and kind, of the given globs and kinds: one read for many globs. */
  latestOutboxJobs(globIds: readonly string[], kinds: readonly EffectKind[]): Promise<OutboxJob[]>;

  /** Adds a knowledge page version; false when the board already has that version number (a concurrent regeneration won). */
  insertKnowledgePageVersion(version: KnowledgePageVersion): Promise<boolean>;
  /** The board's newest knowledge page version; null before the first. */
  latestKnowledgePageVersion(boardId: number): Promise<KnowledgePageVersion | null>;
  getKnowledgePageVersion(boardId: number, version: number): Promise<KnowledgePageVersion | null>;
  /** The board's versions without their sections, newest first, at most `limit`. */
  listKnowledgePageVersions(boardId: number, limit: number): Promise<KnowledgePageHistoryEntry[]>;
  /** The board's Pin / Not key verdicts, newest first. */
  listKnowledgePageFeedback(boardId: number): Promise<KnowledgePageFeedback[]>;
  /** Records a verdict on a decision glob, replacing the one it had. */
  saveKnowledgePageFeedback(feedback: KnowledgePageFeedback): Promise<void>;
  /** Undoes a verdict. */
  deleteKnowledgePageFeedback(boardId: number, globId: string): Promise<void>;

  /** The work steps of these globs on a board (any state), oldest first; none for an empty list. */
  listHumanSteps(boardId: number, globIds: readonly string[]): Promise<StoredHumanStep[]>;
  /** A board's open work steps, for the board list. */
  listOpenHumanSteps(boardId: number): Promise<StoredHumanStep[]>;
  /** Writes work steps (insert or replace by ID). */
  saveHumanSteps(steps: readonly StoredHumanStep[]): Promise<void>;

  /** Every relation of a board, oldest first. */
  listRelations(boardId: number): Promise<Relation[]>;
  /** The relations that start at these globs (any gate), oldest first; none for an empty list. */
  listRelationsFrom(globIds: readonly string[]): Promise<Relation[]>;
  /** The relations that point at these globs (any gate), oldest first; none for an empty list. */
  listRelationsTo(globIds: readonly string[]): Promise<Relation[]>;
  /** Inserts a relation; false when the glob already has one to the same glob for the same gate. */
  insertRelation(relation: Relation): Promise<boolean>;
  /** Changes a relation's dismissal, override, reason, evidence or until; the rest of it stays. */
  updateRelation(id: string, patch: RelationPatch): Promise<void>;
  deleteRelation(id: string): Promise<void>;
  /** Deletes every relation that starts at the glob (its own; the ones pointing at it stay, so a view can say it was deleted). */
  deleteRelationsFrom(globId: string): Promise<void>;
  /** Serialises a board's relation writes until the transaction ends, so two cycle checks can't both pass (a no-op where transactions don't overlap). */
  lockBoardRelations(boardId: number): Promise<void>;

  /** The status messages this person dismissed on the board's globs: the glob and the message key. */
  listStatusDismissals(email: string, boardId: number): Promise<{ globId: string; key: string }[]>;
  /** Records a dismissal (a second one for the same message changes nothing). */
  addStatusDismissal(email: string, globId: string, key: string, at: string): Promise<void>;
  /** Undoes a dismissal. */
  removeStatusDismissal(email: string, globId: string, key: string): Promise<void>;

  getDeploy(id: string): Promise<Deploy | null>;
  /** Writes deploys (insert or replace by ID). */
  saveDeploys(deploys: readonly Deploy[]): Promise<void>;
  /** A board's deploys, newest request first, narrowed by the filter. */
  listDeploys(boardId: number, filter: DeployFilter): Promise<Deploy[]>;
  /** The deploy a provider reports on, by its handle. */
  findDeployByProviderRef(providerRef: string): Promise<Deploy | null>;
  /** Each glob's latest deploy (by request time), for the given globs of a board. */
  latestDeploys(boardId: number, globIds: readonly string[]): Promise<Deploy[]>;
  /**
   * Serialises an environment's deploy queue until the transaction ends, so concurrent requests
   * and results can't both see "nothing running" (a no-op where transactions don't overlap).
   */
  lockDeployQueue(boardId: number, environment: string): Promise<void>;

  /** Records a release or integration deploy; false when the board already has its event ID (a redelivery). */
  insertEnvironmentDeploy(deploy: NewEnvironmentDeploy): Promise<boolean>;
  /** The environment's latest succeeded deploy (by deploy time): the commit it runs now. */
  latestEnvironmentDeploy(boardId: number, environment: string): Promise<EnvironmentDeploy | null>;
  /** Whether environments held globs when last checked, narrowed by the filter. */
  listGlobPresence(boardId: number, filter: PresenceFilter): Promise<GlobPresence[]>;
  /** Writes presence rows (insert or replace by glob and environment). */
  saveGlobPresence(rows: readonly GlobPresence[]): Promise<void>;
  /**
   * Serialises an environment's containment checks until the transaction ends, so an older deploy's check can't
   * overwrite a newer one's (a no-op where transactions don't overlap).
   */
  lockEnvironment(boardId: number, environment: string): Promise<void>;

  /** Records a test run; false when the board already has its event ID (a redelivery). */
  insertTestRun(run: NewTestRun): Promise<boolean>;
  /** The board's test runs matching the filter (branch runs of its globs, or environment runs at its commits). */
  listTestRuns(boardId: number, filter: TestRunFilter): Promise<TestRun[]>;

  /** Records a review to split into findings; null when its artifact or external ID is already recorded. */
  insertReviewSource(source: NewReviewSource): Promise<ReviewSource | null>;
  getReviewSource(id: number): Promise<ReviewSource | null>;
  /** A glob's review sources, oldest first. */
  listReviewSources(globId: string): Promise<ReviewSource[]>;
  /** The oldest pending source on any board whose `processAfter` is unset or not after `now`. */
  nextReviewSourceToSplit(now: string): Promise<ReviewSource | null>;
  /** Writes `source` if the stored version is still `expectedVersion`; returns false otherwise. */
  updateReviewSource(source: ReviewSource, expectedVersion: number): Promise<boolean>;
  /** One artifact version by its ID (the findings pipeline reads a local review's text). */
  getArtifact(id: number): Promise<Artifact | null>;
  /** Inserts findings, skipping any whose (globId, source, fingerprint) exists; returns how many were inserted. */
  insertFindings(findings: readonly NewFinding[], createdAt: string): Promise<number>;
  getFinding(id: number): Promise<ReviewFinding | null>;
  /** The oldest pending finding on any board whose `processAfter` is unset or not after `now`. */
  nextFindingToClassify(now: string): Promise<ReviewFinding | null>;
  /** Writes `finding` if the stored version is still `expectedVersion`; returns false otherwise. */
  updateFinding(finding: ReviewFinding, expectedVersion: number): Promise<boolean>;
  /** A glob's findings, oldest first. */
  listFindings(globId: string): Promise<ReviewFinding[]>;
  /**
   * A board's findings from sources (reviews, comments) created from `since` to `until`, oldest source first (for
   * mining and effect checks): windowed by when the review was written, not when it was split into findings.
   */
  listBoardFindings(boardId: number, since: string, until: string): Promise<ReviewFinding[]>;

  /** A board's events at or after `since` (of `types` and of `globIds`, when given), oldest first (events carry no board: joined through globs). */
  listBoardEvents(boardId: number, since: string, types?: readonly DomainEventType[], globIds?: readonly string[]): Promise<DomainEvent[]>;
  /**
   * Every board's events of `types` before `until`, oldest first, in log order (time tracking replays them whole). Each
   * event's `data` keeps only the top-level `dataKeys` it has, so the replay doesn't load whole payloads.
   */
  listEventsUntil(until: string, types: readonly DomainEventType[], dataKeys: readonly string[]): Promise<DomainEvent[]>;
  /**
   * A board's artifact versions of `kinds` created at or after `since`, oldest first, without content except
   * for `ARTIFACT_KINDS_WITH_CONTENT` (mining reads review rounds and plan changes).
   */
  listArtifactMeta(boardId: number, kinds: readonly ArtifactKind[], since: string): Promise<ArtifactMeta[]>;
  /** A board's mined-signal state, one row per signal key. */
  listKbSignals(boardId: number): Promise<KbSignalState[]>;
  upsertKbSignal(state: KbSignalState): Promise<void>;
  /**
   * Counts one retrieval of each of the board's choices among `itemIds` (knowledge item ids; items that are not a
   * choice are ignored) on `day` (`YYYY-MM-DD`), under `globId` or `NO_GLOB`. A cheap counter, one increment each.
   */
  recordChoiceUsage(boardId: number, itemIds: readonly number[], globId: string | null, day: string): Promise<void>;
  /** A board's choice usage rows on or after `fromDay`, for choices that still exist. */
  listChoiceUsage(boardId: number, fromDay: string): Promise<ChoiceUsageRow[]>;
  /** Deletes a board's usage rows before `day`. */
  pruneChoiceUsage(boardId: number, beforeDay: string): Promise<void>;
  /** Adds `count` retrievals on `day` for each source type and tier pair given (a cheap counter per pair). */
  recordContextRetrievals(boardId: number, day: string, rows: readonly Omit<ContextRetrievalRow, 'day'>[]): Promise<void>;
  /** A board's retrieval counters on or after `fromDay`. */
  listContextRetrievals(boardId: number, fromDay: string): Promise<ContextRetrievalRow[]>;
  /** Deletes a board's retrieval counters before `day`. */
  pruneContextRetrievals(boardId: number, beforeDay: string): Promise<void>;
  /** The board's context settings: stored values clamped to their bounds, the default where nothing is stored. */
  getContextSettings(boardId: number): Promise<ContextSettings>;
  /** Stores one setting's value for the board (the caller keeps it within bounds; reads clamp anyway). */
  setContextSetting(boardId: number, key: ContextSettingKey, value: number, at: string): Promise<void>;
  /** Drops the board's stored value: the default applies again. */
  resetContextSetting(boardId: number, key: ContextSettingKey): Promise<void>;
  insertContextSettingChange(change: NewContextSettingChange): Promise<ContextSettingChange>;
  /** A board's recorded setting moves, newest first. */
  listContextSettingChanges(boardId: number): Promise<ContextSettingChange[]>;
  getBoardJob(boardId: number, job: BoardJobName): Promise<BoardJob | null>;
  /**
   * Takes a board job's lease until `now + leaseMs` unless another server holds it (its `runningUntil` is after
   * `now`); returns the claimed row, or null when it is held.
   */
  claimBoardJob(boardId: number, job: BoardJobName, now: string, leaseMs: number): Promise<BoardJob | null>;
  /**
   * Records a run's result and releases its lease, only while the run still holds it (the stored `runningUntil`
   * is still `lease`, what `claimBoardJob` returned); returns false when it doesn't. `job.runningUntil` is ignored.
   */
  finishBoardJob(job: BoardJob, lease: string): Promise<boolean>;
  /**
   * What a board job keeps between its runs (consolidation's memory of pairs it checked), as stored: the job narrows
   * it. Null when nothing is stored. Kept apart from the job's result, so a skipped or failed run leaves it alone.
   */
  getBoardJobState(boardId: number, job: BoardJobName): Promise<unknown>;
  setBoardJobState(boardId: number, job: BoardJobName, state: unknown): Promise<void>;
  /**
   * Serialises a board job's work until the transaction ends, so two runs that both got past the lease (or
   * skipped it) don't read and raise the same signals at once (a no-op where transactions don't overlap).
   */
  lockBoardJob(boardId: number, job: BoardJobName): Promise<void>;

  /** A board's indexed items: external ref to content hash (the indexer re-chunks only what changed). */
  itemHashes(boardId: number): Promise<Map<string, string>>;
  /**
   * Inserts or replaces the item with this board and external ref, and replaces its chunks (stored without an
   * embedding) in the same transaction.
   */
  replaceItem(item: NewKnowledgeItem, chunks: readonly NewChunk[]): Promise<void>;
  /** Deletes a board's items of one source type whose external ref isn't in `refs` (their source is gone); returns how many. */
  deleteItemsNotIn(boardId: number, sourceType: SourceType, refs: ReadonlySet<string>): Promise<number>;
  /** The oldest item on any board awaiting its summary whose `processAfter` is unset or not after `now`. */
  nextItemToSummarise(now: string): Promise<KnowledgeItem | null>;
  /** Records a summary step's progress on an item: the attempt count, when to try again, and the last error. */
  setItemProgress(id: number, progress: { attempts: number; processAfter: string | null; lastError: string | null }): Promise<void>;
  /** Up to `limit` chunks without an embedding, oldest first. */
  chunksToEmbed(limit: number): Promise<PendingChunk[]>;
  /** Stores embeddings (each of `EMBEDDING_DIMENSIONS` numbers) on chunks. */
  setEmbeddings(rows: readonly { id: number; embedding: readonly number[] }[]): Promise<void>;
  /**
   * Chunks matching the query's words (full text, plus trigram matches for identifiers and paths), best first, with
   * relevance in [0, 1]. Always one board; superseded and legacy items are returned too (core ranks them down).
   */
  keywordCandidates(q: SearchQuery, limit: number): Promise<Candidate[]>;
  /** Chunks nearest to `embedding` by cosine similarity (relevance = similarity), best first; only embedded chunks. */
  vectorCandidates(q: SearchQuery, embedding: readonly number[], limit: number): Promise<Candidate[]>;
  /** Merged-change summaries matching `q.query` (words in the summary, or a path in its `Files:` line), newest first. */
  changeCandidates(q: SearchQuery, limit: number): Promise<Candidate[]>;
  /** The latest version of each artifact (per glob, kind and label) on a board, with content. */
  listLatestArtifacts(boardId: number): Promise<Artifact[]>;

  /** A board's decisions, oldest decision first. */
  listDecisions(boardId: number): Promise<Decision[]>;
  getDecision(id: number): Promise<Decision | null>;
  /**
   * Inserts the decision, or (the same item) updates its facts and keeps its supersession state and check progress.
   * Returns the stored row.
   */
  upsertDecision(decision: NewDecision): Promise<Decision>;
  /** Writes the given fields of a decision (supersession state, check progress); a no-op when it is gone. */
  updateDecision(id: number, patch: DecisionPatch): Promise<void>;
  /** Deletes a decision with its knowledge item and chunks. */
  deleteDecision(id: number): Promise<void>;
  /** The oldest decision on any board whose supersession check is due (`checkedAt` unset, `processAfter` unset or not after `now`). */
  nextDecisionToCheck(now: string): Promise<Decision | null>;
  /** Sets an item's status and the item that replaced it (the search store ranks and labels by them). */
  setItemSupersession(itemId: number, status: ItemStatus, supersededBy: number | null): Promise<void>;
  getDecisionSource(boardId: number, sourceRef: string): Promise<DecisionSource | null>;
  listDecisionSources(boardId: number): Promise<DecisionSource[]>;
  /** Inserts or replaces the source row (by board and ref). */
  upsertDecisionSource(source: DecisionSource): Promise<void>;
  /** Deletes a source row (its decisions are deleted separately). */
  deleteDecisionSource(boardId: number, sourceRef: string): Promise<void>;
  /** The oldest pending source on any board whose `processAfter` is unset or not after `now`. */
  nextDecisionSourceToExtract(now: string): Promise<DecisionSource | null>;
  /** The stored item for a board and external ref: its ID, status, replacing item and content hash; null when none. */
  getItemByRef(boardId: number, externalRef: string): Promise<{ id: number; status: ItemStatus; supersededBy: number | null; contentHash: string } | null>;

  /** A conversation's latest `limit` messages, oldest first. */
  listChatMessages(chatId: number, limit: number): Promise<ChatMessage[]>;
  addChatMessage(message: NewChatMessage): Promise<ChatMessage>;
  /** The person's conversations on a board, most recently used first. */
  listChats(boardId: number, email: string, limit: number): Promise<ChatThread[]>;
  getChat(chatId: number): Promise<ChatThread | null>;
  createChat(chat: NewChatThread): Promise<ChatThread>;
  /** Marks the conversation as used at `at`. */
  touchChat(chatId: number, at: string): Promise<void>;
  /** Deletes a conversation and its messages. */
  deleteChat(chatId: number): Promise<void>;
  /**
   * Stores a pasted or delivered item (status `new`, summary pending). A board's item with the same content hash, or
   * the same source and non-empty source ref, is returned instead, with `created: false`.
   */
  insertInboxItem(item: NewInboxItem): Promise<{ item: InboxItem; created: boolean }>;
  getInboxItem(boardId: number, id: number): Promise<InboxItem | null>;
  /** The board's item from an integration with this source key (`sourceRef` is never empty here). */
  getInboxItemBySource(boardId: number, source: string, sourceRef: string): Promise<InboxItem | null>;
  /** A board's items, newest `occurredAt` first, optionally with one of `statuses`. */
  listInboxItems(boardId: number, statuses?: readonly InboxStatus[]): Promise<InboxItem[]>;
  /** Writes `item` (everything but its id, board, source and creation; an import's re-run changes its text, hash, date and label) if the stored version is still `expectedVersion` (the version is then bumped); returns false otherwise. */
  updateInboxItem(item: InboxItem, expectedVersion: number): Promise<boolean>;
  /** The oldest pending, not discarded item on any board whose `processAfter` is unset or not after `now`. */
  nextInboxItemToProcess(now: string): Promise<InboxItem | null>;
  /** Records a link; false when the item is already linked to the glob. */
  insertInboxLink(link: InboxLink): Promise<boolean>;
  listInboxLinks(boardId: number): Promise<InboxLink[]>;
  /** Deletes the link between an item and a glob; false when there was none. */
  deleteInboxLink(inboxId: number, globId: string): Promise<boolean>;
  /** The attached items linked to a glob, oldest link first. */
  listInboxForGlob(globId: string): Promise<InboxItem[]>;
  /** Sets the globs (and group) a search item links to, without touching its chunks. */
  setItemLinks(itemId: number, globIds: readonly string[], globGroup: string | null): Promise<void>;
  /** Deletes a board's search item with this external ref, with its chunks; a no-op when none. */
  deleteItemByRef(boardId: number, externalRef: string): Promise<void>;

  /** The board's integration token that has not been revoked; null when none. */
  getActiveIntegrationToken(boardId: number): Promise<IntegrationToken | null>;
  /** A token by the hash of its secret, revoked or not; null when unknown. */
  findIntegrationToken(tokenHash: string): Promise<IntegrationToken | null>;
  insertIntegrationToken(token: Omit<IntegrationToken, 'id' | 'revokedAt'>): Promise<void>;
  /** Revokes the board's active token (if any) at `at`. */
  revokeIntegrationTokens(boardId: number, at: string): Promise<void>;

  /**
   * Stores a glob's intake snapshot (`embedding` null when it couldn't be computed yet); false when that version
   * exists. Snapshots are never edited: a rewritten plan adds the next version.
   */
  insertIntakeSnapshot(snapshot: IntakeSnapshot, embedding: readonly number[] | null): Promise<boolean>;
  /** The board's snapshots, the latest version of each glob. */
  listLatestIntakeSnapshots(boardId: number): Promise<IntakeSnapshot[]>;
  /** Up to `limit` snapshots without an embedding, oldest first: the text to embed is the request. */
  snapshotsToEmbed(boardId: number, limit: number): Promise<{ globId: string; version: number; request: string }[]>;
  /** Fills the embedding of a snapshot that has none (the only change a snapshot row takes). */
  setSnapshotEmbedding(globId: string, version: number, embedding: readonly number[]): Promise<void>;
  /** The snapshot versions nearest to `embedding` by cosine distance, nearest first; only embedded ones. */
  nearestIntakeSnapshots(boardId: number, embedding: readonly number[], limit: number): Promise<{ globId: string; version: number; distance: number }[]>;
  /** Inserts or replaces a merged glob's outcome. */
  upsertGlobOutcome(outcome: GlobOutcome): Promise<void>;
  /** A board's merged-glob outcomes (only those of `globIds`, when given). */
  listGlobOutcomes(boardId: number, globIds?: readonly string[]): Promise<GlobOutcome[]>;

  appendEvents(events: readonly DomainEvent[]): Promise<void>;
  deleteEvents(globId: string): Promise<void>;
  enqueueEffects(effects: readonly Effect[]): Promise<void>;
}

export interface Store {
  /** Runs `work` in one transaction; everything it writes commits or rolls back together. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

export type Hint =
  | { readonly kind: 'glob.changed'; readonly boardId: number; readonly globId: string; readonly version: number }
  | { readonly kind: 'glob.deleted'; readonly boardId: number; readonly globId: string; readonly version: number }
  /** An artifact was added: it doesn't bump the glob's version, so clients refetch regardless. */
  | { readonly kind: 'glob.artifacts'; readonly boardId: number; readonly globId: string }
  /** A glob's deploys changed: they don't bump the glob's version, so clients refetch regardless. */
  | { readonly kind: 'glob.deploys'; readonly boardId: number; readonly globId: string }
  /** A glob's review findings changed (split or classified): they don't bump the glob's version either. */
  | { readonly kind: 'glob.findings'; readonly boardId: number; readonly globId: string }
  /** A glob's decisions (or what replaced them) changed: clients refetch the glob's decision list. */
  | { readonly kind: 'glob.decisions'; readonly boardId: number; readonly globId: string }
  /**
   * A test run against a release or integration environment arrived: every glob that environment holds may show it, so
   * clients refetch the board's deploy state (one hint rather than one per held glob).
   */
  | { readonly kind: 'board.tests'; readonly boardId: number }
  | { readonly kind: 'board.changed'; readonly boardId: number }
  /** The board's KB items, documents or agent-set files changed (the board itself only on an agent-set version bump). */
  | { readonly kind: 'board.kb'; readonly boardId: number }
  /** An integration's health changed (sent to every open board): the banner refetches it. */
  | { readonly kind: 'board.health'; readonly boardId: number }
  /** A board notification was raised, changed or cleared (beside the board, no version bump). */
  | { readonly kind: 'board.notifications'; readonly boardId: number }
  /** The board's inbox changed (an item added, summarised, attached, kept or discarded). */
  | { readonly kind: 'board.inbox'; readonly boardId: number };

/** Publishes small change hints to open boards after a commit. */
export interface Notifier {
  publish(hint: Hint): void;
}

/** The catalog's agent set: its files and a stable hash of them (paths and contents). */
export interface CatalogAgentSet {
  readonly hash: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** The generic catalog shipped with slop (`catalog/`): starter KB entries and the agent set. */
export interface Catalog {
  kbEntries(): Promise<{ id: string; version: number; fileName: string; content: string }[]>;
  agentSet(): Promise<CatalogAgentSet>;
  /** The starting path patterns and rules for dependency edges; absent: none (nothing is predicted from the catalog). */
  dependencyDefaults?(): Promise<DependencyDefaults>;
}

/**
 * The code host's view of what merged commits did to dependency manifests (mined signals). Null when the
 * board's repo can't be read, so the dependency signal isn't measured.
 */
export interface ManifestSource {
  manifestChanges(board: Board, commits: readonly MergedCommit[]): Promise<ManifestChange[] | null>;
}

/** The code host's line counts for merged commits (the learned sub limit, for gate verdicts recorded without them). */
export interface SubDiffSource {
  /** Lines the merge commit `sha` changed against its parent, without files matching `sizeIgnoredPaths`; null when the board's repo can't be read. */
  mergedChangedLines(board: Board, sha: string, sizeIgnoredPaths: readonly string[]): Promise<number | null>;
}

/** Turns text into vectors for semantic search (slop's one embedding model). */
export interface Embedder {
  /** The model ID, for logs and health. */
  readonly model: string;
  readonly dimensions: 1024;
  /** One vector per text, in order. Throws `LlmUnavailable` when credentials or model access are missing. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

/** The code host's account of merged commits, for the change index. */
export interface ChangeSource {
  /** The files and changed lines of merge commit `sha`; null when the board's repo can't be read. */
  mergedDiff(board: Board, sha: string): Promise<DiffSummary | null>;
}

/** The files a glob's branch changes against the base branch, read from the code host. */
export interface BranchFiles {
  /** Null when unknown: the glob has no branch yet, or the code host couldn't say. Never throws. */
  filesOf(board: Board, glob: Glob): Promise<readonly string[] | null>;
}

/** What the board's repo holds of the agent set, read from its base branch. */
export interface AgentSetRepo {
  /** The version in `.claude/slop-agent-set.json`; null when the file is missing or isn't valid. Throws when the host can't be read. */
  committedVersion(board: Board): Promise<number | null>;
}

/** A presigned POST: the form action and the fields to send before the file (S3 enforces the policy behind them). */
export interface PresignedUpload {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** What storage knows about an object. */
export interface ObjectInfo {
  readonly size: number;
  readonly contentType: string;
}

/** Object storage for file attachments (S3 in the server). Only slop picks keys; nothing here lists or reads bytes. */
export interface ObjectStore {
  /**
   * A presigned POST for `key`. The policy limits the size to 1..`maxBytes` bytes and requires a `Content-Type` that
   * starts with the common prefix of `contentTypes`; it expires after `ttlSeconds`.
   */
  presignUpload(input: {
    readonly key: string;
    readonly maxBytes: number;
    readonly contentTypes: readonly string[];
    readonly ttlSeconds: number;
  }): Promise<PresignedUpload>;
  /** A GET link for `key`; `fileName` and `disposition` set how a browser treats it. */
  presignDownload(
    key: string,
    ttlSeconds: number,
    options?: { readonly fileName?: string; readonly disposition?: 'inline' | 'attachment' },
  ): Promise<string>;
  /** The object's size and type, or null when it isn't there. */
  head(key: string): Promise<ObjectInfo | null>;
  /** Removes the object; fine when it isn't there. */
  delete(key: string): Promise<void>;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  runId(): string;
}

/** Who owns routines: used to fall back to the board's default routine owner. */
export interface RoutineDirectory {
  /** Whether the developer has a routine for this board (their own for it, or their default). */
  hasRoutine(email: string, boardId: number): Promise<boolean>;
}

export type { Role };
