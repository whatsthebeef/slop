import type {
  Action,
  AwaitedDependency,
  AgentSetEntry,
  AgentSetFileView,
  Approval,
  ArtifactKind,
  ArtifactSummary,
  Board,
  BoardNotification,
  BoardJob,
  BoardJobStatus,
  CatalogUpdate,
  Category,
  ChatCitation,
  ChatMessage,
  CodeReviewBadge,
  Confidence,
  IntakeAccuracy,
  IntakeExample,
  GlobCodeReview,
  DecisionView,
  Deploy,
  DeployIndicator,
  AtfIndicator,
  EnvironmentIndicator,
  GlobEnvironment,
  ReadinessItem,
  Environment,
  Glob,
  GlobFindings,
  InboxStatus,
  KbItem,
  KbProposalList,
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
  SlopType,
  SubLimitView,
  TargetChange,
} from '@slop/core';

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
  /** Set when the glob came from a split: the glob that was cut, this one's place (0 is the original) and every part's ID. */
  readonly split?: { readonly source: string; readonly part: number; readonly parts: readonly string[] };
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
}

export interface KnowledgeIndex {
  readonly documents: readonly {
    readonly name: string;
    readonly area: string | null;
    readonly audience: readonly string[];
    readonly description: string;
    readonly version: number;
    readonly source: string;
  }[];
  readonly agentSet: {
    readonly version: number;
    /** The paths served. */
    readonly files: readonly string[];
    /** Every path with how it is served, orphaned overlays included. */
    readonly entries: readonly AgentSetEntry[];
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
  readonly provenance: { readonly by: string; readonly actor: string };
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly current?: GlobView;
  /** A KB item's version conflict carries the item as it is now. */
  readonly currentItem?: KbItem;
  readonly allowedActions?: readonly string[];
  /** `llm_unavailable` only: what is wrong with the model, and what to do. */
  readonly reason?: string;
  readonly fix?: string;
}

/** An ATF run as the API sends it; `id` is optional because an older server doesn't send it. */
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

/** One question to the board chat; the scope fields are optional. */
export interface ChatQuestion {
  readonly question: string;
  readonly history?: boolean;
  readonly glob?: string;
  readonly group?: string;
}

/** The chat's reply to a question (`answered` false: the board's records don't answer it). */
export interface ChatReply {
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
  /** IDs of globs on the board to start after. */
  after?: string[];
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
}

export type GlobChanges = Partial<Pick<Glob, 'title' | 'summary' | 'type' | 'category' | 'group' | 'environment' | 'after'>>;

export type ActionPath =
  | 'start'
  | 'start-anyway'
  | 'retrigger'
  | 'retry-autofix'
  | 'resolve-conflict'
  | 'pick-up'
  | 'take-over'
  | 'start-again'
  | 'merge'
  | 'merge-continue'
  | 'mark-ready';

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
  me: () => request<{ email: string; boards: BoardView[] }>('GET', '/api/me'),

  createBoard: (input: { name: string; repo: string | null; baseBranch: string; timeZone: string; environments: Environment[] }) =>
    request<Board>('POST', '/api/boards', input),
  board: (id: number) => request<BoardView>('GET', `/api/boards/${id}`),
  updateSettings: (id: number, version: number, settings: Partial<Board>) =>
    request<Board>('PATCH', `/api/boards/${id}/settings`, { ...settings, version }),
  members: (id: number) => request<Member[]>('GET', `/api/boards/${id}/members`),
  setMember: (id: number, email: string, role: Role) =>
    request<Member>('POST', `/api/boards/${id}/members`, { email, role }),
  removeMember: (id: number, email: string) =>
    request<object>('DELETE', `/api/boards/${id}/members/${encodeURIComponent(email)}`),

  globs: (boardId: number) => request<GlobView[]>('GET', `/api/boards/${boardId}/globs`),
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
  /** CodeRabbit's badge per glob (inline comment count and review link); globs with nothing stored are left out. */
  boardCodeReviews: (boardId: number, globIds: readonly string[]) =>
    request<{ value: Partial<Record<string, CodeReviewBadge>> }>(
      'GET',
      `/api/boards/${boardId}/code-reviews?globs=${globIds.map(encodeURIComponent).join(',')}`,
    ).then((r) => r.value),
  searchBoard: (boardId: number, q: string, history: boolean) =>
    request<{ value: BoardSearchResult }>(
      'GET',
      `/api/boards/${boardId}/search?q=${encodeURIComponent(q)}${history ? '&history=1' : ''}`,
    ).then((r) => r.value),
  chatHistory: (boardId: number) => request<{ messages: ChatMessage[] }>('GET', `/api/boards/${boardId}/chat`).then((r) => r.messages),
  askChat: (boardId: number, input: ChatQuestion) => request<ChatReply>('POST', `/api/boards/${boardId}/chat`, input),
  clearChat: (boardId: number) => request<{ ok: boolean }>('DELETE', `/api/boards/${boardId}/chat`),
  globCodeReview: (id: string) => request<{ value: GlobCodeReview }>('GET', `/api/globs/${id}/code-review`).then((r) => r.value),
  globDeploys: (id: string) => request<{ value: Deploy[] }>('GET', `/api/globs/${id}/deploys`).then((r) => r.value),
  deployNow: (id: string) => request<{ value: Deploy | null }>('POST', `/api/globs/${id}/deploy-now`).then((r) => r.value),
  createGlob: (boardId: number, input: NewGlob) =>
    request<GlobView>('POST', `/api/boards/${boardId}/globs`, { ...input, idempotencyKey: crypto.randomUUID() }),
  updateGlob: (id: string, version: number, changes: GlobChanges) =>
    request<GlobView>('PATCH', `/api/globs/${id}`, { ...changes, version }),
  deleteGlob: (id: string, version: number) => request<object>('DELETE', `/api/globs/${id}`, { version }),
  action: (id: string, action: ActionPath, version: number) =>
    request<GlobView>('POST', `/api/globs/${id}/actions/${action}`, { version }),
  intake: (boardId: number, text: string) =>
    request<IntakeProposalView>('POST', `/api/boards/${boardId}/intake`, { text }),
  intakeAccuracy: (boardId: number) => request<IntakeAccuracy>('GET', `/api/boards/${boardId}/intake-accuracy`),
  repoConnection: (boardId: number) =>
    request<{ repo: string | null; configured: boolean; connected: boolean; installUrl: string | null; appName: string | null }>(
      'GET',
      `/api/boards/${boardId}/repo-connection`,
    ),
  knowledge: (boardId: number) => request<KnowledgeIndex>('GET', `/api/boards/${boardId}/kb`),
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
  proposals: (boardId: number, limit: number) =>
    request<KbProposalList>('GET', `/api/boards/${boardId}/kb/proposals?limit=${limit}`),
  approveProposal: (id: string, version: number, approval: Approval) =>
    request<KbItem>('POST', `/api/kb/${id}/approve`, { ...approval, version }),
  changeProposalTarget: (id: string, version: number, target: TargetChange) =>
    request<KbItem>('POST', `/api/kb/${id}/target`, { version, target }),
  retryProposal: (id: string, version: number) => request<KbItem>('POST', `/api/kb/${id}/retry`, { version }),
  reopenProposal: (id: string, version: number) => request<KbItem>('POST', `/api/kb/${id}/reopen`, { version }),
  keepProposal: (id: string, version: number) => request<KbItem>('POST', `/api/kb/${id}/keep`, { version }),
  rejectProposal: (id: string, version: number, reason: string) =>
    request<KbItem>('POST', `/api/kb/${id}/reject`, { version, reason }),
  boardJobs: (boardId: number) => request<BoardJobStatus[]>('GET', `/api/boards/${boardId}/kb/jobs`),
  runBoardJob: (boardId: number, job: BoardJob['job']) => request<BoardJob>('POST', `/api/boards/${boardId}/kb/jobs/${job}/run`),
  /** The board's signals as measured now: what an approval of a submitted item can watch (admins). */
  boardSignals: (boardId: number) => request<KbSignal[]>('GET', `/api/boards/${boardId}/kb/signals`),
  /** The board's learned sub size limit, its bounds and its history (members). */
  subLimit: (boardId: number) => request<SubLimitView>('GET', `/api/boards/${boardId}/sub-limit`),
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
  findings: (id: string) => request<GlobFindings>('GET', `/api/globs/${id}/findings`),
  /** The decisions taken on a glob, newest first, with what replaced them. */
  decisions: (boardId: number, id: string) => request<{ decisions: DecisionView[] }>('GET', `/api/boards/${boardId}/globs/${id}/decisions`),
  /** Confirms a proposed replacement (the older decision becomes superseded). */
  confirmDecision: (boardId: number, id: number) => request<DecisionView>('POST', `/api/boards/${boardId}/decisions/${id}/confirm`),
  /** Undoes a replacement, or dismisses a proposed one. */
  undoDecision: (boardId: number, id: number) => request<DecisionView>('POST', `/api/boards/${boardId}/decisions/${id}/undo`),
  /** The board's inbox: new, attached and kept items (newest first). */
  inbox: (boardId: number) => request<{ items: InboxItemView[] }>('GET', `/api/boards/${boardId}/inbox`).then((r) => r.items),
  inboxItem: (boardId: number, id: number) => request<InboxItemView>('GET', `/api/boards/${boardId}/inbox/${id}`),
  addToInbox: (boardId: number, paste: NewInboxPaste) => request<{ id: number; created: boolean }>('POST', `/api/boards/${boardId}/inbox`, paste),
  attachInbox: (boardId: number, id: number, globIds: readonly string[]) =>
    request<InboxItemView>('POST', `/api/boards/${boardId}/inbox/${id}/attach`, { globIds }),
  keepInbox: (boardId: number, id: number) => request<InboxItemView>('POST', `/api/boards/${boardId}/inbox/${id}/keep`),
  discardInbox: (boardId: number, id: number) => request<InboxItemView>('POST', `/api/boards/${boardId}/inbox/${id}/discard`),
  /** Sign-off labels and their review checklists: submit items, approve, tick, resubmit, re-open. */
  reviewLabel: (id: string, label: LabelName, command: LabelCommand, version: number) =>
    request<GlobView>('POST', `/api/globs/${id}/labels/${label}`, { command, version }),
};

export const ACTION_PATHS: Record<Action, ActionPath | null> = {
  start: 'start',
  start_anyway: 'start-anyway',
  pick_up: 'pick-up',
  take_over: 'take-over',
  retrigger: 'retrigger',
  retry_autofix: 'retry-autofix',
  resolve_conflict: 'resolve-conflict',
  start_again: 'start-again',
  merge: 'merge',
  merge_continue: 'merge-continue',
  mark_ready: 'mark-ready',
  delete: null,
};

export const ACTION_LABELS: Record<Action, string> = {
  start: 'Start',
  start_anyway: 'Start anyway',
  pick_up: 'Pick up',
  take_over: 'Take over',
  retrigger: 'Re-trigger',
  retry_autofix: 'Retry auto-fix',
  resolve_conflict: 'Resolve conflict',
  start_again: 'Start again',
  merge: 'Merge',
  merge_continue: 'Merge and continue',
  mark_ready: 'Ready for review',
  delete: 'Delete',
};
