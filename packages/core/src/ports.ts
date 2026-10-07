import type { Deploy, DeployState } from './domain/deploys.js';
import type { DomainEvent, DomainEventType, Effect } from './domain/events.js';
import type { NewFinding, NewReviewSource, ReviewFinding, ReviewSource } from './domain/findings.js';
import type { IdLetter } from './domain/ids.js';
import type { KbItem, KbItemStatus } from './domain/kb.js';
import type { Artifact, ArtifactKind, ArtifactSummary, KnowledgeDoc, KnowledgeKind } from './domain/knowledge.js';
import type { ArtifactMeta, BoardJob, BoardJobName, KbSignalState, ManifestChange, MergedCommit } from './domain/signals.js';
import type { Board, Glob, Member, Role, Status, SlopType, User } from './domain/types.js';

export interface GlobFilter {
  readonly status?: readonly Status[];
  readonly type?: SlopType;
  readonly group?: string;
  readonly person?: string;
}

export interface DeployFilter {
  readonly environment?: string;
  readonly states?: readonly DeployState[];
  readonly globIds?: readonly string[];
  readonly limit?: number;
}

/** Store access inside one transaction. Glob writes are conditional on the glob's version. */
export interface Tx {
  getGlob(id: string): Promise<Glob | null>;
  /** Inserts a new glob; returns false if the ID already exists. */
  insertGlob(glob: Glob, creationKey: string | null): Promise<boolean>;
  /** Writes `glob` if the stored version is still `expectedVersion`; returns false otherwise. */
  updateGlob(glob: Glob, expectedVersion: number): Promise<boolean>;
  /** Deletes the glob with its artifacts, review sources and findings. */
  deleteGlob(id: string): Promise<void>;
  findGlobByCreationKey(boardId: number, key: string): Promise<Glob | null>;
  listGlobs(boardId: number, filter: GlobFilter): Promise<Glob[]>;
  /** Atomically returns the next number for a board's ID letter. */
  nextNumber(boardId: number, letter: IdLetter): Promise<number>;

  getBoard(id: number): Promise<Board | null>;
  insertBoard(board: Omit<Board, 'id' | 'version' | 'agentSetVersion' | 'agentCatalogHash' | 'runNoProgressHours' | 'runReadyHours' | 'subMaxChangedLines' | 'deploy' | 'readinessTicks'>): Promise<Board>;
  updateBoard(board: Board, expectedVersion: number): Promise<boolean>;
  listBoards(email: string): Promise<Board[]>;
  /** Every board, for background jobs. */
  listAllBoards(): Promise<Board[]>;

  getMember(boardId: number, email: string): Promise<Member | null>;
  listMembers(boardId: number): Promise<Member[]>;
  upsertMember(member: Member): Promise<void>;
  deleteMember(boardId: number, email: string): Promise<void>;

  getUser(email: string): Promise<User | null>;
  upsertUser(user: User): Promise<void>;

  listKnowledge(boardId: number, kinds?: readonly KnowledgeKind[]): Promise<KnowledgeDoc[]>;
  getKnowledge(boardId: number, kind: KnowledgeKind, name: string): Promise<KnowledgeDoc | null>;
  /** Writes the document's current version and keeps the previous ones as history. */
  saveKnowledge(doc: KnowledgeDoc): Promise<void>;
  deleteKnowledge(boardId: number, kind: KnowledgeKind, name: string): Promise<void>;

  /** Appends an artifact; its version is the next for the glob, kind and label. */
  insertArtifact(artifact: Omit<Artifact, 'id' | 'version'>): Promise<Artifact>;
  /** Latest version of each artifact (per kind and label), optionally of one kind. */
  listArtifacts(globId: string, kind?: ArtifactKind): Promise<Artifact[]>;
  artifactVersions(globId: string, kind: ArtifactKind, label: string): Promise<Artifact[]>;
  /** Content-free summaries of the latest version of each artifact on the given globs of a board. */
  listArtifactSummaries(boardId: number, globIds: readonly string[]): Promise<ArtifactSummary[]>;

  /** Inserts a new KB item; returns false if the ID already exists. */
  insertKbItem(item: KbItem): Promise<boolean>;
  getKbItem(id: string): Promise<KbItem | null>;
  /** A board's KB items, oldest first, optionally with one status. */
  listKbItems(boardId: number, status?: KbItemStatus): Promise<KbItem[]>;
  /**
   * A board's newest `limit` KB items with one of `statuses`, newest first by `decidedAt` (else
   * `createdAt`), and how many there are in all.
   */
  listRecentKbItems(boardId: number, statuses: readonly KbItemStatus[], limit: number): Promise<{ items: KbItem[]; total: number }>;
  /**
   * The oldest open item on any board still waiting for the pipeline (`pending` routing or
   * `routed`, waiting for its draft) whose `processAfter` is unset or not after `now`.
   */
  nextKbItemToProcess(now: string): Promise<KbItem | null>;
  /** Writes `item` if the stored version is still `expectedVersion`; returns false otherwise. */
  updateKbItem(item: KbItem, expectedVersion: number): Promise<boolean>;

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

  /** A board's events at or after `since` (of `types`, when given), oldest first (events carry no board: joined through globs). */
  listBoardEvents(boardId: number, since: string, types?: readonly DomainEventType[]): Promise<DomainEvent[]>;
  /**
   * A board's artifact versions of `kinds` created at or after `since`, oldest first, without content except
   * for `ARTIFACT_KINDS_WITH_CONTENT` (mining reads review rounds and plan changes).
   */
  listArtifactMeta(boardId: number, kinds: readonly ArtifactKind[], since: string): Promise<ArtifactMeta[]>;
  /** A board's mined-signal state, one row per signal key. */
  listKbSignals(boardId: number): Promise<KbSignalState[]>;
  upsertKbSignal(state: KbSignalState): Promise<void>;
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
  | { readonly kind: 'board.changed'; readonly boardId: number }
  /** The board's KB items, documents or agent-set files changed (the board itself only on an agent-set version bump). */
  | { readonly kind: 'board.kb'; readonly boardId: number };

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
}

/**
 * The code host's view of what merged commits did to dependency manifests (mined signals). Null when the
 * board's repo can't be read, so the dependency signal isn't measured.
 */
export interface ManifestSource {
  manifestChanges(board: Board, commits: readonly MergedCommit[]): Promise<ManifestChange[] | null>;
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
