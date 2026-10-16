import type {
  ChatFeedback,
  ChatFeedbackRating,
  ChatTestCase,
  Action,
  MachineStep,
  OpenQuestion,
  Move,
  AttachmentFile,
  AgentSetEntry,
  AgentSetFileView,
  ArtifactKind,
  ArtifactSummary,
  Board,
  BoardNotification,
  BoardSession,
  BoardJob,
  BoardJobStatus,
  Capabilities,
  ContextReport,
  ContextSettingsView,
  CatalogUpdate,
  Category,
  InferenceSource,
  Mode,
  WorkActor,
  WorkKind,
  ChatCitation,
  ChatMessage,
  Confidence,
  IntakeAccuracy,
  IntakeExample,
  DecisionDiff,
  SuggestionView,
  DecisionLearning,
  DecisionOutcomeKind,
  DecisionScope,
  DecisionView,
  Deploy,
  DeployIndicator,
  AtfIndicator,
  AtfRunnerConfig,
  AtfRunnerMethod,
  AtfSpecList,
  RunnerChange,
  RunnerInput,
  SpecStatus,
  BoardEnvironment,
  GlobEnvironment,
  MonthSpend,
  ReadinessItem,
  Environment,
  Glob,
  GlobFindings,
  GroupSummary,
  GroupView,
  RegroupResult,
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
  Handover,
  SizeThresholdView,
  SizeCalibrationView,
  SlopType,
  RiskAreaView,
  EscalationView,
  HotspotView,
  TypeLearningView,
  SubLimitChange,
  SubLimitView,
  CompactHumanStep,
  HumanStep,
  DependencyRulesView,
  Holding,
  HeldBack,
  RelationGate,
  RelationSuggestion,
  RelationUntil,
  RelationsView,
  TargetChange,
  WorkstreamsSummary,
  Handoff,
  Arm,
} from '@slop/core';
import type { PageContext } from './page-context';
import { takeSseEvents } from './sse';

/** A step on the board list is compact; a single-glob read adds the rest (read each with `?.`). */
export type ListedHumanStep = CompactHumanStep &
  Partial<
    Pick<
      HumanStep,
      | 'detail'
      | 'script'
      | 'check'
      | 'why'
      | 'permissions'
      | 'commands'
      | 'verify'
      | 'source'
      | 'doneBy'
      | 'doneAt'
      | 'dismissedReason'
    >
  >;

export interface GlobView extends Glob {
  /** Who works on the glob and how (derived on the server; read through `actorOf` and `modeOf` where a fixture may lack them). */
  readonly actor?: WorkActor;
  readonly mode?: Mode;
  readonly list: List;
  readonly branch: string;
  readonly currentRun: Run | null;
  readonly allowedActions?: readonly Action[];
  /** The latest version of each artifact (board list and glob reads; absent from some write responses). */
  readonly artifacts?: readonly ArtifactSummaryView[];
  /** Every relation of the glob that still holds something back (any gate), with the title of what it points at; computed on the server for the board list and the glob read (read with `?.`: absent on an older API). */
  readonly holding?: readonly Holding[];
  /** The glob's relations in groups: holding it back, held back by it, and no longer holding (single-glob reads only). */
  readonly relations?: RelationsView;
  /** Other globs' relations that wait for this one (board list rows; redacted for boards the viewer is not on); absent when none or on an older API. */
  readonly holdsBack?: readonly HeldBack[];
  /** Open card suggestions from the automatic relation pass; absent when none or on an older API. */
  readonly suggestions?: readonly RelationSuggestion[];
  /** Open and answered questions (the "the AI is unsure" marker); absent on an older API or when the glob has none (read with `?.`). */
  readonly questions?: readonly OpenQuestion[];
  /** Set when the glob came from a split: the glob that was cut, this one's place (0 is the original) and every part's ID. */
  readonly split?: { readonly source: string; readonly part: number; readonly parts: readonly string[] };
  /** A fanned-out glob's workstreams in compact form, for the card's workstream states; absent for a small glob or an older API. */
  readonly workstreams?: WorkstreamsSummary;
  /** True while the size check flagged the glob oversized and it hasn't started (advice only; the card's chip). */
  readonly oversized?: boolean;
  /** The size check: why it was flagged, its evidence and the forecast's workstreams, advice only (single-glob reads only). */
  readonly sizeCheck?: SizeCheck;
  /** Why a person is needed and what to do first; null when nothing is wrong, absent on an older API (single-glob reads only). */
  readonly handover?: Handover | null;
  /** An open action's script (a `script:` line in its plan) and whether the base branch has it (null: could not check); null when it names none; absent on an older API and for other globs on the list. */
  readonly script?: { readonly path: string; readonly onBase: boolean | null } | null;
  /** The status messages the viewer dismissed on this glob (see `lib/dismissals.ts`); absent on an older API. */
  readonly dismissedKeys?: readonly string[];
  /** The check a sub on the board waits for (the merge policy's `subGateCheck`); absent on an older API, read as `checks`. */
  readonly gateCheck?: string;
  /** What a person must do on the glob, most pressing first: compact on the board list, in full on a single read; absent on an older API. */
  readonly humanSteps?: readonly ListedHumanStep[];
  /** Open rollout steps holding back sign-off, counted by the server (a same with any is merged with Merge and continue); absent on an older API, read with `?.`. */
  readonly rolloutSteps?: number;
  /** The "Arm system" label: the first stage with an open rollout step (an environment, or the base branch for after-merge) and that step's title; absent when no step is open or on an older API. */
  readonly arm?: Arm;
  /** Whose move it is, derived on every read (board list only; absent on an older API). */
  readonly move?: Move;
  /** What slop is doing for the glob (board list and glob read; absent on an older API). */
  readonly machineSteps?: readonly MachineStep[];
  /** Who picked the glob up, took it over or handed it to the machine, oldest first (single-glob reads only; absent on an older API). */
  readonly handoffs?: readonly Handoff[];
}

export type ArtifactSummaryView = Omit<ArtifactSummary, 'globId'>;

export interface BoardView extends Board {
  readonly role: Role;
  /** Globs on the board waiting on a person (from /api/me only). */
  readonly attention?: number;
  /** Due human steps on the board that are yours to do (from /api/me only). */
  readonly yourTurn?: number;
  /** Globs on the board with a routine run in progress (from /api/me only). */
  readonly running?: number;
  /** Globs on the board nobody is moving (from /api/me only). */
  readonly stalled?: number;
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
  readonly provenance: { readonly by: string; readonly actor: string; readonly validation?: string; readonly atfSpecs?: AtfSpecList };
  /** File attachments: the stored file's facts (state, name, type, size). */
  readonly file?: AttachmentFile | null;
}

/** What slop answers to a request for an upload link: the pending attachment and the presigned POST for its bytes. */
export interface FileUploadLink {
  readonly attachmentId: number;
  readonly label: string;
  readonly file: AttachmentFile;
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly expiresAt: string;
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
export type AtfRun = Omit<AtfIndicator, 'id'> & {
  readonly id?: number;
  readonly specs?: readonly RunSpecView[];
  /** Which runner produced the run; the server sends it only when the board has more than one (an older one never does). */
  readonly runnerName?: string;
};

/** A registered ATF runner as the API sends it; only the identity is required, so an older server's answer still renders. */
export interface AtfRunnerView {
  readonly id: number;
  readonly name: string;
  readonly method?: AtfRunnerMethod;
  readonly config?: AtfRunnerConfig;
  readonly environments?: readonly string[];
  readonly enabled?: boolean;
  readonly lastSeenAt?: string | null;
  readonly lastResultAt?: string | null;
}

/** What a created client-credentials runner is told once; the secret is never sent again. All fields optional, read with `?.`. */
export interface AtfRunnerCredentials {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly tokenUrl?: string;
  readonly scope?: string;
}

export interface AtfRunnerCreated {
  readonly value: AtfRunnerView;
  readonly credentials?: AtfRunnerCredentials;
}

export interface AtfRunnerRevoked {
  readonly value?: AtfRunnerView;
  /** Set when the runner is revoked but its client credentials could not be removed; revoking again retries. */
  readonly warning?: string;
}

/** One spec's result inside a run; absent from runs that reported counts only (and from an older server). */
export interface RunSpecView {
  readonly spec: string;
  readonly status: SpecStatus;
  readonly tests?: number;
  readonly failedTests?: number;
  readonly durationMs?: number | null;
}

/** A planned spec's latest result on a glob: `status` null (and no run) while nothing has reported it ("no result yet"). */
export interface GlobSpecResult {
  readonly spec: string;
  readonly status: SpecStatus | null;
  readonly runId?: number | null;
  readonly url?: string | null;
  readonly at?: string | null;
  readonly environment?: string | null;
  readonly sha?: string | null;
}

/** The glob's tests as the API sends them: its runs, and (when its test plan lists specs) each planned spec's latest result. */
export interface GlobTestsView {
  readonly value: AtfRun[];
  readonly specs?: readonly GlobSpecResult[];
}

/** A glob's plan.md or test plan with its version history (`current` null before the first is saved). */
export interface VersionedDocView {
  readonly current: ArtifactView | null;
  readonly versions: { version: number; createdAt: string; by: string }[];
}

export interface BoardDeploys {
  readonly indicators: Readonly<Record<string, DeployIndicator>>;
  /** Environments with a deploy running: Deploy now is disabled there for everyone. */
  readonly running: readonly string[];
  /** Each glob's ATF results: its branch run, and the runs against the environment commits holding it. Optional: an older server
   * doesn't send it, and a mismatched dev pairing (vite on a branch, API on main) must not blank the board. */
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
  /** Re-ask with the model told to use the code view ("Look at the code" under a miss). */
  readonly lookAtCode?: boolean;
}

/** One of the person's conversations on a board. */
export interface ChatThread {
  readonly id: number;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The chat's reply to a question (`answered` false: nothing cited; the reply says which with `uncited` or `miss`). */
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
  /** A line about what the chat is doing while it tries again (the text shown so far is dropped). */
  readonly onProgress?: (line: string) => void;
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
      else if (event.event === 'progress') stream.onProgress?.((data as { line: string }).line);
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
  /** plan.md v1 (intake's write-up of the request); without it the glob's plan starts as its title. */
  plan?: string;
  /** Who works on it: agents (machine) or a person (human). */
  actor: WorkActor;
  /** How: a machine's sub, same or super; a human's action (decisions come from learnings, never from the form). */
  mode: SlopType | 'action';
  /** Whether the work fixes something broken, with who set it; absent: slop infers it from the title and plan. */
  fix?: boolean;
  fixSource?: InferenceSource;
  /** R&D or maintenance for the time report, with who set it; absent: slop infers it. */
  workKind?: WorkKind;
  workKindSource?: InferenceSource;
  /** Intake's one-line reason for the two, passed back so the glob keeps it. */
  inferenceReason?: string | null;
  /** Actions only: who is meant to do it. */
  assignee?: string | null;
  /** Omitted: slop chooses one from the title and plan; null: none. */
  group?: string | null;
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
  /** Questions the intake proposal raised, sent back as given: they hold the new glob's start until a person answers. */
  questions?: { text: string; options?: string[]; blocking?: 'start' | 'none'; key?: string }[];
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
export type IntakeProposalView = Omit<NewGlob, 'group' | 'actor' | 'mode' | 'fix' | 'workKind' | 'fixSource' | 'workKindSource'> & {
  /** Intake only proposes code work, so always a type (the machine mode). */
  type: SlopType;
  /** The legacy category the fields derive: nobody picks it. */
  category: Category;
  fix: boolean;
  fixSource: InferenceSource;
  fixReason: string | null;
  workKind: WorkKind;
  workKindSource: InferenceSource;
  workKindReason: string | null;
  group: string | null;
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
  plan: string;
  category?: Category;
  type?: SlopType;
  fix?: boolean;
  workKind?: WorkKind;
  /** Indexes of earlier parts this one starts after. */
  after?: number[];
}

/** A relation to add: this glob can't pass `gate` (default start) until `to` reaches `until` (default merged; decided for a decision). */
export type AddRelationInput = {
  readonly gate?: RelationGate;
  readonly until?: RelationUntil;
  readonly reason?: string;
} & (
  | { readonly to: string; readonly version: number }
  | { readonly holdsBack: string }
  /** This glob supersedes that one (the label lands on it). */
  | { readonly supersedes: string }
);

/** An answer to an open question: a chosen option, free text, or both. */
export interface AnswerQuestionInput {
  readonly answer?: string;
  readonly option?: string;
}

export type GlobChanges = Partial<Pick<Glob, 'title' | 'type' | 'category' | 'fix' | 'workKind' | 'group' | 'environment'>> & {
  /** A decision's scope or an action's assignee, the only attributes a person edits. */
  attributes?: { scope: DecisionScope } | { assignee: string | null };
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
  | 'cancel-merge'
  | 'deescalate'
  | 'make-super'
  | 'merge-continue'
  | 'mark-ready'
  | 'sign-off'
  | 'reopen'
  | 'done'
  | 'dismiss';

/** What the board's banner shows: each integration that needs a person, and the in-app AWS sign-in (local development only). */
export interface IntegrationHealthView {
  /** What slop can verify about its own deployment; absent on an older API, and a name it can't tell is left out. */
  readonly capabilities?: Capabilities;
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

export const atfRunnersKey = (boardId: number) => ['atf-runners', boardId] as const;

export const api = {
  /** The board's ATF runners (admins only). */
  atfRunners: (boardId: number) => request<{ value?: AtfRunnerView[] }>('GET', `/api/boards/${boardId}/atf-runners`).then((r) => r.value ?? []),
  /** Registers a runner; a client-credentials one answers its credentials once (the answer isn't cacheable). */
  createAtfRunner: (boardId: number, input: RunnerInput) => request<AtfRunnerCreated>('POST', `/api/boards/${boardId}/atf-runners`, input),
  updateAtfRunner: (boardId: number, id: number, change: RunnerChange) =>
    request<{ value: AtfRunnerView }>('PATCH', `/api/boards/${boardId}/atf-runners/${id}`, change).then((r) => r.value),
  revokeAtfRunner: (boardId: number, id: number) => request<AtfRunnerRevoked>('DELETE', `/api/boards/${boardId}/atf-runners/${id}`),
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
  /** The board's observed environments: how each one's deploys are known and the last one seen. */
  boardEnvironments: (boardId: number) =>
    request<{ value: BoardEnvironment[] }>('GET', `/api/boards/${boardId}/environments`).then((r) => r.value),
  /** Recent release tags of the board's repo, offered when recording a deploy. */
  releaseTags: (boardId: number) =>
    request<{ value: { name: string; sha: string }[] }>('GET', `/api/boards/${boardId}/release-tags`).then((r) => r.value),
  /** Records that a manual environment now runs `ref` (a branch, tag or commit; blank means the base branch's head). */
  recordEnvironmentDeploy: (boardId: number, environment: string, ref: string) =>
    request<{ value: unknown }>('POST', `/api/boards/${boardId}/environments/${encodeURIComponent(environment)}/deploys`, { ref }),
  globTests: (id: string) => request<GlobTestsView>('GET', `/api/globs/${id}/tests`).then((r) => r.value),
  /** The same read with the planned specs' results beside the runs. */
  globTestsView: (id: string) => request<GlobTestsView>('GET', `/api/globs/${id}/tests`),
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
  /** 👍/👎 on an answer; rating again replaces the verdict. The note is kept only on a 👎. */
  rateChatAnswer: (boardId: number, chat: number, message: number, input: { rating: ChatFeedbackRating; note?: string; page?: { type: string; id?: string } }) =>
    request<{ feedback: ChatFeedback }>('POST', `/api/boards/${boardId}/chats/${chat}/messages/${message}/feedback`, input).then((r) => r.feedback),
  myChatFeedback: (boardId: number, chat: number) => request<{ feedback: ChatFeedback[] }>('GET', `/api/boards/${boardId}/chats/${chat}/feedback`).then((r) => r.feedback),
  /** The board's 👎 answers (admins only). */
  chatTestCases: (boardId: number) => request<{ cases: ChatTestCase[] }>('GET', `/api/boards/${boardId}/chat-feedback`).then((r) => r.cases),
  askChat: (boardId: number, input: ChatQuestion, stream?: ChatStream) => (stream === undefined ? request<ChatReply>('POST', `/api/boards/${boardId}/chat`, input) : askChatStream(boardId, input, stream)),
  globDeploys: (id: string) => request<{ value: Deploy[] }>('GET', `/api/globs/${id}/deploys`).then((r) => r.value),
  deployNow: (id: string) => request<{ value: Deploy | null }>('POST', `/api/globs/${id}/deploy-now`).then((r) => r.value),
  createGlob: (boardId: number, input: NewGlob) =>
    request<GlobView>('POST', `/api/boards/${boardId}/globs`, { ...input, idempotencyKey: input.idempotencyKey ?? crypto.randomUUID() }),
  /** The board's groups with progress (the card's "name 3/5"); a group is only the label on its globs. */
  groups: (boardId: number) => request<GroupSummary[]>('GET', `/api/boards/${boardId}/groups`),
  group: (boardId: number, name: string) => request<GroupView>('GET', `/api/boards/${boardId}/groups/${encodeURIComponent(name)}`),
  /** Puts a new name on every glob of the group; `failed` lists globs that kept their old one (a second call moves them). */
  renameGroup: (boardId: number, name: string, to: string) =>
    request<RegroupResult>('POST', `/api/boards/${boardId}/groups/${encodeURIComponent(name)}/rename`, { to }),
  /** Moves every glob of the group into an existing group. */
  mergeGroup: (boardId: number, name: string, into: string) =>
    request<RegroupResult>('POST', `/api/boards/${boardId}/groups/${encodeURIComponent(name)}/merge`, { into }),
  updateGlob: (id: string, version: number, changes: GlobChanges) =>
    request<GlobView>('PATCH', `/api/globs/${id}`, { ...changes, version }),
  /** Human steps answer with the glob's view, steps included. A step change leaves the glob's version alone. */
  addHumanStep: (
    id: string,
    step: {
      title: string;
      detail?: string;
      why?: string;
      permissions?: string;
      commands?: string[];
      verify?: string;
      who?: string;
      due?: string;
    },
  ) => request<GlobView>('POST', `/api/globs/${id}/human-steps`, step),
  completeHumanStep: (id: string, stepId: string) =>
    request<GlobView>(
      'POST',
      `/api/globs/${id}/human-steps/${encodeURIComponent(stepId)}/complete`,
      {},
    ),
  /**
   * "It failed": a step's run failed. A rollout step of a merged glob starts the glob's next generation; any other step stays open
   * and slop asks whether a glob fixes it. The version is sent once, as given.
   */
  failStep: (id: string, stepId: string, note: string, version?: number | null) =>
    request<GlobView>('POST', `/api/globs/${id}/steps/${encodeURIComponent(stepId)}/fail`, version === undefined ? { note } : { note, version }),
  /** A person's mark that the glob's change is deployed to the environment: its after-deploy steps fall due. */
  markEnvironmentDeployed: (id: string, env: string) =>
    request<GlobView>('POST', `/api/globs/${id}/environments/${encodeURIComponent(env)}/deployed`, {}),
  dismissHumanStep: (id: string, stepId: string, reason: string) =>
    request<GlobView>('POST', `/api/globs/${id}/human-steps/${encodeURIComponent(stepId)}/dismiss`, { reason }),
  /** A script artifact's text, or null when there is none (the kind is served from a later part). */
  rolloutScript: (id: string, label: string) =>
    request<ArtifactView[]>('GET', `/api/globs/${id}/artifacts/rollout_script?label=${encodeURIComponent(label)}`).then((v) => v.at(-1)?.content ?? null),
  deleteGlob: (id: string, version: number) => request<object>('DELETE', `/api/globs/${id}`, { version }),
  /** An action glob: a person did it (the note says what they checked, optional). */
  completeAction: (id: string, version: number, note?: string) =>
    request<GlobView>('POST', `/api/globs/${id}/actions/done`, note === undefined || note.trim() === '' ? { version } : { version, note: note.trim() }),
  /** An action glob that is not needed after all (the reason is required). */
  dismissAction: (id: string, version: number, reason: string) =>
    request<GlobView>('POST', `/api/globs/${id}/actions/dismiss`, { version, reason: reason.trim() }),
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
  /** Removes one learned risk area (admins). */
  removeRiskArea: (boardId: number, name: string) => request<RiskAreaView>('POST', `/api/boards/${boardId}/risk-areas/remove`, {name}),
  /** What intake learned from people's retypes, or the catalog defaults (members). */
  typeLearning: (boardId: number) => request<TypeLearningResponse>('GET', `/api/boards/${boardId}/type-learning`),
  /** Forgets the board's type corrections: intake goes back to the defaults; the history stays (admins). */
  resetTypeLearning: (boardId: number) => request<TypeLearningResponse>('POST', `/api/boards/${boardId}/type-learning/reset`, {}),
  /** The board's escalation criteria (learned vs default) and the outcome history (members). */
  escalations: (boardId: number) => request<EscalationView>('GET', `/api/boards/${boardId}/escalations`),
  /** Puts the escalation criteria back to the defaults, keeping the history (admins). */
  resetEscalations: (boardId: number) => request<EscalationView>('POST', `/api/boards/${boardId}/escalations/reset`, {}),
  /** The files that keep conflicting inside the window, with their numbers (members). */
  hotspots: (boardId: number) => request<HotspotView>('GET', `/api/boards/${boardId}/hotspots`),
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
  splitGlob: (id: string, version: number, parts: SplitPartInput[], idempotencyKey: string, group?: string) =>
    request<{ parts: GlobView[] }>('POST', `/api/globs/${id}/split`, { version, idempotencyKey, parts, ...(group === undefined ? {} : { group }) }),
  savePlan: (id: string, content: string) => request<ArtifactView>('PUT', `/api/globs/${id}/plan`, { content }),
  /** The glob's test plan with its versions; `version` reads an older one. */
  testPlan: (id: string, version?: number) =>
    request<VersionedDocView>('GET', `/api/globs/${id}/test-plan${version === undefined ? '' : `?version=${String(version)}`}`),
  /** A new test plan version; `version` is the one you read (0 when none), a stale one is refused with version_conflict. */
  saveTestPlan: (id: string, content: string, version?: number) =>
    request<ArtifactView>('PUT', `/api/globs/${id}/test-plan`, version === undefined ? { content } : { content, version }),
  artifacts: (id: string) => request<ArtifactView[]>('GET', `/api/globs/${id}/artifacts`),
  /** An upload link for a file on a glob (refills the `missing` file with `label`); the bytes then go straight to storage. */
  requestFileUpload: (id: string, input: { fileName: string; contentType?: string; label?: string }) =>
    request<FileUploadLink>('POST', `/api/globs/${id}/attachment-files`, input),
  /** A fresh link (about 15 minutes) to a stored file. */
  fileDownload: (id: string, label: string) =>
    request<{ url: string; fileName: string; contentType: string; expiresAt: string }>(
      'GET',
      `/api/globs/${id}/attachment-files/download?label=${encodeURIComponent(label)}`,
    ),
  /** Removes a file attachment (and its object). */
  deleteFile: async (id: string, label: string) => {
    const response = await fetch(`/api/globs/${id}/attachment-files?label=${encodeURIComponent(label)}`, { method: 'DELETE', credentials: 'same-origin' });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiError | null;
      throw new RequestError(response.status, body ?? { code: 'internal', message: `Could not remove the file (${String(response.status)})` });
    }
  },
  /** Adds an attachment (a link and/or text) to a glob; the same label again adds a version. */
  attach: (id: string, input: { label: string; text: string | null; link: string | null }) =>
    request<ArtifactView>('POST', `/api/globs/${id}/attachments`, input),
  artifactVersions: (id: string, kind: ArtifactKind, label: string) =>
    request<ArtifactView[]>('GET', `/api/globs/${id}/artifacts/${kind}?label=${encodeURIComponent(label)}`),
  /** Decision globs: the outcome of a decision in Doing. */
  decide: (id: string, version: number, input: DecideInput) => request<GlobView>('POST', `/api/globs/${id}/decision`, { ...input, version }),
  /** Decision globs: the proposed change against the target as it is now. */
  globDiff: (id: string) => request<GlobDiff>('GET', `/api/globs/${id}/diff`),
  /** Decision globs: queues Suggest (admins and POs); the result follows as an `assessment` artifact labelled `suggestion`. */
  suggest: (id: string) => request<{ queued: true }>('POST', `/api/globs/${id}/suggest`, {}),
  /** Decision globs: the latest suggestion, whether the draft or target moved since, and whether one is queued. */
  suggestion: (id: string) => request<SuggestionView>('GET', `/api/globs/${id}/suggestion`),
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
  /** "Got it" / ×: the viewer has read the status message `key` (dismiss) or wants it back (Show again). Answers the glob. */
  setDismissed: (id: string, key: string, dismiss: boolean) =>
    request<GlobView>(dismiss ? 'POST' : 'DELETE', `/api/globs/${id}/dismiss`, { key }),
  /** The ✕ on a relation: it is not a dependency. */
  dismissRelation: (id: string, relationId: string, version: number) =>
    request<GlobView>('POST', `/api/globs/${id}/relations/${relationId}/dismiss`, { version }),
  /** Accepts a card suggestion (writes the relation); a failed step's suggestion needs `glob`, the fix glob to link. */
  acceptSuggestion: (id: string, suggestionId: string, body: { readonly glob?: string } = {}) =>
    request<GlobView>('POST', `/api/globs/${id}/suggestions/${encodeURIComponent(suggestionId)}/accept`, body),
  /** "Not a prerequisite": the suggestion is declined and never asked again. */
  dismissSuggestion: (id: string, suggestionId: string) =>
    request<GlobView>('POST', `/api/globs/${id}/suggestions/${encodeURIComponent(suggestionId)}/dismiss`, {}),
  /** Adds a relation: `to` holds this glob back (needs its version), or `holdsBack` is held back by this one (a decision's "Holds back"). */
  addRelation: (id: string, relation: AddRelationInput) => request<GlobView>('POST', `/api/globs/${id}/relations`, relation),
  /** Answers an open question (an option, free text, or both); writes the Clarifications attachment and releases what it held. */
  answerQuestion: (id: string, questionId: string, input: AnswerQuestionInput) =>
    request<GlobView>('POST', `/api/globs/${id}/questions/${encodeURIComponent(questionId)}/answer`, input),
  /** Dismisses an open question: go ahead as is, with an optional note. */
  dismissQuestion: (id: string, questionId: string, note?: string) =>
    request<GlobView>('POST', `/api/globs/${id}/questions/${encodeURIComponent(questionId)}/dismiss`, note === undefined || note === '' ? {} : { note }),
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
  cancel_merge: 'cancel-merge',
  deescalate: 'deescalate',
  make_super: 'make-super',
  merge_continue: 'merge-continue',
  mark_ready: 'mark-ready',
  // The outcome has its own dialog and route (api.decide).
  decide: null,
  sign_off: 'sign-off',
  reopen: 'reopen',
  // Done takes an optional note and Dismiss a reason: each has its own confirm and call (api.completeAction, api.dismissAction).
  complete_action: null,
  dismiss_action: null,
  delete: null,
};
