import type { BoardSession } from '../domain/board-sessions.js';
import type { Decision, DecisionSource } from '../domain/decisions.js';
import type { InboxItem, InboxLink } from '../domain/inbox.js';
import type { IntegrationToken } from '../domain/integration-tokens.js';
import type { Deploy } from '../domain/deploys.js';
import type { EnvironmentDeploy, GlobPresence } from '../domain/environments.js';
import type { DomainEvent, Effect } from '../domain/events.js';
import { sameCommit } from '../domain/signals.js';
import type { TestRun } from '../domain/test-runs.js';
import type { CodeReviewComment } from '../domain/code-review.js';
import type { BoardNotification } from '../domain/notifications.js';
import type { ChatMessage, ChatThread } from '../domain/chat.js';
import type { ReviewFinding, ReviewSource } from '../domain/findings.js';
import { EFFECT_CHECK_GLOBS_DEFAULT } from '../domain/effect-check.js';
import type { KbItem } from '../domain/kb.js';
import { ARTIFACT_KINDS_WITH_CONTENT } from '../domain/signals.js';
import type { BoardJob, KbSignalState } from '../domain/signals.js';
import type { Artifact, ArtifactSummary, KnowledgeDoc } from '../domain/knowledge.js';
import { GLOB_OWNED_SOURCES, matchesFilters } from '../domain/search.js';
import type { Candidate, KnowledgeItem } from '../domain/search.js';
import { DEFAULT_SIZE_THRESHOLD } from '../domain/size-check.js';
import type { SizeCheck, SizeThreshold, SizeThresholdChange } from '../domain/size-check.js';
import type { SubLimitChange } from '../domain/sub-limit.js';
import type { GlobOutcome, IntakeSnapshot } from '../domain/intake-learning.js';
import type { Board, Glob, Member, User } from '../domain/types.js';
import type { GlobFilter, Hint, Notifier, Store, Tx } from '../ports.js';
import type { SearchQuery } from '../domain/search.js';

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
  nextBoardId: number;
  knowledge: Map<string, KnowledgeDoc>;
  knowledgeHistory: KnowledgeDoc[];
  artifacts: Artifact[];
  kbItems: Map<string, KbItem>;
  deploys: Map<string, Deploy>;
  reviewSources: ReviewSource[];
  findings: ReviewFinding[];
  kbSignals: Map<string, KbSignalState>;
  boardJobs: Map<string, BoardJob>;
  boardJobStates: Map<string, unknown>;
  subLimitChanges: SubLimitChange[];
  sizeChecks: SizeCheck[];
  sizeThresholds: Map<number, SizeThreshold>;
  sizeThresholdChanges: SizeThresholdChange[];
  intakeSnapshots: { snapshot: IntakeSnapshot; embedding: readonly number[] | null }[];
  globOutcomes: GlobOutcome[];
  environmentDeploys: EnvironmentDeploy[];
  /** Keyed by glob and environment. */
  globPresence: Map<string, GlobPresence>;
  testRuns: TestRun[];
  codeReviews: CodeReviewComment[];
  /** External IDs of CodeRabbit items deleted on the code host (tombstones). */
  /** Tombstones: external ID and when it was deleted, as Postgres keeps `deleted_at`. */
  deletedCodeReviews: { externalId: string; at: string }[];
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
  nextBoardId: state.nextBoardId,
  knowledge: new Map(state.knowledge),
  knowledgeHistory: [...state.knowledgeHistory],
  artifacts: [...state.artifacts],
  kbItems: new Map(state.kbItems),
  deploys: new Map(state.deploys),
  reviewSources: [...state.reviewSources],
  findings: [...state.findings],
  kbSignals: new Map(state.kbSignals),
  boardJobs: new Map(state.boardJobs),
  boardJobStates: new Map(state.boardJobStates),
  subLimitChanges: [...state.subLimitChanges],
  sizeChecks: [...state.sizeChecks],
  sizeThresholds: new Map(state.sizeThresholds),
  sizeThresholdChanges: [...state.sizeThresholdChanges],
  intakeSnapshots: [...state.intakeSnapshots],
  globOutcomes: [...state.globOutcomes],
  environmentDeploys: [...state.environmentDeploys],
  globPresence: new Map(state.globPresence),
  testRuns: [...state.testRuns],
  codeReviews: [...state.codeReviews],
  deletedCodeReviews: [...state.deletedCodeReviews],
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
    nextBoardId: 1,
    knowledge: new Map(),
    knowledgeHistory: [],
    artifacts: [],
    kbItems: new Map(),
    deploys: new Map(),
    reviewSources: [],
    findings: [],
    kbSignals: new Map(),
    boardJobs: new Map(),
    boardJobStates: new Map(),
    subLimitChanges: [],
    sizeChecks: [],
    sizeThresholds: new Map(),
    sizeThresholdChanges: [],
    intakeSnapshots: [],
    globOutcomes: [],
    environmentDeploys: [],
    globPresence: new Map(),
    testRuns: [],
    codeReviews: [],
    deletedCodeReviews: [],
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
        s.codeReviews = s.codeReviews.filter((c) => c.globId !== id);
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
                (filter.status === undefined || filter.status.includes(g.status)) &&
                (filter.type === undefined || g.type === filter.type) &&
                (filter.group === undefined || g.group === filter.group) &&
                (filter.person === undefined ||
                  g.planner === filter.person ||
                  g.implementer === filter.person),
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
        const board: Board = { ...input, id: s.nextBoardId++, deploy: null, readinessTicks: {}, version: 1, agentSetVersion: 0, agentCatalogHash: null, runNoProgressHours: 2, runReadyHours: 8, runStartMinutes: 30, runRespondMinutes: 30, subMaxChangedLines: 2000, effectCheckGlobs: EFFECT_CHECK_GLOBS_DEFAULT, agentKbApproval: 'docs' };
        s.boards.set(board.id, board);
        return Promise.resolve(board);
      },
      updateBoard: (board, expectedVersion) => {
        const current = s.boards.get(board.id);
        if (current?.version !== expectedVersion) return Promise.resolve(false);
        // As in Postgres, the learned sub limit has its own write.
        s.boards.set(board.id, { ...board, subMaxChangedLines: current.subMaxChangedLines });
        return Promise.resolve(true);
      },
      setSubLimit: (boardId, from, to) => {
        const current = s.boards.get(boardId);
        if (current?.subMaxChangedLines !== from) return Promise.resolve(false);
        s.boards.set(boardId, { ...current, subMaxChangedLines: to });
        return Promise.resolve(true);
      },
      insertSubLimitChange: (change) => {
        if (s.subLimitChanges.some((c) => c.boardId === change.boardId && c.globId === change.globId && c.outcome === change.outcome)) {
          return Promise.resolve(false);
        }
        s.subLimitChanges.push({ ...change, id: this.nextRowId++ });
        return Promise.resolve(true);
      },
      listSubLimitChanges: (boardId) =>
        Promise.resolve(s.subLimitChanges.filter((c) => c.boardId === boardId).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)),
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
      setBoardSessionOrder: (email, boardIds) => {
        for (const m of s.members.values()) {
          if (m.email !== email) continue;
          const key = memberKey(m.boardId, email);
          const index = boardIds.indexOf(m.boardId);
          const session = s.boardSessions.get(key);
          if (index !== -1) s.boardSessions.set(key, { position: index + 1, lastViewedAt: session?.lastViewedAt ?? null });
          else if (session !== undefined) s.boardSessions.set(key, { ...session, position: null });
        }
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
        return Promise.resolve([...latest.values()].sort((a, b) => b.id - a.id));
      },
      artifactVersions: (globId, kind, label) =>
        Promise.resolve(s.artifacts.filter((a) => a.globId === globId && a.kind === kind && a.label === label)),
      listArtifactSummaries: (boardId, globIds) => {
        const onBoard = (id: string) => s.globs.get(id)?.glob.boardId === boardId && globIds.includes(id);
        const summaries = new Map<string, ArtifactSummary>();
        for (const a of s.artifacts) {
          if (!onBoard(a.globId)) continue;
          const key = `${a.globId}:${a.kind}:${a.label}`;
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
          });
        }
        return Promise.resolve([...summaries.values()]);
      },
      insertKbItem: (item) => {
        if (s.kbItems.has(item.id)) return Promise.resolve(false);
        s.kbItems.set(item.id, item);
        return Promise.resolve(true);
      },
      getKbItem: (id) => Promise.resolve(s.kbItems.get(id) ?? null),
      listKbItems: (boardId, status) =>
        Promise.resolve(
          [...s.kbItems.values()].filter((i) => i.boardId === boardId && (status === undefined || i.status === status)),
        ),
      listRecentKbItems: (boardId, statuses, limit) => {
        // Newest by decision, else by submission; later inserts first among equals.
        const all = [...s.kbItems.values()]
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.boardId === boardId && statuses.includes(item.status))
          .sort((a, b) => (b.item.decidedAt ?? b.item.createdAt).localeCompare(a.item.decidedAt ?? a.item.createdAt) || b.index - a.index)
          .map(({ item }) => item);
        return Promise.resolve({ items: all.slice(0, limit), total: all.length });
      },
      nextKbItemToProcess: (now) =>
        Promise.resolve(
          [...s.kbItems.values()]
            .filter(
              (i) =>
                i.status === 'open' &&
                (i.processing === 'pending' || i.processing === 'routed') &&
                (i.processAfter === null || i.processAfter <= now),
            )
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] ?? null,
        ),
      listFailedKbItems: () =>
        Promise.resolve([...s.kbItems.values()].filter((i) => i.status === 'open' && i.processing === 'failed')),
      updateKbItem: (item, expectedVersion) => {
        if (s.kbItems.get(item.id)?.version !== expectedVersion) return Promise.resolve(false);
        s.kbItems.set(item.id, item);
        return Promise.resolve(true);
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
      upsertCodeReviewComment: (comment) => {
        if (s.deletedCodeReviews.some((d) => d.externalId === comment.externalId)) return Promise.resolve(false);
        const stored = s.codeReviews.find((c) => c.externalId === comment.externalId);
        if (stored === undefined) {
          s.codeReviews.push({ ...comment, id: this.nextRowId++ });
          return Promise.resolve(true);
        }
        if (stored.updatedAt > comment.updatedAt) return Promise.resolve(false);
        const next = { ...stored, kind: comment.kind, body: comment.body, url: comment.url, commitSha: comment.commitSha, path: comment.path, line: comment.line, updatedAt: comment.updatedAt };
        const changed = JSON.stringify(next) !== JSON.stringify(stored);
        s.codeReviews = s.codeReviews.map((c) => (c === stored ? next : c));
        return Promise.resolve(changed);
      },
      deleteCodeReviewComment: (externalId, at) => {
        const stored = s.codeReviews.find((c) => c.externalId === externalId) ?? null;
        if (stored === null) return Promise.resolve(null);
        s.codeReviews = s.codeReviews.filter((c) => c.externalId !== externalId);
        s.deletedCodeReviews.push({ externalId, at });
        return Promise.resolve(stored);
      },
      listCodeReviewComments: (boardId, globIds) =>
        Promise.resolve(
          s.codeReviews
            .filter((c) => c.boardId === boardId && globIds.includes(c.globId))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id),
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
            (f) => f.globId === input.globId && f.source === input.source && f.fingerprint === input.fingerprint,
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
      listBoardEvents: (boardId, since, types) =>
        Promise.resolve(
          s.events
            .map((event, index) => ({ event, index }))
            .filter(
              ({ event }) =>
                s.globs.get(event.globId)?.glob.boardId === boardId &&
                event.at >= since &&
                (types === undefined || types.includes(event.type)),
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
      listGlobOutcomes: (boardId) => Promise.resolve(s.globOutcomes.filter((o) => o.boardId === boardId)),
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
        s.outbox.push(...effects);
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
