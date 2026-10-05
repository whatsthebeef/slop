import { err, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { formatId } from '../domain/ids.js';
import { isLearningType } from '../domain/kb.js';
import type { KbItem, KbItemStatus, KbOutcome, LearningType, ProposedDocument } from '../domain/kb.js';
import {
  agentSetKind,
  docName,
  hasFrontmatter,
  isAgentSetKind,
  parseFrontmatter,
  renderFrontmatter,
} from '../domain/knowledge.js';
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
  /** Required for statements; a document proposal (`/kb-bootstrap`) may come from outside any glob. */
  readonly sourceGlobId: string | null;
  /** Checked against `LEARNING_TYPES`; a string because it arrives from agents. */
  readonly type: string;
  readonly statement: string;
  readonly evidence: string;
  readonly suggestedTarget?: string | null;
  readonly agentSetVersion?: number | null;
  /** A whole document to propose (`/kb-bootstrap`); approving it creates or updates that document. */
  readonly document?: ProposedDocument | null;
}

/**
 * How an admin approves a KB item: keep the statement as an approved learning, apply it by hand as
 * new content for an existing document or agent-set file, or (document proposals) create or update
 * the proposed document. The statement or content may be edited first.
 */
export type Approval =
  | { readonly as: 'learning'; readonly statement?: string }
  | {
      readonly as: 'edit';
      readonly target: { readonly kind: KnowledgeKind; readonly name: string };
      readonly content: string;
      readonly statement?: string;
    }
  | { readonly as: 'document'; readonly content?: string };

/** An approved learning as `get_conventions(board)` serves it. */
export interface ApprovedLearning {
  readonly id: string;
  readonly type: LearningType;
  readonly statement: string;
  readonly sourceGlobIds: readonly string[];
  readonly approvedAt: string;
}

/** The board (its agent-set version) changed while documents were written; thrown so the writes roll back. */
class BoardChanged extends Error {
  constructor(boardId: number) {
    super(`Board ${boardId} changed during the write; retry`);
  }
}

/** A decision's conditional write lost to a concurrent one; thrown so the transaction rolls back. */
class StaleKbItem extends Error {
  constructor(id: string) {
    super(`KB item ${id} changed during the decision`);
  }
}

const SINGLE_LINE = /^[^\r\n]*$/;
const PLAIN_NAME = /^[\w.-]+$/;

/** Checks a proposed document's frontmatter fields, and strips any frontmatter from its body. */
const checkDocument = (document: ProposedDocument): Result<ProposedDocument> => {
  const name = docName(document.name);
  const area = document.area.trim();
  const description = document.description.trim();
  const audience = document.audience.map((a) => a.trim()).filter((a) => a !== '');
  const body = (hasFrontmatter(document.content) ? parseFrontmatter(document.content).body : document.content).trim();
  if (!PLAIN_NAME.test(name)) return invalidInput('A proposed document needs a name of letters, digits, _, . or -');
  if (area === '' || !SINGLE_LINE.test(area)) return invalidInput('A proposed document needs an area (one line)');
  if (description === '' || !SINGLE_LINE.test(description)) {
    return invalidInput('A proposed document needs a description (one line)');
  }
  if (!audience.every((a) => PLAIN_NAME.test(a))) return invalidInput('Audience entries are agent names');
  if (body === '') return invalidInput('A proposed document needs content');
  return ok({ name, area, audience, description, content: `${body}\n` });
};

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
    let document: ProposedDocument | null = null;
    if (learning.document !== undefined && learning.document !== null) {
      const checked = checkDocument(learning.document);
      if (!checked.ok) return checked;
      document = checked.value;
    }
    const sourceGlobId = learning.sourceGlobId?.trim() ?? '';
    if (sourceGlobId === '' && document === null) return invalidInput('A learning needs its source glob');
    const { type } = learning;
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const sourceGlobIds: string[] = [];
      if (sourceGlobId !== '') {
        const glob = await tx.getGlob(sourceGlobId);
        if (glob?.boardId !== boardId) return notFound(`No glob ${sourceGlobId} on board ${boardId}`);
        sourceGlobIds.push(glob.id);
      }
      const id = formatId(boardId, 'k', await tx.nextNumber(boardId, 'k'));
      const inserted = await tx.insertKbItem({
        id,
        boardId,
        status: 'open',
        type,
        statement,
        evidence,
        suggestedTarget: suggestedTarget === '' ? null : suggestedTarget,
        sourceGlobIds,
        source: 'submitted',
        agentSetVersion,
        submittedBy: email,
        createdAt: this.deps.clock.now(),
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        document,
        outcome: null,
        version: 1,
      });
      // The counter is atomic, so a clash means the counter and the table disagree.
      if (!inserted) throw new Error(`KB item ${id} already exists`);
      return ok({ id });
    });
  }

  /** The board's KB items, oldest first, optionally with one status. Members may read them. */
  async proposals(email: string, boardId: number, status?: KbItemStatus): Promise<Result<KbItem[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return ok(await tx.listKbItems(boardId, status));
    });
  }

  /** Items approved as learnings (not applied to a document), for `get_conventions(board)`. */
  async approvedLearnings(email: string, boardId: number): Promise<Result<ApprovedLearning[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const items = await tx.listKbItems(boardId, 'approved');
      return ok(
        items
          .filter((i) => i.outcome?.kind === 'learning')
          .map((i) => ({
            id: i.id,
            type: i.type,
            statement: i.statement,
            sourceGlobIds: i.sourceGlobIds,
            approvedAt: i.decidedAt ?? i.createdAt,
          })),
      );
    });
  }

  /**
   * Admins approve an open KB item, conditional on the version they read. Edits and documents are
   * written through `write` in the same transaction as the decision, so they version the document,
   * and an agent-set file bumps the board's agent-set version.
   */
  async approve(email: string, itemId: string, version: number, approval: Approval): Promise<Result<KbItem>> {
    return this.decide(email, itemId, version, async (tx, item) => {
      if (approval.as === 'document') {
        if (item.document === null) return invalidInput(`${item.id} is not a document proposal`);
        const document = checkDocument({ ...item.document, content: approval.content ?? item.document.content });
        if (!document.ok) return document;
        const { name, content } = document.value;
        const outcome = await this.apply(tx, email, item, 'doc', name, renderFrontmatter(document.value) + content);
        return outcome.ok ? ok({ statement: item.statement, outcome: outcome.value }) : outcome;
      }
      if (item.document !== null) return invalidInput(`${item.id} proposes a document; approve it as that document`);
      const statement = approval.statement?.trim() ?? item.statement;
      if (statement === '') return invalidInput('A learning needs a statement');
      if (approval.as === 'learning') return ok({ statement, outcome: { kind: 'learning' } });

      const { kind, name } = approval.target;
      const existing = await tx.getKnowledge(item.boardId, kind, name);
      if (existing === null) {
        return notFound(`No ${kind === 'doc' ? 'document' : 'agent-set file'} ${name} on board ${item.boardId}`);
      }
      if (approval.content.trim() === '') return invalidInput('The new content is empty');
      // A document edited without frontmatter keeps its area, audience and description.
      const content =
        kind === 'doc' && !hasFrontmatter(approval.content) ? renderFrontmatter(existing) + approval.content : approval.content;
      const outcome = await this.apply(tx, email, item, kind, name, content);
      return outcome.ok ? ok({ statement, outcome: outcome.value }) : outcome;
    });
  }

  /** Admins reject an open KB item with a reason; it is kept so repeats can be suppressed later. */
  async reject(email: string, itemId: string, version: number, reason: string): Promise<Result<KbItem>> {
    const trimmed = reason.trim();
    if (trimmed === '') return invalidInput('Rejecting needs a reason');
    return this.decide(email, itemId, version, () => Promise.resolve(ok({ reason: trimmed })));
  }

  /** A decision: the item exists, the caller is an admin of its board, it is unchanged since read and still open. */
  private async decide(
    email: string,
    itemId: string,
    version: number,
    decision: (tx: Tx, item: KbItem) => Promise<Result<{ statement: string; outcome: KbOutcome } | { reason: string }>>,
  ): Promise<Result<KbItem>> {
    const stale = (item: KbItem) => err({ code: 'version_conflict', message: `${item.id} has changed`, currentItem: item });
    try {
      return await this.deps.store.transaction(async (tx) => {
        const item = await tx.getKbItem(itemId);
        if (item === null) return notFound(`No KB item ${itemId}`);
        const actor = await adminOf(tx, email, item.boardId);
        if (!actor.ok) return actor;
        if (item.version !== version) return stale(item);
        if (item.status !== 'open') return invalidInput(`${item.id} is already ${item.status}`);
        const decided = await decision(tx, item);
        if (!decided.ok) return decided;
        const base = { ...item, decidedBy: email, decidedAt: this.deps.clock.now(), version: item.version + 1 };
        const next: KbItem =
          'reason' in decided.value
            ? { ...base, status: 'rejected', decisionReason: decided.value.reason }
            : { ...base, status: 'approved', statement: decided.value.statement, outcome: decided.value.outcome };
        if (!(await tx.updateKbItem(next, item.version))) throw new StaleKbItem(item.id);
        return ok(next);
      });
    } catch (error) {
      // A concurrent agent-set change (another approval or import) is a conflict to retry, like a stale item.
      if (!(error instanceof StaleKbItem || error instanceof BoardChanged)) throw error;
      const current = await this.deps.store.transaction((tx) => tx.getKbItem(itemId));
      if (current === null) return notFound(`No KB item ${itemId}`);
      return error instanceof BoardChanged
        ? err({ code: 'version_conflict', message: 'The board changed meanwhile; try again', currentItem: current })
        : stale(current);
    }
  }

  /** Writes an approved change to a document or agent-set file and returns the outcome with its new version. */
  private async apply(
    tx: Tx,
    email: string,
    item: KbItem,
    kind: KnowledgeKind,
    name: string,
    content: string,
  ): Promise<Result<KbOutcome>> {
    const written = await this.write(tx, email, item.boardId, [{ kind, name, content, source: `kb:${item.id}` }]);
    if (!written.ok) return written;
    const saved = await tx.getKnowledge(item.boardId, kind, name);
    if (saved === null) throw new Error(`${name} was not saved`);
    return ok({ kind: 'applied', target: kind, name, version: saved.version });
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
      if (!(await tx.updateBoard(next, board.version))) throw new BoardChanged(boardId);
    }
    if (created.length + updated.length > 0) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    return ok({ created, updated, unchanged });
  }
}
