import type { BoardSession } from '../domain/board-sessions.js';
import type { Decision, DecisionSource } from '../domain/decisions.js';
import type { InboxItem, InboxLink } from '../domain/inbox.js';
import type { IntegrationToken } from '../domain/integration-tokens.js';
import type { Deploy } from '../domain/deploys.js';
import type { EnvironmentDeploy, GlobPresence } from '../domain/environments.js';
import type { DomainEvent, Effect, OutboxJob } from '../domain/events.js';
import { sameCommit } from '../domain/signals.js';
import type { TestRun } from '../domain/test-runs.js';
import type { BoardNotification } from '../domain/notifications.js';
import type { ChatMessage, ChatThread } from '../domain/chat.js';
import type { ReviewFinding, ReviewSource } from '../domain/findings.js';
import { EFFECT_CHECK_GLOBS_DEFAULT } from '../domain/effect-check.js';
import { KNOWLEDGE_PAGE_INTERVAL_DEFAULT } from '../domain/knowledge-page.js';
import type { KnowledgePageFeedback, KnowledgePageHistoryEntry, KnowledgePageVersion } from '../domain/knowledge-page.js';
import { DEFAULT_REVIEW_BOARD_SETTINGS } from '../domain/review-settings.js';
import { ARTIFACT_KINDS_WITH_CONTENT } from '../domain/signals.js';
import { NO_GLOB } from '../domain/choice-usage.js';
import type { ChoiceUsageRow, ContextRetrievalRow } from '../domain/choice-usage.js';
import { resolveContextSettings } from '../domain/context-settings.js';
import type { ContextSettingChange } from '../domain/context-settings.js';
import type { BoardJob, KbSignalState } from '../domain/signals.js';
import { isClearedAttachment } from '../domain/knowledge.js';
import type { Artifact, ArtifactSummary, KnowledgeDoc } from '../domain/knowledge.js';
import { GLOB_OWNED_SOURCES, matchesFilters } from '../domain/search.js';
import type { Candidate, KnowledgeItem } from '../domain/search.js';
import { DEFAULT_SIZE_THRESHOLD } from '../domain/size-check.js';
import type { SizeCheck, SizeThreshold, SizeThresholdChange } from '../domain/size-check.js';
import { DEFAULT_SIZE_CALIBRATION } from '../domain/size-forecast.js';
import type { SizeCalibration, SizeCalibrationChange, SizeRecord } from '../domain/size-forecast.js';
import { riskChangeKey } from '../domain/risk-area.js';
import type { EscalationRecord } from '../domain/escalation-learning.js';
import type { RiskArea, RiskAreaChange } from '../domain/risk-area.js';
import { SUB_LIMIT_STEP } from '../domain/sub-limit.js';
import type { SubLimitChange } from '../domain/sub-limit.js';
import type { ReviewFeedback } from '../domain/review-feedback.js';
import { summariseSpend } from '../domain/spend.js';
import type { LlmSpend } from '../domain/spend.js';
import type { TypeCorrection } from '../domain/type-learning.js';
import type { DependencyRule, DependencyRuleChange } from '../domain/dependency-rules.js';
import type { GlobOutcome, IntakeSnapshot } from '../domain/intake-learning.js';
import type { Board, Glob, Member, User } from '../domain/types.js';
import type { GlobFilter, Hint, Notifier, Store, Tx } from '../ports.js';
import type { SearchQuery } from '../domain/search.js';

/** An outbox job in memory: the job and the effect it runs. */
export interface MemoryOutboxJob extends OutboxJob {
  readonly effect: Effect;
}

/** Memory has no clock: a queued job may run at once. */
const QUEUED_AT = '1970-01-01T00:00:00.000Z';

interface State {
  globs: Map<string, { glob: Glob; creationKey: string | null }>;
  boards: Map<number, Board>;
  members: Map<string, Member>;
  /** Keyed like `members`. */
  boardSessions: Map<string, { position: number | null; lastViewedAt: string | null }>;
  users: Map<string, User>;
  counters: Map<string, number>;
  events: DomainEvent[];
  outbox: Effect[];
  /** Every effect queued, as an outbox job (what `latestOutboxJobs` reads; tests that run jobs update their state). */
  outboxJobs: MemoryOutboxJob[];
  nextBoardId: number;
  knowledge: Map<string, KnowledgeDoc>;
  knowledgeHistory: KnowledgeDoc[];
  artifacts: Artifact[];
  deploys: Map<string, Deploy>;
  reviewSources: ReviewSource[];
  findings: ReviewFinding[];
  kbSignals: Map<string, KbSignalState>;
  choiceUsage: (ChoiceUsageRow & { boardId: number })[];
  contextRetrievals: (ContextRetrievalRow & { boardId: number })[];
  contextSettings: Map<string, number>;
  contextSettingChanges: ContextSettingChange[];
  boardJobs: Map<string, BoardJob>;
  boardJobStates: Map<string, unknown>;
  subLimitChanges: SubLimitChange[];
  llmSpend: LlmSpend[];
  knowledgePages: KnowledgePageVersion[];
  knowledgePageFeedback: KnowledgePageFeedback[];
  reviewFeedback: ReviewFeedback[];
  dependencyRules: DependencyRule[];
  dependencyRuleChanges: DependencyRuleChange[];
  riskAreas: RiskArea[];
  riskAreaChanges: RiskAreaChange[];
  escalationRecords: EscalationRecord[];
  typeCorrections: TypeCorrection[];
  sizeChecks: SizeCheck[];
  sizeThresholds: Map<number, SizeThreshold>;
  sizeThresholdChanges: SizeThresholdChange[];
  sizeCalibrations: Map<number, SizeCalibration>;
  sizeCalibrationChanges: SizeCalibrationChange[];
  sizeRecords: SizeRecord[];
  intakeSnapshots: { snapshot: IntakeSnapshot; embedding: readonly number[] | null }[];
  globOutcomes: GlobOutcome[];
  environmentDeploys: EnvironmentDeploy[];
  /** Keyed by glob and environment. */
  globPresence: Map<string, GlobPresence>;
  testRuns: TestRun[];
  notifications: Map<string, BoardNotification>;
  /** Search store: items keyed by board and external ref, and their chunks. */
  searchItems: Map<string, KnowledgeItem>;
  searchChunks: StoredChunk[];
  decisions: Decision[];
  decisionSources: DecisionSource[];
  chatMessages: ChatMessage[];
  chats: ChatThread[];
  inboxItems: InboxItem[];
  inboxLinks: InboxLink[];
  integrationTokens: IntegrationToken[];
}

interface StoredChunk {
  readonly id: number;
  readonly itemId: number;
  readonly position: number;
  readonly header: string;
  readonly text: string;
  readonly embedding: readonly number[] | null;
}

const itemKey = (boardId: number, externalRef: string) => `${boardId}:${externalRef}`;

const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');

/** Naive relevance for tests: the share of the query's words found in the text, or 1 for the whole query as a substring. */
const matchRelevance = (query: string, haystack: string): number => {
  const text = haystack.toLowerCase();
  if (query.trim() !== '' && text.includes(query.trim().toLowerCase())) return 1;
  const terms = words(query);
  if (terms.length === 0) return 0;
  return terms.filter((t) => text.includes(t)).length / terms.length;
};

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((x, i) => {
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  });
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

const memberKey = (boardId: number, email: string) => `${boardId}:${email}`;

const clone = (state: State): State => ({
  globs: new Map(state.globs),
  boards: new Map(state.boards),
  members: new Map(state.members),
  boardSessions: new Map(state.boardSessions),
  users: new Map(state.users),
  counters: new Map(state.counters),
  events: [...state.events],
  outbox: [...state.outbox],
  outboxJobs: [...state.outboxJobs],
  nextBoardId: state.nextBoardId,
  knowledge: new Map(state.knowledge),
  knowledgeHistory: [...state.knowledgeHistory],
  artifacts: [...state.artifacts],
  deploys: new Map(state.deploys),
  reviewSources: [...state.reviewSources],
  findings: [...state.findings],
  kbSignals: new Map(state.kbSignals),
  choiceUsage: state.choiceUsage.map((r) => ({ ...r })),
  contextRetrievals: state.contextRetrievals.map((r) => ({ ...r })),
  contextSettings: new Map(state.contextSettings),
  contextSettingChanges: [...state.contextSettingChanges],
  boardJobs: new Map(state.boardJobs),
  boardJobStates: new Map(state.boardJobStates),
  subLimitChanges: [...state.subLimitChanges],
  llmSpend: [...state.llmSpend],
  knowledgePages: [...state.knowledgePages],
  knowledgePageFeedback: [...state.knowledgePageFeedback],
  reviewFeedback: [...state.reviewFeedback],
  dependencyRules: [...state.dependencyRules],
  dependencyRuleChanges: [...state.dependencyRuleChanges],
  riskAreas: [...state.riskAreas],
  riskAreaChanges: [...state.riskAreaChanges],
  escalationRecords: [...state.escalationRecords],
  typeCorrections: [...state.typeCorrections],
  sizeChecks: [...state.sizeChecks],
  sizeThresholds: new Map(state.sizeThresholds),
  sizeThresholdChanges: [...state.sizeThresholdChanges],
  sizeCalibrations: new Map(state.sizeCalibrations),
  sizeCalibrationChanges: [...state.sizeCalibrationChanges],
  sizeRecords: [...state.sizeRecords],
  intakeSnapshots: [...state.intakeSnapshots],
  globOutcomes: [...state.globOutcomes],
  environmentDeploys: [...state.environmentDeploys],
  globPresence: new Map(state.globPresence),
  testRuns: [...state.testRuns],
  notifications: new Map(state.notifications),
  searchItems: new Map(state.searchItems),
  searchChunks: [...state.searchChunks],
  decisions: [...state.decisions],
  decisionSources: [...state.decisionSources],
  chatMessages: [...state.chatMessages],
  chats: [...state.chats],
  inboxItems: [...state.inboxItems],
  inboxLinks: [...state.inboxLinks],
  integrationTokens: [...state.integrationTokens],
});

const knowledgeKey = (boardId: number, kind: string, name: string) => `${boardId}:${kind}:${name}`;

/** An in-memory Store for core tests. A transaction commits only if `work` resolves. */
export class MemoryStore implements Store {
  state: State = {
    globs: new Map(),
    boards: new Map(),
    members: new Map(),
    boardSessions: new Map(),
    users: new Map(),
    counters: new Map(),
    events: [],
    outbox: [],
    outboxJobs: [],
    nextBoardId: 1,
    knowledge: new Map(),
    knowledgeHistory: [],
    artifacts: [],
    deploys: new Map(),
    reviewSources: [],
    findings: [],
    kbSignals: new Map(),
    choiceUsage: [],
    contextRetrievals: [],
    contextSettings: new Map(),
    contextSettingChanges: [],
    boardJobs: new Map(),
    boardJobStates: new Map(),
    subLimitChanges: [],
    llmSpend: [],
    knowledgePages: [],
    knowledgePageFeedback: [],
    reviewFeedback: [],
    dependencyRules: [],
    dependencyRuleChanges: [],
    riskAreas: [],
    riskAreaChanges: [],
    escalationRecords: [],
    typeCorrections: [],
    sizeChecks: [],
    sizeThresholds: new Map(),
    sizeThresholdChanges: [],
    sizeCalibrations: new Map(),
    sizeCalibrationChanges: [],
    sizeRecords: [],
    intakeSnapshots: [],
    globOutcomes: [],
    environmentDeploys: [],
    globPresence: new Map(),
    testRuns: [],
    notifications: new Map(),
    searchItems: new Map(),
    searchChunks: [],
    decisions: [],
    decisionSources: [],
    chatMessages: [],
    chats: [],
    inboxItems: [],
    inboxLinks: [],
    integrationTokens: [],
  };
  /** Row IDs, like Postgres sequences: never reused, even after a rolled-back transaction. */
  private nextRowId = 1;

  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const draft = clone(this.state);
    const result = await work(this.tx(draft));
    this.state = draft;
    return result;
  }

  private tx(s: State): Tx {
    return {
      getGlob: (id) => Promise.resolve(s.globs.get(id)?.glob ?? null),
      getGlobs: (ids) => Promise.resolve([...new Set(ids)].flatMap((id) => s.globs.get(id)?.glob ?? [])),
      globFacts: (ids) =>
        Promise.resolve(
          [...new Set(ids)].flatMap((id) => {
            const glob = s.globs.get(id)?.glob;
            return glob === undefined ? [] : [{ id, boardId: glob.boardId, planner: glob.planner, category: glob.category, type: glob.type }];
          }),
        ),
      insertGlob: (glob, creationKey) => {
        if (s.globs.has(glob.id)) return Promise.resolve(false);
        s.globs.set(glob.id, { glob, creationKey });
        return Promise.resolve(true);
      },
      updateGlob: (glob, expectedVersion) => {
        const row = s.globs.get(glob.id);
        if (row === undefined || row.glob.version !== expectedVersion) return Promise.resolve(false);
        s.globs.set(glob.id, { glob, creationKey: row.creationKey });
        return Promise.resolve(true);
      },
      deleteGlob: (id) => {
        s.globs.delete(id);
        s.intakeSnapshots = s.intakeSnapshots.filter((r) => r.snapshot.globId !== id);
        s.globOutcomes = s.globOutcomes.filter((o) => o.globId !== id);
        s.sizeChecks = s.sizeChecks.filter((c) => c.globId !== id);
        s.artifacts = s.artifacts.filter((a) => a.globId !== id);
        s.findings = s.findings.filter((f) => f.globId !== id);
        s.reviewSources = s.reviewSources.filter((r) => r.globId !== id);
        for (const [key, p] of s.globPresence) if (p.globId === id) s.globPresence.delete(key);
        s.testRuns = s.testRuns.filter((r) => r.globId !== id);
        // A glob's own items go with it; a learning or document it fed only loses the link.
        const gone = new Set<number>();
        const goneDecisions = new Set(s.decisions.filter((d) => d.globId === id).map((d) => d.id));
        for (const [key, item] of s.searchItems) {
          if (!item.globIds.includes(id)) continue;
          if (GLOB_OWNED_SOURCES.includes(item.sourceType)) {
            s.searchItems.delete(key);
            gone.add(item.id);
          } else {
            s.searchItems.set(key, { ...item, globIds: item.globIds.filter((g) => g !== id) });
          }
        }
        s.searchChunks = s.searchChunks.filter((c) => !gone.has(c.itemId));
        // Older decisions the deleted ones replaced stand again.
        for (const older of s.decisions) {
          if (older.replacedBy === null || !goneDecisions.has(older.replacedBy) || goneDecisions.has(older.id)) continue;
          s.decisions = s.decisions.map((d) => (d.id === older.id ? { ...d, replacedBy: null, replaceState: null } : d));
          for (const [key, item] of s.searchItems) if (item.id === older.itemId) s.searchItems.set(key, { ...item, status: 'active', supersededBy: null });
        }
        s.decisions = s.decisions.filter((d) => !goneDecisions.has(d.id) && !gone.has(d.itemId));
        s.decisionSources = s.decisionSources.filter((d) => d.globId !== id);
        // Pasted items stay; one whose last glob went is only kept.
        const touched = new Set(s.inboxLinks.filter((l) => l.globId === id).map((l) => l.inboxId));
        s.inboxLinks = s.inboxLinks.filter((l) => l.globId !== id);
        s.inboxItems = s.inboxItems.map((i) =>
          touched.has(i.id) && i.status === 'attached' && !s.inboxLinks.some((l) => l.inboxId === i.id) ? { ...i, status: 'kept', version: i.version + 1 } : i,
        );
        return Promise.resolve();
      },
      findGlobByCreationKey: (boardId, key) =>
        Promise.resolve(
          [...s.globs.values()].find((r) => r.glob.boardId === boardId && r.creationKey === key)?.glob ??
            null,
        ),
      listGlobs: (boardId, filter: GlobFilter) =>
        Promise.resolve(
          [...s.globs.values()]
            .map((r) => r.glob)
            .filter(
              (g) =>
                g.boardId === boardId &&
                (filter.include === 'all' || (filter.include === 'decisions') === (g.category === 'decision')) &&
                (filter.status === undefined || filter.status.includes(g.status)) &&
                (filter.type === undefined || g.type === filter.type) &&
                (filter.group === undefined || g.group === filter.group) &&
                (filter.person === undefined ||
                  g.planner === filter.person ||
                  g.implementer === filter.person) &&
                (filter.origins === undefined ||
                  (g.attributes !== undefined && 'origin' in g.attributes && filter.origins.includes(g.attributes.origin.kind))),
            ),
        ),
      nextNumber: (boardId, letter) => {
        const key = `${boardId}:${letter}`;
        const n = (s.counters.get(key) ?? 0) + 1;
        s.counters.set(key, n);
        return Promise.resolve(n);
      },
      getBoard: (id) => Promise.resolve(s.boards.get(id) ?? null),
      insertBoard: (input) => {
        const board: Board = { ...input, id: s.nextBoardId++, deploy: null, readinessTicks: {}, version: 1, agentSetVersion: 0, agentCatalogHash: null, runNoProgressHours: 2, runReadyHours: 8, runStartMinutes: 30, runRespondMinutes: 30, subMaxChangedLines: 2000, subLimitStep: SUB_LIMIT_STEP, effectCheckGlobs: EFFECT_CHECK_GLOBS_DEFAULT, agentKbApproval: 'docs', autoInvestigate: true, knowledgePageIntervalMinutes: KNOWLEDGE_PAGE_INTERVAL_DEFAULT, review: DEFAULT_REVIEW_BOARD_SETTINGS };
        s.boards.set(board.id, board);
        return Promise.resolve(board);
      },
      updateBoard: (board, expectedVersion) => {
        const current = s.boards.get(board.id);
        if (current?.version !== expectedVersion) return Promise.resolve(false);
        // As in Postgres, the learned sub limit has its own write.
        s.boards.set(board.id, { ...board, subMaxChangedLines: current.subMaxChangedLines, subLimitStep: current.subLimitStep });
        return Promise.resolve(true);
      },
      setSubLimit: (boardId, from, to, step) => {
        const current = s.boards.get(boardId);
        if (current?.subMaxChangedLines !== from) return Promise.resolve(false);
        s.boards.set(boardId, { ...current, subMaxChangedLines: to, subLimitStep: step ?? current.subLimitStep });
        return Promise.resolve(true);
      },
      insertLlmSpend: (row) => {
        s.llmSpend.push({ ...row, id: this.nextRowId++ });
        return Promise.resolve();
      },
      sumLlmSpend: (boardId, from, to) =>
        Promise.resolve(summariseSpend(s.llmSpend.filter((r) => r.boardId === boardId && r.createdAt >= from && r.createdAt <= to))),
      insertReviewFeedback: (row) => {
        if (s.reviewFeedback.some((f) => f.githubCommentId === row.githubCommentId && f.source === row.source)) return Promise.resolve(false);
        s.reviewFeedback.push({ ...row, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      listReviewFeedback: (boardId, since, until) =>
        Promise.resolve(
          s.reviewFeedback
            .filter((f) => f.boardId === boardId && f.createdAt >= since && f.createdAt <= until)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id),
        ),
      insertSubLimitChange: (change) => {
        if (s.subLimitChanges.some((c) => c.boardId === change.boardId && c.globId === change.globId && c.outcome === change.outcome)) {
          return Promise.resolve(false);
        }
        s.subLimitChanges.push({ ...change, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      listSubLimitChanges: (boardId) =>
        Promise.resolve(s.subLimitChanges.filter((c) => c.boardId === boardId).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
      listDependencyRules: (boardId) => Promise.resolve(s.dependencyRules.filter((r) => r.boardId === boardId)),
      upsertDependencyRule: (rule) => {
        s.dependencyRules = [...s.dependencyRules.filter((r) => !(r.boardId === rule.boardId && r.pattern === rule.pattern)), rule];
        return Promise.resolve();
      },
      deleteDependencyRules: (boardId, pattern) => {
        s.dependencyRules = s.dependencyRules.filter((r) => r.boardId !== boardId || (pattern !== undefined && r.pattern !== pattern));
        return Promise.resolve();
      },
      insertDependencyRuleChange: (change) => {
        const same = (c: DependencyRuleChange): boolean =>
          c.boardId === change.boardId && c.globId === change.globId && c.pattern === change.pattern && c.cause === change.cause;
        if (change.globId !== null && s.dependencyRuleChanges.some(same)) return Promise.resolve(false);
        s.dependencyRuleChanges.push({ ...change, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      listDependencyRuleChanges: (boardId) =>
        Promise.resolve(s.dependencyRuleChanges.filter((c) => c.boardId === boardId).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
      listRiskAreas: (boardId) => Promise.resolve(s.riskAreas.filter((a) => a.boardId === boardId)),
      putRiskArea: (area) => {
        s.riskAreas = [...s.riskAreas.filter((a) => !(a.boardId === area.boardId && a.name === area.name)), area];
        return Promise.resolve();
      },
      deleteRiskArea: (boardId, name) => {
        s.riskAreas = s.riskAreas.filter((a) => !(a.boardId === boardId && a.name === name));
        return Promise.resolve();
      },
      insertRiskAreaChange: (change) => {
        const key = riskChangeKey(change.globId, change.cause, change.areaName);
        if (change.globId !== null && change.areaName !== null && s.riskAreaChanges.some((c) => c.boardId === change.boardId && riskChangeKey(c.globId, c.cause, c.areaName) === key)) {
          return Promise.resolve(false);
        }
        s.riskAreaChanges.push({ ...change, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      listRiskAreaChanges: (boardId) =>
        Promise.resolve(s.riskAreaChanges.filter((c) => c.boardId === boardId).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
      insertEscalationRecord: (record) => {
        if (record.globId !== null && s.escalationRecords.some((r) => r.boardId === record.boardId && r.globId === record.globId && r.outcome === record.outcome)) {
          return Promise.resolve(false);
        }
        s.escalationRecords.push({ ...record, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      listEscalationRecords: (boardId) =>
        Promise.resolve(s.escalationRecords.filter((r) => r.boardId === boardId).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
      insertTypeCorrection: (correction) => {
        s.typeCorrections.push({ ...correction, id: this.nextRowId++, resetAt: null });
        return Promise.resolve();
      },
      listTypeCorrections: (boardId, options) =>
        Promise.resolve(
          s.typeCorrections
            .filter((c) => c.boardId === boardId && (options?.all === true || c.resetAt === null))
            .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
            .slice(0, options?.limit),
        ),
      resetTypeCorrections: (boardId, at) => {
        let reset = 0;
        s.typeCorrections = s.typeCorrections.map((c) => {
          if (c.boardId !== boardId || c.resetAt !== null) return c;
          reset++;
          return { ...c, resetAt: at };
        });
        return Promise.resolve(reset);
      },
      getSizeCheck: (globId) => Promise.resolve(s.sizeChecks.find((c) => c.globId === globId) ?? null),
      listSizeChecks: (boardId) => Promise.resolve(s.sizeChecks.filter((c) => c.boardId === boardId)),
      upsertSizeCheck: (check) => {
        s.sizeChecks = [...s.sizeChecks.filter((c) => c.globId !== check.globId), check];
        return Promise.resolve();
      },
      updateSizeAssessment: (check) => {
        const found = s.sizeChecks.find((c) => c.globId === check.globId);
        const next = found === undefined ? check : { ...check, decision: found.decision, decidedBy: found.decidedBy, decidedAt: found.decidedAt, createdAt: found.createdAt };
        s.sizeChecks = [...s.sizeChecks.filter((c) => c.globId !== check.globId), next];
        return Promise.resolve();
      },
      getSizeThreshold: (boardId) => Promise.resolve(s.sizeThresholds.get(boardId) ?? DEFAULT_SIZE_THRESHOLD),
      setSizeThreshold: (boardId, from, to) => {
        const current = s.sizeThresholds.get(boardId) ?? DEFAULT_SIZE_THRESHOLD;
        if (current.maxTasks !== from.maxTasks || current.maxParts !== from.maxParts) return Promise.resolve(false);
        s.sizeThresholds.set(boardId, to);
        return Promise.resolve(true);
      },
      insertSizeThresholdChange: (change) => {
        if (s.sizeThresholdChanges.some((c) => c.boardId === change.boardId && c.globId === change.globId)) return Promise.resolve(false);
        s.sizeThresholdChanges.push({ ...change, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      listSizeThresholdChanges: (boardId) =>
        Promise.resolve(s.sizeThresholdChanges.filter((c) => c.boardId === boardId).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
      getSizeCalibration: (boardId) => Promise.resolve(s.sizeCalibrations.get(boardId) ?? DEFAULT_SIZE_CALIBRATION),
      setSizeCalibration: (boardId, calibration) => {
        s.sizeCalibrations.set(boardId, calibration);
        return Promise.resolve();
      },
      insertSizeCalibrationChange: (change) => {
        if (s.sizeCalibrationChanges.some((c) => c.boardId === change.boardId && c.globId === change.globId && c.cause === change.cause)) return Promise.resolve(false);
        s.sizeCalibrationChanges.push({ ...change, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      listSizeCalibrationChanges: (boardId) =>
        Promise.resolve(s.sizeCalibrationChanges.filter((c) => c.boardId === boardId).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
      getSizeRecord: (globId) => Promise.resolve(s.sizeRecords.find((r) => r.globId === globId) ?? null),
      upsertSizeRecord: (record) => {
        s.sizeRecords = [...s.sizeRecords.filter((r) => r.globId !== record.globId), record];
        return Promise.resolve();
      },
      listSizeRecords: (boardId) => Promise.resolve(s.sizeRecords.filter((r) => r.boardId === boardId)),
      setBaseChecks: (boardId, baseChecks) => {
        const current = s.boards.get(boardId);
        if (current !== undefined) s.boards.set(boardId, { ...current, baseChecks });
        return Promise.resolve();
      },
      getNotification: (id) => Promise.resolve(s.notifications.get(id) ?? null),
      saveNotification: (notification) => {
        s.notifications.set(notification.id, notification);
        return Promise.resolve();
      },
      deleteNotification: (id) => Promise.resolve(s.notifications.delete(id)),
      listNotifications: (boardId) =>
        Promise.resolve([...s.notifications.values()].filter((n) => n.boardId === null || n.boardId === boardId)),
      listBoards: (email) =>
        Promise.resolve(
          [...s.boards.values()].filter((b) => s.members.has(memberKey(b.id, email))),
        ),
      listAllBoards: () => Promise.resolve([...s.boards.values()]),
      getMember: (boardId, email) => Promise.resolve(s.members.get(memberKey(boardId, email)) ?? null),
      listMembers: (boardId) =>
        Promise.resolve([...s.members.values()].filter((m) => m.boardId === boardId)),
      upsertMember: (member) => {
        s.members.set(memberKey(member.boardId, member.email), member);
        return Promise.resolve();
      },
      deleteMember: (boardId, email) => {
        s.members.delete(memberKey(boardId, email));
        // As Postgres cascades the session with the membership.
        s.boardSessions.delete(memberKey(boardId, email));
        return Promise.resolve();
      },
      lockBoardSessions: () => Promise.resolve(),
      listBoardSessions: (email) =>
        Promise.resolve(
          [...s.members.values()].flatMap((m): BoardSession[] => {
            const session = m.email === email ? s.boardSessions.get(memberKey(m.boardId, email)) : undefined;
            return session === undefined ? [] : [{ boardId: m.boardId, ...session }];
          }),
        ),
      touchBoardSession: (email, boardId, at) => {
        const key = memberKey(boardId, email);
        if (s.members.has(key)) s.boardSessions.set(key, { position: s.boardSessions.get(key)?.position ?? null, lastViewedAt: at });
        return Promise.resolve();
      },
      setBoardSessionPosition: (email, boardId, position) => {
        const key = memberKey(boardId, email);
        if (!s.members.has(key)) throw new Error(`${email} is not a member of board ${boardId}`);
        if (position !== null && [...s.members.values()].some((m) => m.email === email && m.boardId !== boardId && s.boardSessions.get(memberKey(m.boardId, email))?.position === position)) {
          throw new Error(`${email} already has a session at ${position}`);
        }
        s.boardSessions.set(key, { position, lastViewedAt: s.boardSessions.get(key)?.lastViewedAt ?? null });
        return Promise.resolve();
      },
      getUser: (email) => Promise.resolve(s.users.get(email) ?? null),
      upsertUser: (user) => {
        s.users.set(user.email, user);
        return Promise.resolve();
      },
      listKnowledge: (boardId, kinds) =>
        Promise.resolve(
          [...s.knowledge.values()]
            .filter((d) => d.boardId === boardId && (kinds === undefined || kinds.includes(d.kind)))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ),
      getKnowledge: (boardId, kind, name) => Promise.resolve(s.knowledge.get(knowledgeKey(boardId, kind, name)) ?? null),
      getKnowledgeVersion: (boardId, kind, name, version) =>
        Promise.resolve(
          s.knowledgeHistory.find((d) => d.boardId === boardId && d.kind === kind && d.name === name && d.version === version) ?? null,
        ),
      saveKnowledge: (doc) => {
        const key = knowledgeKey(doc.boardId, doc.kind, doc.name);
        const previous = s.knowledge.get(key);
        if (previous !== undefined) s.knowledgeHistory.push(previous);
        s.knowledge.set(key, doc);
        return Promise.resolve();
      },
      deleteKnowledge: (boardId, kind, name) => {
        s.knowledge.delete(knowledgeKey(boardId, kind, name));
        return Promise.resolve();
      },
      insertArtifact: (input) => {
        const versions = s.artifacts.filter((a) => a.globId === input.globId && a.kind === input.kind && a.label === input.label);
        const artifact: Artifact = { ...input, id: s.artifacts.length + 1, version: versions.length + 1 };
        s.artifacts.push(artifact);
        return Promise.resolve(artifact);
      },
      listArtifacts: (globId, kind) => {
        const latest = new Map<string, Artifact>();
        for (const a of s.artifacts) {
          if (a.globId === globId && (kind === undefined || a.kind === kind)) latest.set(`${a.kind}:${a.label}`, a);
        }
        return Promise.resolve([...latest.values()].filter((a) => !isClearedAttachment(a)).sort((a, b) => b.id - a.id));
      },
      artifactVersions: (globId, kind, label) =>
        Promise.resolve(s.artifacts.filter((a) => a.globId === globId && a.kind === kind && a.label === label)),
      listArtifactSummaries: (boardId, globIds) => {
        const onBoard = (id: string) => s.globs.get(id)?.glob.boardId === boardId && globIds.includes(id);
        const summaries = new Map<string, ArtifactSummary>();
        const cleared = new Set<string>();
        for (const a of s.artifacts) {
          if (!onBoard(a.globId)) continue;
          const key = `${a.globId}:${a.kind}:${a.label}`;
          if (isClearedAttachment(a)) cleared.add(key);
          else cleared.delete(key);
          summaries.set(key, {
            globId: a.globId,
            kind: a.kind,
            label: a.label,
            version: a.version,
            versions: (summaries.get(key)?.versions ?? 0) + 1,
            commitSha: a.commitSha,
            createdAt: a.createdAt,
            by: a.provenance.by,
            actor: a.provenance.actor,
            ...(a.provenance.independentReview === undefined ? {} : { review: a.provenance.independentReview }),
          });
        }
        return Promise.resolve([...summaries.entries()].filter(([key]) => !cleared.has(key)).map(([, v]) => v));
      },
      getDeploy: (id) => Promise.resolve(s.deploys.get(id) ?? null),
      saveDeploys: (deploys) => {
        for (const d of deploys) s.deploys.set(d.id, d);
        return Promise.resolve();
      },
      listDeploys: (boardId, filter) =>
        Promise.resolve(
          [...s.deploys.values()]
            .filter(
              (d) =>
                d.boardId === boardId &&
                (filter.environment === undefined || d.environment === filter.environment) &&
                (filter.states === undefined || filter.states.includes(d.state)) &&
                (filter.globIds === undefined || filter.globIds.includes(d.globId)),
            )
            .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id))
            .slice(0, filter.limit ?? Infinity),
        ),
      latestDeploys: (boardId, globIds) => {
        const latest = new Map<string, Deploy>();
        const sorted = [...s.deploys.values()]
          .filter((d) => d.boardId === boardId && globIds.includes(d.globId))
          .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id));
        for (const d of sorted) if (!latest.has(d.globId)) latest.set(d.globId, d);
        return Promise.resolve([...latest.values()]);
      },
      // Memory transactions run one at a time, so there is nothing to serialise.
      lockDeployQueue: () => Promise.resolve(),
      findDeployByProviderRef: (ref) =>
        Promise.resolve([...s.deploys.values()].find((d) => d.providerRef === ref) ?? null),
      insertEnvironmentDeploy: (deploy) => {
        if (s.environmentDeploys.some((d) => d.boardId === deploy.boardId && d.eventId === deploy.eventId)) {
          return Promise.resolve(false);
        }
        s.environmentDeploys.push({ ...deploy, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      latestEnvironmentDeploy: (boardId, environment) =>
        Promise.resolve(
          s.environmentDeploys
            .filter((d) => d.boardId === boardId && d.environment === environment && d.succeeded)
            .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)[0] ?? null,
        ),
      listGlobPresence: (boardId, filter) =>
        Promise.resolve(
          [...s.globPresence.values()].filter(
            (p) =>
              p.boardId === boardId &&
              (filter.environment === undefined || p.environment === filter.environment) &&
              (filter.globIds === undefined || filter.globIds.includes(p.globId)) &&
              (filter.contained === undefined || p.contained === filter.contained),
          ),
        ),
      saveGlobPresence: (rows) => {
        for (const p of rows) s.globPresence.set(`${p.globId}:${p.environment}`, p);
        return Promise.resolve();
      },
      lockEnvironment: () => Promise.resolve(),
      insertTestRun: (run) => {
        if (s.testRuns.some((r) => r.boardId === run.boardId && r.eventId === run.eventId)) return Promise.resolve(false);
        s.testRuns.push({ ...run, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      listTestRuns: (boardId, filter) =>
        Promise.resolve(
          s.testRuns.filter(
            (r) =>
              r.boardId === boardId &&
              ((r.globId !== null && (filter.globIds?.includes(r.globId) ?? false)) ||
                (r.globId === null &&
                  (filter.commits?.some((c) => c.environment === r.environment && sameCommit(c.sha, r.sha)) ?? false))),
          ),
        ),
      insertReviewSource: (input) => {
        const taken = s.reviewSources.some(
          (r) =>
            (input.artifactId !== null && r.artifactId === input.artifactId) ||
            (input.externalId !== null && r.externalId === input.externalId),
        );
        if (taken) return Promise.resolve(null);
        const source: ReviewSource = { ...input, id: this.nextRowId++, state: 'pending', attempts: 0, processAfter: null, error: null, version: 1 };
        s.reviewSources.push(source);
        return Promise.resolve(source);
      },
      getReviewSource: (id) => Promise.resolve(s.reviewSources.find((r) => r.id === id) ?? null),
      listReviewSources: (globId) => Promise.resolve(s.reviewSources.filter((r) => r.globId === globId)),
      nextReviewSourceToSplit: (now) =>
        Promise.resolve(
          s.reviewSources
            .filter((r) => r.state === 'pending' && (r.processAfter === null || r.processAfter <= now))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)[0] ?? null,
        ),
      updateReviewSource: (source, expectedVersion) => {
        const index = s.reviewSources.findIndex((r) => r.id === source.id);
        if (s.reviewSources[index]?.version !== expectedVersion) return Promise.resolve(false);
        s.reviewSources[index] = source;
        return Promise.resolve(true);
      },
      getArtifact: (id) => Promise.resolve(s.artifacts.find((a) => a.id === id) ?? null),
      insertFindings: (findings, createdAt) => {
        let inserted = 0;
        for (const input of findings) {
          const exists = s.findings.some(
            (f) => f.globId === input.globId && f.fingerprint === input.fingerprint,
          );
          if (exists) continue;
          s.findings.push({
            ...input,
            id: this.nextRowId++,
            class: null,
            classNote: null,
            state: 'pending',
            attempts: 0,
            processAfter: null,
            error: null,
            createdAt,
            classifiedAt: null,
            version: 1,
          });
          inserted++;
        }
        return Promise.resolve(inserted);
      },
      getFinding: (id) => Promise.resolve(s.findings.find((f) => f.id === id) ?? null),
      nextFindingToClassify: (now) =>
        Promise.resolve(
          s.findings
            .filter((f) => f.state === 'pending' && (f.processAfter === null || f.processAfter <= now))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)[0] ?? null,
        ),
      updateFinding: (finding, expectedVersion) => {
        const index = s.findings.findIndex((f) => f.id === finding.id);
        if (s.findings[index]?.version !== expectedVersion) return Promise.resolve(false);
        s.findings[index] = finding;
        return Promise.resolve(true);
      },
      listFindings: (globId) => Promise.resolve(s.findings.filter((f) => f.globId === globId)),
      listBoardFindings: (boardId, since, until) => {
        const written = new Map(s.reviewSources.map((r) => [r.id, r.createdAt]));
        const inWindow = (f: ReviewFinding) => {
          const at = written.get(f.sourceId);
          return at !== undefined && at >= since && at <= until;
        };
        return Promise.resolve(
          s.findings
            .filter((f) => f.boardId === boardId && inWindow(f))
            .sort((a, b) => (written.get(a.sourceId) ?? '').localeCompare(written.get(b.sourceId) ?? '') || a.id - b.id),
        );
      },
      listBoardEvents: (boardId, since, types, globIds) =>
        Promise.resolve(
          s.events
            .map((event, index) => ({ event, index }))
            .filter(
              ({ event }) =>
                s.globs.get(event.globId)?.glob.boardId === boardId &&
                event.at >= since &&
                (types === undefined || types.includes(event.type)) &&
                (globIds === undefined || globIds.includes(event.globId)),
            )
            .sort((a, b) => a.event.at.localeCompare(b.event.at) || a.index - b.index)
            .map(({ event }) => event),
        ),
      listEventsUntil: (until, types, dataKeys) =>
        Promise.resolve(
          s.events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => event.at < until && types.includes(event.type))
            .sort((a, b) => a.event.at.localeCompare(b.event.at) || a.index - b.index)
            .map(({ event }) => ({
              ...event,
              data: Object.fromEntries(Object.entries(event.data).filter(([key]) => dataKeys.includes(key))),
            })),
        ),
      listArtifactMeta: (boardId, kinds, since) =>
        Promise.resolve(
          s.artifacts
            .filter((a) => s.globs.get(a.globId)?.glob.boardId === boardId && kinds.includes(a.kind) && a.createdAt >= since)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
            .map((a) => ({
              id: a.id,
              globId: a.globId,
              kind: a.kind,
              label: a.label,
              version: a.version,
              commitSha: a.commitSha,
              provenance: a.provenance,
              createdAt: a.createdAt,
              content: ARTIFACT_KINDS_WITH_CONTENT.includes(a.kind) ? a.content : null,
            })),
        ),
      listKbSignals: (boardId) => Promise.resolve([...s.kbSignals.values()].filter((k) => k.boardId === boardId)),
      upsertKbSignal: (state) => {
        s.kbSignals.set(`${state.boardId}:${state.key}`, state);
        return Promise.resolve();
      },
      recordChoiceUsage: (boardId, itemIds, globId, day) => {
        const wanted = new Set(itemIds);
        const at = globId ?? NO_GLOB;
        for (const d of s.decisions) {
          if (d.boardId !== boardId || !wanted.has(d.itemId)) continue;
          const i = s.choiceUsage.findIndex((r) => r.decisionId === d.id && r.day === day && r.globId === at);
          const row = s.choiceUsage[i];
          if (row === undefined) s.choiceUsage.push({ boardId, decisionId: d.id, day, globId: at, count: 1 });
          else s.choiceUsage[i] = { ...row, count: row.count + 1 };
        }
        return Promise.resolve();
      },
      listChoiceUsage: (boardId, fromDay) => {
        const alive = new Set(s.decisions.map((d) => d.id));
        return Promise.resolve(
          s.choiceUsage
            .filter((r) => r.boardId === boardId && r.day >= fromDay && alive.has(r.decisionId))
            .map(({ decisionId, day, globId, count }) => ({ decisionId, day, globId, count })),
        );
      },
      pruneChoiceUsage: (boardId, beforeDay) => {
        s.choiceUsage = s.choiceUsage.filter((r) => r.boardId !== boardId || r.day >= beforeDay);
        return Promise.resolve();
      },
      recordContextRetrievals: (boardId, day, rows) => {
        for (const row of rows) {
          const i = s.contextRetrievals.findIndex((r) => r.boardId === boardId && r.day === day && r.sourceType === row.sourceType && r.tier === row.tier);
          const found = s.contextRetrievals[i];
          if (found === undefined) s.contextRetrievals.push({ boardId, day, ...row });
          else s.contextRetrievals[i] = { ...found, count: found.count + row.count };
        }
        return Promise.resolve();
      },
      listContextRetrievals: (boardId, fromDay) =>
        Promise.resolve(s.contextRetrievals.filter((r) => r.boardId === boardId && r.day >= fromDay).map(({ day, sourceType, tier, count }) => ({ day, sourceType, tier, count }))),
      pruneContextRetrievals: (boardId, beforeDay) => {
        s.contextRetrievals = s.contextRetrievals.filter((r) => r.boardId !== boardId || r.day >= beforeDay);
        return Promise.resolve();
      },
      getContextSettings: (boardId) => {
        const prefix = `${boardId}:`;
        const stored: Record<string, number> = {};
        for (const [k, v] of s.contextSettings) if (k.startsWith(prefix)) stored[k.slice(prefix.length)] = v;
        return Promise.resolve(resolveContextSettings(stored));
      },
      setContextSetting: (boardId, key, value) => {
        s.contextSettings.set(`${boardId}:${key}`, value);
        return Promise.resolve();
      },
      resetContextSetting: (boardId, key) => {
        s.contextSettings.delete(`${boardId}:${key}`);
        return Promise.resolve();
      },
      insertContextSettingChange: (change) => {
        const row = { ...change, id: this.nextRowId++ };
        s.contextSettingChanges.push(row);
        return Promise.resolve(row);
      },
      listContextSettingChanges: (boardId) =>
        Promise.resolve(s.contextSettingChanges.filter((c) => c.boardId === boardId).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
      getBoardJob: (boardId, job) => Promise.resolve(s.boardJobs.get(`${boardId}:${job}`) ?? null),
      claimBoardJob: (boardId, job, now, leaseMs) => {
        const key = `${boardId}:${job}`;
        const current = s.boardJobs.get(key) ?? { boardId, job, lastRunAt: null, lastResult: null, runningUntil: null };
        if (current.runningUntil !== null && current.runningUntil > now) return Promise.resolve(null);
        const claimed = { ...current, runningUntil: new Date(Date.parse(now) + leaseMs).toISOString() };
        s.boardJobs.set(key, claimed);
        return Promise.resolve(claimed);
      },
      finishBoardJob: (job, lease) => {
        const key = `${job.boardId}:${job.job}`;
        if (s.boardJobs.get(key)?.runningUntil !== lease) return Promise.resolve(false);
        s.boardJobs.set(key, { ...job, runningUntil: null });
        return Promise.resolve(true);
      },
      getBoardJobState: (boardId, job) => Promise.resolve(structuredClone(s.boardJobStates.get(`${boardId}:${job}`) ?? null)),
      setBoardJobState: (boardId, job, state) => {
        s.boardJobStates.set(`${boardId}:${job}`, structuredClone(state));
        return Promise.resolve();
      },
      // Memory transactions run one at a time, so there is nothing to serialise.
      lockBoardJob: () => Promise.resolve(),
      itemHashes: (boardId) =>
        Promise.resolve(new Map([...s.searchItems.values()].filter((i) => i.boardId === boardId).map((i) => [i.externalRef, i.contentHash]))),
      replaceItem: (item, chunks) => {
        const key = itemKey(item.boardId, item.externalRef);
        const id = s.searchItems.get(key)?.id ?? this.nextRowId++;
        s.searchItems.set(key, { ...item, id, attempts: 0, processAfter: null, lastError: null });
        s.searchChunks = [
          ...s.searchChunks.filter((c) => c.itemId !== id),
          ...chunks.map((c) => ({ id: this.nextRowId++, itemId: id, position: c.position, header: c.header, text: c.text, embedding: null })),
        ];
        return Promise.resolve();
      },
      deleteItemsNotIn: (boardId, sourceType, refs) => {
        const gone = new Set<number>();
        for (const [key, item] of s.searchItems) {
          if (item.boardId === boardId && item.sourceType === sourceType && !refs.has(item.externalRef)) {
            s.searchItems.delete(key);
            gone.add(item.id);
          }
        }
        s.searchChunks = s.searchChunks.filter((c) => !gone.has(c.itemId));
        return Promise.resolve(gone.size);
      },
      nextItemToSummarise: (now) =>
        Promise.resolve(
          [...s.searchItems.values()]
            .filter((i) => i.state === 'pending_summary' && (i.processAfter === null || i.processAfter <= now))
            .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id - b.id)[0] ?? null,
        ),
      setItemProgress: (id, progress) => {
        for (const [key, item] of s.searchItems) if (item.id === id) s.searchItems.set(key, { ...item, ...progress });
        return Promise.resolve();
      },
      chunksToEmbed: (limit) =>
        Promise.resolve(s.searchChunks.filter((c) => c.embedding === null).slice(0, limit).map((c) => ({ id: c.id, header: c.header, text: c.text }))),
      setEmbeddings: (rows) => {
        const byId = new Map(rows.map((r) => [r.id, r.embedding]));
        s.searchChunks = s.searchChunks.map((c) => ({ ...c, embedding: byId.get(c.id) ?? c.embedding }));
        return Promise.resolve();
      },
      keywordCandidates: (q, limit) =>
        Promise.resolve(
          this.candidates(s, q, (c, item) => matchRelevance(q.query, `${c.header} ${c.text} ${item.title}`)).slice(0, limit),
        ),
      vectorCandidates: (q, embedding, limit) =>
        Promise.resolve(
          this.candidates(s, q, (c) => (c.embedding === null ? 0 : Math.max(0, cosine(embedding, c.embedding))), (c) => c.embedding !== null).slice(0, limit),
        ),
      changeCandidates: (q, limit) =>
        Promise.resolve(
          this.candidates(
            s,
            { ...q, sourceTypes: ['change_summary'] },
            (c, item) => (q.query.trim() === '' ? 1 : matchRelevance(q.query, `${c.text} ${item.title}`)),
          )
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.chunkId - b.chunkId)
            .slice(0, limit),
        ),
      latestArtifacts: (globIds, kinds) => {
        const latest = new Map<string, Artifact>();
        for (const a of s.artifacts) {
          if (globIds.includes(a.globId) && kinds.includes(a.kind)) latest.set(`${a.globId}:${a.kind}:${a.label}`, a);
        }
        return Promise.resolve([...latest.values()]);
      },
      insertKnowledgePageVersion: (version) => {
        if (s.knowledgePages.some((v) => v.boardId === version.boardId && v.version === version.version)) return Promise.resolve(false);
        s.knowledgePages.push(version);
        return Promise.resolve(true);
      },
      latestKnowledgePageVersion: (boardId) =>
        Promise.resolve(s.knowledgePages.filter((v) => v.boardId === boardId).sort((a, b) => b.version - a.version)[0] ?? null),
      getKnowledgePageVersion: (boardId, version) => Promise.resolve(s.knowledgePages.find((v) => v.boardId === boardId && v.version === version) ?? null),
      listKnowledgePageVersions: (boardId, limit): Promise<KnowledgePageHistoryEntry[]> =>
        Promise.resolve(
          s.knowledgePages
            .filter((v) => v.boardId === boardId)
            .sort((a, b) => b.version - a.version)
            .slice(0, limit)
            .map((v) => ({ version: v.version, createdAt: v.createdAt, reason: v.reason })),
        ),
      listKnowledgePageFeedback: (boardId) =>
        Promise.resolve(s.knowledgePageFeedback.filter((f) => f.boardId === boardId).sort((a, b) => b.at.localeCompare(a.at) || a.globId.localeCompare(b.globId))),
      saveKnowledgePageFeedback: (feedback) => {
        s.knowledgePageFeedback = [...s.knowledgePageFeedback.filter((f) => !(f.boardId === feedback.boardId && f.globId === feedback.globId)), feedback];
        return Promise.resolve();
      },
      deleteKnowledgePageFeedback: (boardId, globId) => {
        s.knowledgePageFeedback = s.knowledgePageFeedback.filter((f) => !(f.boardId === boardId && f.globId === globId));
        return Promise.resolve();
      },
      latestOutboxJobs: (globIds, kinds) => {
        const latest = new Map<string, OutboxJob>();
        for (const j of s.outboxJobs) {
          if (!globIds.includes(j.globId) || !kinds.includes(j.kind)) continue;
          latest.set(`${j.globId}:${j.kind}`, { id: j.id, globId: j.globId, kind: j.kind, state: j.state, attempts: j.attempts, lastError: j.lastError, runAfter: j.runAfter });
        }
        return Promise.resolve([...latest.values()]);
      },
      listLatestArtifacts: (boardId) => {
        const latest = new Map<string, Artifact>();
        for (const a of s.artifacts) {
          if (s.globs.get(a.globId)?.glob.boardId === boardId) latest.set(`${a.globId}:${a.kind}:${a.label}`, a);
        }
        return Promise.resolve([...latest.values()]);
      },
      insertIntakeSnapshot: (snapshot, embedding) => {
        if (s.intakeSnapshots.some((r) => r.snapshot.globId === snapshot.globId && r.snapshot.version === snapshot.version)) return Promise.resolve(false);
        s.intakeSnapshots.push({ snapshot, embedding });
        return Promise.resolve(true);
      },
      listLatestIntakeSnapshots: (boardId) => {
        const latest = new Map<string, IntakeSnapshot>();
        for (const { snapshot } of s.intakeSnapshots) {
          const seen = latest.get(snapshot.globId);
          if (snapshot.boardId === boardId && (seen === undefined || seen.version < snapshot.version)) latest.set(snapshot.globId, snapshot);
        }
        return Promise.resolve([...latest.values()]);
      },
      snapshotsToEmbed: (boardId, limit) =>
        Promise.resolve(
          s.intakeSnapshots
            .filter((r) => r.snapshot.boardId === boardId && r.embedding === null)
            .slice(0, limit)
            .map((r) => ({ globId: r.snapshot.globId, version: r.snapshot.version, request: r.snapshot.request })),
        ),
      setSnapshotEmbedding: (globId, version, embedding) => {
        s.intakeSnapshots = s.intakeSnapshots.map((r) =>
          r.snapshot.globId === globId && r.snapshot.version === version && r.embedding === null ? { ...r, embedding } : r,
        );
        return Promise.resolve();
      },
      nearestIntakeSnapshots: (boardId, embedding, limit) =>
        Promise.resolve(
          s.intakeSnapshots
            .flatMap((r) =>
              r.snapshot.boardId === boardId && r.embedding !== null
                ? [{ globId: r.snapshot.globId, version: r.snapshot.version, distance: 1 - cosine(embedding, r.embedding) }]
                : [],
            )
            .sort((a, b) => a.distance - b.distance)
            .slice(0, limit),
        ),
      upsertGlobOutcome: (outcome) => {
        s.globOutcomes = [...s.globOutcomes.filter((o) => o.globId !== outcome.globId), outcome];
        return Promise.resolve();
      },
      listGlobOutcomes: (boardId, globIds) =>
        Promise.resolve(s.globOutcomes.filter((o) => o.boardId === boardId && (globIds === undefined || globIds.includes(o.globId)))),
      listDecisions: (boardId) =>
        Promise.resolve(s.decisions.filter((d) => d.boardId === boardId).sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.id - b.id)),
      getDecision: (id) => Promise.resolve(s.decisions.find((d) => d.id === id) ?? null),
      upsertDecision: (input) => {
        const index = s.decisions.findIndex((d) => d.itemId === input.itemId);
        const existing = s.decisions[index];
        if (existing !== undefined) {
          const updated: Decision = { ...existing, ...input, createdAt: existing.createdAt };
          s.decisions[index] = updated;
          return Promise.resolve(updated);
        }
        const created: Decision = {
          ...input,
          id: this.nextRowId++,
          replacedBy: null,
          replaceState: null,
          replaceOldQuote: null,
          replaceNewQuote: null,
          replaceReason: null,
          checkedAt: null,
          attempts: 0,
          processAfter: null,
          lastError: null,
        };
        s.decisions.push(created);
        return Promise.resolve(created);
      },
      updateDecision: (id, patch) => {
        s.decisions = s.decisions.map((d) => (d.id === id ? { ...d, ...patch } : d));
        return Promise.resolve();
      },
      deleteDecision: (id) => {
        const decision = s.decisions.find((d) => d.id === id);
        if (decision === undefined) return Promise.resolve();
        s.decisions = s.decisions.filter((d) => d.id !== id);
        for (const [key, item] of s.searchItems) {
          if (item.id !== decision.itemId) continue;
          s.searchItems.delete(key);
        }
        s.searchChunks = s.searchChunks.filter((c) => c.itemId !== decision.itemId);
        return Promise.resolve();
      },
      nextDecisionToCheck: (now) =>
        Promise.resolve(
          s.decisions
            .filter((d) => d.checkedAt === null && (d.processAfter === null || d.processAfter <= now))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)[0] ?? null,
        ),
      setItemSupersession: (itemId, status, supersededBy) => {
        for (const [key, item] of s.searchItems) if (item.id === itemId) s.searchItems.set(key, { ...item, status, supersededBy });
        return Promise.resolve();
      },
      getItemByRef: (boardId, externalRef) => {
        const item = s.searchItems.get(itemKey(boardId, externalRef));
        return Promise.resolve(item === undefined ? null : { id: item.id, status: item.status, supersededBy: item.supersededBy, contentHash: item.contentHash });
      },
      getDecisionSource: (boardId, sourceRef) =>
        Promise.resolve(s.decisionSources.find((d) => d.boardId === boardId && d.sourceRef === sourceRef) ?? null),
      listDecisionSources: (boardId) => Promise.resolve(s.decisionSources.filter((d) => d.boardId === boardId)),
      upsertDecisionSource: (source) => {
        s.decisionSources = [...s.decisionSources.filter((d) => d.boardId !== source.boardId || d.sourceRef !== source.sourceRef), source];
        return Promise.resolve();
      },
      deleteDecisionSource: (boardId, sourceRef) => {
        s.decisionSources = s.decisionSources.filter((d) => d.boardId !== boardId || d.sourceRef !== sourceRef);
        return Promise.resolve();
      },
      nextDecisionSourceToExtract: (now) =>
        Promise.resolve(
          s.decisionSources
            .filter((d) => d.state === 'pending' && (d.processAfter === null || d.processAfter <= now))
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.sourceRef.localeCompare(b.sourceRef))[0] ?? null,
        ),
      listChatMessages: (chatId, limit) => Promise.resolve(s.chatMessages.filter((m) => m.chatId === chatId).slice(-limit)),
      addChatMessage: (message) => {
        const stored = { ...message, id: this.nextRowId++ };
        s.chatMessages.push(stored);
        return Promise.resolve(stored);
      },
      listChats: (boardId, email, limit) =>
        Promise.resolve(
          s.chats
            .filter((c) => c.boardId === boardId && c.email === email)
            .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt) || y.id - x.id)
            .slice(0, limit),
        ),
      getChat: (chatId) => Promise.resolve(s.chats.find((c) => c.id === chatId) ?? null),
      createChat: (chat) => {
        const stored = { ...chat, id: this.nextRowId++, updatedAt: chat.createdAt };
        s.chats.push(stored);
        return Promise.resolve(stored);
      },
      touchChat: (chatId, at) => {
        s.chats = s.chats.map((c) => (c.id === chatId ? { ...c, updatedAt: at } : c));
        return Promise.resolve();
      },
      deleteChat: (chatId) => {
        s.chats = s.chats.filter((c) => c.id !== chatId);
        s.chatMessages = s.chatMessages.filter((m) => m.chatId !== chatId);
        return Promise.resolve();
      },
      insertInboxItem: (input) => {
        const existing =
          s.inboxItems.find((i) => input.sourceRef !== '' && i.boardId === input.boardId && i.source === input.source && i.sourceRef === input.sourceRef) ??
          s.inboxItems.find((i) => i.boardId === input.boardId && i.contentHash === input.contentHash);
        if (existing !== undefined) return Promise.resolve({ item: existing, created: false });
        const item: InboxItem = {
          ...input,
          id: this.nextRowId++,
          status: input.status ?? 'new',
          summary: null,
          suggestions: [],
          state: input.state ?? 'pending',
          attempts: 0,
          processAfter: null,
          lastError: null,
          itemId: null,
          version: 1,
          updatedAt: input.createdAt,
        };
        s.inboxItems.push(item);
        return Promise.resolve({ item, created: true });
      },
      getActiveIntegrationToken: (boardId) =>
        Promise.resolve(s.integrationTokens.find((t) => t.boardId === boardId && t.revokedAt === null) ?? null),
      findIntegrationToken: (tokenHash) => Promise.resolve(s.integrationTokens.find((t) => t.tokenHash === tokenHash) ?? null),
      insertIntegrationToken: (token) => {
        s.integrationTokens.push({ ...token, id: this.nextRowId++, revokedAt: null });
        return Promise.resolve();
      },
      revokeIntegrationTokens: (boardId, at) => {
        s.integrationTokens = s.integrationTokens.map((t) => (t.boardId === boardId && t.revokedAt === null ? { ...t, revokedAt: at } : t));
        return Promise.resolve();
      },
      getInboxItem: (boardId, id) => Promise.resolve(s.inboxItems.find((i) => i.boardId === boardId && i.id === id) ?? null),
      getInboxItemBySource: (boardId, source, sourceRef) =>
        Promise.resolve(s.inboxItems.find((i) => i.boardId === boardId && i.source === source && i.sourceRef === sourceRef) ?? null),
      listInboxItems: (boardId, statuses) =>
        Promise.resolve(
          s.inboxItems
            .filter((i) => i.boardId === boardId && (statuses === undefined || statuses.includes(i.status)))
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id - a.id),
        ),
      updateInboxItem: (item, expectedVersion) => {
        const index = s.inboxItems.findIndex((i) => i.id === item.id);
        if (index < 0 || s.inboxItems[index]?.version !== expectedVersion) return Promise.resolve(false);
        s.inboxItems[index] = { ...item, version: expectedVersion + 1 };
        return Promise.resolve(true);
      },
      nextInboxItemToProcess: (now) =>
        Promise.resolve(
          s.inboxItems
            .filter((i) => i.state === 'pending' && i.status !== 'discarded' && (i.processAfter === null || i.processAfter <= now))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)[0] ?? null,
        ),
      insertInboxLink: (link) => {
        if (s.inboxLinks.some((l) => l.inboxId === link.inboxId && l.globId === link.globId)) return Promise.resolve(false);
        s.inboxLinks.push(link);
        return Promise.resolve(true);
      },
      deleteInboxLink: (inboxId, globId) => {
        const before = s.inboxLinks.length;
        s.inboxLinks = s.inboxLinks.filter((l) => l.inboxId !== inboxId || l.globId !== globId);
        return Promise.resolve(s.inboxLinks.length < before);
      },
      listInboxLinks: (boardId) => {
        const mine = new Set(s.inboxItems.filter((i) => i.boardId === boardId).map((i) => i.id));
        return Promise.resolve(s.inboxLinks.filter((l) => mine.has(l.inboxId)));
      },
      listInboxForGlob: (globId) => {
        const ids = s.inboxLinks.filter((l) => l.globId === globId).sort((a, b) => a.linkedAt.localeCompare(b.linkedAt)).map((l) => l.inboxId);
        return Promise.resolve(ids.flatMap((id) => s.inboxItems.find((i) => i.id === id) ?? []));
      },
      setItemLinks: (itemId, globIds, globGroup) => {
        for (const [key, item] of s.searchItems) if (item.id === itemId) s.searchItems.set(key, { ...item, globIds: [...globIds], globGroup });
        return Promise.resolve();
      },
      deleteItemByRef: (boardId, externalRef) => {
        const item = s.searchItems.get(itemKey(boardId, externalRef));
        if (item === undefined) return Promise.resolve();
        s.searchItems.delete(itemKey(boardId, externalRef));
        s.searchChunks = s.searchChunks.filter((c) => c.itemId !== item.id);
        return Promise.resolve();
      },
      appendEvents: (events) => {
        s.events.push(...events);
        return Promise.resolve();
      },
      deleteEvents: (globId) => {
        s.events = s.events.filter((e) => e.globId !== globId);
        return Promise.resolve();
      },
      enqueueEffects: (effects) => {
        for (const effect of effects) {
          // One pending recheck per board is enough: it reads the board as it is when it runs.
          if (effect.kind === 'recheck_overlaps' && s.outbox.some((e) => e.kind === 'recheck_overlaps' && e.globId === effect.globId)) continue;
          // One unclaimed knowledge page job per board; a Rebuild upgrades the waiting one and makes it due now.
          if (effect.kind === 'regenerate_knowledge_page') {
            const waiting = s.outboxJobs.find((j) => j.kind === effect.kind && j.globId === effect.globId && j.state === 'pending' && j.attempts === 0);
            if (waiting !== undefined) {
              if (effect.full === true && !(waiting.effect.kind === effect.kind && waiting.effect.full === true)) {
                s.outbox = s.outbox.map((e) => (e === waiting.effect ? effect : e));
                s.outboxJobs = s.outboxJobs.map((j) => (j === waiting ? { ...j, effect, runAfter: QUEUED_AT } : j));
              }
              continue;
            }
          }
          // One unclaimed KB pipeline job per item and kind: it re-reads the item when it runs. A claimed one (running, or
          // backing off) gets a sibling, so a change it may not have seen still gets its step.
          if ((effect.kind === 'kb_route' || effect.kind === 'kb_draft') && s.outboxJobs.some((j) => j.kind === effect.kind && j.globId === effect.globId && j.state === 'pending' && j.attempts === 0)) continue;
          // An on-demand review (it has a requestId) is always queued, and neither dedupes nor cancels the automatic ones.
          if (effect.kind === 'review_change' && effect.requestId === undefined) {
            const same = (e: Effect) => e.kind === 'review_change' && e.requestId === undefined && e.globId === effect.globId && e.stage === effect.stage;
            if (s.outbox.some((e) => same(e) && e.kind === 'review_change' && e.sha === effect.sha)) continue;
            // A newer pre-merge head cancels the older head's pending job.
            if (effect.stage === 'pre_merge') {
              s.outbox = s.outbox.filter((e) => !same(e));
              s.outboxJobs = s.outboxJobs.map((j) => (same(j.effect) && j.state === 'pending' ? { ...j, state: 'dropped' } : j));
            }
          }
          s.outbox.push(effect);
          s.outboxJobs.push({ id: this.nextRowId++, globId: effect.globId, kind: effect.kind, state: 'pending', attempts: 0, lastError: null, runAfter: QUEUED_AT, effect });
        }
        return Promise.resolve();
      },
    };
  }

  /** Chunks of one board that pass the query's filters and score above zero, best first. */
  private candidates(
    s: State,
    q: SearchQuery,
    relevance: (chunk: StoredChunk, item: KnowledgeItem) => number,
    include: (chunk: StoredChunk) => boolean = () => true,
  ): Candidate[] {
    const items = new Map([...s.searchItems.values()].map((i) => [i.id, i]));
    const out: Candidate[] = [];
    for (const chunk of s.searchChunks) {
      const item = items.get(chunk.itemId);
      if (item?.boardId !== q.boardId || !include(chunk) || !matchesFilters(item, q)) continue;
      const score = relevance(chunk, item);
      if (score <= 0) continue;
      out.push({
        chunkId: chunk.id,
        itemId: item.id,
        header: chunk.header,
        text: chunk.text,
        relevance: Math.min(1, score),
        sourceType: item.sourceType,
        title: item.title,
        occurredAt: item.occurredAt,
        authority: item.authority,
        status: item.status,
        supersededByTitle: item.supersededBy === null ? null : (items.get(item.supersededBy)?.title ?? null),
        supersededByAt: item.supersededBy === null ? null : (items.get(item.supersededBy)?.occurredAt ?? null),
        globIds: item.globIds,
        globGroup: item.globGroup,
        externalUrl: item.externalUrl,
      });
    }
    return out.sort((a, b) => b.relevance - a.relevance || a.chunkId - b.chunkId);
  }
}

export class RecordingNotifier implements Notifier {
  readonly hints: Hint[] = [];
  publish(hint: Hint): void {
    this.hints.push(hint);
  }
}
