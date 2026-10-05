import type { DomainEvent, Effect } from '../domain/events.js';
import type { KbItem } from '../domain/kb.js';
import type { Artifact, ArtifactSummary, KnowledgeDoc } from '../domain/knowledge.js';
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
  };

  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const draft = clone(this.state);
    const result = await work(this.tx(draft));
    this.state = draft;
    return result;
  }

  private tx(s: State): Tx {
    return {
      getGlob: (id) => Promise.resolve(s.globs.get(id)?.glob ?? null),
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
        const board: Board = { ...input, id: s.nextBoardId++, version: 1, agentSetVersion: 0, runNoProgressHours: 2, runReadyHours: 8, subMaxChangedLines: 2000 };
        s.boards.set(board.id, board);
        return Promise.resolve(board);
      },
      updateBoard: (board, expectedVersion) => {
        const current = s.boards.get(board.id);
        if (current?.version !== expectedVersion) return Promise.resolve(false);
        s.boards.set(board.id, board);
        return Promise.resolve(true);
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
      updateKbItem: (item, expectedVersion) => {
        if (s.kbItems.get(item.id)?.version !== expectedVersion) return Promise.resolve(false);
        s.kbItems.set(item.id, item);
        return Promise.resolve(true);
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
}

export class RecordingNotifier implements Notifier {
  readonly hints: Hint[] = [];
  publish(hint: Hint): void {
    this.hints.push(hint);
  }
}
