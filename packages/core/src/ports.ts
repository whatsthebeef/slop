import type { DomainEvent, Effect } from './domain/events.js';
import type { IdLetter } from './domain/ids.js';
import type { KbItem, KbItemStatus } from './domain/kb.js';
import type { Artifact, ArtifactKind, ArtifactSummary, KnowledgeDoc, KnowledgeKind } from './domain/knowledge.js';
import type { Board, Glob, Member, Role, Status, SlopType, User } from './domain/types.js';

export interface GlobFilter {
  readonly status?: readonly Status[];
  readonly type?: SlopType;
  readonly group?: string;
  readonly person?: string;
}

/** Store access inside one transaction. Glob writes are conditional on the glob's version. */
export interface Tx {
  getGlob(id: string): Promise<Glob | null>;
  /** Inserts a new glob; returns false if the ID already exists. */
  insertGlob(glob: Glob, creationKey: string | null): Promise<boolean>;
  /** Writes `glob` if the stored version is still `expectedVersion`; returns false otherwise. */
  updateGlob(glob: Glob, expectedVersion: number): Promise<boolean>;
  deleteGlob(id: string): Promise<void>;
  findGlobByCreationKey(boardId: number, key: string): Promise<Glob | null>;
  listGlobs(boardId: number, filter: GlobFilter): Promise<Glob[]>;
  /** Atomically returns the next number for a board's ID letter. */
  nextNumber(boardId: number, letter: IdLetter): Promise<number>;

  getBoard(id: number): Promise<Board | null>;
  insertBoard(board: Omit<Board, 'id' | 'version' | 'agentSetVersion' | 'runNoProgressHours' | 'runReadyHours' | 'subMaxChangedLines'>): Promise<Board>;
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
  /** Writes `item` if the stored version is still `expectedVersion`; returns false otherwise. */
  updateKbItem(item: KbItem, expectedVersion: number): Promise<boolean>;

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
  | { readonly kind: 'board.changed'; readonly boardId: number };

/** Publishes small change hints to open boards after a commit. */
export interface Notifier {
  publish(hint: Hint): void;
}

/** The generic catalog shipped with slop (`catalog/`): starter KB entries and the agent set. */
export interface Catalog {
  kbEntries(): Promise<{ id: string; version: number; fileName: string; content: string }[]>;
  agentSet(): Promise<{ path: string; content: string }[]>;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  runId(): string;
}

/** Who owns routines: used to fall back to the board's default routine owner. */
export interface RoutineDirectory {
  hasRoutine(email: string): Promise<boolean>;
}

export type { Role };
