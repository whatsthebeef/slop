import { err, forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { formatId } from '../domain/ids.js';
import { composeAgentSet, contextDiff, overlayProblem } from '../domain/agent-set.js';
import { agentSetCommitEffect, knowledgePageEffect } from '../domain/events.js';
import type { AgentSetEntry, AgentSetEntryStatus, ComposedAgentSet } from '../domain/agent-set.js';
import { byEvidence, isLearningType, KB_HISTORY_MAX, KB_HISTORY_PAGE } from '../domain/kb.js';
import type {
  DraftPreview,
  LearningWirePage,
  LearningStatus,
  KbOutcome,
  KbProposalList,
  KbTarget,
  KbVia,
  LearningType,
  NewDocumentMeta,
  ProposedDocument,
} from '../domain/kb.js';
import {
  learningDecision,
  learningDocument,
  learningDraft,
  learningEffectCheck,
  learningEvidenceOrder,
  learningFacts,
  learningLinks,
  learningOutcome,
  learningStaleness,
  learningStatus,
  learningTarget,
  pipelineState,
} from '../domain/learning.js';
import type { LearningRead } from '../domain/learning.js';
import { learningWire, learningWireView } from '../domain/learning-wire.js';
import type { LearningWire, LearningWireView } from '../domain/kb.js';
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
import type { AgentKbApproval, Board, Role } from '../domain/types.js';
import type { Catalog, CatalogAgentSet, Clock, Hint, Notifier, Store, Tx } from '../ports.js';
import { adminOf, memberOf, roleOf } from './access.js';
import { boardLearnings, readLearning } from './learning-reads.js';
import {
  createLearning,
  dismissLearningStale,
  keepLearningApart,
  recordLearningDecision,
  reopenClosedLearning,
  reopenDecidedLearning,
  requeueLearningDraft,
  retryLearningStep,
} from './learning-writes.js';
import type { LearningWriteContext } from './learning-writes.js';

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

/** Why an agent may not approve the learning, or null when it may: these are decided by a person. */
const keptForPeople = (learning: LearningRead, setting: AgentKbApproval): string | null => {
  const wider = setting === 'docs_and_agent_files';
  const target = learningTarget(learning.glob).routed;
  if (learningDocument(learning.glob, learning.artifacts) !== null) return 'proposes a whole document';
  if (!wider && learningLinks(learning.glob).contradicts.length > 0) return 'is flagged as contradicting existing knowledge';
  if (target?.kind === 'local_run') return "changes the local-run spec, which sstor runs on developers' machines";
  if (target?.kind === 'merge_policy') return 'changes the merge policy, which decides which globs wait for each other';
  if (!wider && target !== null && isAgentSetKind(target.kind)) return `changes an agent-set file (${target.kind} ${target.name}), which changes how agents behave`;
  return null;
};

/** What a decision does inside `decideIn`: the checks and writes for an approval, or just the reason for a rejection. */
type DecisionStep = (
  tx: Tx,
  learning: LearningRead,
) => Promise<Result<{ statement: string; outcome: KbOutcome; signal?: KbSignal | null; reason?: string } | { reason: string }>>;

/** The learning that approval writes are made for: its ID and board. */
interface LearningRef {
  readonly id: string;
  readonly boardId: number;
}

const refOf = (learning: LearningRead): LearningRef => ({ id: learning.glob.id, boardId: learning.glob.boardId });

/** What a draft's preview reads (a KB item has these fields). */
export type DraftPreviewInput = Pick<LearningWire, 'boardId' | 'status' | 'target' | 'draft' | 'draftedAgainstVersion'>;

/** A learning's fields for its draft's preview. */
const previewInputOf = (learning: LearningRead): DraftPreviewInput => {
  const drafted = learningDraft(learning.artifacts);
  return {
    boardId: learning.glob.boardId,
    status: learningStatus(learning.glob, learning.artifacts),
    target: learningTarget(learning.glob).routed,
    draft: drafted?.draft ?? null,
    draftedAgainstVersion: drafted?.targetVersion ?? null,
  };
};

/** Learnings in the open queue's order (`byEvidence`), each one's evidence read once. */
const byEvidenceOrder = (learnings: readonly LearningRead[]): LearningRead[] =>
  learnings
    .map((learning) => ({ learning, order: learningEvidenceOrder(learning.glob, learning.artifacts) }))
    .sort((a, b) => byEvidence(a.order, b.order))
    .map(({ learning }) => learning);

/** Who decides a KB item on the Knowledge page. */
const ADMINS: readonly Role[] = ['admin'];

/** A decision's conditional write lost to a concurrent one; thrown so the transaction rolls back. */
class StaleLearning extends Error {
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
/** What approving an open item's draft would change now, against the target's current text; null without a draft or a target. */
export const draftPreview = async (tx: Tx, catalog: CatalogAgentSet, item: DraftPreviewInput): Promise<DraftPreview | null> => {
  if (item.status !== 'open' || item.draft === null || item.target === null) return null;
  const state = await targetState(tx, catalog, item.boardId, item.target);
  if (state === null) return null;
  // The local-run spec is replaced whole (a draft holds its canonical text).
  const whole = state.newDocument || item.target.kind === 'local_run' || item.target.kind === 'merge_policy';
  const { diff } = splicePreview(state.text, item.draft.section, item.draft.content, whole);
  return { version: state.version, stale: state.version !== item.draftedAgainstVersion, diff: contextDiff(diff) };
};

export const newLearningId = async (tx: Tx, boardId: number): Promise<string> => formatId(boardId, 'k', await tx.nextNumber(boardId, 'k'));

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

  /**
   * Raises a hint for after the commit of `tx` (from `transaction`); repeats within it are dropped (for one glob, a later
   * `glob.changed` replaces an earlier one: it carries the newest version).
   */
  hint(tx: Tx, hint: Hint): void {
    const hints = this.raised.get(tx);
    if (hints === undefined) throw new Error('Hints need a transaction from KnowledgeService.transaction');
    const same = (h: Hint) => h.kind === hint.kind && h.boardId === hint.boardId && ('globId' in h ? 'globId' in hint && h.globId === hint.globId : true);
    const at = hints.findIndex(same);
    if (at < 0) hints.push(hint);
    else if (hint.kind === 'glob.changed') hints[at] = hint;
  }

  /**
   * Runs `work` in a write transaction whose hints are published after it commits, and turns a conflicting concurrent
   * write to `itemId` into a version conflict: for DecisionGlobService, which decides an item and its glob together.
   */
  async inTransaction<T>(itemId: string | null, work: (tx: Tx) => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await this.transaction(work);
    } catch (error) {
      if (!(error instanceof StaleLearning || error instanceof BoardChanged) || itemId === null) throw error;
      const current = await this.deps.store.transaction((tx) => this.current(tx, itemId));
      if (current === null) return notFound(`No KB item ${itemId}`);
      return err({ code: 'version_conflict', message: `${itemId} changed meanwhile; try again`, currentItem: current });
    }
  }

  /** Raises hints returned by a decision step, from inside `transaction`. */
  private raise(tx: Tx, hints: readonly Hint[]): void {
    for (const h of hints) this.hint(tx, h);
  }

  /** How learnings are written in `tx`: with the service's clock, their live hints raised for after the commit. */
  private writes(tx: Tx): LearningWriteContext {
    return { clock: this.deps.clock, raise: (hint) => this.hint(tx, hint) };
  }

  /** A learning as it reads now, in its wire form; null when there is none. */
  private async current(tx: Tx, id: string): Promise<LearningWire | null> {
    const learning = await readLearning(tx, id);
    return learning === null ? null : learningWire(learning);
  }

  /** A learning this transaction just wrote, in its wire form. */
  private async written(tx: Tx, id: string): Promise<LearningWire> {
    const current = await this.current(tx, id);
    if (current === null) throw new Error(`KB item ${id} is missing after its write`);
    return current;
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
  async submitLearning(email: string, boardId: number, learning: NewLearning): Promise<Result<{ id: string; globId: string }>> {
    const statement = learning.statement.trim();
    const evidence = learning.evidence.trim();
    const suggestedTarget = learning.suggestedTarget?.trim() ?? '';
    const agentSetVersion = learning.agentSetVersion ?? null;
    if (learning.type === 'decision') {
      return invalidInput("The decision learning type is gone: record choices in your implementation record's ## Decisions; learnings are guidance (gotcha, pattern or agent-behaviour)");
    }
    if (!isLearningType(learning.type)) {
      return invalidInput(`Unknown learning type "${learning.type}"; use gotcha, pattern or agent-behaviour`);
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
      const id = await newLearningId(tx, boardId);
      // Document proposals name their target and are their own draft, so the pipeline has nothing to do.
      const target = document === null ? null : await documentTarget(tx, boardId, document);
      // The item is its decision glob: it enters Planning under the same ID.
      const inserted = await createLearning(tx, this.writes(tx), {
        id,
        boardId,
        type,
        statement,
        evidence,
        suggestedTarget: suggestedTarget === '' ? null : suggestedTarget,
        sourceGlobIds,
        agentSetVersion,
        submittedBy: email,
        createdAt: this.deps.clock.now(),
        document,
        target,
      });
      // The counter is atomic, so a clash means the counter and the globs disagree.
      if (!inserted) throw new Error(`KB item ${id} already exists`);
      this.kbChanged(tx, boardId);
      return ok({ id, globId: id });
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
      const learnings = await boardLearnings(tx, boardId);
      const statusOf = (l: LearningRead) => learningStatus(l.glob, l.artifacts);
      const open: LearningWireView[] = [];
      for (const learning of byEvidenceOrder(learnings.filter((l) => statusOf(l) === 'open'))) {
        open.push(learningWireView(learning, await this.preview(tx, catalog, learning)));
      }
      const page = (statuses: readonly LearningStatus[]): LearningWirePage => {
        // Newest by decision (a learning joins the decided group when decided); closed ones have none.
        const all = learnings
          .filter((l) => statuses.includes(statusOf(l)))
          .map((learning) => ({ learning, at: learningDecision(learning.glob, learning.artifacts).at ?? learning.glob.createdAt }))
          .sort((a, b) => b.at.localeCompare(a.at) || b.learning.glob.id.localeCompare(a.learning.glob.id));
        return { items: all.slice(0, limit).map(({ learning }) => learningWireView(learning, null)), total: all.length };
      };
      return ok({ open, decided: page(['approved', 'rejected']), closed: page(['merged', 'suppressed', 'covered']) });
    });
  }

  /**
   * Admins point an open item at another document or agent file (or a new document): its draft is
   * cleared and it is drafted again against that target, without routing it again.
   */
  async changeTarget(email: string, itemId: string, version: number, change: TargetChange): Promise<Result<LearningWire>> {
    return this.transaction((tx) => this.changeTargetIn(tx, email, itemId, version, change));
  }

  /** `changeTarget` inside the caller's transaction (from `inTransaction`); `roles` says who may (admins by default). */
  async changeTargetIn(
    tx: Tx,
    email: string,
    itemId: string,
    version: number,
    change: TargetChange,
    roles: readonly Role[] = ADMINS,
  ): Promise<Result<LearningWire>> {
    const catalog = await this.deps.catalog.agentSet();
    const learning = await readLearning(tx, itemId);
    if (learning === null) return notFound(`No KB item ${itemId}`);
    const { glob } = learning;
    const actor = await roleOf(tx, email, glob.boardId, roles);
    if (!actor.ok) return actor;
    const stale = (current: LearningWire) => err({ code: 'version_conflict', message: `${glob.id} has changed`, currentItem: current });
    if (glob.version !== version) return stale(learningWire(learning));
    const status = learningStatus(glob, learning.artifacts);
    if (status !== 'open') return invalidInput(`${glob.id} is already ${status}`);
    if (learningDocument(glob, learning.artifacts) !== null) return invalidInput(`${glob.id} proposes a document; its target is that document`);
    const target = await this.checkTarget(tx, catalog, glob.boardId, change);
    if (!target.ok) return target;
    if (!(await requeueLearningDraft(tx, this.writes(tx), itemId, glob.version, target.value))) {
      const current = await this.current(tx, itemId);
      return current === null ? notFound(`No KB item ${itemId}`) : stale(current);
    }
    this.kbChanged(tx, glob.boardId);
    return ok(await this.written(tx, itemId));
  }

  /**
   * Admins send an item the pipeline gave up on (`failed`) back to it with fresh attempts: to
   * routing when it has no target yet, otherwise to drafting against its target.
   */
  async retryProcessing(email: string, itemId: string, version: number): Promise<Result<LearningWire>> {
    return this.transaction(async (tx) => {
      const learning = await readLearning(tx, itemId);
      if (learning === null) return notFound(`No KB item ${itemId}`);
      const { glob } = learning;
      const actor = await adminOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const stale = (current: LearningWire) => err({ code: 'version_conflict', message: `${glob.id} has changed`, currentItem: current });
      if (glob.version !== version) return stale(learningWire(learning));
      const status = learningStatus(glob, learning.artifacts);
      if (status !== 'open') return invalidInput(`${glob.id} is already ${status}`);
      const { processing } = pipelineState(glob, learning.artifacts, learning.jobs);
      if (processing !== 'failed') return invalidInput(`${glob.id} hasn't failed; it is ${processing}`);
      // A fresh job for the step it failed at (routing without a target, drafting with one), with its attempts unspent.
      // The write bumps the version, so a Knowledge page tab holding the failed item gets a conflict and refetches.
      if (!(await retryLearningStep(tx, this.writes(tx), itemId, glob.version))) {
        const current = await this.current(tx, itemId);
        return current === null ? notFound(`No KB item ${itemId}`) : stale(current);
      }
      this.kbChanged(tx, glob.boardId);
      return ok(await this.written(tx, itemId));
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
  async reopen(email: string, itemId: string, version: number): Promise<Result<LearningWire>> {
    return this.transaction(async (tx) => {
      const learning = await readLearning(tx, itemId);
      if (learning === null) return notFound(`No KB item ${itemId}`);
      const { glob, artifacts } = learning;
      const actor = await adminOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const stale = (current: LearningWire) => err({ code: 'version_conflict', message: `${glob.id} has changed`, currentItem: current });
      if (glob.version !== version) return stale(learningWire(learning));
      const status = learningStatus(glob, artifacts);
      if ((status === 'approved' || status === 'rejected') && learningOutcome(artifacts)?.via === 'agent') return this.reopenAgentApproval(tx, email, learning, stale);
      if (!(status === 'merged' || status === 'suppressed' || status === 'covered')) {
        return invalidInput(`${glob.id} is ${status}; only items the pipeline closed or an agent approved can be reopened`);
      }
      // A merge the admin undid keeps the pair apart: weekly consolidation never merges them again.
      const former = status === 'merged' ? learningLinks(glob).duplicateOf : null;
      if (learningDocument(glob, artifacts) === null && learningTarget(glob).routed === null) {
        return invalidInput(`${glob.id} has no target, so reopening it would route and deduplicate it again`);
      }
      // Row D12: the admin reopens the closure on the decision itself.
      if (!(await reopenClosedLearning(tx, this.writes(tx), itemId, actor.value, glob.version))) {
        const current = await this.current(tx, itemId);
        return current === null ? notFound(`No KB item ${itemId}`) : stale(current);
      }
      const other = former === null ? null : await readLearning(tx, former);
      if (other !== null && !learningLinks(other.glob).keptApartFrom.includes(glob.id)) {
        // The other item changed between the read and the write: roll the reopen back too, as a conflict.
        if (!(await keepLearningApart(tx, this.writes(tx), other.glob.id, glob.id, other.glob.version))) throw new StaleLearning(other.glob.id);
      }
      this.kbChanged(tx, glob.boardId);
      return ok(await this.written(tx, itemId));
    }).catch(async (error: unknown) => {
      if (!(error instanceof StaleLearning)) throw error;
      const current = await this.deps.store.transaction((tx) => this.current(tx, itemId));
      return current === null
        ? notFound(`No KB item ${itemId}`)
        : err({ code: 'version_conflict', message: `${itemId} changed meanwhile; try again`, currentItem: current });
    });
  }

  /**
   * Reopens an item an agent decided (a rejection simply returns to the queue): an approval's change is reverted through a new knowledge version (the version before the
   * approval's, written again), and the item goes back to the open queue to be drafted afresh. Refused when the target
   * changed since the approval (reverting would undo later work), or when the approval created the document, which has
   * no earlier version to restore.
   */
  private async reopenAgentApproval(
    tx: Tx,
    email: string,
    learning: LearningRead,
    stale: (current: LearningWire) => Result<never>,
  ): Promise<Result<LearningWire>> {
    const { id, boardId } = refOf(learning);
    const outcome = learningOutcome(learning.artifacts);
    if (outcome?.kind === 'applied') {
      const current = await tx.getKnowledge(boardId, outcome.target, outcome.name);
      if (current === null || current.version !== outcome.version) {
        return invalidInput(`${outcome.name} changed after ${id} was approved; revert it by hand under Edit, then reject or edit this item`);
      }
      const previous = await tx.getKnowledgeVersion(boardId, outcome.target, outcome.name, outcome.version - 1);
      if (previous === null) {
        return invalidInput(`${id} created ${outcome.name}, which has no earlier version to restore; delete or edit it by hand`);
      }
      const content = outcome.target === 'doc' ? renderFrontmatter(previous) + previous.content : previous.content;
      const written = await this.write(
        tx,
        email,
        boardId,
        [{ kind: outcome.target, name: outcome.name, content, layer: previous.layer, source: `kb:${id}:reopened` }],
        id,
      );
      if (!written.ok) return written;
    }
    if (!(await reopenDecidedLearning(tx, this.writes(tx), id, learning.glob.version))) {
      const current = await this.current(tx, id);
      return current === null ? notFound(`No KB item ${id}`) : stale(current);
    }
    this.kbChanged(tx, boardId);
    return ok(await this.written(tx, id));
  }

  /**
   * Admins keep an open item weekly consolidation flagged stale: the flag is cleared and not raised again for
   * `STALE_KEEP_MS`. (Reject is the other answer to a stale flag; nothing closes an item for being stale.)
   */
  async keepStale(email: string, itemId: string, version: number): Promise<Result<LearningWire>> {
    return this.transaction(async (tx) => {
      const learning = await readLearning(tx, itemId);
      if (learning === null) return notFound(`No KB item ${itemId}`);
      const { glob } = learning;
      const actor = await adminOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const stale = (current: LearningWire) => err({ code: 'version_conflict', message: `${glob.id} has changed`, currentItem: current });
      if (glob.version !== version) return stale(learningWire(learning));
      const status = learningStatus(glob, learning.artifacts);
      if (status !== 'open') return invalidInput(`${glob.id} is already ${status}`);
      if (learningStaleness(glob).since === null) return invalidInput(`${glob.id} isn't flagged stale`);
      if (!(await dismissLearningStale(tx, this.writes(tx), itemId, glob.version, this.deps.clock.now()))) {
        const current = await this.current(tx, itemId);
        return current === null ? notFound(`No KB item ${itemId}`) : stale(current);
      }
      this.kbChanged(tx, glob.boardId);
      return ok(await this.written(tx, itemId));
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
      const learnings = await boardLearnings(tx, boardId);
      return ok(
        learnings
          .filter((l) => learningStatus(l.glob, l.artifacts) === 'approved' && learningOutcome(l.artifacts)?.kind === 'learning')
          .map((l) => {
            const facts = learningFacts(l.glob);
            return {
              id: l.glob.id,
              type: facts.kind,
              statement: l.glob.summary,
              sourceGlobIds: facts.sourceGlobIds,
              approvedAt: learningDecision(l.glob, l.artifacts).at ?? l.glob.createdAt,
            };
          }),
      );
    });
  }

  /**
   * Admins approve an open KB item, conditional on the version they read. Edits and documents are
   * written through `write` in the same transaction as the decision, so they version the document,
   * and an agent-set file bumps the board's agent-set version.
   */
  async approve(email: string, itemId: string, version: number, approval: Approval): Promise<Result<LearningWire>> {
    return this.decide(email, itemId, version, (tx, learning) => this.approving(tx, email, learning, approval));
  }

  /** The approval's checks and writes, shared by a person's approval and an agent's. */
  private async approving(
    tx: Tx,
    email: string,
    learning: LearningRead,
    approval: Approval,
  ): Promise<Result<{ statement: string; outcome: KbOutcome; signal: KbSignal | null }>> {
    // A watched signal is claimed in `kb_signals` under mining's lock, so a mining run neither overwrites the claim
    // with the row it read before nor raises the signal meanwhile; taken first, so the measurement sees its rows.
    if (approval.watchSignal !== undefined) await tx.lockBoardJob(learning.glob.boardId, 'mining');
    // Checked before anything is written: a refused decision commits nothing it wrote.
    const watched = await this.watchedSignal(tx, learning, approval.watchSignal);
    if (!watched.ok) return watched;
    const applied = await this.applyApproval(tx, email, learning, approval);
    return applied.ok ? ok({ ...applied.value, signal: watched.value }) : applied;
  }

  /**
   * An agent (signed in as the admin) approves an open item, as drafted or with an edited draft, or rejects it with a
   * reason: the same checks and writes as the page's buttons, recorded with `via: 'agent'` in the outcome. Approving
   * is always refused for the local-run spec, the merge policy (slop executes or enforces them) and a whole
   * document. Agent-set files and items flagged as contradicting are refused unless the board's `agentKbApproval` is
   * `docs_and_agent_files`; a contradicting item then needs a reason, recorded with the decision. Rejecting is always allowed.
   */
  async decideByAgent(
    email: string,
    itemId: string,
    version: number,
    decision: 'approve' | 'reject',
    options: { readonly reason?: string; readonly editedDraft?: string } = {},
  ): Promise<Result<LearningWire>> {
    const via: KbVia = 'agent';
    const reason = options.reason?.trim() ?? '';
    if (decision === 'reject') {
      if (options.editedDraft !== undefined) return invalidInput('editedDraft is for approving');
      if (reason === '') return invalidInput('Rejecting needs a reason');
      return this.decide(email, itemId, version, () => Promise.resolve(ok({ reason })), via);
    }
    return this.decide(
      email,
      itemId,
      version,
      async (tx, learning) => {
        const { id, boardId } = refOf(learning);
        const board = await tx.getBoard(boardId);
        if (board === null) return notFound(`No board ${boardId}`);
        const kept = keptForPeople(learning, board.agentKbApproval);
        if (kept !== null) return forbidden(`${id} ${kept}: approve it on the Knowledge page, or reject it here`);
        const contradicting = learningLinks(learning.glob).contradicts.length > 0;
        if (contradicting && reason === '') {
          return invalidInput(`${id} contradicts existing knowledge: give a reason (why the contradiction is intended or resolved)`);
        }
        if (options.editedDraft !== undefined && options.editedDraft.trim() === '') return invalidInput('The edited draft is empty');
        const approval: Approval = options.editedDraft === undefined ? { as: 'draft' } : { as: 'draft', content: options.editedDraft };
        const approved = await this.approving(tx, email, learning, approval);
        if (!approved.ok) return approved;
        return ok(contradicting ? { ...approved.value, reason } : approved.value);
      },
      via,
    );
  }

  /**
   * The board's KB items with the given status (open by default), for an admin's agent: the open queue in the page's
   * order, others newest decision first. Admins only, like deciding.
   */
  async listItems(email: string, boardId: number, status: LearningStatus = 'open'): Promise<Result<LearningWireView[]>> {
    const catalog = await this.deps.catalog.agentSet();
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const learnings = (await boardLearnings(tx, boardId)).filter((l) => learningStatus(l.glob, l.artifacts) === status);
      if (status !== 'open') return ok(learnings.map((l) => learningWireView(l, null)));
      const views: LearningWireView[] = [];
      for (const learning of byEvidenceOrder(learnings)) views.push(learningWireView(learning, await this.preview(tx, catalog, learning)));
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
  private async watchedSignal(tx: Tx, learning: LearningRead, key: string | undefined): Promise<Result<KbSignal | null>> {
    if (key === undefined) return ok(null);
    const { id, boardId } = refOf(learning);
    if (learningDocument(learning.glob, learning.artifacts) !== null) return invalidInput(`${id} proposes a document; a document proposal doesn't watch a signal`);
    if (!isEffectMeasured(key)) return invalidInput(`Effect checks don't measure ${key}`);
    const { signal } = learningFacts(learning.glob);
    if (signal !== null) return invalidInput(`${id} already has a signal (${signal.label}); its effect check watches that`);
    const signals = this.deps.signals === undefined ? [] : await this.deps.signals.measure(tx, boardId, this.deps.clock.now());
    const found = signals.find((s) => s.key === key);
    return found === undefined ? invalidInput(`No signal ${key} is measured on board ${boardId} now`) : ok(found);
  }

  /** What an approval writes, and the statement and outcome it records. */
  private async applyApproval(
    tx: Tx,
    email: string,
    learning: LearningRead,
    approval: Approval,
  ): Promise<Result<{ statement: string; outcome: KbOutcome }>> {
    const item = refOf(learning);
    const proposed = learningDocument(learning.glob, learning.artifacts);
    // A document proposal is its own draft.
    if (approval.as === 'document' || (approval.as === 'draft' && proposed !== null)) {
      if (proposed === null) return invalidInput(`${item.id} is not a document proposal`);
      const document = checkDocument({ ...proposed, content: approval.content ?? proposed.content });
      if (!document.ok) return document;
      const { name, content } = document.value;
      const outcome = await this.apply(tx, email, item, 'doc', name, renderFrontmatter(document.value) + content);
      return outcome.ok ? ok({ statement: learning.glob.summary, outcome: outcome.value }) : outcome;
    }
    if (proposed !== null) return invalidInput(`${item.id} proposes a document; approve it as that document`);
    const statement = approval.statement?.trim() ?? learning.glob.summary;
    if (statement === '') return invalidInput('A learning needs a statement');
    if (approval.as === 'learning') return ok({ statement, outcome: { kind: 'learning' } });
    if (approval.as === 'draft') {
      const outcome = await this.applyDraft(tx, email, learning, approval);
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
  async reject(email: string, itemId: string, version: number, reason: string): Promise<Result<LearningWire>> {
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
    decision: DecisionStep,
    via?: KbVia,
  ): Promise<Result<LearningWire>> {
    const stale = (item: LearningWire) => err({ code: 'version_conflict', message: `${item.id} has changed`, currentItem: item });
    try {
      return await this.transaction((tx) => this.decideIn(tx, email, itemId, version, decision, { ...(via === undefined ? {} : { via }), roles: ADMINS }));
    } catch (error) {
      // A concurrent agent-set change (another approval or import) is a conflict to retry, like a stale item.
      if (!(error instanceof StaleLearning || error instanceof BoardChanged)) throw error;
      const current = await this.deps.store.transaction((tx) => this.current(tx, itemId));
      if (current === null) return notFound(`No KB item ${itemId}`);
      return error instanceof BoardChanged
        ? err({ code: 'version_conflict', message: 'The board changed meanwhile; try again', currentItem: current })
        : stale(current);
    }
  }

  /**
   * `approve` inside the caller's transaction (from `inTransaction`), for the decision glob that decides an item and its
   * glob together: `roles` says who may (POs too), and the glob is not synced here (the caller moves it itself).
   */
  async approveIn(tx: Tx, email: string, itemId: string, version: number, approval: Approval, roles: readonly Role[]): Promise<Result<LearningWire>> {
    const edited = approval.as === 'draft' && approval.content !== undefined;
    return this.decideIn(tx, email, itemId, version, (t, learning) => this.approving(t, email, learning, approval), { roles, edited });
  }

  /** `reject` inside the caller's transaction (see `approveIn`). */
  async rejectIn(tx: Tx, email: string, itemId: string, version: number, reason: string, roles: readonly Role[]): Promise<Result<LearningWire>> {
    const trimmed = reason.trim();
    if (trimmed === '') return invalidInput('Rejecting needs a reason');
    return this.decideIn(tx, email, itemId, version, () => Promise.resolve(ok({ reason: trimmed })), { roles });
  }

  /**
   * A decision: the item exists, the caller has one of `roles` on its board, it is unchanged since read and still open
   * (items the pipeline closed as merged, suppressed or covered can't be decided). Throws `StaleLearning` or `BoardChanged`
   * on a lost conditional write so the transaction rolls back; the callers turn those into a version conflict.
   */
  private async decideIn(
    tx: Tx,
    email: string,
    itemId: string,
    version: number,
    decision: DecisionStep,
    options: { readonly via?: KbVia; readonly roles: readonly Role[]; readonly edited?: boolean },
  ): Promise<Result<LearningWire>> {
    const { via } = options;
    const stale = (item: LearningWire) => err({ code: 'version_conflict', message: `${item.id} has changed`, currentItem: item });
    const learning = await readLearning(tx, itemId);
    if (learning === null) return notFound(`No KB item ${itemId}`);
    const { id, boardId } = refOf(learning);
    const actor = await roleOf(tx, email, boardId, options.roles);
    if (!actor.ok) return actor;
    if (learning.glob.version !== version) return stale(learningWire(learning));
    const status = learningStatus(learning.glob, learning.artifacts);
    if (status !== 'open') return invalidInput(`${id} is already ${status}`);
    const decided = await decision(tx, learning);
    if (!decided.ok) return decided;
    const decidedAt = this.deps.clock.now();
    // The write is the decision's own transition: the glob is accepted (with edits) or rejected with it.
    let written: boolean;
    if (!('statement' in decided.value)) {
      const outcome: KbOutcome | null = via === undefined ? null : { kind: 'rejected', via };
      written = await recordLearningDecision(tx, this.writes(tx), id, version, { kind: 'rejected', by: email, at: decidedAt, reason: decided.value.reason, outcome });
    } else {
      const { statement, outcome } = decided.value;
      const chosen = decided.value.signal ?? null;
      const signal = chosen ?? learningFacts(learning.glob).signal;
      // An approved change with a signal the check measures is watched (the daily effect check).
      const effectCheck = signal === null || !isEffectMeasured(signal.key) ? null : await this.effectCheckFor(tx, boardId, signal, outcome, decidedAt);
      if (chosen !== null) await this.claimSignal(tx, { id, boardId }, chosen);
      written = await recordLearningDecision(tx, this.writes(tx), id, version, {
        kind: 'approved',
        by: email,
        at: decidedAt,
        statement,
        reason: decided.value.reason ?? null,
        outcome: via === undefined ? outcome : { ...outcome, via },
        signal,
        effectCheck,
        edited: options.edited === true,
      });
    }
    if (!written) throw new StaleLearning(id);
    this.kbChanged(tx, boardId);
    // Decided, it has left the pipeline.
    return ok(await this.written(tx, id));
  }

  /**
   * A new effect check for an approval. A revise-or-revert item (`effect:` signal) watches the key its original
   * watched, so approving the revision is checked against the same signal.
   */
  private async effectCheckFor(tx: Tx, boardId: number, signal: KbSignal, outcome: KbOutcome, decidedAt: string): Promise<EffectCheck> {
    const board = await tx.getBoard(boardId);
    if (board === null) throw new Error(`No board ${boardId}`);
    const originalId = effectItemOf(signal.key);
    const original = originalId === null ? null : await readLearning(tx, originalId);
    const watch = (original === null ? null : (learningEffectCheck(original.artifacts) ?? learningFacts(original.glob).signal)) ?? signal;
    return startEffectCheck({ key: watch.key, label: watch.label }, effectBasisOf(outcome, decidedAt), board.effectCheckGlobs);
  }

  /**
   * A signal an admin chose to watch belongs to the approved item from now on (`kb_signals`), so mining doesn't raise
   * it again while the effect check owns it; an open item already raised for it keeps it (mining refreshes that one).
   */
  private async claimSignal(tx: Tx, item: LearningRef, signal: KbSignal): Promise<void> {
    const row = (await tx.listKbSignals(item.boardId)).find((r) => r.key === signal.key);
    const holder = row?.itemId == null ? null : await readLearning(tx, row.itemId);
    if (holder !== null && learningStatus(holder.glob, holder.artifacts) === 'open') return;
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
    learning: LearningRead,
    approval: Extract<Approval, { as: 'draft' }>,
  ): Promise<Result<KbOutcome>> {
    const item = refOf(learning);
    const target = learningTarget(learning.glob).routed;
    if (target === null) return invalidInput(`${item.id} has no target yet`);
    const drafted = learningDraft(learning.artifacts);
    const draft =
      approval.content === undefined
        ? (drafted?.draft ?? null)
        : {
            section: approval.section === undefined ? (drafted?.draft.section ?? null) : cleanHeading(approval.section),
            content: approval.content,
          };
    if (draft === null) return invalidInput(`${item.id} has no draft yet`);
    if (draft.content.trim() === '') return invalidInput('The draft is empty');
    const state = await targetState(tx, await this.deps.catalog.agentSet(), item.boardId, target);
    if (state === null) return notFound(`${target.name} is no longer on board ${item.boardId}; choose another target under Edit`);
    if (drafted !== null && drafted.targetVersion !== null && state.version !== drafted.targetVersion) {
      if (!(await requeueLearningDraft(tx, this.writes(tx), item.id, learning.glob.version))) throw new StaleLearning(item.id);
      this.kbChanged(tx, item.boardId);
      return err({
        code: 'version_conflict',
        message: `${target.name} changed since ${item.id} was drafted; it is being drafted again`,
        currentItem: await this.written(tx, item.id),
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

  /** What approving an open learning's draft would change now; null without a draft or a target. */
  private async preview(tx: Tx, catalog: CatalogAgentSet, learning: LearningRead): Promise<DraftPreview | null> {
    return draftPreview(tx, catalog, previewInputOf(learning));
  }

  /** `preview` for one learning, reading the catalog itself: the diff a decision glob shows beside its proposal. */
  async previewFor(tx: Tx, learning: LearningRead): Promise<DraftPreview | null> {
    return draftPreview(tx, await this.deps.catalog.agentSet(), previewInputOf(learning));
  }

  /** The current state of a learning's routed target (its text and version), for Suggest; null when it has none or it is gone. */
  async targetStateFor(tx: Tx, learning: LearningRead): Promise<TargetState | null> {
    const target = learningTarget(learning.glob).routed;
    return target === null ? null : targetState(tx, await this.deps.catalog.agentSet(), learning.glob.boardId, target);
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
    item: LearningRef,
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
    item: LearningRef,
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
        if (!(await tx.updateBoard(next, board.version))) return { kind: 'conflict' as const };
        // A new agent-set version is a change on the knowledge page.
        await tx.enqueueEffects([knowledgePageEffect(boardId), agentSetCommitEffect(boardId)]);
        return { kind: 'bumped' as const, version: next.agentSetVersion };
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
      await tx.enqueueEffects([knowledgePageEffect(boardId), agentSetCommitEffect(boardId)]);
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
    for (const { glob, artifacts, jobs } of await boardLearnings(tx, boardId)) {
      if (glob.id === decidingItem || learningStatus(glob, artifacts) !== 'open') continue;
      const target = learningTarget(glob).routed;
      if (pipelineState(glob, artifacts, jobs).processing !== 'drafted' || learningDocument(glob, artifacts) !== null || target === null) continue;
      if (!changed.some((c) => c.kind === target.kind && c.name === target.name)) continue;
      // A lost conditional write means the learning changed meanwhile; approving it still checks the version.
      await requeueLearningDraft(tx, this.writes(tx), glob.id, glob.version);
    }
  }
}
