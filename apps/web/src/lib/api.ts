import type {
  Action,
  Board,
  Category,
  Environment,
  Glob,
  LabelName,
  LabelState,
  List,
  Member,
  Role,
  Run,
  SlopType,
} from '@slop/core';

export interface GlobView extends Glob {
  readonly list: List;
  readonly branch: string;
  readonly currentRun: Run | null;
  readonly allowedActions?: readonly Action[];
}

export interface BoardView extends Board {
  readonly role: Role;
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
  readonly agentSet: { readonly version: number; readonly files: readonly string[] };
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
  readonly kind: string;
  readonly label: string;
  readonly version: number;
  readonly content: string;
  readonly link: string | null;
  readonly createdAt: string;
  readonly provenance: { readonly by: string; readonly actor: string };
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly current?: GlobView;
  readonly allowedActions?: readonly string[];
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

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

export type ActionPath = 'start' | 'retrigger' | 'pick-up' | 'take-over' | 'start-again' | 'merge';

export const api = {
  authConfig: () => request<{ mode: 'dev' | 'cognito' }>('GET', '/auth/config'),
  devLogin: (email: string) => request<{ email: string }>('POST', '/auth/dev-login', { email }),
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
  createGlob: (boardId: number, input: NewGlob) =>
    request<GlobView>('POST', `/api/boards/${boardId}/globs`, { ...input, idempotencyKey: crypto.randomUUID() }),
  updateGlob: (id: string, version: number, changes: GlobChanges) =>
    request<GlobView>('PATCH', `/api/globs/${id}`, { ...changes, version }),
  deleteGlob: (id: string, version: number) => request<object>('DELETE', `/api/globs/${id}`, { version }),
  action: (id: string, action: ActionPath, version: number) =>
    request<GlobView>('POST', `/api/globs/${id}/actions/${action}`, { version }),
  knowledge: (boardId: number) => request<KnowledgeIndex>('GET', `/api/boards/${boardId}/kb`),
  knowledgeDoc: (boardId: number, name: string) =>
    request<{ name: string; content: string; version: number }[]>('GET', `/api/boards/${boardId}/kb/docs/${encodeURIComponent(name)}`),
  catalog: () => request<CatalogEntry[]>('GET', '/api/catalog/kb'),
  importCatalog: (boardId: number, ids: string[]) =>
    request<ImportResult>('POST', `/api/boards/${boardId}/kb/catalog-imports`, { ids }),
  upload: (boardId: number, documents: { fileName: string; content: string }[]) =>
    request<ImportResult>('POST', `/api/boards/${boardId}/kb/uploads`, { documents }),
  forkAgentSet: (boardId: number) => request<ImportResult>('POST', `/api/boards/${boardId}/kb/agent-set/fork`),
  plan: (id: string) =>
    request<{ current: ArtifactView | null; versions: { version: number; createdAt: string; by: string }[] }>(
      'GET',
      `/api/globs/${id}/plan`,
    ),
  savePlan: (id: string, content: string) => request<ArtifactView>('PUT', `/api/globs/${id}/plan`, { content }),
  artifacts: (id: string) => request<ArtifactView[]>('GET', `/api/globs/${id}/artifacts`),
  setLabel: (id: string, label: LabelName, state: LabelState, version: number) =>
    request<GlobView>('PUT', `/api/globs/${id}/labels/${label}`, { state, version }),
};

export const ACTION_PATHS: Record<Action, ActionPath | null> = {
  start: 'start',
  pick_up: 'pick-up',
  take_over: 'take-over',
  retrigger: 'retrigger',
  start_again: 'start-again',
  merge: 'merge',
  delete: null,
};

export const ACTION_LABELS: Record<Action, string> = {
  start: 'Start',
  pick_up: 'Pick up',
  take_over: 'Take over',
  retrigger: 'Re-trigger',
  start_again: 'Start again',
  merge: 'Merge',
  delete: 'Delete',
};
