import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { formatId } from '../domain/ids.js';
import { isLearningType } from '../domain/kb.js';
import { agentSetKind, docName, isAgentSetKind, parseFrontmatter } from '../domain/knowledge.js';
import type { KnowledgeDoc, KnowledgeKind } from '../domain/knowledge.js';
import type { Board } from '../domain/types.js';
import type { Catalog, Clock, Notifier, Store, Tx } from '../ports.js';
import { adminOf, memberOf } from './access.js';

export interface IndexEntry {
  readonly name: string;
  readonly area: string | null;
  readonly audience: readonly string[];
  readonly description: string;
  readonly version: number;
  readonly source: string;
}

export interface AgentSet {
  readonly version: number;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

export interface ImportResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
}

export interface NewLearning {
  readonly sourceGlobId: string;
  /** Checked against `LEARNING_TYPES`; a string because it arrives from agents. */
  readonly type: string;
  readonly statement: string;
  readonly evidence: string;
  readonly suggestedTarget?: string | null;
  readonly agentSetVersion?: number | null;
}

export interface NewDocument {
  /** A file name or path; documents are named after it, agent-set files keep their path. */
  readonly fileName: string;
  readonly content: string;
}

/**
 * A board's knowledge base: documents served to agents by area and audience, and the board's
 * fork of the agent set. Imports are admin-only; everything else is open to members.
 */
export class KnowledgeService {
  constructor(
    private readonly deps: { store: Store; clock: Clock; catalog: Catalog; notifier: Notifier },
  ) {}

  /** `get_conventions(board)`: the document index, so agents know what to fetch. */
  async index(email: string, boardId: number): Promise<Result<IndexEntry[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const docs = await tx.listKnowledge(boardId, ['doc']);
      return ok(
        docs.map(({ name, area, audience, description, version, source }) => ({
          name,
          area,
          audience,
          description,
          version,
          source,
        })),
      );
    });
  }

  /** `get_conventions(board, area)`: the documents in an area, or one document by name. */
  async documents(email: string, boardId: number, areaOrName: string): Promise<Result<KnowledgeDoc[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const key = areaOrName.trim().toLowerCase();
      const docs = (await tx.listKnowledge(boardId, ['doc'])).filter(
        (d) => d.area?.toLowerCase() === key || d.name.toLowerCase() === key,
      );
      return docs.length === 0 ? notFound(`No documents for "${areaOrName}" on board ${boardId}`) : ok(docs);
    });
  }

  /** `get_agent_set(board)`: every agent-set file and the set's version. */
  async agentSet(email: string, boardId: number): Promise<Result<AgentSet>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${boardId}`);
      const files = (await tx.listKnowledge(boardId))
        .filter((d) => isAgentSetKind(d.kind))
        .map((d) => ({ path: d.name, content: d.content }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return ok({ version: board.agentSetVersion, files });
    });
  }

  /** Imports documents (uploads, a project's existing docs, `import_knowledge`). Frontmatter sets area and audience. */
  async importDocuments(
    email: string,
    boardId: number,
    documents: readonly NewDocument[],
    source: 'upload' | 'import',
  ): Promise<Result<ImportResult>> {
    if (documents.length === 0) return invalidInput('Nothing to import');
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const result = await this.write(
        tx,
        email,
        boardId,
        documents.map((d) => ({ kind: 'doc' as const, name: docName(d.fileName), content: d.content, source })),
      );
      return result;
    });
  }

  /** Imports (forks) catalog KB entries by ID. */
  async importCatalogEntries(email: string, boardId: number, ids: readonly string[]): Promise<Result<ImportResult>> {
    const entries = (await this.deps.catalog.kbEntries()).filter((e) => ids.includes(e.id));
    const missing = ids.filter((id) => !entries.some((e) => e.id === id));
    if (missing.length > 0) return notFound(`Not in the catalog: ${missing.join(', ')}`);
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return this.write(
        tx,
        email,
        boardId,
        entries.map((e) => ({ kind: 'doc' as const, name: docName(e.fileName), content: e.content, source: `catalog:${e.id}@${e.version}` })),
      );
    });
  }

  /** Forks the catalog's agent set into the board (a new board, or adopting catalog changes). */
  async forkAgentSet(email: string, boardId: number): Promise<Result<ImportResult>> {
    const files = await this.deps.catalog.agentSet();
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const items: { kind: KnowledgeKind; name: string; content: string; source: string }[] = [];
      for (const file of files) {
        const kind = agentSetKind(file.path);
        if (kind !== null) items.push({ kind, name: file.path, content: file.content, source: 'catalog:agents' });
      }
      return this.write(tx, email, boardId, items);
    });
  }

  /**
   * `submit_learning`: records an agent's learning as an open KB item (`s<board>k<n>`) for admins
   * to review. Capture only: nothing reaches the knowledge base until it is approved.
   */
  async submitLearning(email: string, boardId: number, learning: NewLearning): Promise<Result<{ id: string }>> {
    const statement = learning.statement.trim();
    const evidence = learning.evidence.trim();
    const suggestedTarget = learning.suggestedTarget?.trim() ?? '';
    const agentSetVersion = learning.agentSetVersion ?? null;
    if (!isLearningType(learning.type)) {
      return invalidInput(`Unknown learning type "${learning.type}"; use decision, gotcha, pattern or agent-behaviour`);
    }
    if (statement === '') return invalidInput('A learning needs a statement');
    if (evidence === '') return invalidInput('A learning needs evidence');
    if (agentSetVersion !== null && (!Number.isInteger(agentSetVersion) || agentSetVersion < 0)) {
      return invalidInput('agentSetVersion must be a whole number');
    }
    const { type } = learning;
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const glob = await tx.getGlob(learning.sourceGlobId);
      if (glob?.boardId !== boardId) return notFound(`No glob ${learning.sourceGlobId} on board ${boardId}`);
      const id = formatId(boardId, 'k', await tx.nextNumber(boardId, 'k'));
      const inserted = await tx.insertKbItem({
        id,
        boardId,
        status: 'open',
        type,
        statement,
        evidence,
        suggestedTarget: suggestedTarget === '' ? null : suggestedTarget,
        sourceGlobIds: [glob.id],
        source: 'submitted',
        agentSetVersion,
        submittedBy: email,
        createdAt: this.deps.clock.now(),
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        version: 1,
      });
      // The counter is atomic, so a clash means the counter and the table disagree.
      if (!inserted) throw new Error(`KB item ${id} already exists`);
      return ok({ id });
    });
  }

  /** Writes documents, versioning only real changes; any agent-set change bumps the set's version. */
  private async write(
    tx: Tx,
    email: string,
    boardId: number,
    items: readonly { kind: KnowledgeKind; name: string; content: string; source: string }[],
  ): Promise<Result<ImportResult>> {
    const board = await tx.getBoard(boardId);
    if (board === null) return notFound(`No board ${boardId}`);
    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    let agentSetChanged = false;
    const now = this.deps.clock.now();

    for (const item of items) {
      if (item.name === '') return invalidInput('Every document needs a name');
      const meta =
        item.kind === 'doc'
          ? parseFrontmatter(item.content)
          : { area: null, audience: [], description: '', body: item.content };
      const existing = await tx.getKnowledge(boardId, item.kind, item.name);
      const same =
        existing !== null &&
        existing.content === meta.body &&
        existing.area === meta.area &&
        existing.description === meta.description &&
        existing.audience.join(',') === meta.audience.join(',');
      if (same) {
        unchanged.push(item.name);
        continue;
      }
      await tx.saveKnowledge({
        boardId,
        kind: item.kind,
        name: item.name,
        area: meta.area,
        audience: meta.audience,
        description: meta.description,
        content: meta.body,
        version: (existing?.version ?? 0) + 1,
        source: item.source,
        updatedBy: email,
        updatedAt: now,
      });
      (existing === null ? created : updated).push(item.name);
      if (isAgentSetKind(item.kind)) agentSetChanged = true;
    }

    if (agentSetChanged) {
      const next: Board = { ...board, agentSetVersion: board.agentSetVersion + 1, version: board.version + 1 };
      if (!(await tx.updateBoard(next, board.version))) throw new Error('Board changed during import; retry');
    }
    if (created.length + updated.length > 0) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    return ok({ created, updated, unchanged });
  }
}
