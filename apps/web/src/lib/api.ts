import type {
  Action,
  AgentSetEntry,
  AgentSetFileView,
  Approval,
  ArtifactKind,
  ArtifactSummary,
  Board,
  BoardJob,
  BoardJobStatus,
  CatalogUpdate,
  Category,
  CodeReviewBadge,
  GlobCodeReview,
  Deploy,
  DeployIndicator,
  AtfIndicator,
  EnvironmentIndicator,
  GlobEnvironment,
  ReadinessItem,
  Environment,
  Glob,
  GlobFindings,
  KbItem,
  KbProposalList,
  KbSignal,
  LabelCommand,
  LocalRunView,
  LabelName,
  List,
  Member,
  Role,
  Run,
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

const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) throw new RequestError(response.status, data as ApiError);
  return data as T;
};

export interface NewGlob {
  title: string;
  summary: string;
  type: SlopType;
  category: Category;
  group: string | null;
  environment: string | null;
  autoTrigger: boolean;
}

export type GlobChanges = Partial<Pick<Glob, 'title' | 'summary' | 'type' | 'category' | 'group' | 'environment'>>;

export type ActionPath =
  | 'start'
  | 'retrigger'
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

export const healthKey = ['health'] as const;

export const api = {
  health: () => request<IntegrationHealthView>('GET', '/api/health'),
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
    request<NewGlob & { autoTriggerReason: string | null }>('POST', `/api/boards/${boardId}/intake`, { text }),
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
  plan: (id: string) =>
    request<{ current: ArtifactView | null; versions: { version: number; createdAt: string; by: string }[] }>(
      'GET',
      `/api/globs/${id}/plan`,
    ),
  savePlan: (id: string, content: string) => request<ArtifactView>('PUT', `/api/globs/${id}/plan`, { content }),
  artifacts: (id: string) => request<ArtifactView[]>('GET', `/api/globs/${id}/artifacts`),
  artifactVersions: (id: string, kind: ArtifactKind, label: string) =>
    request<ArtifactView[]>('GET', `/api/globs/${id}/artifacts/${kind}?label=${encodeURIComponent(label)}`),
  findings: (id: string) => request<GlobFindings>('GET', `/api/globs/${id}/findings`),
  /** Sign-off labels and their review checklists: submit items, approve, tick, resubmit, re-open. */
  reviewLabel: (id: string, label: LabelName, command: LabelCommand, version: number) =>
    request<GlobView>('POST', `/api/globs/${id}/labels/${label}`, { command, version }),
};

export const ACTION_PATHS: Record<Action, ActionPath | null> = {
  start: 'start',
  pick_up: 'pick-up',
  take_over: 'take-over',
  retrigger: 'retrigger',
  resolve_conflict: 'resolve-conflict',
  start_again: 'start-again',
  merge: 'merge',
  merge_continue: 'merge-continue',
  mark_ready: 'mark-ready',
  delete: null,
};

export const ACTION_LABELS: Record<Action, string> = {
  start: 'Start',
  pick_up: 'Pick up',
  take_over: 'Take over',
  retrigger: 'Re-trigger',
  resolve_conflict: 'Resolve conflict',
  start_again: 'Start again',
  merge: 'Merge',
  merge_continue: 'Merge and continue',
  mark_ready: 'Ready for review',
  delete: 'Delete',
};
