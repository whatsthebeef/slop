import { composeAgentSet } from '../domain/agent-set.js';
import { effectItemOf } from '../domain/effect-check.js';
import { LLM_WAITING_PREFIX } from '../domain/kb.js';
import type {
  KbContradiction,
  KbCoverage,
  KbDraft,
  KbItem,
  KbMergeNote,
  KbPossibleCoverage,
  KbProcessing,
  KbTarget,
  NewDocumentMeta,
} from '../domain/kb.js';
import { agentSetKind, docName, hasFrontmatter, isAgentSetKind, parseFrontmatter, PROSE_KINDS } from '../domain/knowledge.js';
import type { KnowledgeDoc, KnowledgeKind, KnowledgeLayer } from '../domain/knowledge.js';
import { checkLocalRun, LOCAL_RUN_NAME, parseLocalRun, renderLocalRun } from '../domain/local-run.js';
import { checkMergePolicy, MERGE_POLICY_NAME, parseMergePolicy, renderMergePolicy } from '../domain/merge-policy.js';
import { markdownHeadings, sameHeading, sectionText, spliceHeadings, withHeading } from '../domain/sections.js';
import type { Catalog, Clock, Notifier, Store, Tx } from '../ports.js';
import { LlmUnavailable } from './intake-service.js';
import type { Llm, LlmRequest } from './intake-service.js';
import { documentTarget, targetState } from './knowledge-service.js';
import type { TargetState } from './knowledge-service.js';
import { addEvidenceTo, keptApart, longEnoughQuote, normalised, verifiedQuote } from './kb-dedupe.js';
import { completeWithDeadline } from './llm-call.js';
import { field, isObject, list, parseJson, text } from './llm-json.js';

/** Failures at one stage (LLM errors or unusable answers) before an item is marked `failed`. */
export const MAX_PROCESSING_ATTEMPTS = 3;
/** How long a claimed item is held before another worker may take it (a crash mid-item retries after this). */
const LEASE_MS = 5 * 60_000;
/**
 * How long one LLM call may take before it is abandoned and the attempt fails (retried with
 * backoff). Below the lease, so a stalled call can't hold the single worker, and every board's items, forever.
 */
export const LLM_TIMEOUT_MS = 2 * 60_000;
const backoffMs = (attempts: number) => 30_000 * 2 ** (attempts - 1);
/**
 * How long an item waits after an `LlmUnavailable` (expired sign-in, no model access) before it is
 * tried again. No attempt is counted: only a person can fix it, and items shouldn't fail meanwhile.
 */
export const LLM_WAIT_MS = 60_000;
/**
 * Dedupe compares against at most this many items per group (open, approved, rejected), newest
 * first, to keep one call small. Older items fall out of comparison; weekly consolidation
 * catches repeats across the open queue.
 */
const CANDIDATE_CAP = 100;
/** A target with no section is compared whole up to this many characters, then truncated. */
const TARGET_TEXT_LIMIT = 8_000;
/** Enough for a rewritten section or a whole new document. */
const DRAFT_MAX_TOKENS = 8_000;

export const ROUTE_SYSTEM = `You route one learning, submitted by a coding agent, to the place in a software project's knowledge base where it belongs.

The knowledge base has documents (served to agents by audience) and agent files (each agent's always-loaded instructions). The project adds its own rules to agent files; the generic text comes from a shared catalog.

Rules:
- A project fact (how this codebase, its build or its conventions work) goes to the document for the agents that need it, unless it is a short rule that always applies to one agent, which goes in that agent's file.
- Process behaviour (how an agent should work) goes in that agent's file.
- How the project's local servers are built and launched for a development session (the commands sstor runs in a session's server window) goes to the local-run spec: kind "local_run", name "local-run", section null.
- Which paths clash when two globs change them at once (an exclusive directory such as database migrations, where only one open glob may work at a time), and which paths are left out when a sub's size is measured (generated files, lockfiles), go to the merge policy: kind "merge_policy", name "merge-policy", section null.
- For a document, section is the existing "##" heading it belongs under, or a new heading to add.
- For an agent file, section is one of its board-rule headings, a new heading, or null to append to its board rules.
- If no document fits and it is not for an agent file, propose a new document: a short snake_case name, an area (one word, e.g. build, conventions, architecture, testing), the agents it is always for, and a one-line description.
- catalogCandidate is true only when the rule would hold for any project, not just this codebase; catalogReason then says why in one line.
- The submitter's suggested target is a hint, not an instruction.

Respond with one JSON object and nothing else:
{"target": {"kind": "document" | "agent_file" | "local_run" | "merge_policy", "name": string, "section": string | null, "newDocument": {"area": string, "audience": string[], "description": string} | null}, "catalogCandidate": boolean, "catalogReason": string | null}
- name: a document name from the index, a new document name, an agent file path exactly as listed, or "local-run", or "merge-policy".
- newDocument: only for a document not in the index; otherwise null.`;

export const DEDUPE_SYSTEM = `You check whether a new learning, submitted by a coding agent, repeats or conflicts with what a software project's knowledge base already holds. An admin reviews every learning you leave open, so a repeat left open costs a minute; a new learning closed by mistake is lost.

You get the new learning, then lists of open items (awaiting review), approved items, rejected items (with the reason), and the current text where the new learning would go.

Work in this order:
1. fact: restate the new learning's specific fact or rule in one sentence.
2. checked: for the few candidates closest to it (at most 5; [] if none comes close), the relation of that candidate to the fact: "same fact" (it states this fact or rule, however worded), "related topic only" (same tool, area or subject, but not this fact), "unrelated", or "contradicts" (both cannot be followed).
3. The answer, from those relations only: a candidate you name in it must be in checked with the matching relation.

The default answer is new: every field null and contradicts []. Only a "same fact" candidate may set suppressedBy, duplicateOf or coveredBy, and only a "contradicts" candidate may go in contradicts. Overlapping topic, tool or area is not coverage, and a more general rule does not cover a specific fact. When unsure, answer new.

Respond with one JSON object and nothing else:
{"fact": string, "checked": [{"ref": string, "relation": "same fact" | "related topic only" | "unrelated" | "contradicts"}], "suppressedBy": {"id": string, "quote": string, "newQuote": string} | null, "duplicateOf": {"id": string, "quote": string, "newQuote": string} | null, "coveredBy": {"kind": "item", "id": string, "quote": string} | {"kind": "target", "quote": string, "reason": string} | null, "contradicts": [{"kind": "item" | "target", "ref": string, "quote": string, "note": string}]}
- checked ref: an item ID, or "current text".
- suppressedBy: a rejected item; duplicateOf: an open item; coveredBy: an approved item ({"kind": "item"}) or the current text ({"kind": "target"}).
- quote: for suppressedBy and duplicateOf, the whole sentence, copied word for word from that item's statement, that states the same fact; for coveredBy and contradicts, the exact sentence or phrase, copied word for word from that item's statement or from the current text, that states the same fact (coveredBy) or conflicts (contradicts). No such sentence means no claim.
- newQuote (suppressedBy, duplicateOf): the whole sentence, copied word for word from the new learning's statement, that states that fact. No such sentence means no claim.
- reason, note: one short line each. For a contradiction in the current text, ref is the heading it conflicts with, or "".
Use IDs exactly as given.`;

export const DRAFT_SYSTEM = `You draft one change to a software project's knowledge base: the edit that puts a reviewed learning, submitted by a coding agent, into the document or agent file it was routed to. An admin approves your draft as is or edits it first.

Rules:
- Change only what the learning requires. Keep the target's structure, headings, tone and formatting, and be concise: a bullet or a sentence or two is usually enough.
- Rewrite one section: the existing heading the learning belongs under (you may choose a better heading in the same text than the one suggested), or add a new section when none fits.
- For an agent file you change only the project's board rules. The catalog text is shown for context and is never changed; don't repeat what it already says. Board rules are appended under a "## Board rules" heading, so their sections use "###" headings.
- For a new document, write the whole body (no frontmatter), starting with a "#" title, and don't overlap the existing documents listed.
- For the local-run spec, write its whole new value: content is a JSON object {"build"?: string, "launch": string} and nothing else (build runs first, then launch; each one shell command line, run from the worktree root), and section is null. Keep what the current value does unless the learning changes it.
- For the merge policy, write its whole new value: content is a JSON object {"exclusivePaths"?: string[], "sizeIgnoredPaths"?: string[]} and nothing else (path globs relative to the repo root, such as "apps/server/drizzle/**"; exclusivePaths are paths only one open glob may change at a time, sizeIgnoredPaths are not counted when a sub's size is measured), and section is null. Keep the entries the current value has unless the learning changes them.

Respond with one JSON object and nothing else:
{"section": string | null, "content": string | object, "rationale": string}
- section: the existing heading (its text, without "#") whose section content replaces, or null to add content as a new section. Always null for a new document.
- content: the full new text of that section, from its heading line through to the end of the section, including any subsections it keeps; for a new section, its heading line and body; for a new document, the whole body; for the local-run spec, the JSON object.
- rationale: one line saying what the change does and why.`;

const PLAIN_NAME = /^[\w.-]+$/;
const SINGLE_LINE = /^[^\r\n]*$/;

/** A routable agent file: one a learning can add board rules (or, for a board-owned file, text) to. */
interface AgentFile {
  readonly path: string;
  readonly kind: KnowledgeKind;
  readonly layer: KnowledgeLayer;
  readonly description: string;
  /** Headings of the board's layer: its overlay, or the whole file it owns. */
  readonly boardHeadings: readonly string[];
  /** The file as served (catalog plus overlay). */
  readonly served: string;
}

interface Snapshot {
  readonly docs: readonly KnowledgeDoc[];
  readonly agentFiles: readonly AgentFile[];
  /** The board's local-run spec row; null when it has none yet. */
  readonly localRun: KnowledgeDoc | null;
  /** The board's merge policy row; null when it has none yet. */
  readonly mergePolicy: KnowledgeDoc | null;
  readonly open: readonly KbItem[];
  readonly approved: readonly KbItem[];
  readonly rejected: readonly KbItem[];
}

interface Routing {
  readonly target: KbTarget;
  readonly catalogCandidate: boolean;
  readonly catalogReason: string | null;
}

/** A hint naming another item (approved, open or rejected) on a quote too short to close on. */
type ItemHint = Extract<KbPossibleCoverage, { kind: 'item' }>;

/** A "same fact" item the new one closes against, with both quotes verified and long enough (`longEnoughQuote`). */
interface ClosingMatch {
  readonly id: string;
  /** From the matched item's statement. */
  readonly quote: string;
  /** From the new item's statement. */
  readonly ownQuote: string;
}

interface Dedupe {
  /** A rejected item it matches: closes it as `suppressed`. */
  readonly suppressedBy: ClosingMatch | null;
  /** An open item it repeats: closes it as `merged`. */
  readonly duplicateOf: ClosingMatch | null;
  /** An approved item that says it, quote verified: the only coverage that closes an item. */
  readonly coveredBy: KbCoverage | null;
  /**
   * The target's text that may say it, or an item (approved, open or rejected) with a quote too short to close on
   * (quotes verified either way): flagged on the open item, never closes it.
   */
  readonly possiblyCoveredBy: KbPossibleCoverage | null;
  readonly contradicts: readonly KbContradiction[];
}

const NO_MATCH: Dedupe = { suppressedBy: null, duplicateOf: null, coveredBy: null, possiblyCoveredBy: null, contradicts: [] };

interface Drafted {
  readonly draft: KbDraft;
  readonly target: KbTarget;
  readonly rationale: string | null;
}

/** The item changed while it was processed (decided, or merged into); thrown so the writes roll back. */
class StaleItem extends Error {
  constructor(id: string) {
    super(`KB item ${id} changed while it was processed`);
  }
}

const newest = (items: readonly KbItem[]) => [...items].reverse().slice(0, CANDIDATE_CAP);

const targetLabel = (target: KbTarget) =>
  target.kind === 'local_run'
    ? 'the local-run spec'
    : target.kind === 'merge_policy'
      ? 'the merge policy'
      : `${target.kind === 'doc' ? 'document' : 'agent file'} ${target.name}${target.section === null ? '' : `, section "${target.section}"`}`;

const describeItem = (item: KbItem) => {
  if (item.outcome?.kind === 'applied') return ` -> applied to ${item.outcome.name}`;
  return item.target === null ? '' : ` -> ${targetLabel(item.target)}`;
};

/**
 * The KB pipeline (spec, self-improvement processing): a background job claims each newly
 * submitted item and, with one LLM call each, routes it to a document or agent file and
 * deduplicates it against open, approved and rejected items and the target's current text. Each
 * routed item is then claimed again and drafted (one more call): the new text of one section of
 * its target, or a whole new document. Nothing reaches the knowledge base here; it only prepares
 * items for an admin's decision.
 */
export class KbPipeline {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      catalog: Catalog;
      notifier: Notifier;
      /** Routing and dedupe. */
      route: Llm;
      /** Drafting. */
      draft: Llm;
      /** Deadline for each LLM call; defaults to LLM_TIMEOUT_MS. */
      llmTimeoutMs?: number;
    },
  ) {}

  /** One LLM call with a deadline; a timeout rejects with a readable reason, recorded like any other failure. */
  private complete(llm: Llm, request: Omit<LlmRequest, 'signal'>): Promise<string> {
    return completeWithDeadline(llm, request, this.deps.llmTimeoutMs ?? LLM_TIMEOUT_MS);
  }

  /** Claims the oldest item due for routing or drafting and processes it; returns its ID, or null when none is due. */
  async processNext(): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = this.deps.clock.now();
      const next = await this.deps.store.transaction((tx) => tx.nextKbItemToProcess(now));
      if (next === null) return null;
      const claimed = await this.claim(next.id);
      // Another worker took it first: look for the next one.
      if (claimed === null) continue;
      await this.run(claimed);
      return claimed.id;
    }
    return null;
  }

  /**
   * Claims one given item, if it is still open and waiting for routing or drafting, and processes
   * it; returns whether it ran. The job uses `processNext`; this is for a caller (so far only tests)
   * that must process a particular item while others are due too.
   */
  async process(itemId: string): Promise<boolean> {
    const claimed = await this.claim(itemId);
    if (claimed === null) return false;
    await this.run(claimed);
    return true;
  }

  /**
   * Takes the item with a conditional write that holds it for a lease, so two workers can't both
   * process it and a crash mid-item retries once the lease ends.
   */
  private async claim(itemId: string): Promise<KbItem | null> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const item = await tx.getKbItem(itemId);
      if (item?.status !== 'open' || !(item.processing === 'pending' || item.processing === 'routed')) return null;
      if (item.processAfter !== null && item.processAfter > now) return null;
      const claimed: KbItem = { ...item, processAfter: this.later(now, LEASE_MS), version: item.version + 1 };
      return (await tx.updateKbItem(claimed, item.version)) ? claimed : null;
    });
  }

  private async run(item: KbItem): Promise<void> {
    if (item.processing === 'routed') {
      await this.draft(item);
      return;
    }
    if (item.document !== null) {
      // A document proposal names its own target (items from before routing existed land here).
      const { document } = item;
      await this.finish(item, async (tx) => ({
        routing: { target: await documentTarget(tx, item.boardId, document), catalogCandidate: false, catalogReason: null },
        dedupe: NO_MATCH,
      }));
      return;
    }
    const snapshot = await this.snapshot(item);
    const decided = await this.ask(item, snapshot);
    if ('unavailable' in decided) await this.wait(item, decided.unavailable);
    else if ('failure' in decided) await this.fail(item, decided.failure, 'pending');
    else await this.finish(item, () => Promise.resolve(decided));
  }

  /**
   * Drafts a routed item against its target's current text. A document proposal is its own draft,
   * so it needs no call. If the target changes during the call, the item is released to be drafted again.
   */
  private async draft(item: KbItem): Promise<void> {
    const { target } = item;
    if (item.document !== null || target === null) {
      // Document proposals (routed before drafting existed) are their own draft; an item with no
      // target can't be drafted and is left for an admin to decide or retarget.
      const wrote = await this.write(item, (current) =>
        current.document !== null
          ? { ...current, processing: 'drafted', processAfter: null }
          : { ...current, processing: 'failed', processingError: 'No target to draft against', processAfter: null },
      );
      if (wrote) this.deps.notifier.publish({ kind: 'board.kb', boardId: item.boardId });
      return;
    }
    const catalog = await this.deps.catalog.agentSet();
    const context = await this.deps.store.transaction(async (tx) => ({
      state: await targetState(tx, catalog, item.boardId, target),
      docs: target.newDocument === null ? [] : await tx.listKnowledge(item.boardId, ['doc']),
    }));
    const { state } = context;
    if (state === null) {
      await this.fail(item, `The target ${target.name} is no longer on the board; choose another target`, 'routed');
      return;
    }
    let drafted: Drafted | string;
    try {
      drafted = parseDraft(
        await this.complete(this.deps.draft, {
          system: DRAFT_SYSTEM,
          prompt: draftPrompt(item, target, state, context.docs),
          maxTokens: DRAFT_MAX_TOKENS,
        }),
        target,
        state,
      );
    } catch (error) {
      if (error instanceof LlmUnavailable) await this.wait(item, error.reason);
      else await this.fail(item, error instanceof Error ? error.message : String(error), 'routed');
      return;
    }
    if (typeof drafted === 'string') {
      await this.fail(item, drafted, 'routed');
      return;
    }
    const { draft, rationale } = drafted;
    const wrote = await this.write(item, async (current, tx) => {
      const now = await targetState(tx, catalog, item.boardId, target);
      // The target moved during the call: release the item to be drafted against the new text.
      if (now?.version !== state.version) return { ...current, processAfter: null };
      return {
        ...current,
        target: drafted.target,
        draft,
        rationale,
        draftedAgainstVersion: state.version,
        processing: 'drafted',
        processingError: null,
        processingAttempts: 0,
        processAfter: null,
      };
    });
    if (wrote) this.deps.notifier.publish({ kind: 'board.kb', boardId: item.boardId });
  }

  /** A conditional write of the claimed item; false when it changed meanwhile (decided, retargeted). */
  private async write(item: KbItem, next: (current: KbItem, tx: Tx) => KbItem | Promise<KbItem>): Promise<boolean> {
    return this.deps.store.transaction(async (tx) => {
      const current = await tx.getKbItem(item.id);
      if (current?.version !== item.version) return false;
      return tx.updateKbItem({ ...(await next(current, tx)), version: current.version + 1 }, current.version);
    });
  }

  /**
   * The routing call, then the dedupe call against the routed target; a failure says why either
   * went wrong, and `unavailable` why the LLM can't be used at all.
   */
  private async ask(
    item: KbItem,
    snapshot: Snapshot,
  ): Promise<{ routing: Routing; dedupe: Dedupe } | { failure: string } | { unavailable: string }> {
    try {
      const routing = parseRouting(
        await this.complete(this.deps.route, { system: ROUTE_SYSTEM, prompt: routePrompt(item, snapshot), maxTokens: 600 }),
        snapshot,
      );
      if (routing === null) return { failure: 'The routing answer was not usable JSON' };
      const targetText = currentText(routing.target, snapshot);
      const nothingToCompare =
        snapshot.open.length + snapshot.approved.length + snapshot.rejected.length === 0 && targetText === null;
      if (nothingToCompare) return { routing, dedupe: NO_MATCH };
      const dedupe = parseDedupe(
        await this.complete(this.deps.route, {
          system: DEDUPE_SYSTEM,
          prompt: dedupePrompt(item, snapshot, routing.target, targetText),
          // The fact and up to five relations come before the answer.
          maxTokens: 1_000,
        }),
        item,
        snapshot,
        routing.target,
        targetText,
      );
      return dedupe === null ? { failure: 'The dedupe answer was not usable JSON' } : { routing, dedupe };
    } catch (error) {
      if (error instanceof LlmUnavailable) return { unavailable: error.reason };
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What the routing and dedupe calls see: the board's documents and agent files, and its other items. */
  private async snapshot(item: KbItem): Promise<Snapshot> {
    const catalog = await this.deps.catalog.agentSet();
    return this.deps.store.transaction(async (tx) => {
      const knowledge = await tx.listKnowledge(item.boardId);
      const docs = knowledge.filter((d) => d.kind === 'doc');
      const rows = knowledge.filter((d) => isAgentSetKind(d.kind));
      const composed = composeAgentSet(catalog.files, rows);
      const agentFiles: AgentFile[] = [];
      for (const entry of composed.entries) {
        // Learnings are prose: settings, hooks and mcp.json aren't targets.
        if (!PROSE_KINDS.includes(entry.kind)) continue;
        const served = composed.files.find((f) => f.path === entry.path)?.content;
        if (served === undefined) continue;
        const row = rows.find((r) => r.name === entry.path);
        const layer: KnowledgeLayer = row?.layer ?? 'overlay';
        agentFiles.push({
          path: entry.path,
          kind: entry.kind,
          layer,
          description: parseFrontmatter(served).description,
          boardHeadings: markdownHeadings(row?.content ?? '')
            .filter((h) => h.level <= 3)
            .map((h) => h.text),
          served,
        });
      }
      // A revise-or-revert item (`effect:` signal) is about its original, and quotes it: dedupe never sees the original
      // or another item raised for it, so it can't be closed as covered by (or a repeat of) the change it questions.
      const original = item.signal === null ? null : effectItemOf(item.signal.key);
      const aboutOriginal = (i: KbItem) => original !== null && (i.id === original || i.signal?.key === item.signal?.key);
      const others = (await tx.listKbItems(item.boardId)).filter(
        (i) => i.id !== item.id && i.document === null && !aboutOriginal(i),
      );
      return {
        docs,
        agentFiles,
        localRun: knowledge.find((d) => d.kind === 'local_run' && d.name === LOCAL_RUN_NAME) ?? null,
        mergePolicy: knowledge.find((d) => d.kind === 'merge_policy' && d.name === MERGE_POLICY_NAME) ?? null,
        open: newest(others.filter((i) => i.status === 'open')),
        approved: newest(others.filter((i) => i.status === 'approved')),
        rejected: newest(others.filter((i) => i.status === 'rejected')),
      };
    });
  }

  /** Writes the outcome in one transaction, conditional on the item (and any item it adds evidence to). */
  private async finish(item: KbItem, decide: (tx: Tx) => Promise<{ routing: Routing; dedupe: Dedupe }>): Promise<void> {
    try {
      await this.deps.store.transaction(async (tx) => {
        const current = await tx.getKbItem(item.id);
        if (current?.version !== item.version) throw new StaleItem(item.id);
        const { routing, dedupe } = await decide(tx);
        let next: KbItem = {
          ...current,
          target: routing.target,
          catalogCandidate: routing.catalogCandidate,
          catalogReason: routing.catalogReason,
          // A document proposal is its own draft.
          processing: item.document === null ? 'routed' : 'drafted',
          processingError: null,
          processingAttempts: 0,
          processAfter: null,
          version: current.version + 1,
        };
        const addEvidence = async (
          id: string,
          status: 'open' | 'approved',
          adjust?: (merged: KbItem) => KbItem,
        ): Promise<boolean> => {
          const other = await tx.getKbItem(id);
          // An admin separated them (reopening a merge): the item stays open rather than joining it again.
          if (other?.status !== status || keptApart(other, current)) return false;
          if (!(await addEvidenceTo(tx, other, current, adjust))) throw new StaleItem(id);
          return true;
        };
        // The verified quotes go on the closed item, so its card shows what it closed on.
        const noteOn = (match: ClosingMatch): KbMergeNote => ({
          by: 'intake',
          quote: match.ownQuote,
          survivorQuote: match.quote,
          at: this.deps.clock.now(),
        });
        // A suppression adds nothing to the rejected item, but checks it as a merge or coverage does: still rejected,
        // and not kept apart from this one. Like theirs, the check holds at the write: the rejected item is written
        // back unchanged on the version read, so a change committed since fails it (and the item is retried), and
        // the row stays locked until this transaction commits.
        const stillRejected = async (id: string): Promise<boolean> => {
          const other = await tx.getKbItem(id);
          if (other?.status !== 'rejected' || keptApart(other, current)) return false;
          if (!(await tx.updateKbItem(other, other.version))) throw new StaleItem(id);
          return true;
        };
        // A short-quote hint on an item is only shown when an admin hasn't kept that item apart from this one, as a
        // closure on it would be refused; a target hint it hid is shown instead.
        const shownHint = async (hint: KbPossibleCoverage | null): Promise<KbPossibleCoverage | null> => {
          if (hint === null || hint.kind !== 'item') return hint;
          const other = await tx.getKbItem(hint.id);
          if (other === null || !keptApart(other, current)) return hint;
          const { kind, name, section } = routing.target;
          return hint.alsoTarget === undefined ? null : { knowledgeKind: kind, name, section, ...hint.alsoTarget };
        };
        // A merge closes the item, so a short-quote match with a rejected item would go unseen: it moves to the open
        // item merged into (when that has no hint of its own, and isn't kept apart from the rejected item), with
        // `via` naming this item, whose statement its `ownQuote` is from. The target hint beside it is this item's
        // target's, so it stays behind.
        const hint = dedupe.possiblyCoveredBy;
        const rejectedHint = hint?.kind === 'item' && hint.claim === 'suppressed' ? hint : null;
        const hinted = rejectedHint === null ? null : await tx.getKbItem(rejectedHint.id);
        const carryHint = (survivor: KbItem): KbItem => {
          if (rejectedHint === null || hinted === null) return survivor;
          if (survivor.possiblyCoveredBy !== null || keptApart(hinted, survivor)) return survivor;
          const carried: ItemHint = { ...rejectedHint, alsoTarget: undefined, via: current.id };
          return { ...survivor, possiblyCoveredBy: carried };
        };
        if (dedupe.suppressedBy !== null && (await stillRejected(dedupe.suppressedBy.id))) {
          next = {
            ...next,
            status: 'suppressed',
            suppressedBy: dedupe.suppressedBy.id,
            mergeNote: noteOn(dedupe.suppressedBy),
          };
        } else if (dedupe.duplicateOf !== null && (await addEvidence(dedupe.duplicateOf.id, 'open', carryHint))) {
          next = {
            ...next,
            status: 'merged',
            duplicateOf: dedupe.duplicateOf.id,
            mergeNote: noteOn(dedupe.duplicateOf),
          };
        } else if (dedupe.coveredBy?.kind === 'item' && (await addEvidence(dedupe.coveredBy.id, 'approved'))) {
          next = { ...next, status: 'covered', coveredBy: dedupe.coveredBy };
        } else {
          // Coverage by the target's text, or a match with an item on a short quote, is only a hint: the item stays
          // open for an admin to decide.
          next = { ...next, possiblyCoveredBy: await shownHint(dedupe.possiblyCoveredBy), contradicts: dedupe.contradicts };
        }
        if (!(await tx.updateKbItem(next, current.version))) throw new StaleItem(item.id);
      });
    } catch (error) {
      // Decided or merged into meanwhile: a still-pending item is retried when its lease ends.
      if (error instanceof StaleItem) return;
      throw error;
    }
    this.deps.notifier.publish({ kind: 'board.kb', boardId: item.boardId });
  }

  /**
   * Records a failed attempt at a stage (`retry`: the state to retry it from): back off and retry,
   * or give up after the last attempt (the item stays open).
   */
  private async fail(item: KbItem, reason: string, retry: KbProcessing): Promise<void> {
    const now = this.deps.clock.now();
    const message = reason.slice(0, 500);
    const recorded = await this.deps.store.transaction(async (tx) => {
      const current = await tx.getKbItem(item.id);
      if (current?.version !== item.version) return false;
      const attempts = current.processingAttempts + 1;
      const last = attempts >= MAX_PROCESSING_ATTEMPTS;
      const next: KbItem = {
        ...current,
        processingAttempts: attempts,
        processingError: message,
        processing: last ? 'failed' : retry,
        processAfter: last ? null : this.later(now, backoffMs(attempts)),
        version: current.version + 1,
      };
      return tx.updateKbItem(next, current.version);
    });
    // Retrying shows the error and attempt count too, not only the final failure.
    if (recorded) this.deps.notifier.publish({ kind: 'board.kb', boardId: item.boardId });
  }

  /**
   * Releases an item the LLM couldn't be used for (credentials, model access) at the same stage,
   * to be tried again after `LLM_WAIT_MS`. Not a failed attempt: the count is unchanged and the item
   * never ends `failed` this way; `processingError` says why it waits.
   */
  private async wait(item: KbItem, reason: string): Promise<void> {
    const now = this.deps.clock.now();
    const message = `${LLM_WAITING_PREFIX}${reason}`.slice(0, 500);
    const wrote = await this.write(item, (current) => ({
      ...current,
      processingError: message,
      processAfter: this.later(now, LLM_WAIT_MS),
    }));
    // Each probe while the LLM is down releases the item again; the page only needs to hear of the
    // first (the write only lands on the claimed version, so `item` is what it replaced).
    if (wrote && item.processingError !== message) this.deps.notifier.publish({ kind: 'board.kb', boardId: item.boardId });
  }

  private later(now: string, ms: number): string {
    return new Date(Date.parse(now) + ms).toISOString();
  }
}

const headingsLine = (headings: readonly string[]) => (headings.length === 0 ? '(none)' : headings.join(' | '));

const routePrompt = (item: KbItem, snapshot: Snapshot): string =>
  [
    `Learning (${item.type}): ${item.statement}`,
    `Evidence: ${item.evidence}`,
    `Suggested target: ${item.suggestedTarget ?? '(none)'}`,
    '',
    'Documents:',
    ...(snapshot.docs.length === 0
      ? ['(none)']
      : snapshot.docs.map(
          (d) =>
            `- ${d.name} [area: ${d.area ?? '-'}; for: ${d.audience.join(', ') || '-'}] ${d.description}\n  headings: ${headingsLine(
              markdownHeadings(d.content)
                .filter((h) => h.level === 2)
                .map((h) => h.text),
            )}`,
        )),
    '',
    'Agent files:',
    ...(snapshot.agentFiles.length === 0
      ? ['(none)']
      : snapshot.agentFiles.map(
          (f) => `- ${f.path} [${f.kind}] ${f.description}\n  board-rule headings: ${headingsLine(f.boardHeadings)}`,
        )),
    '',
    'Local-run spec (local-run):',
    snapshot.localRun === null ? '(not set)' : snapshot.localRun.content.trim(),
    '',
    'Merge policy (merge-policy):',
    snapshot.mergePolicy === null ? '(not set)' : snapshot.mergePolicy.content.trim(),
  ].join('\n');

/** The current text where the item would go: its section, or the whole target (truncated); null for a new document. */
const currentText = (target: KbTarget, snapshot: Snapshot): string | null => {
  if (target.kind === 'local_run') {
    const spec = snapshot.localRun?.content.trim() ?? '';
    return spec === '' ? null : spec;
  }
  if (target.kind === 'merge_policy') {
    const policy = snapshot.mergePolicy?.content.trim() ?? '';
    return policy === '' ? null : policy;
  }
  const whole =
    target.kind === 'doc'
      ? snapshot.docs.find((d) => d.name === target.name)?.content
      : snapshot.agentFiles.find((f) => f.path === target.name)?.served;
  if (whole === undefined || whole.trim() === '') return null;
  const section = target.section === null ? null : sectionText(whole, target.section);
  if (section !== null) return section;
  return whole.length > TARGET_TEXT_LIMIT ? `${whole.slice(0, TARGET_TEXT_LIMIT)}\n(truncated)` : whole;
};

const dedupePrompt = (item: KbItem, snapshot: Snapshot, target: KbTarget, targetText: string | null): string =>
  [
    `New learning (${item.type}): ${item.statement}`,
    `Evidence: ${item.evidence}`,
    '',
    'Open items:',
    ...(snapshot.open.length === 0 ? ['(none)'] : snapshot.open.map((i) => `- ${i.id} (${i.type}): ${i.statement}`)),
    '',
    'Approved items:',
    ...(snapshot.approved.length === 0
      ? ['(none)']
      : snapshot.approved.map((i) => `- ${i.id} (${i.type})${describeItem(i)}: ${i.statement}`)),
    '',
    'Rejected items:',
    ...(snapshot.rejected.length === 0
      ? ['(none)']
      : snapshot.rejected.map((i) => `- ${i.id}: ${i.statement} (rejected: ${i.decisionReason ?? 'no reason'})`)),
    '',
    targetText === null
      ? `Current text: (none; the learning would start ${targetLabel(target)})`
      : `Current text of ${targetLabel(target)}:\n<<<\n${targetText}\n>>>`,
  ].join('\n');

const cleanSection = (value: unknown): string | null => {
  const section = text(value)?.replace(/^#+\s*/, '').trim() ?? '';
  return section === '' || !SINGLE_LINE.test(section) ? null : section;
};

const parseNewDocument = (value: unknown): NewDocumentMeta | null => {
  const area = text(field(value, 'area'))?.trim() ?? '';
  const description = text(field(value, 'description'))?.trim() ?? '';
  const audience = list(field(value, 'audience')).flatMap((a) => {
    const name = text(a)?.trim() ?? '';
    return PLAIN_NAME.test(name) ? [name] : [];
  });
  if (area === '' || !SINGLE_LINE.test(area) || description === '' || !SINGLE_LINE.test(description)) return null;
  return { area, audience, description };
};

/** The routing answer, checked against what the board has; null when it can't be used. */
const parseRouting = (answer: string, snapshot: Snapshot): Routing | null => {
  const parsed = parseJson(answer);
  const target = field(parsed, 'target');
  if (!isObject(target)) return null;
  const name = text(field(target, 'name'))?.trim() ?? '';
  const section = cleanSection(field(target, 'section'));
  let routed: KbTarget;
  if (field(target, 'kind') === 'local_run') {
    // One spec per board, replaced whole: it needs no name or section from the model.
    routed = { kind: 'local_run', name: LOCAL_RUN_NAME, section: null, newDocument: null };
  } else if (field(target, 'kind') === 'merge_policy') {
    routed = { kind: 'merge_policy', name: MERGE_POLICY_NAME, section: null, newDocument: null };
  } else if (field(target, 'kind') === 'agent_file') {
    const file = snapshot.agentFiles.find((f) => f.path === name);
    const kind = agentSetKind(name);
    if (file === undefined || kind === null) return null;
    routed = { kind, name, section, newDocument: null };
  } else if (field(target, 'kind') === 'document') {
    const doc = docName(name);
    if (snapshot.docs.some((d) => d.name === doc)) {
      routed = { kind: 'doc', name: doc, section, newDocument: null };
    } else {
      const newDocument = parseNewDocument(field(target, 'newDocument'));
      if (newDocument === null || !PLAIN_NAME.test(doc)) return null;
      // A new document's learning is the document; there's no section to put it under yet.
      routed = { kind: 'doc', name: doc, section: null, newDocument };
    }
  } else {
    return null;
  }
  const catalogCandidate = field(parsed, 'catalogCandidate') === true;
  const reason = text(field(parsed, 'catalogReason'))?.trim() ?? '';
  return { target: routed, catalogCandidate, catalogReason: catalogCandidate && reason !== '' ? reason : null };
};

/** The `checked` ref for the target's current text. */
const TARGET_REF = 'current text';

/**
 * The dedupe answer, keeping only references to items and text it was shown (anything else is
 * ignored rather than failing the item); null when it isn't a JSON object. Every claim must quote the text it was
 * shown (`targetText`, or the item's statement), else it is dropped. A claim that closes the item needs more: a
 * merge (`duplicateOf`) or suppression (`suppressedBy`) quotes both the matched item's statement and the new
 * item's own, and those quotes, like coverage by an approved item's, must be long enough (`longEnoughQuote`); a
 * claim whose quotes are verbatim but too short is only flagged (`possiblyCoveredBy`). A dropped claim leaves the
 * item open. `targetText` is null when the model was told the target has no text yet (a
 * new document, an empty overlay or document), so the target can't cover or contradict the learning.
 * `fact` (the model's restatement) is only there to focus the model and isn't kept. `checked` isn't
 * kept either, but every claim needs it: a candidate closes or flags the item only when `checked`
 * classes it "same fact" (suppressedBy, duplicateOf, coveredBy) or "contradicts" (contradicts). A
 * claim on a candidate it classed otherwise, or didn't class, contradicts its own reasoning, which
 * is the unsure case: the item stays new.
 */
const parseDedupe = (
  answer: string,
  item: KbItem,
  snapshot: Snapshot,
  target: KbTarget,
  targetText: string | null,
): Dedupe | null => {
  const parsed = parseJson(answer);
  if (!isObject(parsed)) return null;
  const relations = new Map<string, string>();
  for (const entry of list(field(parsed, 'checked'))) {
    const ref = normalised(field(entry, 'ref'));
    const relation = normalised(field(entry, 'relation'));
    if (ref !== '' && relation !== '') relations.set(ref, relation);
  }
  const classedAs = (ref: string, relation: 'same fact' | 'contradicts') => relations.get(normalised(ref)) === relation;
  const itemIn = (items: readonly KbItem[], value: unknown, relation: 'same fact' | 'contradicts') => {
    const id = text(value)?.trim();
    const found = items.find((i) => i.id === id) ?? null;
    return found !== null && classedAs(found.id, relation) ? found : null;
  };
  /**
   * A merge or suppression claim on one of `items`: it closes the item (`match`) when both quotes are verbatim (the
   * matched item's statement, the new item's own) and long enough, and is only a hint when verbatim but either is
   * too short; otherwise it is dropped (null).
   */
  const closingClaim = (
    items: readonly KbItem[],
    value: unknown,
    claim: 'duplicate' | 'suppressed',
  ): { match: ClosingMatch } | { hint: ItemHint } | null => {
    const other = itemIn(items, field(value, 'id'), 'same fact');
    if (other === null) return null;
    const quote = verifiedQuote(field(value, 'quote'), other.statement);
    const ownQuote = verifiedQuote(field(value, 'newQuote'), item.statement);
    if (quote === null || ownQuote === null) return null;
    const quoteOk = longEnoughQuote(quote);
    const ownOk = longEnoughQuote(ownQuote);
    if (quoteOk && ownOk) return { match: { id: other.id, quote, ownQuote } };
    const tooShort = quoteOk ? 'ownQuote' : ownOk ? 'quote' : 'both';
    return { hint: { kind: 'item', id: other.id, quote, shortQuote: true, claim, ownQuote, tooShort } };
  };
  const suppression = closingClaim(snapshot.rejected, field(parsed, 'suppressedBy'), 'suppressed');
  const merge = closingClaim(snapshot.open, field(parsed, 'duplicateOf'), 'duplicate');
  const matchOf = (c: typeof merge) => (c !== null && 'match' in c ? c.match : null);
  const hintOf = (c: typeof merge) => (c !== null && 'hint' in c ? c.hint : null);
  // One hint is shown: suppression's, then merge's, then coverage's. A target hint it hides stays beside it.
  const itemHint = hintOf(suppression) ?? hintOf(merge);
  let possiblyCoveredBy: KbPossibleCoverage | null = itemHint;
  const covered = field(parsed, 'coveredBy');
  let coveredBy: KbCoverage | null = null;
  if (field(covered, 'kind') === 'target' && classedAs(TARGET_REF, 'same fact')) {
    const quote = verifiedQuote(field(covered, 'quote'), targetText);
    if (quote !== null) {
      const said = text(field(covered, 'reason'))?.trim() ?? '';
      const reason = SINGLE_LINE.test(said) ? said : '';
      possiblyCoveredBy =
        itemHint === null
          ? { knowledgeKind: target.kind, name: target.name, section: target.section, quote, reason }
          : { ...itemHint, alsoTarget: { quote, reason } };
    }
  } else if (field(covered, 'kind') === 'item') {
    const approved = itemIn(snapshot.approved, field(covered, 'id'), 'same fact');
    const quote = approved === null ? null : verifiedQuote(field(covered, 'quote'), approved.statement);
    // Coverage closes the item: a word or two found in the statement checks nothing (`longEnoughQuote`). A short
    // quote only flags the item, so the admin still sees what the model thought.
    if (approved !== null && quote !== null) {
      if (longEnoughQuote(quote)) coveredBy = { kind: 'item', id: approved.id };
      else possiblyCoveredBy ??= { kind: 'item', id: approved.id, quote, shortQuote: true };
    }
  }
  const contradicts = list(field(parsed, 'contradicts')).flatMap((entry): KbContradiction[] => {
    const note = text(field(entry, 'note'))?.trim() ?? '';
    if (field(entry, 'kind') === 'target') {
      if (!classedAs(TARGET_REF, 'contradicts') || verifiedQuote(field(entry, 'quote'), targetText) === null) return [];
      const heading = cleanSection(field(entry, 'ref'));
      return [{ kind: 'knowledge', ref: heading === null ? target.name : `${target.name} § ${heading}`, note }];
    }
    if (field(entry, 'kind') === 'item') {
      const other = itemIn([...snapshot.open, ...snapshot.approved], field(entry, 'ref'), 'contradicts');
      return other === null || verifiedQuote(field(entry, 'quote'), other.statement) === null
        ? []
        : [{ kind: 'item', ref: other.id, note }];
    }
    return [];
  });
  return {
    suppressedBy: matchOf(suppression),
    duplicateOf: matchOf(merge),
    coveredBy,
    possiblyCoveredBy,
    contradicts,
  };
};

const titled = (heading: string, text: string) => `${heading}\n<<<\n${text.trim() === '' ? '(empty)' : text}\n>>>`;

/** What the drafter sees: the learning and its evidence, the target, and the target's full current text. */
const draftPrompt = (item: KbItem, target: KbTarget, state: TargetState, docs: readonly KnowledgeDoc[]): string => {
  const where = target.section === null ? 'no section chosen' : `section "${target.section}"`;
  let targetLines: string[];
  if (target.kind === 'local_run') {
    targetLines = [
      'Target: the local-run spec (the whole value is replaced)',
      '',
      titled('Current local-run spec:', state.version === 0 ? '(not set yet)' : state.text),
    ];
  } else if (target.kind === 'merge_policy') {
    targetLines = [
      'Target: the merge policy (the whole value is replaced)',
      '',
      titled('Current merge policy:', state.version === 0 ? '(not set yet)' : state.text),
    ];
  } else if (state.newDocument && target.newDocument !== null) {
    const meta = target.newDocument;
    targetLines = [
      `Target: a new document "${target.name}" [area: ${meta.area}; for: ${meta.audience.join(', ') || '-'}] ${meta.description}`,
      '',
      "Existing documents (don't overlap them):",
      ...(docs.length === 0 ? ['(none)'] : docs.map((d) => `- ${d.name} [area: ${d.area ?? '-'}] ${d.description}`)),
    ];
  } else if (target.kind === 'doc') {
    targetLines = [
      `Target: document ${target.name}, ${where}`,
      '',
      titled(`Current text of document ${target.name} (without its frontmatter):`, state.text),
    ];
  } else if (state.catalog !== null) {
    targetLines = [
      `Target: the board rules of agent file ${target.name}, ${where}`,
      '',
      titled(`Catalog text of ${target.name} (context only; never changed):`, state.catalog),
      '',
      titled(`Current board rules of ${target.name} (the text you change):`, state.text),
    ];
  } else {
    targetLines = [
      `Target: agent file ${target.name} (the project's own file), ${where}`,
      '',
      titled(`Current text of ${target.name}:`, state.text),
    ];
  }
  return [
    `Learning (${item.type}): ${item.statement}`,
    `Evidence: ${item.evidence}`,
    ...(item.extraEvidence.length === 0
      ? []
      : [
          'More evidence (from near-duplicates):',
          ...item.extraEvidence.map(
            (e) => `- ${e.itemId}${e.globIds.length === 0 ? '' : ` (${e.globIds.join(', ')})`}: ${e.evidence}`,
          ),
        ]),
    `Source globs: ${item.sourceGlobIds.join(', ') || '(none)'}`,
    '',
    ...targetLines,
  ].join('\n');
};

/**
 * The draft answer: a section (an existing heading or a new one) and its content, given a heading
 * line if it came without one, or a new document's body. The target's section follows the
 * drafter's choice. Otherwise why it isn't usable (the attempt fails and is retried).
 */
const parseDraft = (answer: string, target: KbTarget, state: TargetState): Drafted | string => {
  const unusable = 'The draft answer was not usable JSON';
  const parsed = parseJson(answer);
  if (!isObject(parsed)) return unusable;
  if (target.kind === 'local_run') return parseLocalRunDraft(field(parsed, 'content'), target, parsed);
  if (target.kind === 'merge_policy') return parseMergePolicyDraft(field(parsed, 'content'), target, parsed);
  const raw = text(field(parsed, 'content'))?.trim() ?? '';
  if (raw === '') return unusable;
  const rationale = (text(field(parsed, 'rationale'))?.trim() ?? '').split(/\r?\n/)[0]?.trim() ?? '';
  const why = rationale === '' ? null : rationale;
  if (state.newDocument) {
    const body = (hasFrontmatter(raw) ? parseFrontmatter(raw).body : raw).trim();
    return body === '' ? unusable : { draft: { section: null, content: body }, target, rationale: why };
  }
  const named = cleanSection(field(parsed, 'section'));
  // A document's title isn't a section to replace (it would take the whole document). Content
  // under it that starts with its own level-1 heading is a whole-document rewrite: a bad draft, so
  // retry. Otherwise it is a new section: append it.
  const namesTitle =
    named !== null &&
    markdownHeadings(state.text).some((h) => sameHeading(h.text, named)) &&
    !spliceHeadings(state.text).some((h) => sameHeading(h.text, named));
  if (namesTitle && markdownHeadings(raw)[0]?.level === 1) {
    return 'The draft rewrote the whole document under its title instead of one section';
  }
  const section = namesTitle ? null : named;
  // Board rules sit under "## Board rules", so a new heading there is one level down.
  const content = section === null ? raw : withHeading(state.text, section, raw, state.catalog === null ? 2 : 3);
  return {
    draft: { section, content },
    // The document exists now (another item created it), so the item no longer proposes it.
    target: { ...target, section: section ?? markdownHeadings(content)[0]?.text ?? null, newDocument: null },
    rationale: why,
  };
};

/** The one-line rationale of a draft answer, or null. */
const rationaleOf = (parsed: unknown): string | null => {
  const line = (text(field(parsed, 'rationale'))?.trim() ?? '').split(/\r?\n/)[0]?.trim() ?? '';
  return line === '' ? null : line;
};

/** A merge-policy draft: the whole value, checked like an approval checks it and kept in canonical form. */
const parseMergePolicyDraft = (content: unknown, target: KbTarget, parsed: unknown): Drafted | string => {
  const raw = text(content);
  const checked = raw === null ? checkMergePolicy(content) : parseMergePolicy(raw.trim());
  if (!checked.ok) return `The drafted merge policy is invalid: ${checked.error.message}`;
  return {
    draft: { section: null, content: renderMergePolicy(checked.value) },
    target: { ...target, section: null, newDocument: null },
    rationale: rationaleOf(parsed),
  };
};

/**
 * A local-run draft: the whole value, as a JSON object (or its text), checked like an approval checks
 * it and kept in canonical form. An invalid value fails the attempt, to be drafted again.
 */
const parseLocalRunDraft = (content: unknown, target: KbTarget, parsed: unknown): Drafted | string => {
  const raw = text(content);
  const checked = raw === null ? checkLocalRun(content) : parseLocalRun(raw.trim());
  if (!checked.ok) return `The drafted local-run spec is invalid: ${checked.error.message}`;
  return {
    draft: { section: null, content: renderLocalRun(checked.value) },
    target: { ...target, section: null, newDocument: null },
    rationale: rationaleOf(parsed),
  };
};
