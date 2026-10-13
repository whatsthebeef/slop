import type {
  Action,
  AwaitedDependency,
  BlockedBy,
  AgentSetEntry,
  AgentSetFileView,
  ArtifactKind,
  ArtifactSummary,
  Board,
  BoardNotification,
  BoardSession,
  BoardJob,
  BoardJobStatus,
  ContextReport,
  ContextSettingsView,
  CatalogUpdate,
  Category,
  ChatCitation,
  ChatMessage,
  Confidence,
  IntakeAccuracy,
  IntakeExample,
  DecisionDiff,
  DecisionLearning,
  DecisionOutcomeKind,
  DecisionScope,
  DecisionView,
  Deploy,
  DeployIndicator,
  AtfIndicator,
  EnvironmentIndicator,
  GlobEnvironment,
  MonthSpend,
  ReadinessItem,
  Environment,
  Glob,
  GlobFindings,
  InboxStatus,
  KbSignal,
  LabelCommand,
  LocalRunView,
  MergePolicyView,
  LabelName,
  List,
  Member,
  Role,
  Run,
  SearchHit,
  SizeCheck,
  SizeThresholdView,
  SizeCalibrationView,
  SlopType,
  RiskAreaView,
  EscalationView,
  TypeLearningView,
  SubLimitChange,
  SubLimitView,
  DependencyRulesView,
  Edge,
  TargetChange,
} from '@slop/core';
import type { PageContext } from './page-context';
import { takeSseEvents } from './sse';

export interface GlobView extends Glob {
  readonly list: List;
  readonly branch: string;
  readonly currentRun: Run | null;
  readonly allowedActions?: readonly Action[];
  /** The latest version of each artifact (board list and glob reads; absent from some write responses). */
  readonly artifacts?: readonly ArtifactSummaryView[];
  /** What the glob still waits for, and the globs in Planning that wait for it (single-glob reads only). */
  readonly waitingFor?: readonly AwaitedDependency[];
  readonly waitedOnBy?: readonly string[];
  /** Everything unmerged ahead of the glob, transitively (absent when nothing is), and the one to start next. */
  /** Every dependency edge with its kind (needs block the start, overlaps only order merges), source and evidence; absent on an older server. */
  readonly edges?: readonly Edge[];
  readonly blockedBy?: readonly BlockedBy[];
  readonly nextStartable?: string | null;
  /** Set when the glob came from a split: the glob that was cut, this one's place (0 is the original) and every part's ID. */
  readonly split?: { readonly source: string; readonly part: number; readonly parts: readonly string[] };
  /** True while the size check flagged the glob oversized and nobody has split it or kept it whole (the card's chip). */
  readonly oversized?: boolean;
  /** The size check: why it was flagged, its evidence and the proposed split (single-glob reads only). */
  readonly sizeCheck?: SizeCheck;
}

export type ArtifactSummaryView = Omit<ArtifactSummary, 'globId'>;

export interface BoardView extends Board {
  readonly role: Role;
  /** Globs on the board waiting on a person (from /api/me only). */
  readonly attention?: number;
  /** Globs on the board with a routine run in progress (from /api/me only). */
  readonly running?: number;
  /** Your supers in Doing on the board (from /api/me only); a person drives them, so they aren't runs. */
  readonly supers?: number;
  /** Per sign-off label, globs waiting on that review (from /api/me only). */
  readonly reviews?: Partial<Record<LabelName, number>>;
  /** Your place in the board bar, 1-based; null when the board isn't in it (from /api/me only; absent from an older API). */
  readonly position?: number | null;
  /** When you last opened the board; null if never (from /api/me only). */
  readonly lastViewedAt?: string | null;
}

/** `/api/me`: who you are and your boards with their bar sessions and counts. */
export interface Me {
  readonly email: string;
  readonly boards: readonly BoardView[];
}

export interface KnowledgeIndex {
  readonly documents: readonly {
    readonly name: string;
    readonly area: string | null;
    readonly audience: readonly string[];
    readonly description: string;
    readonly version: number;
    readonly source: string;
    /** Headings that appear more than once in the document. */
    readonly duplicateSections?: readonly string[];
  }[];
  readonly agentSet: {
    readonly version: number;
    /** The paths served. */
    readonly files: readonly string[];
    /** Every path with how it is served, orphaned overlays included. */
    readonly entries: readonly AgentSetEntry[];
    /** The version the repo's base branch holds (`.claude/slop-agent-set.json`); null when unknown or none. */
    readonly committedVersion?: number | null;
    /** The open "Agent set vN" glob that brings the repo to the board's version; null when none is open. */
    readonly openGlobId?: string | null;
  };
  /** Documents forked from a catalog entry that has a newer version (shown for copying by hand, never applied). */
  readonly catalogUpdates: readonly CatalogUpdate[];
  /** The local-run spec, read-only (it changes through proposals). */
  readonly localRun: LocalRunView;
  /** The merge policy (which paths clash between globs), read-only (it changes through proposals). */
  readonly mergePolicy: MergePolicyView;
}

export interface CatalogEntry {
  readonly id: string;
  readonly version: number;
  readonly area: string | null;
  readonly audience: readonly string[];
  readonly description: string;
}

export interface ImportResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
}

export interface ArtifactView {
  readonly id: number;
  readonly kind: ArtifactKind;
  readonly label: string;
  readonly version: number;
  readonly content: string;
  readonly link: string | null;
  readonly commitSha: string | null;
  readonly createdAt: string;
  readonly provenance: { readonly by: string; readonly actor: string; readonly validation?: string };
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly current?: GlobView;
  readonly allowedActions?: readonly string[];
  /** `llm_unavailable` only: what is wrong with the model, and what to do. */
  readonly reason?: string;
  readonly fix?: string;
}

/** An ATF run as the API sends it; `id` is optional because an older server doesn't send it. */
/** The sub-limit view; the step fields are optional so an older server's answer still renders. */
export type SubLimitResponse = Omit<SubLimitView, 'bounds' | 'history'> & {
  readonly bounds: Omit<SubLimitView['bounds'], 'startStep'> & { readonly startStep?: number };
  readonly history: readonly (Omit<SubLimitChange, 'step'> & { readonly step?: number })[];
};

/** What intake learned about types; every field is optional so an older server's answer still renders. */
export type TypeLearningResponse = Partial<TypeLearningView>;
/** This month's spend; `unpricedBySource` is optional because an older server doesn't send it. */
export type MonthSpendView = Omit<MonthSpend, 'unpricedBySource'> & {
  readonly unpricedBySource?: MonthSpend['unpricedBySource'];
};

export type AtfRun = Omit<AtfIndicator, 'id'> & { readonly id?: number };

export interface BoardDeploys {
  readonly indicators: Readonly<Record<string, DeployIndicator>>;
  /** Environments with a deploy running: Deploy now is disabled there for everyone. */
  readonly running: readonly string[];
  /** The release and integration environments each glob is in. Optional: an older server doesn't send it, and a
   * mismatched dev pairing (vite on a branch, API on main) must not blank the board. */
  readonly environments?: Readonly<Record<string, readonly EnvironmentIndicator[]>>;
  /** Each glob's ATF results: its branch run, and the runs against the environment commits holding it. Optional, as above. */
  readonly atf?: Readonly<Record<string, readonly AtfRun[]>>;
}

/** The board search box's results; `semantic: 'unavailable'` means keyword matches only (the embedding model is down). */
export interface BoardSearchResult {
  readonly hits: readonly SearchHit[];
  readonly semantic: 'ok' | 'unavailable';
}

/** One question to the board chat; everything but the question is optional. */
export interface ChatQuestion {
  readonly question: string;
  /** The conversation to add to; a new one starts without it. */
  readonly chat?: number;
  readonly history?: boolean;
  readonly glob?: string;
  readonly group?: string;
  /** Where the person is asking from. */
  readonly page?: { readonly type: PageContext['type']; readonly id?: string };
  /** One answer from the stronger model. */
  readonly think?: boolean;
}

/** One of the person's conversations on a board. */
export interface ChatThread {
  readonly id: number;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The chat's reply to a question (`answered` false: the board's records don't answer it). */
export interface ChatReply {
  readonly chat: ChatThread;
  readonly question: ChatMessage;
  readonly reply: ChatMessage;
  readonly answered?: boolean;
}

export type { ChatCitation, ChatMessage };

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

/** A failure that can pass by itself: the server unreachable (fetch throws) or a 5xx. */
export const isTransient = (error: unknown): boolean => !(error instanceof RequestError) || error.status >= 500;

export const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const parsed = await response.json().then(
    (json: unknown) => ({ json }),
    () => null,
  );
  if (!response.ok) {
    throw new RequestError(response.status, (parsed?.json ?? { code: 'internal', message: `${method} ${path} failed (${response.status})` }) as ApiError);
  }
  // An OK answer that isn't JSON is not the API (a server older than the board answers an unknown route with the page).
  if (parsed === null) {
    throw new RequestError(response.status, { code: 'internal', message: `${method} ${path} did not answer with JSON (is the server older than the board?)` });
  }
  return parsed.json as T;
};

/** Listens to a streamed answer: `onText` gets each piece; `signal` stops it. */
export interface ChatStream {
  readonly onText: (text: string) => void;
  readonly signal?: AbortSignal;
}

/** A question answered as server-sent events: `text` pieces, then `done` with the stored messages, or `error`. */
const askChatStream = async (boardId: number, input: ChatQuestion, stream: ChatStream): Promise<ChatReply> => {
  const path = `/api/boards/${boardId}/chat`;
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(input),
    ...(stream.signal === undefined ? {} : { signal: stream.signal }),
  });
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream') || response.body === null) {
    const json: unknown = await response.json().catch(() => null);
    throw new RequestError(response.status, (json ?? { code: 'internal', message: `POST ${path} failed (${response.status})` }) as ApiError);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) buffer += decoder.decode(value, { stream: !done });
    const taken = takeSseEvents(done ? `${buffer}\n\n` : buffer);
    buffer = taken.rest;
    for (const event of taken.events) {
      const data: unknown = JSON.parse(event.data);
      if (event.event === 'text') stream.onText((data as { text: string }).text);
      else if (event.event === 'done') return data as ChatReply;
      else if (event.event === 'error') {
        const failure = data as { status: number; body: ApiError };
        throw new RequestError(failure.status, failure.body);
      }
    }
    if (done) throw new RequestError(502, { code: 'internal', message: 'The answer ended before it was finished' });
  }
};

export interface NewGlob {
  title: string;
  /** One or two sentences for the card. */
  summary: string;
  /** plan.md v1, when it is more than the summary (intake's write-up of the request). */
  plan?: string;
  type: SlopType;
  category: Category;
  group: string | null;
  environment: string | null;
  autoTrigger: boolean;
  /** Super only: false parks it in Planning until a person picks it up to pair. */
  start?: boolean;
  /** IDs of globs on the board to start after. */
  after?: string[];
  /** An inbox item of the board to attach to the new glob as it is created. */
  inboxItem?: number;
  /** Overrides the random key (a glob made from an inbox item uses `inbox:<id>`, so a repeat finds it). */
  idempotencyKey?: string;
  /** Files intake guessed the work changes (sent back as given). */
  files?: string[];
  /** What the intake proposal behind the form said, sent back so the glob's snapshot records it. */
  intake?: {
    request: string;
    categoryConfidence: Confidence | null;
    reason: string | null;
    model: string | null;
    promptVersion: number;
    examples: string[];
  };
}

/** Intake's answer: the form's fields, plus how sure it is and the past globs it was shown. */
export type IntakeProposalView = NewGlob & {
  plan: string;
  autoTriggerReason: string | null;
  suggestedAfter: string[];
  categoryConfidence: Confidence | null;
  categoryReason: string | null;
  /** Why intake chose the type: when a person is needed. Optional: an older API sends none. */
  typeReason?: string | null;
  examples: IntakeExample[];
  needsConfirmation: boolean;
  model: string | null;
  promptVersion: number;
};

export interface SplitPartInput {
  title: string;
  summary: string;
  plan: string;
  category?: Category;
  type?: SlopType;
  /** Indexes of earlier parts this one starts after. */
  after?: number[];
  /** Indexes of earlier parts that may change the same files (merge order only). */
  overlaps?: number[];
}

export type GlobChanges = Partial<Pick<Glob, 'title' | 'summary' | 'type' | 'category' | 'group' | 'environment' | 'after'>> & {
  /** A decision's scope, the only attribute a person edits. */
  attributes?: { scope: DecisionScope };
};

/** What a person chooses for a decision in Doing (`POST /api/globs/:id/decision`). */
export interface DecideInput {
  readonly outcome: Exclude<DecisionOutcomeKind, 'closed'>;
  readonly reason?: string;
  readonly editedDraft?: string;
  readonly target?: TargetChange;
  readonly linkedGlobId?: string;
  /** Accept: the key of a measured signal for the effect check to watch. */
  readonly watchSignal?: string;
}

/** A decision's diff as the API answers it; `learning` is optional because an older API omits it. */
export type GlobDiff = Omit<DecisionDiff, 'learning'> & { readonly learning?: DecisionLearning | null };

export type ActionPath =
  | 'start'
  | 'investigate'
  | 'review-now'
  | 'start-anyway'
  | 'retrigger'
  | 'retry-autofix'
  | 'resolve-conflict'
  | 'pick-up'
  | 'take-over'
  | 'start-again'
  | 'merge'
  | 'retry-merge'
  | 'deescalate'
  | 'make-super'
  | 'merge-continue'
  | 'mark-ready'
  | 'sign-off'
  | 'reopen';

/** What the board's banner shows: each integration that needs a person, and the in-app AWS sign-in (local development only). */
export interface IntegrationHealthView {
  readonly integrations: readonly {
    readonly id: string;
    readonly name: string;
    readonly state: 'degraded' | 'down';
    readonly reason: string | null;
    readonly fix: string | null;
    readonly since: string;
    /** Whether the Sign in to AWS button applies. */
    readonly signIn: boolean;
  }[];
  readonly awsSignIn:
    | ({ readonly canStart: boolean } & (
        | { readonly state: 'idle' | 'done' }
        | { readonly state: 'waiting'; readonly verificationUri: string; readonly userCode: string; readonly expiresAt: string }
        | { readonly state: 'failed'; readonly message: string }
      ))
    | null;
}

/** An inbox item as the board lists it (spec, Inbox and ingest). Fields added after the first release are optional: the web may run against an older API. */
export interface InboxItemView {
  readonly id: number;
  readonly title: string;
  readonly source?: string;
  readonly sourceLabel?: string;
  readonly sourceType?: string;
  readonly occurredAt: string;
  readonly createdAt?: string;
  readonly status: InboxStatus;
  readonly summary?: string | null;
  /** `waiting` while the model can't be used. */
  readonly processing?: 'pending' | 'waiting' | 'done' | 'failed';
  readonly lastError?: string | null;
  readonly excerpt?: string;
  readonly suggestions?: readonly { readonly globId: string; readonly title: string; readonly reason: string }[];
  readonly attachedTo?: readonly { readonly globId: string; readonly title: string }[];
  /** Only on a single-item read. */
  readonly text?: string;
}

export interface NewInboxPaste {
  readonly text: string;
  readonly title?: string;
  readonly occurredAt?: string;
  readonly sourceLabel?: string;
}

/** The work time zone (any member of the board) and whether the caller may download its reports (its admins). Optional for older servers. */
export interface ReportsView {
  timeZone?: string;
  canDownload?: boolean;
}

/** One board's report for one period, computed when asked for. */
export interface ReportFile {
  boardId: number;
  period: string;
  csv: string;
}

export const healthKey = ['health'] as const;

/** The board's notifications; invalidated by `board.notifications` hints and on reconnect. */
export const notificationsKey = (boardId: number) => ['notifications', boardId] as const;

/** One agent or skill in the generated knowledge page. Every field after `name` may be missing from an older API. */
export interface KnowledgePageAgent {
  readonly path: string;
  readonly kind?: 'agent' | 'command';
  readonly name: string;
  readonly description?: string;
  readonly changedInAgentSet?: number | null;
  readonly decisionGlobId?: string | null;
}

export interface KnowledgePageDecision {
  readonly text: string;
  readonly rationale?: string;
  readonly globIds?: readonly string[];
  /** A new developer or the product owner would need it; absent on versions written before the flag existed. */
  readonly key?: boolean;
  /** When the newest decision behind it was decided. */
  readonly at?: string;
}

export interface KnowledgePageDecisionGroup {
  readonly area: string;
  readonly entries?: readonly KnowledgePageDecision[];
}

export interface KnowledgePageVersion {
  readonly boardId?: number;
  readonly version: number;
  readonly createdAt: string;
  readonly reason?: 'first' | 'delta' | 'rebuild' | 'prompt' | 'guide';
  readonly sections?: {
    readonly agents?: readonly KnowledgePageAgent[];
    readonly decisions?: readonly KnowledgePageDecisionGroup[];
  };
}

export interface KnowledgePageHistoryItem {
  readonly version: number;
  readonly createdAt: string;
  readonly reason?: string;
}

export interface KnowledgePageAgentSetVersion {
  readonly version: number;
  readonly at: string;
  readonly changedPaths?: readonly string[];
}

export type KnowledgePageVerdict = 'pin' | 'hide';

/** A Pin / Not key verdict on a decision glob. */
export interface KnowledgePageFeedback {
  readonly globId: string;
  readonly verdict: KnowledgePageVerdict;
  readonly by: string;
  readonly at: string;
}

export interface KnowledgePageView {
  readonly current: KnowledgePageVersion | null;
  readonly history?: readonly KnowledgePageHistoryItem[];
  readonly nextRegenerationAt?: string | null;
  readonly pending?: boolean;
  /** The last agent-set versions the page observed, newest first; absent on an older API. */
  readonly agentSetHistory?: readonly KnowledgePageAgentSetVersion[];
  /** Verdicts in force, newest first; absent on an older API. */
  readonly feedback?: readonly KnowledgePageFeedback[];
}

export const api = {
  health: () => request<IntegrationHealthView>('GET', '/api/health'),
  notifications: (boardId: number) =>
    request<{ value: BoardNotification[] }>('GET', `/api/boards/${boardId}/notifications`).then((r) => r.value),
  dismissNotification: (boardId: number, id: string) =>
    request<object>('POST', `/api/boards/${boardId}/notifications/dismiss`, { id }),
  startAwsSignIn: () => request<object>('POST', '/api/aws-sign-in'),
  authConfig: () => request<{ mode: 'dev' | 'cognito' }>('GET', '/auth/config'),
  devLogin: (email: string, returnTo?: string) =>
    request<{ email: string; returnTo: string }>('POST', '/auth/dev-login', { email, returnTo }),
  logout: () => request<object>('POST', '/auth/logout'),
  me: () => request<Me>('GET', '/api/me'),
  /** Records that you opened the board (server time); the bar is unchanged. */
  openBoard: (id: number) => request<{ sessions: BoardSession[] }>('POST', `/api/boards/${id}/viewed`),
  addSession: (id: number) => request<{ sessions: BoardSession[] }>('PUT', `/api/boards/${id}/session`),
  removeSession: (id: number) => request<{ sessions: BoardSession[] }>('DELETE', `/api/boards/${id}/session`),

  createBoard: (input: { name: string; repo: string | null; baseBranch: string; timeZone: string; environments: Environment[] }) =>
    request<Board>('POST', '/api/boards', input),
  board: (id: number) => request<BoardView>('GET', `/api/boards/${id}`),
  updateSettings: (id: number, version: number, settings: Partial<Board>) =>
    request<Board>('PATCH', `/api/boards/${id}/settings`, { ...settings, version }),
  /** This month's LLM spend (every board model call, by source) in the board's time zone. */
  spend: (id: number) => request<MonthSpendView>('GET', `/api/boards/${id}/spend`),
  members: (id: number) => request<Member[]>('GET', `/api/boards/${id}/members`),
  setMember: (id: number, email: string, role: Role) =>
    request<Member>('POST', `/api/boards/${id}/members`, { email, role }),
  removeMember: (id: number, email: string) =>
    request<object>('DELETE', `/api/boards/${id}/members/${encodeURIComponent(email)}`),

  globs: (boardId: number) => request<GlobView[]>('GET', `/api/boards/${boardId}/globs`),
  signedOffCount: (boardId: number) => request<{ total: number }>('GET', `/api/boards/${boardId}/signed-off/count`).then((r) => r.total),
  signedOff: (boardId: number, cursor: string | null) =>
    request<{ globs: GlobView[]; next: string | null }>(
      'GET',
      `/api/boards/${boardId}/signed-off${cursor === null ? '' : `?cursor=${cursor}`}`,
    ),
  glob: (id: string) => request<GlobView>('GET', `/api/globs/${id}`),
  /** The board's readiness checklist. */
  readiness: (boardId: number) => request<{ items: ReadinessItem[] }>('GET', `/api/boards/${boardId}/readiness`).then((r) => r.items),
  /** Deploy indicators for the given globs, and the environments with a deploy running. */
  boardDeploys: (boardId: number, globIds: readonly string[]) =>
    request<BoardDeploys>('GET', `/api/boards/${boardId}/deploys?globs=${globIds.map(encodeURIComponent).join(',')}`),
  globEnvironments: (id: string) =>
    request<{ value: GlobEnvironment[] }>('GET', `/api/globs/${id}/environments`).then((r) => r.value),
  globTests: (id: string) => request<{ value: AtfRun[] }>('GET', `/api/globs/${id}/tests`).then((r) => r.value),
  searchBoard: (boardId: number, q: string, history: boolean) =>
    request<{ value: BoardSearchResult }>(
      'GET',
      `/api/boards/${boardId}/search?q=${encodeURIComponent(q)}${history ? '&history=1' : ''}`,
    ).then((r) => r.value),
  chats: (boardId: number) => request<{ chats: ChatThread[] }>('GET', `/api/boards/${boardId}/chats`).then((r) => r.chats),
  chatMessages: (boardId: number, chat: number) => request<{ messages: ChatMessage[] }>('GET', `/api/boards/${boardId}/chats/${chat}`).then((r) => r.messages),
  deleteChat: (boardId: number, chat: number) => request<{ ok: boolean }>('DELETE', `/api/boards/${boardId}/chats/${chat}`),
  /** Save to knowledge: the answer goes to the proposal queue; `glob` is the source when the answer cites none. */
  saveChatAnswer: (boardId: number, chat: number, message: number, glob?: string) =>
    request<{ id: string }>('POST', `/api/boards/${boardId}/chats/${chat}/messages/${message}/save`, glob === undefined ? {} : { glob }),
  askChat: (boardId: number, input: ChatQuestion, stream?: ChatStream) => (stream === undefined ? request<ChatReply>('POST', `/api/boards/${boardId}/chat`, input) : askChatStream(boardId, input, stream)),
  globDeploys: (id: string) => request<{ value: Deploy[] }>('GET', `/api/globs/${id}/deploys`).then((r) => r.value),
  deployNow: (id: string) => request<{ value: Deploy | null }>('POST', `/api/globs/${id}/deploy-now`).then((r) => r.value),
  createGlob: (boardId: number, input: NewGlob) =>
    request<GlobView>('POST', `/api/boards/${boardId}/globs`, { ...input, idempotencyKey: input.idempotencyKey ?? crypto.randomUUID() }),
  updateGlob: (id: string, version: number, changes: GlobChanges) =>
    request<GlobView>('PATCH', `/api/globs/${id}`, { ...changes, version }),
  deleteGlob: (id: string, version: number) => request<object>('DELETE', `/api/globs/${id}`, { version }),
  action: (id: string, action: ActionPath, version: number, anyway?: boolean) =>
    request<GlobView>('POST', `/api/globs/${id}/actions/${action}`, anyway === true ? { version, anyway } : { version }),
  intake: (boardId: number, text: string) =>
    request<IntakeProposalView>('POST', `/api/boards/${boardId}/intake`, { text }),
  intakeAccuracy: (boardId: number) => request<IntakeAccuracy>('GET', `/api/boards/${boardId}/intake-accuracy`),
  repoConnection: (boardId: number) =>
    request<{ repo: string | null; configured: boolean; connected: boolean; installUrl: string | null; appName: string | null }>(
      'GET',
      `/api/boards/${boardId}/repo-connection`,
    ),
  knowledge: (boardId: number) => request<KnowledgeIndex>('GET', `/api/boards/${boardId}/kb`),
  /** The generated page; null when the server has no such endpoint (404), so the section is just hidden. */
  knowledgePage: (boardId: number): Promise<KnowledgePageView | null> =>
    request<KnowledgePageView>('GET', `/api/boards/${boardId}/knowledge-page`).catch((e: unknown) => {
      if (e instanceof RequestError && e.status === 404) return null;
      throw e;
    }),
  knowledgePageVersion: (boardId: number, version: number) =>
    request<KnowledgePageVersion>('GET', `/api/boards/${boardId}/knowledge-page/versions/${version}`),
  rebuildKnowledgePage: (boardId: number) =>
    request<{ queued?: boolean }>('POST', `/api/boards/${boardId}/knowledge-page/rebuild`),
  /** Pins the decisions as key, marks them not key, or undoes the verdict (null). */
  knowledgePageFeedback: (boardId: number, globIds: readonly string[], verdict: KnowledgePageVerdict | null) =>
    request<{ updated: number }>('POST', `/api/boards/${boardId}/knowledge-page/feedback`, { globIds, verdict }),
  knowledgeDoc: (boardId: number, name: string) =>
    request<{ name: string; content: string; version: number }[]>('GET', `/api/boards/${boardId}/kb/docs/${encodeURIComponent(name)}`),
  catalog: () => request<CatalogEntry[]>('GET', '/api/catalog/kb'),
  importCatalog: (boardId: number, ids: string[]) =>
    request<ImportResult>('POST', `/api/boards/${boardId}/kb/catalog-imports`, { ids }),
  upload: (boardId: number, documents: { fileName: string; content: string }[]) =>
    request<ImportResult>('POST', `/api/boards/${boardId}/kb/uploads`, { documents }),
  agentSetFile: (boardId: number, path: string) =>
    request<AgentSetFileView>('GET', `/api/boards/${boardId}/kb/agent-set/file?path=${encodeURIComponent(path)}`),
  useCatalogVersion: (boardId: number, path: string, overlay = '') =>
    request<{ version: number }>('POST', `/api/boards/${boardId}/kb/agent-set/use-catalog`, { path, overlay }),
  /** Keeps an open learning's statement as an approved learning, without applying it to any document (admins). */
  // The /api/kb/* calls take the item's version, which is the decision glob's version.
  keepAsLearning: (id: string, version: number, statement: string, watchSignal?: string) =>
    request<unknown>('POST', `/api/kb/${id}/approve`, {
      as: 'learning',
      version,
      statement,
      ...(watchSignal === undefined ? {} : { watchSignal }),
    }),
  /** Sends a learning the pipeline gave up on back to routing or drafting (admins). */
  retryProposal: (id: string, version: number) => request<unknown>('POST', `/api/kb/${id}/retry`, { version }),
  /** Marks a learning weekly consolidation flagged stale as not stale (admins). */
  keepProposal: (id: string, version: number) => request<unknown>('POST', `/api/kb/${id}/keep`, { version }),
  boardJobs: (boardId: number) => request<BoardJobStatus[]>('GET', `/api/boards/${boardId}/kb/jobs`),
  runBoardJob: (boardId: number, job: BoardJob['job']) => request<BoardJob>('POST', `/api/boards/${boardId}/kb/jobs/${job}/run`),
  /** The board's signals as measured now: what an approval of a submitted item can watch (admins). */
  boardSignals: (boardId: number) => request<KbSignal[]>('GET', `/api/boards/${boardId}/kb/signals`),
  /** The board's learned sub size limit, its bounds and its history (members). */
  subLimit: (boardId: number) => request<SubLimitResponse>('GET', `/api/boards/${boardId}/sub-limit`),
  /** The board's dependency rules (learned over catalog defaults) and their history (members). */
  dependencyRules: (boardId: number) => request<DependencyRulesView>('GET', `/api/boards/${boardId}/dependency-rules`),
  /** Drops what the board learned for one pattern, or for all of them (admins). */
  resetDependencyRules: (boardId: number, pattern?: string) =>
    request<null>('POST', `/api/boards/${boardId}/dependency-rules/reset`, pattern === undefined ? {} : { pattern }),
  /** The board's risk areas (learned and default) and their history (members). */
  riskAreas: (boardId: number) => request<RiskAreaView>('GET', `/api/boards/${boardId}/risk-areas`),
  /** Drops the learned risk areas and restores the defaults (admins). */
  resetRiskAreas: (boardId: number) => request<RiskAreaView>('POST', `/api/boards/${boardId}/risk-areas/reset`, {}),
  /** What intake learned from people's retypes, or the catalog defaults (members). */
  typeLearning: (boardId: number) => request<TypeLearningResponse>('GET', `/api/boards/${boardId}/type-learning`),
  /** Forgets the board's type corrections: intake goes back to the defaults; the history stays (admins). */
  resetTypeLearning: (boardId: number) => request<TypeLearningResponse>('POST', `/api/boards/${boardId}/type-learning/reset`, {}),
  /** The board's escalation criteria (learned vs default) and the outcome history (members). */
  escalations: (boardId: number) => request<EscalationView>('GET', `/api/boards/${boardId}/escalations`),
  /** Puts the escalation criteria back to the defaults, keeping the history (admins). */
  resetEscalations: (boardId: number) => request<EscalationView>('POST', `/api/boards/${boardId}/escalations/reset`, {}),
  /** The board's learned size threshold (oversized flag), its bounds and its history (members). */
  sizeThreshold: (boardId: number) => request<SizeThresholdView>('GET', `/api/boards/${boardId}/size-threshold`),
  /** The size forecast's calibration: weights, per-area factors against the defaults, and the history with causes (members). */
  sizeCalibration: (boardId: number) => request<SizeCalibrationView>('GET', `/api/boards/${boardId}/size-calibration`),
  /** Admins: puts the size threshold back on the defaults (the history keeps the reset). */
  resetSizeThreshold: (boardId: number) => request<SizeThresholdView>('POST', `/api/boards/${boardId}/size-threshold/reset`, {}),
  /** What agents were handed, what became of the choices and the context settings with their history (members). */
  contextReport: (boardId: number) => request<ContextReport>('GET', `/api/boards/${boardId}/context-report`),
  /** Admins: puts one context setting back on its default (the history keeps the reset). */
  resetContextSetting: (boardId: number, key: string) =>
    request<ContextSettingsView>('POST', `/api/boards/${boardId}/context-settings/${encodeURIComponent(key)}/reset`, {}),
  /** Keep whole: the glob stays one glob; a glob held for the flag starts. */
  keepWhole: (id: string) => request<GlobView>('POST', `/api/globs/${id}/keep-whole`, {}),
  /** Whether the board has an active integration token (members); the secret is never returned here. */
  integrationToken: (boardId: number) =>
    request<{ active: boolean; createdAt: string | null }>('GET', `/api/boards/${boardId}/integration-token`),
  /** Makes a token (admins), revoking the old one; the response carries the secret, once. */
  createIntegrationToken: (boardId: number) =>
    request<{ token: string; createdAt: string }>('POST', `/api/boards/${boardId}/integration-token`),
  revokeIntegrationToken: (boardId: number) =>
    request<{ active: boolean; createdAt: string | null }>('DELETE', `/api/boards/${boardId}/integration-token`),
  /** A board's time reports: the work time zone and whether the caller may download (reports are computed when downloaded). */
  reports: (boardId: number) => request<ReportsView>('GET', `/api/boards/${boardId}/reports`),
  /** One period's report as JSON (its CSV inside), so a refusal comes back as an error rather than a saved file. */
  report: (boardId: number, period: string) =>
    request<ReportFile>('GET', `/api/boards/${boardId}/reports/${encodeURIComponent(period)}`),
  plan: (id: string) =>
    request<{ current: ArtifactView | null; versions: { version: number; createdAt: string; by: string }[] }>(
      'GET',
      `/api/globs/${id}/plan`,
    ),
  /** Cuts a glob in Planning into parts; the first keeps the glob's ID. */
  splitGlob: (id: string, version: number, parts: SplitPartInput[], idempotencyKey: string) =>
    request<{ parts: GlobView[] }>('POST', `/api/globs/${id}/split`, { version, idempotencyKey, parts }),
  savePlan: (id: string, content: string) => request<ArtifactView>('PUT', `/api/globs/${id}/plan`, { content }),
  artifacts: (id: string) => request<ArtifactView[]>('GET', `/api/globs/${id}/artifacts`),
  artifactVersions: (id: string, kind: ArtifactKind, label: string) =>
    request<ArtifactView[]>('GET', `/api/globs/${id}/artifacts/${kind}?label=${encodeURIComponent(label)}`),
  /** Decision globs: the outcome of a decision in Doing. */
  decide: (id: string, version: number, input: DecideInput) => request<GlobView>('POST', `/api/globs/${id}/decision`, { ...input, version }),
  /** Decision globs: the proposed change against the target as it is now. */
  globDiff: (id: string) => request<GlobDiff>('GET', `/api/globs/${id}/diff`),
  /** Decision globs: writes or refreshes the assessment. */
  assess: (id: string) => request<{ kind: ArtifactKind; version: number; content: string }>('POST', `/api/globs/${id}/assessment`, {}),
  /** Inbox: promotes an item to a decision glob in Planning (idempotent). */
  promoteInbox: (boardId: number, id: number) =>
    request<{ glob: GlobView; item: InboxItemView }>('POST', `/api/boards/${boardId}/inbox/${id}/promote`, {}),
  /** Promotes an extracted decision to a decision glob in Planning (idempotent). */
  promoteDecision: (boardId: number, id: number) => request<{ glob: GlobView }>('POST', `/api/boards/${boardId}/decisions/${id}/promote`, {}),
  findings: (id: string) => request<GlobFindings>('GET', `/api/globs/${id}/findings`),
  /** The decisions taken on a glob, newest first, with what replaced them. */
  decisions: (boardId: number, id: string) => request<{ decisions: DecisionView[] }>('GET', `/api/boards/${boardId}/globs/${id}/decisions`),
  /** A replacement card (a decision glob asking "did X replace Y?"): Confirm applies the replacement, Dismiss keeps both and blocks the pair. */
  decideReplacement: (boardId: number, globId: string, outcome: 'confirm' | 'dismiss', reason?: string) =>
    request<unknown>('POST', `/api/boards/${boardId}/globs/${globId}/replacement`, { outcome, ...(reason === undefined ? {} : { reason }) }),
  /** Confirms a proposed replacement (the older decision becomes superseded). */
  confirmDecision: (boardId: number, id: number) => request<DecisionView>('POST', `/api/boards/${boardId}/decisions/${id}/confirm`),
  /** Undoes a replacement, or dismisses a proposed one. */
  undoDecision: (boardId: number, id: number) => request<DecisionView>('POST', `/api/boards/${boardId}/decisions/${id}/undo`),
  /** The board's inbox: new, attached and kept items (newest first), or the ones with `status` (e.g. `archived`, the imported ones). */
  inbox: (boardId: number, status?: InboxStatus) =>
    request<{ items: InboxItemView[] }>('GET', `/api/boards/${boardId}/inbox${status === undefined ? '' : `?status=${status}`}`).then((r) => r.items),
  inboxItem: (boardId: number, id: number) => request<InboxItemView>('GET', `/api/boards/${boardId}/inbox/${id}`),
  addToInbox: (boardId: number, paste: NewInboxPaste) => request<{ id: number; created: boolean }>('POST', `/api/boards/${boardId}/inbox`, paste),
  attachInbox: (boardId: number, id: number, globIds: readonly string[]) =>
    request<InboxItemView>('POST', `/api/boards/${boardId}/inbox/${id}/attach`, { globIds }),
  /** The glob already made from this item (Create glob), or null. */
  inboxGlob: (boardId: number, id: number) => request<{ globId: string | null }>('GET', `/api/boards/${boardId}/inbox/${id}/glob`),
  detachInbox: (boardId: number, id: number, globIds: readonly string[]) =>
    request<InboxItemView>('POST', `/api/boards/${boardId}/inbox/${id}/detach`, { globIds }),
  keepInbox: (boardId: number, id: number) => request<InboxItemView>('POST', `/api/boards/${boardId}/inbox/${id}/keep`),
  discardInbox: (boardId: number, id: number) => request<InboxItemView>('POST', `/api/boards/${boardId}/inbox/${id}/discard`),
  /** Sign-off labels and their review checklists: submit items, approve, tick, resubmit, re-open. */
  reviewLabel: (id: string, label: LabelName, command: LabelCommand, version: number) =>
    request<GlobView>('POST', `/api/globs/${id}/labels/${label}`, { command, version }),
};

export const ACTION_PATHS: Record<Action, ActionPath | null> = {
  start: 'start',
  investigate: 'investigate',
  review_now: 'review-now',
  start_anyway: 'start-anyway',
  pick_up: 'pick-up',
  take_over: 'take-over',
  retrigger: 'retrigger',
  retry_autofix: 'retry-autofix',
  resolve_conflict: 'resolve-conflict',
  start_again: 'start-again',
  merge: 'merge',
  retry_merge: 'retry-merge',
  deescalate: 'deescalate',
  make_super: 'make-super',
  merge_continue: 'merge-continue',
  mark_ready: 'mark-ready',
  // The outcome has its own dialog and route (api.decide).
  decide: null,
  sign_off: 'sign-off',
  reopen: 'reopen',
  delete: null,
};

export const ACTION_LABELS: Record<Action, string> = {
  start: 'Start',
  investigate: 'Investigate',
  review_now: 'Get AI review',
  start_anyway: 'Start anyway',
  pick_up: 'Pick up',
  take_over: 'Take over',
  retrigger: 'Re-trigger',
  retry_autofix: 'Retry auto-fix',
  resolve_conflict: 'Resolve conflict',
  start_again: 'Start again',
  merge: 'Merge',
  retry_merge: 'Retry merge',
  deescalate: 'Make it a sub again',
  make_super: 'Make it a super',
  merge_continue: 'Merge and continue',
  mark_ready: 'Mark done (PR ready)',
  decide: 'Decide',
  sign_off: 'Sign off',
  reopen: 'Reopen',
  delete: 'Delete',
};
