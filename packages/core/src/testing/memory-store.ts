import type { Deploy } from '../domain/deploys.js';
import type { EnvironmentDeploy, GlobPresence } from '../domain/environments.js';
import type { DomainEvent, Effect } from '../domain/events.js';
import { sameCommit } from '../domain/signals.js';
import type { TestRun } from '../domain/test-runs.js';
import type { CodeReviewComment } from '../domain/code-review.js';
import type { ReviewFinding, ReviewSource } from '../domain/findings.js';
import { EFFECT_CHECK_GLOBS_DEFAULT } from '../domain/effect-check.js';
import type { KbItem } from '../domain/kb.js';
import { ARTIFACT_KINDS_WITH_CONTENT } from '../domain/signals.js';
import type { BoardJob, KbSignalState } from '../domain/signals.js';
import type { Artifact, ArtifactSummary, KnowledgeDoc } from '../domain/knowledge.js';
import type { SubLimitChange } from '../domain/sub-limit.js';
import type { Board, Glob, Member, User } from '../domain/types.js';
import type { GlobFilter, Hint, Notifier, Store, Tx } from '../ports.js';

interface State {
  globs: Map<string, { glob: Glob; creationKey: string | null }>;
  boards: Map<number, Board>;
  members: Map<string, Member>;
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
  environmentDeploys: EnvironmentDeploy[];
  /** Keyed by glob and environment. */
  globPresence: Map<string, GlobPresence>;
  testRuns: TestRun[];
  codeReviews: CodeReviewComment[];
  /** External IDs of CodeRabbit items deleted on the code host (tombstones). */
  deletedCodeReviews: string[];
}

const memberKey = (boardId: number, email: string) => `${boardId}:${email}`;

const clone = (state: State): State => ({
  globs: new Map(state.globs),
  boards: new Map(state.boards),
  members: new Map(state.members),
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
  environmentDeploys: [...state.environmentDeploys],
  globPresence: new Map(state.globPresence),
  testRuns: [...state.testRuns],
  codeReviews: [...state.codeReviews],
  deletedCodeReviews: [...state.deletedCodeReviews],
});

const knowledgeKey = (boardId: number, kind: string, name: string) => `${boardId}:${kind}:${name}`;

/** An in-memory Store for core tests. A transaction commits only if `work` resolves. */
export class MemoryStore implements Store {
  state: State = {
    globs: new Map(),
    boards: new Map(),
    members: new Map(),
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
    environmentDeploys: [],
    globPresence: new Map(),
    testRuns: [],
    codeReviews: [],
    deletedCodeReviews: [],
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
        s.artifacts = s.artifacts.filter((a) => a.globId !== id);
        s.findings = s.findings.filter((f) => f.globId !== id);
        s.reviewSources = s.reviewSources.filter((r) => r.globId !== id);
        for (const [key, p] of s.globPresence) if (p.globId === id) s.globPresence.delete(key);
        s.testRuns = s.testRuns.filter((r) => r.globId !== id);
        s.codeReviews = s.codeReviews.filter((c) => c.globId !== id);
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
        const board: Board = { ...input, id: s.nextBoardId++, deploy: null, readinessTicks: {}, version: 1, agentSetVersion: 0, agentCatalogHash: null, runNoProgressHours: 2, runReadyHours: 8, runStartMinutes: 30, subMaxChangedLines: 2000, effectCheckGlobs: EFFECT_CHECK_GLOBS_DEFAULT };
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
      setBaseChecks: (boardId, baseChecks) => {
        const current = s.boards.get(boardId);
        if (current !== undefined) s.boards.set(boardId, { ...current, baseChecks });
        return Promise.resolve();
      },
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
        if (s.deletedCodeReviews.includes(comment.externalId)) return Promise.resolve(false);
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
      deleteCodeReviewComment: (externalId) => {
        const stored = s.codeReviews.find((c) => c.externalId === externalId) ?? null;
        if (stored === null) return Promise.resolve(null);
        s.codeReviews = s.codeReviews.filter((c) => c.externalId !== externalId);
        s.deletedCodeReviews.push(externalId);
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
}

export class RecordingNotifier implements Notifier {
  readonly hints: Hint[] = [];
  publish(hint: Hint): void {
    this.hints.push(hint);
  }
}
