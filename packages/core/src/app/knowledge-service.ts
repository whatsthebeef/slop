import { err, forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { formatId } from '../domain/ids.js';
import { composeAgentSet, contextDiff, overlayProblem } from '../domain/agent-set.js';
import type { AgentSetEntry, AgentSetEntryStatus, ComposedAgentSet } from '../domain/agent-set.js';
import { byEvidence, evidenceCount, isLearningType, KB_HISTORY_MAX, KB_HISTORY_PAGE, lastEvidenceAt, needsDraft, UNPROCESSED } from '../domain/kb.js';
import type {
  DraftPreview,
  KbItem,
  KbItemPage,
  KbItemStatus,
  KbItemView,
  KbOutcome,
  KbProposalList,
  KbTarget,
  KbVia,
  LearningType,
  NewDocumentMeta,
  ProposedDocument,
} from '../domain/kb.js';
import {
  agentSetKind,
  catalogUpdates,
  docName,
  hasFrontmatter,
  isAgentSetKind,
  parseFrontmatter,
  PROSE_KINDS,
  renderFrontmatter,
} from '../domain/knowledge.js';
import type { CatalogUpdate, KnowledgeDoc, KnowledgeKind, KnowledgeLayer } from '../domain/knowledge.js';
import { LOCAL_RUN_NAME, parseLocalRun, renderLocalRun } from '../domain/local-run.js';
import type { LocalRun } from '../domain/local-run.js';
import { MERGE_POLICY_NAME, parseMergePolicy, renderMergePolicy } from '../domain/merge-policy.js';
import type { MergePolicy } from '../domain/merge-policy.js';
import { isReviewGuide } from '../domain/code-review.js';
import { effectBasisOf, effectItemOf, isEffectMeasured, startEffectCheck } from '../domain/effect-check.js';
import type { EffectCheck } from '../domain/effect-check.js';
import type { KbSignal } from '../domain/signals.js';
import { splicePreview } from '../domain/sections.js';
import type { Board } from '../domain/types.js';
import type { Catalog, CatalogAgentSet, Clock, Hint, Notifier, Store, Tx } from '../ports.js';
import { adminOf, memberOf } from './access.js';

/** A board's review guide documents, for `get_review_guide`. */
export interface ReviewGuide {
  readonly boardId: number;
  readonly boardName: string;
  readonly documents: readonly KnowledgeDoc[];
}

export interface IndexEntry {
  readonly name: string;
  readonly area: string | null;
  readonly audience: readonly string[];
  readonly description: string;
  readonly version: number;
  readonly source: string;
}

/**
 * The agent set as served: catalog files with the board's layers applied, plus the board's own files.
 * The local-run spec travels beside it (`sstor init` writes it to `.sstor/local-run.json`), outside
 * `files` and the version.
 */
export interface AgentSet {
  readonly version: number;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  /** Null when the board has none, or its stored value fails the check (`localRunProblem` then says why). */
  readonly localRun: LocalRun | null;
  readonly localRunProblem: string | null;
}

/** The board's local-run spec for the Knowledge page (read-only there; it changes through KB items). */
export interface LocalRunView {
  /** Null when the board has none, or its stored value fails the check (`problem`). */
  readonly spec: LocalRun | null;
  /** The stored text, as is; null without a row. */
  readonly content: string | null;
  readonly version: number | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
  readonly problem: string | null;
}

/** A stored local-run row, checked again on read: a value that fails the check is never served. */
const storedLocalRun = (row: KnowledgeDoc | null): { spec: LocalRun | null; problem: string | null } => {
  if (row === null) return { spec: null, problem: null };
  const parsed = parseLocalRun(row.content);
  return parsed.ok
    ? { spec: parsed.value, problem: null }
    : { spec: null, problem: `The stored local-run spec (version ${row.version}) is invalid: ${parsed.error.message}` };
};

/** A local-run value from an approval or draft, checked and in canonical form. */
const checkedLocalRun = (content: string): Result<string> => {
  const parsed = parseLocalRun(content);
  return parsed.ok ? ok(renderLocalRun(parsed.value)) : parsed;
};

/** The board's merge policy for the Knowledge page (read-only there; it changes through KB items). */
export interface MergePolicyView {
  /** Null when the board has none, or its stored value fails the check (`problem`). */
  readonly policy: MergePolicy | null;
  readonly content: string | null;
  readonly version: number | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
  readonly problem: string | null;
}

/** A stored merge-policy row, checked again on read: a value that fails the check is never served. */
const storedMergePolicy = (row: KnowledgeDoc | null): { policy: MergePolicy | null; problem: string | null } => {
  if (row === null) return { policy: null, problem: null };
  const parsed = parseMergePolicy(row.content);
  return parsed.ok
    ? { policy: parsed.value, problem: null }
    : { policy: null, problem: `The stored merge policy (version ${row.version}) is invalid: ${parsed.error.message}` };
};

/** A merge-policy value from an approval or draft, checked and in canonical form. */
const checkedMergePolicy = (content: string): Result<string> => {
  const parsed = parseMergePolicy(content);
  return parsed.ok ? ok(renderMergePolicy(parsed.value)) : parsed;
};

/**
 * The board's merge policy as slop acts on it: empty when it has none or its stored value fails the check, so a bad
 * row never holds a glob.
 */
export const readMergePolicy = async (tx: Tx, boardId: number): Promise<MergePolicy> =>
  storedMergePolicy(await tx.getKnowledge(boardId, 'merge_policy', MERGE_POLICY_NAME)).policy ?? {};

/** Every path in the board's agent set and how it is served, for the Knowledge page. */
export interface AgentSetIndex {
  readonly version: number;
  readonly entries: readonly AgentSetEntry[];
}

/** One agent-set file for editing: the board's layer, the catalog's text beside it, and the result. */
export interface AgentSetFileView {
  readonly path: string;
  readonly kind: KnowledgeKind;
  readonly status: AgentSetEntryStatus;
  /** What an edit writes: the overlay (empty when the board has none yet) or the whole board file. */
  readonly layer: KnowledgeLayer;
  readonly content: string;
  /** The board row's version; null when the file comes from the catalog with no board row. */
  readonly version: number | null;
  /** The catalog's text, read-only; null for a file the catalog doesn't have. */
  readonly catalog: string | null;
  /** The file as served (placeholders unfilled); null for an orphaned overlay, which isn't served. */
  readonly served: string | null;
}

interface WriteItem {
  readonly kind: KnowledgeKind;
  readonly name: string;
  readonly content: string;
  readonly source: string;
  /** Agent-set rows only; documents are always `file`. */
  readonly layer?: KnowledgeLayer;
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
 * new content for an existing document or agent-set file, (document proposals) create or update
 * the proposed document, or apply the item's draft to its target (one click, or with the drafted
 * section edited first). The statement or content may be edited first. For an agent-set file the
 * content is the board's layer: its overlay on a catalog file, or the whole file the board owns.
 */
export type Approval = (
  | { readonly as: 'learning'; readonly statement?: string }
  | {
      readonly as: 'edit';
      readonly target: { readonly kind: KnowledgeKind; readonly name: string };
      readonly content: string;
      readonly statement?: string;
    }
  | { readonly as: 'document'; readonly content?: string }
  | {
      readonly as: 'draft';
      /** Edited section text (or a new document's body) in place of the draft's. */
      readonly content?: string;
      /** The heading the edited content replaces, or null to append it; defaults to the draft's. */
      readonly section?: string | null;
      readonly statement?: string;
    }
) & {
  /**
   * A submitted item (it has no signal): the key of one of the board's measured signals for the effect check to
   * watch (`watchableSignals`). Absent: none.
   */
  readonly watchSignal?: string;
};

/**
 * The board's signals as measured now (the mining service), for the signal an admin picks to watch when approving
 * a submitted item.
 */
export interface SignalMeasure {
  measure(tx: Tx, boardId: number, now: string): Promise<readonly KbSignal[]>;
}

/** An admin's choice of target for an item; drafting starts again against it (routing is skipped). */
export interface TargetChange {
  readonly kind: KnowledgeKind;
  readonly name: string;
  readonly section: string | null;
  /** Required when the document doesn't exist yet. */
  readonly newDocument?: NewDocumentMeta | null;
}

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

/** An item as the Knowledge page lists it. */
const view = (item: KbItem, preview: DraftPreview | null): KbItemView => ({
  ...item,
  preview,
  evidenceCount: evidenceCount(item),
  lastEvidenceAt: lastEvidenceAt(item),
});

/** Why an agent may not approve the item, or null when it may: these are decided by a person. */
const keptForPeople = (item: KbItem): string | null => {
  if (item.document !== null) return 'proposes a whole document';
  if (item.contradicts.length > 0) return 'is flagged as contradicting existing knowledge';
  if (item.target?.kind === 'local_run') return "changes the local-run spec, which sstor runs on developers' machines";
  if (item.target?.kind === 'merge_policy') return 'changes the merge policy, which decides which globs wait for each other';
  if (item.target !== null && isAgentSetKind(item.target.kind)) return `changes an agent-set file (${item.target.kind} ${item.target.name}), which changes how agents behave`;
  return null;
};

/** `ids` with `id` added once. */
const apart = (ids: readonly string[], id: string): string[] => (ids.includes(id) ? [...ids] : [...ids, id]);

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

/** The next KB item ID on a board (`s<board>k<n>`), for submitted and mined items alike. */
export const newKbItemId = async (tx: Tx, boardId: number): Promise<string> => formatId(boardId, 'k', await tx.nextNumber(boardId, 'k'));

/** A document proposal's target: that document, with its proposed frontmatter when the board doesn't have it yet. */
export const documentTarget = async (tx: Tx, boardId: number, document: ProposedDocument): Promise<KbTarget> => {
  const existing = await tx.getKnowledge(boardId, 'doc', document.name);
  const { area, audience, description } = document;
  return { kind: 'doc', name: document.name, section: null, newDocument: existing === null ? { area, audience, description } : null };
};

/** The current text a draft for a target is spliced into, and the version it has. */
export interface TargetState {
  /** A document's body (without frontmatter), or the board's layer of an agent-set file (empty when it has none). */
  readonly text: string;
  /** The document's or board row's version; 0 when there is none yet. */
  readonly version: number;
  readonly existing: KnowledgeDoc | null;
  /** For an overlay: the catalog's text, read-only context. Null for documents and files the board owns. */
  readonly catalog: string | null;
  /** The target is a document the board doesn't have yet. */
  readonly newDocument: boolean;
}

/** A target's current state, or null when it is gone (or a document that neither exists nor has proposed metadata). */
export const targetState = async (
  tx: Tx,
  catalog: CatalogAgentSet,
  boardId: number,
  target: KbTarget,
): Promise<TargetState | null> => {
  const existing = await tx.getKnowledge(boardId, target.kind, target.name);
  if (target.kind === 'local_run') {
    // The whole value is drafted and replaced; the first value creates the row.
    if (target.name !== LOCAL_RUN_NAME) return null;
    return { text: existing?.content ?? '', version: existing?.version ?? 0, existing, catalog: null, newDocument: false };
  }
  if (target.kind === 'merge_policy') {
    // Like the local-run spec: the whole value is replaced, and the first value creates the row.
    if (target.name !== MERGE_POLICY_NAME) return null;
    return { text: existing?.content ?? '', version: existing?.version ?? 0, existing, catalog: null, newDocument: false };
  }
  if (target.kind === 'doc') {
    if (existing !== null) return { text: existing.content, version: existing.version, existing, catalog: null, newDocument: false };
    return target.newDocument === null ? null : { text: '', version: 0, existing: null, catalog: null, newDocument: true };
  }
  const catalogText = catalog.files.find((f) => f.path === target.name)?.content ?? null;
  if (catalogText === null && existing?.layer !== 'file') {
    // No file, or an orphaned overlay (its catalog file was removed): nothing serves it, so it's no target.
    return null;
  }
  return {
    text: existing?.content ?? '',
    version: existing?.version ?? 0,
    existing,
    catalog: existing?.layer === 'file' ? null : catalogText,
    newDocument: false,
  };
};

const cleanHeading = (section: string | null): string | null => {
  const heading = section?.replace(/^#+\s*/, '').trim() ?? '';
  return heading === '' ? null : heading;
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
    private readonly deps: {
      store: Store;
      clock: Clock;
      catalog: Catalog;
      notifier: Notifier;
      /** Absent: no signal can be picked to watch on approval. */
      signals?: SignalMeasure;
    },
  ) {}

  /** Hints raised in each open write transaction, published once it commits. */
  private readonly raised = new WeakMap<Tx, Hint[]>();

  /**
   * A write transaction whose hints (`hint`) are published only after it commits, so a client
   * refetching on one sees the change; a transaction that throws publishes nothing.
   */
  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    let hints: Hint[] = [];
    const result = await this.deps.store.transaction((tx) => {
      // A retried transaction starts its hints afresh.
      hints = [];
      this.raised.set(tx, hints);
      return work(tx);
    });
    for (const hint of hints) this.deps.notifier.publish(hint);
    return result;
  }

  /** Raises a hint for after the commit of `tx` (from `transaction`); repeats within it are dropped. */
  private hint(tx: Tx, hint: Hint): void {
    const hints = this.raised.get(tx);
    if (hints === undefined) throw new Error('Hints need a transaction from KnowledgeService.transaction');
    if (!hints.some((h) => h.kind === hint.kind && h.boardId === hint.boardId)) hints.push(hint);
  }

  private kbChanged(tx: Tx, boardId: number): void {
    this.hint(tx, { kind: 'board.kb', boardId });
  }

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

  /**
   * `get_review_guide(repo)`: the review guide documents (area `review_guide`) of each board on that repo the caller is
   * a member of. Boards without one are left out; an empty list means there is no review guide.
   */
  async reviewGuides(email: string, repo: string): Promise<Result<ReviewGuide[]>> {
    return this.deps.store.transaction(async (tx) => {
      const key = repo.trim().toLowerCase();
      const guides: ReviewGuide[] = [];
      for (const board of await tx.listBoards(email)) {
        if (board.repo?.toLowerCase() !== key) continue;
        const docs = (await tx.listKnowledge(board.id, ['doc'])).filter(isReviewGuide);
        if (docs.length > 0) guides.push({ boardId: board.id, boardName: board.name, documents: docs });
      }
      return ok(guides);
    });
  }

  /** Whether the board has a review guide (slop then asks CodeRabbit for reviews it doesn't start itself). */
  async hasReviewGuide(boardId: number): Promise<boolean> {
    return this.deps.store.transaction(async (tx) => (await tx.listKnowledge(boardId, ['doc'])).some(isReviewGuide));
  }

  /** `get_agent_set(board)`: every agent-set file as served (catalog plus the board's layers) and the set's version. */
  async agentSet(email: string, boardId: number): Promise<Result<AgentSet>> {
    const catalog = await this.deps.catalog.agentSet();
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return this.served(tx, catalog, boardId);
    });
  }

  /**
   * The agent set as served, without a membership check: for signed download links, whose
   * signature is the authorisation (issued to a member through the authenticated MCP).
   */
  async agentSetForDownload(boardId: number): Promise<Result<AgentSet>> {
    const catalog = await this.deps.catalog.agentSet();
    return this.deps.store.transaction((tx) => this.served(tx, catalog, boardId));
  }

  /** The board's local-run spec as stored and as served, for the Knowledge page. */
  async localRun(email: string, boardId: number): Promise<Result<LocalRunView>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const row = await tx.getKnowledge(boardId, 'local_run', LOCAL_RUN_NAME);
      const { spec, problem } = storedLocalRun(row);
      return ok({
        spec,
        content: row?.content ?? null,
        version: row?.version ?? null,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
        problem,
      });
    });
  }

  /** The board's merge policy as stored and as served, for the Knowledge page. */
  async mergePolicy(email: string, boardId: number): Promise<Result<MergePolicyView>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const row = await tx.getKnowledge(boardId, 'merge_policy', MERGE_POLICY_NAME);
      const { policy, problem } = storedMergePolicy(row);
      return ok({
        policy,
        content: row?.content ?? null,
        version: row?.version ?? null,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
        problem,
      });
    });
  }

  /** Every path in the board's agent set with how it is served (catalog, overlay, board file, override, orphaned). */
  async agentSetIndex(email: string, boardId: number): Promise<Result<AgentSetIndex>> {
    const catalog = await this.deps.catalog.agentSet();
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${boardId}`);
      const { entries } = await this.compose(tx, catalog, boardId);
      return ok({ version: board.agentSetVersion, entries });
    });
  }

  /** One agent-set file: the board's layer to edit, with the catalog's text and the served result. */
  async agentSetFile(email: string, boardId: number, path: string): Promise<Result<AgentSetFileView>> {
    const catalog = await this.deps.catalog.agentSet();
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const composed = await this.compose(tx, catalog, boardId);
      const entry = composed.entries.find((e) => e.path === path);
      if (entry === undefined) return notFound(`No agent-set file ${path} on board ${boardId}`);
      const row = await tx.getKnowledge(boardId, entry.kind, path);
      return ok({
        path,
        kind: entry.kind,
        status: entry.status,
        layer: row?.layer ?? 'overlay',
        content: row?.content ?? '',
        version: row?.version ?? null,
        catalog: catalog.files.find((f) => f.path === path)?.content ?? null,
        served: composed.files.find((f) => f.path === path)?.content ?? null,
      });
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
    return this.transaction(async (tx) => {
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
    return this.transaction(async (tx) => {
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

  /**
   * A new board follows the catalog's agent set: nothing is copied (catalog files are served
   * through layering); the board records the catalog's hash and its agent set gets a version.
   */
  async adoptCatalogAgentSet(email: string, boardId: number): Promise<Result<{ version: number }>> {
    const actor = await this.deps.store.transaction((tx) => adminOf(tx, email, boardId));
    if (!actor.ok) return actor;
    const { hash } = await this.deps.catalog.agentSet();
    const version = await this.followCatalog(boardId, hash);
    return version === null ? notFound(`No board ${boardId}`) : ok({ version });
  }

  /**
   * At server start: every board whose agent set followed a different catalog gets a new
   * agent-set version (so routines and readiness see the catalog change). Returns the boards bumped,
   * and those that kept changing under it (the caller logs them; the next start tries them again).
   */
  async syncCatalogAgentSet(): Promise<{ bumped: number[]; failed: { boardId: number; error: unknown }[] }> {
    const { hash } = await this.deps.catalog.agentSet();
    const boards = await this.deps.store.transaction((tx) => tx.listAllBoards());
    const bumped: number[] = [];
    const failed: { boardId: number; error: unknown }[] = [];
    for (const board of boards) {
      if (board.agentCatalogHash === hash) continue;
      try {
        if ((await this.followCatalog(board.id, hash)) !== null) bumped.push(board.id);
      } catch (error) {
        // One busy board (its conditional writes keep losing) mustn't strand the boards after it.
        if (!(error instanceof BoardChanged)) throw error;
        failed.push({ boardId: board.id, error });
      }
    }
    return { bumped, failed };
  }

  /**
   * Admins turn a whole board file that shadows a catalog file (a legacy fork) back into the
   * catalog file plus board rules, with the given overlay (default none).
   */
  async useCatalogVersion(email: string, boardId: number, path: string, overlay = ''): Promise<Result<{ version: number }>> {
    const kind = agentSetKind(path);
    if (kind === null) return invalidInput(`${path} is not an agent-set path`);
    const catalog = await this.deps.catalog.agentSet();
    if (!catalog.files.some((f) => f.path === path)) return notFound(`${path} is not in the catalog`);
    const problem = overlayProblem(kind, overlay);
    if (problem !== null) return invalidInput(problem);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transaction(async (tx) => {
          const actor = await adminOf(tx, email, boardId);
          if (!actor.ok) return actor;
          const existing = await tx.getKnowledge(boardId, kind, path);
          if (existing?.layer !== 'file') return invalidInput(`${path} already follows the catalog`);
          const written = await this.write(tx, email, boardId, [{ kind, name: path, content: overlay, layer: 'overlay', source: 'edit' }]);
          if (!written.ok) return written;
          // The board's new agent-set version, as the other agent-set results report it.
          const board = await tx.getBoard(boardId);
          return board === null ? notFound(`No board ${boardId}`) : ok({ version: board.agentSetVersion });
        });
      } catch (error) {
        if (!(error instanceof BoardChanged) || attempt >= 4) throw error;
      }
    }
  }

  /**
   * `submit_learning`: records an agent's learning as an open KB item (`s<board>k<n>`) for admins
   * to review. Capture only: the pipeline (`KbPipeline`) routes and deduplicates it in the
   * background, and nothing reaches the knowledge base until it is approved.
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
    return this.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const sourceGlobIds: string[] = [];
      if (sourceGlobId !== '') {
        const glob = await tx.getGlob(sourceGlobId);
        if (glob?.boardId !== boardId) return notFound(`No glob ${sourceGlobId} on board ${boardId}`);
        sourceGlobIds.push(glob.id);
      }
      const id = await newKbItemId(tx, boardId);
      // Document proposals name their target and are their own draft, so the pipeline has nothing to do.
      const routed =
        document === null
          ? UNPROCESSED
          : { ...UNPROCESSED, processing: 'drafted' as const, target: await documentTarget(tx, boardId, document) };
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
        signal: null,
        agentSetVersion,
        submittedBy: email,
        createdAt: this.deps.clock.now(),
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        document,
        outcome: null,
        ...routed,
        version: 1,
      });
      // The counter is atomic, so a clash means the counter and the table disagree.
      if (!inserted) throw new Error(`KB item ${id} already exists`);
      this.kbChanged(tx, boardId);
      return ok({ id });
    });
  }

  /**
   * The board's open KB items, by evidence (`byEvidence`: the most evidence first, then the freshest), each
   * drafted one with a preview of its draft against the target's current text; and the newest `historyLimit`
   * decided items (by decision, so the one just decided is listed first) and closed items, with their totals.
   * Members may read them.
   */
  async proposals(email: string, boardId: number, historyLimit = KB_HISTORY_PAGE): Promise<Result<KbProposalList>> {
    const catalog = await this.deps.catalog.agentSet();
    const limit = Math.max(1, Math.min(Math.trunc(historyLimit), KB_HISTORY_MAX));
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const open: KbItemView[] = [];
      for (const item of [...(await tx.listKbItems(boardId, 'open'))].sort(byEvidence)) {
        open.push(view(item, await this.preview(tx, catalog, item)));
      }
      const page = async (statuses: readonly KbItemStatus[]): Promise<KbItemPage> => {
        const { items, total } = await tx.listRecentKbItems(boardId, statuses, limit);
        return { items: items.map((item) => view(item, null)), total };
      };
      return ok({ open, decided: await page(['approved', 'rejected']), closed: await page(['merged', 'suppressed', 'covered']) });
    });
  }

  /**
   * Admins point an open item at another document or agent file (or a new document): its draft is
   * cleared and it is drafted again against that target, without routing it again.
   */
  async changeTarget(email: string, itemId: string, version: number, change: TargetChange): Promise<Result<KbItem>> {
    const catalog = await this.deps.catalog.agentSet();
    return this.transaction(async (tx) => {
      const item = await tx.getKbItem(itemId);
      if (item === null) return notFound(`No KB item ${itemId}`);
      const actor = await adminOf(tx, email, item.boardId);
      if (!actor.ok) return actor;
      const stale = (current: KbItem) =>
        err({ code: 'version_conflict', message: `${item.id} has changed`, currentItem: current });
      if (item.version !== version) return stale(item);
      if (item.status !== 'open') return invalidInput(`${item.id} is already ${item.status}`);
      if (item.document !== null) return invalidInput(`${item.id} proposes a document; its target is that document`);
      const target = await this.checkTarget(tx, catalog, item.boardId, change);
      if (!target.ok) return target;
      const next = needsDraft(item, target.value);
      if (!(await tx.updateKbItem(next, item.version))) {
        const current = await tx.getKbItem(itemId);
        return current === null ? notFound(`No KB item ${itemId}`) : stale(current);
      }
      this.kbChanged(tx, item.boardId);
      return ok(next);
    });
  }

  /**
   * Admins send an item the pipeline gave up on (`failed`) back to it with fresh attempts: to
   * routing when it has no target yet, otherwise to drafting against its target.
   */
  async retryProcessing(email: string, itemId: string, version: number): Promise<Result<KbItem>> {
    return this.transaction(async (tx) => {
      const item = await tx.getKbItem(itemId);
      if (item === null) return notFound(`No KB item ${itemId}`);
      const actor = await adminOf(tx, email, item.boardId);
      if (!actor.ok) return actor;
      const stale = (current: KbItem) =>
        err({ code: 'version_conflict', message: `${item.id} has changed`, currentItem: current });
      if (item.version !== version) return stale(item);
      if (item.status !== 'open') return invalidInput(`${item.id} is already ${item.status}`);
      if (item.processing !== 'failed') return invalidInput(`${item.id} hasn't failed; it is ${item.processing}`);
      const next: KbItem =
        item.target === null
          ? { ...item, processing: 'pending', processingError: null, processingAttempts: 0, processAfter: null, version: item.version + 1 }
          : needsDraft(item);
      if (!(await tx.updateKbItem(next, item.version))) {
        const current = await tx.getKbItem(itemId);
        return current === null ? notFound(`No KB item ${itemId}`) : stale(current);
      }
      this.kbChanged(tx, item.boardId);
      return ok(next);
    });
  }

  /**
   * Admins reopen an item the pipeline closed (merged, suppressed or covered: a false positive from
   * the model would otherwise drop the learning for good). It goes back to the open queue with its
   * target, to be drafted (a document proposal is its own draft). It isn't routed or deduplicated
   * again, so the pipeline can't close it a second time: dedupe only runs on `pending` items. An
   * item without a target is refused (the pipeline always routes before it closes, so this
   * shouldn't happen): reopening it could only send it back through routing and dedupe. The
   * other item keeps the evidence and count the closing added to it: they are only evidence, and
   * that item may have been decided since. A reopened merge records the pair in both items'
   * `keptApartFrom`, in the same transaction, so weekly consolidation never merges them again.
   */
  async reopen(email: string, itemId: string, version: number): Promise<Result<KbItem>> {
    return this.transaction(async (tx) => {
      const item = await tx.getKbItem(itemId);
      if (item === null) return notFound(`No KB item ${itemId}`);
      const actor = await adminOf(tx, email, item.boardId);
      if (!actor.ok) return actor;
      const stale = (current: KbItem) =>
        err({ code: 'version_conflict', message: `${item.id} has changed`, currentItem: current });
      if (item.version !== version) return stale(item);
      if (!(item.status === 'merged' || item.status === 'suppressed' || item.status === 'covered')) {
        return invalidInput(`${item.id} is ${item.status}; only items the pipeline closed can be reopened`);
      }
      // A merge the admin undid keeps the pair apart: weekly consolidation never merges them again.
      const former = item.status === 'merged' ? item.duplicateOf : null;
      const reopened: KbItem = {
        ...item,
        status: 'open',
        duplicateOf: null,
        suppressedBy: null,
        coveredBy: null,
        mergeNote: null,
        keptApartFrom: former === null ? item.keptApartFrom : apart(item.keptApartFrom, former),
      };
      if (item.document === null && item.target === null) {
        return invalidInput(`${item.id} has no target, so reopening it would route and deduplicate it again`);
      }
      const next: KbItem =
        item.document !== null
          ? { ...reopened, processing: 'drafted', processingError: null, processingAttempts: 0, processAfter: null, version: item.version + 1 }
          : needsDraft(reopened);
      if (!(await tx.updateKbItem(next, item.version))) {
        const current = await tx.getKbItem(itemId);
        return current === null ? notFound(`No KB item ${itemId}`) : stale(current);
      }
      const other = former === null ? null : await tx.getKbItem(former);
      if (other !== null && !other.keptApartFrom.includes(item.id)) {
        const separated: KbItem = { ...other, keptApartFrom: apart(other.keptApartFrom, item.id), version: other.version + 1 };
        // The other item changed between the read and the write: roll the reopen back too, as a conflict.
        if (!(await tx.updateKbItem(separated, other.version))) throw new StaleKbItem(other.id);
      }
      this.kbChanged(tx, item.boardId);
      return ok(next);
    }).catch(async (error: unknown) => {
      if (!(error instanceof StaleKbItem)) throw error;
      const current = await this.deps.store.transaction((tx) => tx.getKbItem(itemId));
      return current === null
        ? notFound(`No KB item ${itemId}`)
        : err({ code: 'version_conflict', message: `${itemId} changed meanwhile; try again`, currentItem: current });
    });
  }

  /**
   * Admins keep an open item weekly consolidation flagged stale: the flag is cleared and not raised again for
   * `STALE_KEEP_MS`. (Reject is the other answer to a stale flag; nothing closes an item for being stale.)
   */
  async keepStale(email: string, itemId: string, version: number): Promise<Result<KbItem>> {
    return this.transaction(async (tx) => {
      const item = await tx.getKbItem(itemId);
      if (item === null) return notFound(`No KB item ${itemId}`);
      const actor = await adminOf(tx, email, item.boardId);
      if (!actor.ok) return actor;
      const stale = (current: KbItem) =>
        err({ code: 'version_conflict', message: `${item.id} has changed`, currentItem: current });
      if (item.version !== version) return stale(item);
      if (item.status !== 'open') return invalidInput(`${item.id} is already ${item.status}`);
      if (item.staleSince === null) return invalidInput(`${item.id} isn't flagged stale`);
      const next: KbItem = {
        ...item,
        staleSince: null,
        staleReason: null,
        staleDismissedAt: this.deps.clock.now(),
        version: item.version + 1,
      };
      if (!(await tx.updateKbItem(next, item.version))) {
        const current = await tx.getKbItem(itemId);
        return current === null ? notFound(`No KB item ${itemId}`) : stale(current);
      }
      this.kbChanged(tx, item.boardId);
      return ok(next);
    });
  }

  /** The board's documents forked from a catalog entry that has a newer version now (read-only; no sync). */
  async catalogUpdates(email: string, boardId: number): Promise<Result<CatalogUpdate[]>> {
    const entries = await this.deps.catalog.kbEntries();
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return ok(catalogUpdates(await tx.listKnowledge(boardId, ['doc']), entries));
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
    return this.decide(email, itemId, version, (tx, item) => this.approving(tx, email, item, approval));
  }

  /** The approval's checks and writes, shared by a person's approval and an agent's. */
  private async approving(
    tx: Tx,
    email: string,
    item: KbItem,
    approval: Approval,
  ): Promise<Result<{ statement: string; outcome: KbOutcome; signal: KbSignal | null }>> {
    // A watched signal is claimed in `kb_signals` under mining's lock, so a mining run neither overwrites the claim
    // with the row it read before nor raises the signal meanwhile; taken first, so the measurement sees its rows.
    if (approval.watchSignal !== undefined) await tx.lockBoardJob(item.boardId, 'mining');
    // Checked before anything is written: a refused decision commits nothing it wrote.
    const watched = await this.watchedSignal(tx, item, approval.watchSignal);
    if (!watched.ok) return watched;
    const applied = await this.applyApproval(tx, email, item, approval);
    return applied.ok ? ok({ ...applied.value, signal: watched.value }) : applied;
  }

  /**
   * An agent (signed in as the admin) approves an open item as drafted, or rejects it with a reason: the same checks
   * and writes as the page's buttons, recorded with `via: 'agent'` in the outcome. Approving is refused for what
   * changes how agents or developers' machines behave, which a person decides on the Knowledge page: the local-run
   * spec, the merge policy, agent-set files, a whole document, and any item flagged as contradicting. Rejecting is always allowed.
   */
  async decideByAgent(
    email: string,
    itemId: string,
    version: number,
    decision: 'approve' | 'reject',
    reason?: string,
  ): Promise<Result<KbItem>> {
    const via: KbVia = 'agent';
    if (decision === 'reject') {
      const trimmed = reason?.trim() ?? '';
      if (trimmed === '') return invalidInput('Rejecting needs a reason');
      return this.decide(email, itemId, version, () => Promise.resolve(ok({ reason: trimmed })), via);
    }
    return this.decide(
      email,
      itemId,
      version,
      async (tx, item) => {
        const kept = keptForPeople(item);
        if (kept !== null) return forbidden(`${item.id} ${kept}: approve it on the Knowledge page, or reject it here`);
        return this.approving(tx, email, item, { as: 'draft' });
      },
      via,
    );
  }

  /**
   * The board's KB items with the given status (open by default), for an admin's agent: the open queue in the page's
   * order, others newest decision first. Admins only, like deciding.
   */
  async listItems(email: string, boardId: number, status: KbItemStatus = 'open'): Promise<Result<KbItemView[]>> {
    const catalog = await this.deps.catalog.agentSet();
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const items = await tx.listKbItems(boardId, status);
      if (status !== 'open') return ok(items.map((item) => view(item, null)));
      const views: KbItemView[] = [];
      for (const item of [...items].sort(byEvidence)) views.push(view(item, await this.preview(tx, catalog, item)));
      return ok(views);
    });
  }

  /**
   * The board's signals as measured now, for the Watch signal choice when approving a submitted item; admins only
   * (only they approve). Empty when signals aren't measured here.
   */
  async watchableSignals(email: string, boardId: number): Promise<Result<KbSignal[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const signals = this.deps.signals === undefined ? [] : await this.deps.signals.measure(tx, boardId, this.deps.clock.now());
      return ok(signals.filter((s) => isEffectMeasured(s.key)).sort((a, b) => a.key.localeCompare(b.key)));
    });
  }

  /** The measured signal an admin chose to watch for a submitted item, or null when none was chosen. */
  private async watchedSignal(tx: Tx, item: KbItem, key: string | undefined): Promise<Result<KbSignal | null>> {
    if (key === undefined) return ok(null);
    if (item.document !== null) return invalidInput(`${item.id} proposes a document; a document proposal doesn't watch a signal`);
    if (!isEffectMeasured(key)) return invalidInput(`Effect checks don't measure ${key}`);
    if (item.signal !== null) return invalidInput(`${item.id} already has a signal (${item.signal.label}); its effect check watches that`);
    const signals = this.deps.signals === undefined ? [] : await this.deps.signals.measure(tx, item.boardId, this.deps.clock.now());
    const found = signals.find((s) => s.key === key);
    return found === undefined ? invalidInput(`No signal ${key} is measured on board ${item.boardId} now`) : ok(found);
  }

  /** What an approval writes, and the statement and outcome it records. */
  private async applyApproval(
    tx: Tx,
    email: string,
    item: KbItem,
    approval: Approval,
  ): Promise<Result<{ statement: string; outcome: KbOutcome }>> {
    // A document proposal is its own draft.
    if (approval.as === 'document' || (approval.as === 'draft' && item.document !== null)) {
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
    if (approval.as === 'draft') {
      const outcome = await this.applyDraft(tx, email, item, approval);
      return outcome.ok ? ok({ statement, outcome: outcome.value }) : outcome;
    }

    const { kind, name } = approval.target;
    if (approval.content.trim() === '') return invalidInput('The new content is empty');
    if (kind === 'local_run') {
      if (name !== LOCAL_RUN_NAME) return invalidInput(`The local-run spec is named ${LOCAL_RUN_NAME}`);
      const content = checkedLocalRun(approval.content);
      if (!content.ok) return content;
      const outcome = await this.apply(tx, email, item, kind, name, content.value);
      return outcome.ok ? ok({ statement, outcome: outcome.value }) : outcome;
    }
    if (kind === 'merge_policy') {
      if (name !== MERGE_POLICY_NAME) return invalidInput(`The merge policy is named ${MERGE_POLICY_NAME}`);
      const content = checkedMergePolicy(approval.content);
      if (!content.ok) return content;
      const outcome = await this.apply(tx, email, item, kind, name, content.value);
      return outcome.ok ? ok({ statement, outcome: outcome.value }) : outcome;
    }
    const existing = await tx.getKnowledge(item.boardId, kind, name);
    if (isAgentSetKind(kind)) {
      const outcome = await this.applyAgentSetEdit(tx, email, item, kind, name, approval.content, existing);
      return outcome.ok ? ok({ statement, outcome: outcome.value }) : outcome;
    }
    if (existing === null) return notFound(`No document ${name} on board ${item.boardId}`);
    // A document edited without frontmatter keeps its area, audience and description.
    const content =
      kind === 'doc' && !hasFrontmatter(approval.content) ? renderFrontmatter(existing) + approval.content : approval.content;
    const outcome = await this.apply(tx, email, item, kind, name, content);
    return outcome.ok ? ok({ statement, outcome: outcome.value }) : outcome;
  }

  /** Admins reject an open KB item with a reason; it is kept so repeats can be suppressed later. */
  async reject(email: string, itemId: string, version: number, reason: string): Promise<Result<KbItem>> {
    const trimmed = reason.trim();
    if (trimmed === '') return invalidInput('Rejecting needs a reason');
    return this.decide(email, itemId, version, () => Promise.resolve(ok({ reason: trimmed })));
  }

  /**
   * A decision: the item exists, the caller is an admin of its board, it is unchanged since read
   * and still open (items the pipeline closed as merged, suppressed or covered can't be decided).
   */
  private async decide(
    email: string,
    itemId: string,
    version: number,
    decision: (
      tx: Tx,
      item: KbItem,
    ) => Promise<Result<{ statement: string; outcome: KbOutcome; signal?: KbSignal | null } | { reason: string }>>,
    via?: KbVia,
  ): Promise<Result<KbItem>> {
    const stale = (item: KbItem) => err({ code: 'version_conflict', message: `${item.id} has changed`, currentItem: item });
    try {
      return await this.transaction(async (tx) => {
        const item = await tx.getKbItem(itemId);
        if (item === null) return notFound(`No KB item ${itemId}`);
        const actor = await adminOf(tx, email, item.boardId);
        if (!actor.ok) return actor;
        if (item.version !== version) return stale(item);
        if (item.status !== 'open') return invalidInput(`${item.id} is already ${item.status}`);
        const decided = await decision(tx, item);
        if (!decided.ok) return decided;
        const decidedAt = this.deps.clock.now();
        const base = { ...item, decidedBy: email, decidedAt, version: item.version + 1 };
        let next: KbItem;
        if ('reason' in decided.value) {
          next = { ...base, status: 'rejected', decisionReason: decided.value.reason, ...(via === undefined ? {} : { outcome: { kind: 'rejected', via } }) };
        }
        else {
          const { statement, outcome } = decided.value;
          const chosen = decided.value.signal ?? null;
          const signal = chosen ?? item.signal;
          // An approved change with a signal the check measures is watched (the daily effect check).
          const effectCheck = signal === null || !isEffectMeasured(signal.key) ? null : await this.effectCheckFor(tx, item.boardId, signal, outcome, decidedAt);
          next = { ...base, status: 'approved', statement, outcome: via === undefined ? outcome : { ...outcome, via }, signal, effectCheck };
          if (chosen !== null) await this.claimSignal(tx, next, chosen);
        }
        if (!(await tx.updateKbItem(next, item.version))) throw new StaleKbItem(item.id);
        this.kbChanged(tx, item.boardId);
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

  /**
   * A new effect check for an approval. A revise-or-revert item (`effect:` signal) watches the key its original
   * watched, so approving the revision is checked against the same signal.
   */
  private async effectCheckFor(tx: Tx, boardId: number, signal: KbSignal, outcome: KbOutcome, decidedAt: string): Promise<EffectCheck> {
    const board = await tx.getBoard(boardId);
    if (board === null) throw new Error(`No board ${boardId}`);
    const originalId = effectItemOf(signal.key);
    const original = originalId === null ? null : await tx.getKbItem(originalId);
    const watch = original?.effectCheck ?? original?.signal ?? signal;
    return startEffectCheck({ key: watch.key, label: watch.label }, effectBasisOf(outcome, decidedAt), board.effectCheckGlobs);
  }

  /**
   * A signal an admin chose to watch belongs to the approved item from now on (`kb_signals`), so mining doesn't raise
   * it again while the effect check owns it; an open item already raised for it keeps it (mining refreshes that one).
   */
  private async claimSignal(tx: Tx, item: KbItem, signal: KbSignal): Promise<void> {
    const row = (await tx.listKbSignals(item.boardId)).find((r) => r.key === signal.key);
    const holder = row?.itemId == null ? null : await tx.getKbItem(row.itemId);
    if (holder?.status === 'open') return;
    await tx.upsertKbSignal({
      boardId: item.boardId,
      key: signal.key,
      itemId: item.id,
      lastFigures: row?.lastFigures ?? signal.figures,
      lastMeasuredAt: row?.lastMeasuredAt ?? signal.measuredAt,
      raisedAt: row?.raisedAt ?? null,
      belowThresholdRuns: row?.belowThresholdRuns ?? 0,
    });
  }

  /**
   * Applies an item's draft (or the admin's edit of it) to the target's current text, refusing a
   * draft made against an older version of the target: the item then goes back to be drafted again.
   */
  private async applyDraft(
    tx: Tx,
    email: string,
    item: KbItem,
    approval: Extract<Approval, { as: 'draft' }>,
  ): Promise<Result<KbOutcome>> {
    const { target } = item;
    if (target === null) return invalidInput(`${item.id} has no target yet`);
    const draft =
      approval.content === undefined
        ? item.draft
        : {
            section: approval.section === undefined ? (item.draft?.section ?? null) : cleanHeading(approval.section),
            content: approval.content,
          };
    if (draft === null) return invalidInput(`${item.id} has no draft yet`);
    if (draft.content.trim() === '') return invalidInput('The draft is empty');
    const state = await targetState(tx, await this.deps.catalog.agentSet(), item.boardId, target);
    if (state === null) return notFound(`${target.name} is no longer on board ${item.boardId}; choose another target under Edit`);
    if (item.draft !== null && item.draftedAgainstVersion !== null && state.version !== item.draftedAgainstVersion) {
      const requeued = needsDraft(item);
      if (!(await tx.updateKbItem(requeued, item.version))) throw new StaleKbItem(item.id);
      this.kbChanged(tx, item.boardId);
      return err({
        code: 'version_conflict',
        message: `${target.name} changed since ${item.id} was drafted; it is being drafted again`,
        currentItem: requeued,
      });
    }
    if (target.kind === 'local_run') {
      // The draft is the whole value, checked again here: nothing invalid is written.
      const content = checkedLocalRun(draft.content);
      if (!content.ok) return content;
      return this.apply(tx, email, item, 'local_run', LOCAL_RUN_NAME, content.value);
    }
    if (target.kind === 'merge_policy') {
      const content = checkedMergePolicy(draft.content);
      if (!content.ok) return content;
      return this.apply(tx, email, item, 'merge_policy', MERGE_POLICY_NAME, content.value);
    }
    const { after } = splicePreview(state.text, draft.section, draft.content, state.newDocument);
    if (target.kind === 'doc') {
      const meta = state.existing ?? target.newDocument;
      if (meta === null) return notFound(`No document ${target.name} on board ${item.boardId}`);
      if (state.existing === null && !PLAIN_NAME.test(target.name)) return invalidInput(`${target.name} is not a document name`);
      // A document keeps its frontmatter; a new one gets the proposed area, audience and description.
      return this.apply(tx, email, item, 'doc', target.name, renderFrontmatter(meta) + after);
    }
    return this.applyAgentSetEdit(tx, email, item, target.kind, target.name, after, state.existing);
  }

  /** What approving an open item's draft would change now; null without a draft or a target. */
  private async preview(tx: Tx, catalog: CatalogAgentSet, item: KbItem): Promise<DraftPreview | null> {
    if (item.status !== 'open' || item.draft === null || item.target === null) return null;
    const state = await targetState(tx, catalog, item.boardId, item.target);
    if (state === null) return null;
    // The local-run spec is replaced whole (a draft holds its canonical text).
    const whole = state.newDocument || item.target.kind === 'local_run' || item.target.kind === 'merge_policy';
    const { diff } = splicePreview(state.text, item.draft.section, item.draft.content, whole);
    return { version: state.version, stale: state.version !== item.draftedAgainstVersion, diff: contextDiff(diff) };
  }

  /** An admin's target, checked against the board: an existing document, a new one with its metadata, or a prose agent file. */
  private async checkTarget(tx: Tx, catalog: CatalogAgentSet, boardId: number, change: TargetChange): Promise<Result<KbTarget>> {
    const section = cleanHeading(change.section);
    if (section !== null && !SINGLE_LINE.test(section)) return invalidInput('A section is one heading');
    if (change.kind === 'local_run') {
      // One row per board, replaced whole; it may not exist yet (the first value arrives as a draft too).
      if (change.name !== LOCAL_RUN_NAME) return invalidInput(`The local-run spec is named ${LOCAL_RUN_NAME}`);
      return ok({ kind: 'local_run', name: LOCAL_RUN_NAME, section: null, newDocument: null });
    }
    if (change.kind === 'merge_policy') {
      if (change.name !== MERGE_POLICY_NAME) return invalidInput(`The merge policy is named ${MERGE_POLICY_NAME}`);
      return ok({ kind: 'merge_policy', name: MERGE_POLICY_NAME, section: null, newDocument: null });
    }
    if (change.kind === 'doc') {
      const name = docName(change.name);
      if (!PLAIN_NAME.test(name)) return invalidInput('A document name is letters, digits, _, . or -');
      if ((await tx.getKnowledge(boardId, 'doc', name)) !== null) return ok({ kind: 'doc', name, section, newDocument: null });
      const meta = change.newDocument ?? null;
      if (meta === null) return notFound(`No document ${name} on board ${boardId}; a new document needs an area and description`);
      const checked = checkDocument({ ...meta, name, content: '-' });
      if (!checked.ok) return checked;
      const { area, audience, description } = checked.value;
      return ok({ kind: 'doc', name, section: null, newDocument: { area, audience, description } });
    }
    if (!PROSE_KINDS.includes(change.kind) || agentSetKind(change.name) !== change.kind) {
      return invalidInput(`${change.name} is not an agent, command or CLAUDE.md file`);
    }
    const { entries } = await this.compose(tx, catalog, boardId);
    if (!entries.some((e) => e.path === change.name && e.status !== 'orphaned')) {
      return notFound(`No agent-set file ${change.name} on board ${boardId}`);
    }
    return ok({ kind: change.kind, name: change.name, section, newDocument: null });
  }

  /**
   * An approved edit to an agent-set file writes the board's layer: the whole file for a file the
   * board owns, otherwise its overlay on the catalog file (created on first use).
   */
  private async applyAgentSetEdit(
    tx: Tx,
    email: string,
    item: KbItem,
    kind: KnowledgeKind,
    name: string,
    content: string,
    existing: KnowledgeDoc | null,
  ): Promise<Result<KbOutcome>> {
    const before = await tx.getBoard(item.boardId);
    if (before === null) throw new Error(`No board ${item.boardId}`);
    const versioned = async (outcome: Result<KbOutcome>) => this.withAgentSetVersion(tx, before, outcome);
    if (existing?.layer === 'file') return versioned(await this.apply(tx, email, item, kind, name, content, 'file'));
    if (existing === null) {
      const catalog = await this.deps.catalog.agentSet();
      if (!catalog.files.some((f) => f.path === name && agentSetKind(f.path) === kind)) {
        return notFound(`No agent-set file ${name} on board ${item.boardId}`);
      }
    }
    const problem = overlayProblem(kind, content);
    if (problem !== null) return invalidInput(problem);
    return versioned(await this.apply(tx, email, item, kind, name, content, 'overlay'));
  }

  /**
   * An agent-set outcome with the first agent-set version that has the change, the version the effect check starts
   * at: the board's version after the write. A write that changed nothing bumps no version and gets none, so its check
   * goes by time (the content was already being served, and no glob might ever reach a next version).
   */
  private async withAgentSetVersion(tx: Tx, before: Board, outcome: Result<KbOutcome>): Promise<Result<KbOutcome>> {
    if (!outcome.ok || outcome.value.kind !== 'applied') return outcome;
    const board = await tx.getBoard(before.id);
    if (board === null) throw new Error(`No board ${before.id}`);
    if (board.agentSetVersion <= before.agentSetVersion) return outcome;
    return ok({ ...outcome.value, agentSetVersion: board.agentSetVersion });
  }

  /** Writes an approved change to a document or agent-set file and returns the outcome with its new version. */
  private async apply(
    tx: Tx,
    email: string,
    item: KbItem,
    kind: KnowledgeKind,
    name: string,
    content: string,
    layer: KnowledgeLayer = 'file',
  ): Promise<Result<KbOutcome>> {
    const written = await this.write(tx, email, item.boardId, [{ kind, name, content, layer, source: `kb:${item.id}` }], item.id);
    if (!written.ok) return written;
    const saved = await tx.getKnowledge(item.boardId, kind, name);
    if (saved === null) throw new Error(`${name} was not saved`);
    return ok({ kind: 'applied', target: kind, name, version: saved.version });
  }

  /** The board's agent-set rows composed over the catalog. */
  private async compose(tx: Tx, catalog: CatalogAgentSet, boardId: number): Promise<ComposedAgentSet> {
    const rows = (await tx.listKnowledge(boardId)).filter((d) => isAgentSetKind(d.kind));
    return composeAgentSet(catalog.files, rows);
  }

  private async served(tx: Tx, catalog: CatalogAgentSet, boardId: number): Promise<Result<AgentSet>> {
    const board = await tx.getBoard(boardId);
    if (board === null) return notFound(`No board ${boardId}`);
    const { files } = await this.compose(tx, catalog, boardId);
    const { spec, problem } = storedLocalRun(await tx.getKnowledge(boardId, 'local_run', LOCAL_RUN_NAME));
    return ok({ version: board.agentSetVersion, files, localRun: spec, localRunProblem: problem });
  }

  /**
   * Records that the board's agent set follows the catalog with `hash`, bumping its agent-set
   * version if it followed another. Retries a lost conditional write; null when there's no board.
   */
  private async followCatalog(boardId: number, hash: string): Promise<number | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const outcome = await this.deps.store.transaction(async (tx) => {
        const board = await tx.getBoard(boardId);
        if (board === null) return { kind: 'missing' as const };
        if (board.agentCatalogHash === hash) return { kind: 'unchanged' as const, version: board.agentSetVersion };
        const next: Board = { ...board, agentSetVersion: board.agentSetVersion + 1, version: board.version + 1, agentCatalogHash: hash };
        return (await tx.updateBoard(next, board.version))
          ? { kind: 'bumped' as const, version: next.agentSetVersion }
          : { kind: 'conflict' as const };
      });
      if (outcome.kind === 'missing') return null;
      if (outcome.kind === 'conflict') continue;
      if (outcome.kind === 'bumped') {
        // The board's agent-set version moved, and with it the files the Knowledge page serves.
        this.deps.notifier.publish({ kind: 'board.changed', boardId });
        this.deps.notifier.publish({ kind: 'board.kb', boardId });
      }
      return outcome.version;
    }
    throw new BoardChanged(boardId);
  }

  /**
   * Writes documents, versioning only real changes; any agent-set change bumps the set's version.
   * Open items drafted against a changed target go back to be drafted again (except `decidingItem`,
   * the item whose approval is writing).
   */
  private async write(
    tx: Tx,
    email: string,
    boardId: number,
    items: readonly WriteItem[],
    decidingItem: string | null = null,
  ): Promise<Result<ImportResult>> {
    const board = await tx.getBoard(boardId);
    if (board === null) return notFound(`No board ${boardId}`);
    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const changed: { kind: KnowledgeKind; name: string }[] = [];
    let agentSetChanged = false;
    const now = this.deps.clock.now();

    for (const item of items) {
      if (item.name === '') return invalidInput('Every document needs a name');
      const meta =
        item.kind === 'doc'
          ? parseFrontmatter(item.content)
          : { area: null, audience: [], description: '', body: item.content };
      const layer = item.kind === 'doc' ? 'file' : (item.layer ?? 'file');
      const existing = await tx.getKnowledge(boardId, item.kind, item.name);
      const same =
        existing !== null &&
        existing.layer === layer &&
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
        layer,
        version: (existing?.version ?? 0) + 1,
        source: item.source,
        updatedBy: email,
        updatedAt: now,
      });
      (existing === null ? created : updated).push(item.name);
      changed.push({ kind: item.kind, name: item.name });
      if (isAgentSetKind(item.kind)) agentSetChanged = true;
    }
    if (changed.length > 0) await this.redraftAgainst(tx, boardId, changed, decidingItem);

    if (agentSetChanged) {
      const next: Board = { ...board, agentSetVersion: board.agentSetVersion + 1, version: board.version + 1 };
      if (!(await tx.updateBoard(next, board.version))) throw new BoardChanged(boardId);
      // The board row itself changed (its agent-set version).
      this.hint(tx, { kind: 'board.changed', boardId });
    }
    if (changed.length > 0) this.kbChanged(tx, boardId);
    return ok({ created, updated, unchanged });
  }

  /**
   * Every write to a target goes through `write`, so re-queueing here catches each draft whose
   * target moved, in the same transaction; approving a stale draft is refused as a backstop.
   */
  private async redraftAgainst(
    tx: Tx,
    boardId: number,
    changed: readonly { kind: KnowledgeKind; name: string }[],
    decidingItem: string | null,
  ): Promise<void> {
    for (const item of await tx.listKbItems(boardId, 'open')) {
      const { target } = item;
      if (item.id === decidingItem || item.processing !== 'drafted' || item.document !== null || target === null) continue;
      if (!changed.some((c) => c.kind === target.kind && c.name === target.name)) continue;
      // A lost conditional write means the item changed meanwhile; approving it still checks the version.
      await tx.updateKbItem(needsDraft(item), item.version);
    }
  }
}
