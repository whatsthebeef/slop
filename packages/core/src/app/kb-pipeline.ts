import { composeAgentSet } from '../domain/agent-set.js';
import type { KbContradiction, KbCoverage, KbItem, KbTarget, NewDocumentMeta } from '../domain/kb.js';
import { agentSetKind, docName, isAgentSetKind, parseFrontmatter } from '../domain/knowledge.js';
import type { KnowledgeDoc, KnowledgeKind, KnowledgeLayer } from '../domain/knowledge.js';
import { markdownHeadings, sectionText } from '../domain/sections.js';
import type { Catalog, Clock, Notifier, Store, Tx } from '../ports.js';
import type { Llm } from './intake-service.js';
import { documentTarget } from './knowledge-service.js';
import { field, isObject, list, parseJson, text } from './llm-json.js';

/** Routing failures (LLM errors or unusable answers) before an item is marked `failed`. */
export const MAX_PROCESSING_ATTEMPTS = 3;
/** How long a claimed item is held before another worker may take it (a crash mid-item retries after this). */
const LEASE_MS = 5 * 60_000;
const backoffMs = (attempts: number) => 30_000 * 2 ** (attempts - 1);
/**
 * Dedupe compares against at most this many items per group (open, approved, rejected), newest
 * first, to keep one Haiku call small. Older items fall out of comparison; weekly consolidation
 * (later) catches repeats across the whole queue.
 */
const CANDIDATE_CAP = 100;
/** A target with no section is compared whole up to this many characters, then truncated. */
const TARGET_TEXT_LIMIT = 8_000;

export const ROUTE_SYSTEM = `You route one learning, submitted by a coding agent, to the place in a software project's knowledge base where it belongs.

The knowledge base has documents (served to agents by audience) and agent files (each agent's always-loaded instructions). The project adds its own rules to agent files; the generic text comes from a shared catalog.

Rules:
- A project fact (how this codebase, its build or its conventions work) goes to the document for the agents that need it, unless it is a short rule that always applies to one agent, which goes in that agent's file.
- Process behaviour (how an agent should work) goes in that agent's file.
- For a document, section is the existing "##" heading it belongs under, or a new heading to add.
- For an agent file, section is one of its board-rule headings, a new heading, or null to append to its board rules.
- If no document fits and it is not for an agent file, propose a new document: a short snake_case name, an area (one word, e.g. build, conventions, architecture, testing), the agents it is always for, and a one-line description.
- catalogCandidate is true only when the rule would hold for any project, not just this codebase; catalogReason then says why in one line.
- The submitter's suggested target is a hint, not an instruction.

Respond with one JSON object and nothing else:
{"target": {"kind": "document" | "agent_file", "name": string, "section": string | null, "newDocument": {"area": string, "audience": string[], "description": string} | null}, "catalogCandidate": boolean, "catalogReason": string | null}
- name: a document name from the index, a new document name, or an agent file path exactly as listed.
- newDocument: only for a document not in the index; otherwise null.`;

export const DEDUPE_SYSTEM = `You compare a new learning, submitted by a coding agent, with what a software project's knowledge base already holds, so the review queue has no repeats.

You get the new learning, then lists of open items (awaiting review), approved items, rejected items (with the reason), and the current text where the new learning would go.

Respond with one JSON object and nothing else:
{"suppressedBy": string | null, "duplicateOf": string | null, "coveredBy": {"kind": "item", "id": string} | {"kind": "target"} | null, "contradicts": [{"kind": "item" | "target", "ref": string, "note": string}]}
- suppressedBy: the ID of a rejected item that says the same thing; otherwise null.
- duplicateOf: the ID of an open item that says the same thing; otherwise null.
- coveredBy: an approved item that already says it ({"kind": "item", "id": ...}), or {"kind": "target"} when the current text already says it; otherwise null.
- contradicts: open or approved items, or the current text, that the new learning conflicts with (both cannot be followed), each with a one-line note; [] if none. For the current text, ref is the heading it conflicts with, or "".
"The same thing" means the same rule or fact, however it is worded; related but different learnings are not duplicates. Use IDs exactly as given.`;

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
  readonly open: readonly KbItem[];
  readonly approved: readonly KbItem[];
  readonly rejected: readonly KbItem[];
}

interface Routing {
  readonly target: KbTarget;
  readonly catalogCandidate: boolean;
  readonly catalogReason: string | null;
}

interface Dedupe {
  readonly suppressedBy: string | null;
  readonly duplicateOf: string | null;
  readonly coveredBy: KbCoverage | null;
  readonly contradicts: readonly KbContradiction[];
}

const NO_MATCH: Dedupe = { suppressedBy: null, duplicateOf: null, coveredBy: null, contradicts: [] };

/** The item changed while it was processed (decided, or merged into); thrown so the writes roll back. */
class StaleItem extends Error {
  constructor(id: string) {
    super(`KB item ${id} changed while it was processed`);
  }
}

const newest = (items: readonly KbItem[]) => [...items].reverse().slice(0, CANDIDATE_CAP);

const withEvidenceFrom = (into: KbItem, from: KbItem): KbItem => ({
  ...into,
  // A pending item may already carry near-duplicates of its own; they move with it.
  occurrenceCount: into.occurrenceCount + from.occurrenceCount,
  extraEvidence: [
    ...into.extraEvidence,
    { itemId: from.id, globIds: from.sourceGlobIds, evidence: from.evidence, submittedBy: from.submittedBy, at: from.createdAt },
    ...from.extraEvidence,
  ],
  sourceGlobIds: [...new Set([...into.sourceGlobIds, ...from.sourceGlobIds])],
  version: into.version + 1,
});

const targetLabel = (target: KbTarget) =>
  `${target.kind === 'doc' ? 'document' : 'agent file'} ${target.name}${target.section === null ? '' : `, section "${target.section}"`}`;

const describeItem = (item: KbItem) => {
  if (item.outcome?.kind === 'applied') return ` -> applied to ${item.outcome.name}`;
  return item.target === null ? '' : ` -> ${targetLabel(item.target)}`;
};

/**
 * The KB pipeline (spec, self-improvement processing): a background job claims each newly
 * submitted item and, with one Haiku call each, routes it to a document or agent file and
 * deduplicates it against open, approved and rejected items and the target's current text.
 * Nothing reaches the knowledge base here; it only prepares items for an admin's decision.
 */
export class KbPipeline {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      catalog: Catalog;
      notifier: Notifier;
      /** Haiku: routing and dedupe. */
      route: Llm;
      /** Sonnet: drafting (step 3). */
      draft: Llm;
    },
  ) {}

  /** Claims the oldest pending item and processes it; returns its ID, or null when none is due. */
  async processNext(): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = this.deps.clock.now();
      const next = await this.deps.store.transaction((tx) => tx.nextPendingKbItem(now));
      if (next === null) return null;
      const claimed = await this.claim(next.id);
      // Another worker took it first: look for the next one.
      if (claimed === null) continue;
      await this.run(claimed);
      return claimed.id;
    }
    return null;
  }

  /** Claims one item, if it is still open and pending, and processes it. Returns whether it ran. */
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
      if (item?.status !== 'open' || item.processing !== 'pending') return null;
      if (item.processAfter !== null && item.processAfter > now) return null;
      const claimed: KbItem = { ...item, processAfter: this.later(now, LEASE_MS), version: item.version + 1 };
      return (await tx.updateKbItem(claimed, item.version)) ? claimed : null;
    });
  }

  private async run(item: KbItem): Promise<void> {
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
    if ('failure' in decided) await this.fail(item, decided.failure);
    else await this.finish(item, () => Promise.resolve(decided));
  }

  /** The routing call, then the dedupe call against the routed target; a failure says why either went wrong. */
  private async ask(item: KbItem, snapshot: Snapshot): Promise<{ routing: Routing; dedupe: Dedupe } | { failure: string }> {
    try {
      const routing = parseRouting(
        await this.deps.route.complete({ system: ROUTE_SYSTEM, prompt: routePrompt(item, snapshot), maxTokens: 600 }),
        snapshot,
      );
      if (routing === null) return { failure: 'The routing answer was not usable JSON' };
      const targetText = currentText(routing.target, snapshot);
      const nothingToCompare =
        snapshot.open.length + snapshot.approved.length + snapshot.rejected.length === 0 && targetText === null;
      if (nothingToCompare) return { routing, dedupe: NO_MATCH };
      const dedupe = parseDedupe(
        await this.deps.route.complete({
          system: DEDUPE_SYSTEM,
          prompt: dedupePrompt(item, snapshot, routing.target, targetText),
          maxTokens: 800,
        }),
        snapshot,
        routing.target,
      );
      return dedupe === null ? { failure: 'The dedupe answer was not usable JSON' } : { routing, dedupe };
    } catch (error) {
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
        if (!(entry.kind === 'agent' || entry.kind === 'command' || entry.kind === 'claude_md')) continue;
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
      const others = (await tx.listKbItems(item.boardId)).filter((i) => i.id !== item.id && i.document === null);
      return {
        docs,
        agentFiles,
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
          processing: 'routed',
          processingError: null,
          processAfter: null,
          version: current.version + 1,
        };
        const addEvidence = async (id: string, status: 'open' | 'approved'): Promise<boolean> => {
          const other = await tx.getKbItem(id);
          if (other?.status !== status) return false;
          if (!(await tx.updateKbItem(withEvidenceFrom(other, current), other.version))) throw new StaleItem(id);
          return true;
        };
        if (dedupe.suppressedBy !== null) {
          next = { ...next, status: 'suppressed', suppressedBy: dedupe.suppressedBy };
        } else if (dedupe.duplicateOf !== null && (await addEvidence(dedupe.duplicateOf, 'open'))) {
          next = { ...next, status: 'merged', duplicateOf: dedupe.duplicateOf };
        } else if (
          dedupe.coveredBy !== null &&
          (dedupe.coveredBy.kind === 'knowledge' || (await addEvidence(dedupe.coveredBy.id, 'approved')))
        ) {
          next = { ...next, status: 'covered', coveredBy: dedupe.coveredBy };
        } else {
          next = { ...next, contradicts: dedupe.contradicts };
        }
        if (!(await tx.updateKbItem(next, current.version))) throw new StaleItem(item.id);
      });
    } catch (error) {
      // Decided or merged into meanwhile: a still-pending item is retried when its lease ends.
      if (error instanceof StaleItem) return;
      throw error;
    }
    this.deps.notifier.publish({ kind: 'board.changed', boardId: item.boardId });
  }

  /** Records a failed attempt: back off and retry, or give up after the last attempt (the item stays open). */
  private async fail(item: KbItem, reason: string): Promise<void> {
    const now = this.deps.clock.now();
    const message = reason.slice(0, 500);
    const failed = await this.deps.store.transaction(async (tx) => {
      const current = await tx.getKbItem(item.id);
      if (current?.version !== item.version) return false;
      const attempts = current.processingAttempts + 1;
      const last = attempts >= MAX_PROCESSING_ATTEMPTS;
      const next: KbItem = {
        ...current,
        processingAttempts: attempts,
        processingError: message,
        processing: last ? 'failed' : 'pending',
        processAfter: last ? null : this.later(now, backoffMs(attempts)),
        version: current.version + 1,
      };
      return (await tx.updateKbItem(next, current.version)) && last;
    });
    if (failed) this.deps.notifier.publish({ kind: 'board.changed', boardId: item.boardId });
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
  ].join('\n');

/** The current text where the item would go: its section, or the whole target (truncated); null for a new document. */
const currentText = (target: KbTarget, snapshot: Snapshot): string | null => {
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
  if (field(target, 'kind') === 'agent_file') {
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

/**
 * The dedupe answer, keeping only references to items it was shown (anything else is ignored
 * rather than failing the item); null when it isn't a JSON object.
 */
const parseDedupe = (answer: string, snapshot: Snapshot, target: KbTarget): Dedupe | null => {
  const parsed = parseJson(answer);
  if (!isObject(parsed)) return null;
  const idIn = (items: readonly KbItem[], value: unknown) => {
    const id = text(value)?.trim();
    return items.find((i) => i.id === id)?.id ?? null;
  };
  const covered = field(parsed, 'coveredBy');
  let coveredBy: KbCoverage | null = null;
  if (field(covered, 'kind') === 'target') {
    coveredBy = { kind: 'knowledge', knowledgeKind: target.kind, name: target.name, section: target.section };
  } else if (field(covered, 'kind') === 'item') {
    const id = idIn(snapshot.approved, field(covered, 'id'));
    if (id !== null) coveredBy = { kind: 'item', id };
  }
  const contradicts = list(field(parsed, 'contradicts')).flatMap((entry): KbContradiction[] => {
    const note = text(field(entry, 'note'))?.trim() ?? '';
    if (field(entry, 'kind') === 'target') {
      const heading = cleanSection(field(entry, 'ref'));
      return [{ kind: 'knowledge', ref: heading === null ? target.name : `${target.name} § ${heading}`, note }];
    }
    if (field(entry, 'kind') === 'item') {
      const id = idIn([...snapshot.open, ...snapshot.approved], field(entry, 'ref'));
      return id === null ? [] : [{ kind: 'item', ref: id, note }];
    }
    return [];
  });
  return {
    suppressedBy: idIn(snapshot.rejected, field(parsed, 'suppressedBy')),
    duplicateOf: idIn(snapshot.open, field(parsed, 'duplicateOf')),
    coveredBy,
    contradicts,
  };
};
