import { chunkDocument, contentHash } from '../domain/chunking.js';
import {
  decisionBody,
  decisionRef,
  decisionSourceLabel,
  decisionText,
  decisionTitle,
  isSuperseded,
  parseDecidedAt,
} from '../domain/decisions.js';
import type { Decision, DecisionSource, DecisionSourceKind } from '../domain/decisions.js';
import { inboxLink, inboxTitle } from '../domain/inbox.js';
import { LLM_WAITING_PREFIX } from '../domain/kb.js';
import { sameHeading, sectionText } from '../domain/sections.js';
import { MAX_QUERY_LENGTH } from '../domain/search.js';
import type { Candidate } from '../domain/search.js';
import type { Clock, Embedder, Notifier, Store, Tx } from '../ports.js';
import { LlmBusy, LlmUnavailable } from './intake-service.js';
import type { Llm } from './intake-service.js';
import { longEnoughQuote, verifiedQuote } from './kb-dedupe.js';
import { LLM_WAIT_MS, MAX_PROCESSING_ATTEMPTS } from './kb-pipeline.js';
import { BusyBackoff, busyMessage, completeWithDeadline } from './llm-call.js';
import { field, isObject, list, parseJson, text } from './llm-json.js';
import { hash } from './text-hash.js';

/** Haiku answers in seconds; a stalled call fails the attempt well inside the lease. */
export const DECISIONS_LLM_TIMEOUT_MS = 60_000;
/** How long a claimed source or decision is held before another worker may take it. */
const LEASE_MS = 2 * 60_000;
const backoffMs = (attempts: number) => 30_000 * 2 ** (attempts - 1);
/** A source yields at most this many decisions; the rest are dropped. */
export const MAX_DECISIONS_PER_SOURCE = 40;
/** How much of a source the extraction model sees. */
export const SOURCE_TEXT_LIMIT = 30_000;
const EXTRACT_MAX_TOKENS = 6_000;
const CHECK_MAX_TOKENS = 1_500;
/** The most earlier decisions one supersession check compares a new decision with. */
export const MAX_CANDIDATES = 6;
/** A semantically near decision must be at least this similar to be compared. */
export const VECTOR_MIN_RELEVANCE = 0.75;
const NEAR_POOL = 20;
/** Supersession's embedding is a bonus: a slow embedder only costs the semantic candidates. */
const EMBED_TIMEOUT_MS = 5_000;
const STATEMENT_LIMIT = 600;
const REASON_LIMIT = 300;
/** Attachments whose whole text is read for decisions (the answers people gave to the agent's questions). */
const DECISION_ATTACHMENTS = ['Clarifications', 'Assumptions'];

export const EXTRACT_SYSTEM = `You find the decisions a software team made, in the text of one project document. A decision is a choice that was actually made: an option picked, a rule adopted, a design settled. An option merely listed, a question, a task or a plan step is not a decision.

Respond with one JSON object and nothing else:
{"decisions": [{"statement": string, "quote": string, "decidedBy": string | null, "decidedAt": string | null}]}
- statement: the decision in one or two plain sentences.
- quote: a phrase copied word for word from the text that states the decision (a full clause, not a few words).
- decidedBy: who made it, only when the text says; otherwise null.
- decidedAt: the date it was made as YYYY-MM-DD, only when the text says; otherwise null.
Report only choices the text actually states. Don't invent decisions, reasons or people. No decisions: {"decisions": []}.`;

export const SUPERSEDE_SYSTEM = `You decide whether a new decision replaces earlier decisions of a software team. An earlier decision is replaced only when it is about the SAME subject as the new one (the same thing in the same place: the same feature, setting or component) and the new one contradicts or overrides it (a different choice for the same thing, a reversal, a changed rule). Decisions that merely share words or a topic, decisions about different things, a more general or more specific statement of the same rule, and related decisions that can both stand, are not replaced.

Respond with one JSON object and nothing else:
{"replaces": [{"id": number, "sameSubject": boolean, "oldQuote": string, "newQuote": string, "reason": string}]}
- id: the number of the earlier decision.
- sameSubject: true only when the earlier decision and the new one are about the same subject and the new one changes it; false when they only share words or a topic.
- oldQuote: words copied word for word from that earlier decision's text (its statement or its source quote) that the new decision contradicts or replaces.
- newQuote: words copied word for word from the new decision's text (its statement or its source quote) that does so.
- reason: one sentence.
Nothing replaced: {"replaces": []}.`;

const later = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();

const globLink = (boardId: number, globId: string) => `/boards/${String(boardId)}?glob=${encodeURIComponent(globId)}`;

const oneLine = (value: unknown, limit: number): string | null => {
  const line = (text(value)?.trim() ?? '').split(/\r?\n/)[0]?.trim() ?? '';
  return line === '' ? null : line.slice(0, limit);
};

/** What a decision is, before it is stored. */
interface Found {
  readonly statement: string;
  readonly quote: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string;
}

/** One text decisions come from, as the pipeline reads it now. */
interface SourceText {
  readonly ref: string;
  readonly kind: DecisionSourceKind;
  readonly label: string;
  readonly globId: string | null;
  readonly group: string | null;
  /** What the model is shown (a section or a whole text, cut to SOURCE_TEXT_LIMIT). */
  readonly text: string;
  readonly hash: string;
  readonly createdAt: string;
  readonly url: string;
}

/** The decisions the model found whose quote is in `shown` and long enough to rest on; `decidedAt` falls back to the source's date. */
const parseExtract = (answer: string, shown: string, fallbackAt: string): Found[] | null => {
  const parsed = parseJson(answer);
  if (!isObject(parsed) || !Array.isArray(field(parsed, 'decisions'))) return null;
  const seen = new Set<string>();
  const found: Found[] = [];
  for (const entry of list(field(parsed, 'decisions'))) {
    const quote = verifiedQuote(field(entry, 'quote'), shown);
    if (quote === null || !longEnoughQuote(quote)) continue;
    const key = quote.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const said = text(field(entry, 'statement'))?.trim() ?? '';
    found.push({
      statement: (said === '' ? quote : said).slice(0, STATEMENT_LIMIT),
      quote,
      decidedBy: oneLine(field(entry, 'decidedBy'), 100),
      decidedAt: parseDecidedAt(field(entry, 'decidedAt')) ?? fallbackAt,
    });
    if (found.length >= MAX_DECISIONS_PER_SOURCE) break;
  }
  return found;
};

interface Replacement {
  readonly old: Decision;
  readonly oldQuote: string;
  readonly newQuote: string;
  readonly reason: string;
  /** Both quotes were found verbatim and are long enough, and the model said the subject is the same. */
  readonly checked: boolean;
}

/** The replacements the model named among `candidates` (numbered from 1); an unknown number is ignored, null when the answer isn't usable. */
const parseReplaces = (answer: string, candidates: readonly Decision[], next: Decision): Replacement[] | null => {
  const parsed = parseJson(answer);
  if (!isObject(parsed) || !Array.isArray(field(parsed, 'replaces'))) return null;
  const out: Replacement[] = [];
  for (const entry of list(field(parsed, 'replaces'))) {
    const id = field(entry, 'id');
    const old = typeof id === 'number' && Number.isInteger(id) ? candidates[id - 1] : undefined;
    if (old === undefined || out.some((r) => r.old.id === old.id)) continue;
    const oldQuote = verifiedQuote(field(entry, 'oldQuote'), decisionBody(old));
    const newQuote = verifiedQuote(field(entry, 'newQuote'), decisionBody(next));
    const reason = oneLine(field(entry, 'reason'), REASON_LIMIT) ?? '';
    // Without the model's explicit same-subject classification a replacement is at most a proposal.
    const sameSubject = field(entry, 'sameSubject') === true;
    const checked = sameSubject && oldQuote !== null && newQuote !== null && longEnoughQuote(oldQuote) && longEnoughQuote(newQuote);
    out.push({
      old,
      oldQuote: oldQuote ?? oneLine(field(entry, 'oldQuote'), 500) ?? '',
      newQuote: newQuote ?? oneLine(field(entry, 'newQuote'), 500) ?? '',
      reason,
      checked,
    });
  }
  return out;
};

const checkPrompt = (next: Decision, candidates: readonly Decision[]): string =>
  [
    'New decision:',
    next.statement,
    `Source quote: "${next.quote}"`,
    '',
    'Earlier decisions:',
    ...candidates.map((c, i) =>
      [`[${String(i + 1)}] decided ${c.decidedAt.slice(0, 10)} (${c.sourceLabel})`, c.statement, `Source quote: "${c.quote}"`].join('\n'),
    ),
  ].join('\n');

/**
 * Whether a replacement of `old` by `next` may be applied without a person: both are in one glob, or the newer
 * decision's own text names the older one's glob. Otherwise two globs that only share words would supersede each other.
 */
const mayApply = (old: Decision, next: Decision): boolean => {
  if (old.globId === null) return false;
  if (old.globId === next.globId) return true;
  return new RegExp(`(?<![\\w-])${old.globId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(decisionBody(next));
};

/** Decisions from one source text (one artifact, attachment, inbox item or learning) state one author's intent at one moment: none replaces another. */
const sameSource = (a: Decision, b: Decision): boolean => a.sourceRef === b.sourceRef;

type Outcome<T> = { ok: T } | { failure: string } | { unavailable: LlmUnavailable };

/**
 * The decision pipeline (spec, Decisions and supersession): `syncBoard` finds the texts decisions come from (the
 * implementation record's `## Decisions`, plan.md, Clarifications and Assumptions, approved decision learnings) and
 * queues each new or changed one; `processNext` extracts one queued source with one Haiku call (a decision is kept only
 * when its quote is found verbatim in the text shown), else checks one new decision against earlier ones for a
 * replacement (applied only when both quotes check out, the model classes them as the same subject and, across globs, the new decision names the older glob; else only proposed; decisions of one source never replace each other). Claims, deadlines, retries and waiting
 * while the LLM is unavailable follow the findings pipeline.
 */
export class DecisionPipeline {
  private readonly busy = new BusyBackoff();

  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      /** Extraction and supersession checks (Haiku). */
      llm: Llm;
      /** Finds semantically near decisions for the supersession check; without it only keywords and the same glob or group are used. */
      embedder?: Embedder;
      /** Deadline for each call; defaults to DECISIONS_LLM_TIMEOUT_MS. */
      llmTimeoutMs?: number;
    },
  ) {}

  /** Brings every board's decision sources up to date; boards that fail don't stop the others (the first error is rethrown after). */
  async syncAll(): Promise<void> {
    const boards = await this.deps.store.transaction((tx) => tx.listAllBoards());
    let failure: Error | null = null;
    for (const board of boards) {
      try {
        await this.syncBoard(board.id);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failure !== null) throw failure;
  }

  /**
   * Finds a board's decision sources: queues each new or changed text for extraction, writes the decisions of
   * approved knowledge items (no model: a statement is its own quote), and removes the decisions of sources that are gone.
   */
  async syncBoard(boardId: number): Promise<{ queued: number; written: number; removed: number }> {
    const now = this.deps.clock.now();
    const result = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return { queued: 0, written: 0, removed: 0, globs: new Set<string>() };
      const sources = await this.discover(tx, boardId);
      const rows = new Map((await tx.listDecisionSources(boardId)).map((r) => [r.sourceRef, r]));
      const all = await tx.listDecisions(boardId);
      let queued = 0;
      for (const source of sources) {
        const row = rows.get(source.ref);
        if (row?.contentHash === source.hash) continue;
        await tx.upsertDecisionSource({
          boardId,
          sourceRef: source.ref,
          contentHash: source.hash,
          state: 'pending',
          attempts: 0,
          processAfter: null,
          lastError: null,
          globId: source.globId,
          updatedAt: now,
        });
        queued++;
      }
      const live = new Set(sources.map((s) => s.ref));
      const globs = new Set<string>();
      let written = 0;
      for (const item of await tx.listKbItems(boardId, 'approved')) {
        if (item.type !== 'decision' || item.document !== null || item.statement.trim() === '') continue;
        const ref = `learning:${item.id}`;
        live.add(ref);
        const quote = item.statement.trim();
        const outcome = await this.store(
          tx,
          boardId,
          {
            ref,
            kind: 'kb_item',
            label: '',
            globId: null,
            group: null,
            url: `/boards/${String(boardId)}/knowledge`,
          },
          // A long enough statement is its own quote; a short one still stands as a decision, it just can't back a supersession.
          [{ statement: quote.slice(0, STATEMENT_LIMIT), quote, decidedBy: item.decidedBy, decidedAt: item.decidedAt ?? item.createdAt }],
          now,
          all,
        );
        written += outcome.written;
      }
      for (const [ref] of rows) if (!live.has(ref)) await tx.deleteDecisionSource(boardId, ref);
      let removed = 0;
      for (const decision of all) {
        if (live.has(decision.sourceRef)) continue;
        await this.remove(tx, decision, all);
        removed++;
        if (decision.globId !== null) globs.add(decision.globId);
      }
      return { queued, written, removed, globs };
    });
    for (const globId of result.globs) this.deps.notifier.publish({ kind: 'glob.decisions', boardId, globId });
    return { queued: result.queued, written: result.written, removed: result.removed };
  }

  /** Extracts the oldest due source, else checks the oldest due decision; returns what it processed, or null when nothing is due. */
  async processNext(): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = await this.deps.store.transaction((tx) => tx.nextDecisionSourceToExtract(this.deps.clock.now()));
      if (next === null) break;
      const claimed = await this.claimSource(next);
      // Another worker took it first: look for the next one.
      if (claimed === null) continue;
      await this.extract(claimed);
      return `source:${claimed.sourceRef}`;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = await this.deps.store.transaction((tx) => tx.nextDecisionToCheck(this.deps.clock.now()));
      if (next === null) return null;
      const claimed = await this.claimDecision(next.id);
      if (claimed === null) continue;
      await this.check(claimed);
      return `check:${claimed.id}`;
    }
    return null;
  }

  /** The texts decisions are read from, as they are now (artifacts without a decisions section aren't sources). */
  private async discover(tx: Tx, boardId: number): Promise<SourceText[]> {
    const globs = new Map((await tx.listGlobs(boardId, {})).map((g) => [g.id, g]));
    const out: SourceText[] = [];
    for (const artifact of await tx.listLatestArtifacts(boardId)) {
      const glob = globs.get(artifact.globId);
      if (glob === undefined) continue;
      let kind: DecisionSourceKind;
      let body: string | null;
      if (artifact.kind === 'implementation_plan' || artifact.kind === 'postplan') {
        kind = 'implementation_plan';
        body = sectionText(artifact.content, 'Decisions');
      } else if (artifact.kind === 'plan') {
        kind = 'plan';
        body = artifact.content;
      } else if (artifact.kind === 'attachment' && DECISION_ATTACHMENTS.some((l) => sameHeading(l, artifact.label))) {
        kind = 'attachment';
        body = artifact.content;
      } else continue;
      const shown = (body ?? '').trim().slice(0, SOURCE_TEXT_LIMIT);
      if (shown === '') continue;
      out.push({
        ref: `artifact:${glob.id}:${artifact.kind}:${artifact.label}`,
        kind,
        label: artifact.label,
        globId: glob.id,
        group: glob.group,
        text: shown,
        hash: hash(shown),
        createdAt: artifact.createdAt,
        url: globLink(boardId, glob.id),
      });
    }
    // Attached inbox items are read on each glob they are on, so the glob's decisions show them.
    const links = await tx.listInboxLinks(boardId);
    for (const item of await tx.listInboxItems(boardId, ['attached'])) {
      const shown = item.text.trim().slice(0, SOURCE_TEXT_LIMIT);
      if (shown === '') continue;
      for (const link of links) {
        const glob = link.inboxId === item.id ? globs.get(link.globId) : undefined;
        if (glob === undefined) continue;
        out.push({
          ref: `inbox:${String(item.id)}:${glob.id}`,
          kind: 'inbox',
          label: inboxTitle(item),
          globId: glob.id,
          group: glob.group,
          text: shown,
          hash: hash(shown),
          // A decision without a date is taken on the day of the meeting.
          createdAt: item.occurredAt,
          url: inboxLink(boardId, item.id),
        });
      }
    }
    return out;
  }

  /** Takes a pending, due source, holding it for a lease; null when it changed or another worker took it. */
  private async claimSource(source: DecisionSource): Promise<DecisionSource | null> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const row = await tx.getDecisionSource(source.boardId, source.sourceRef);
      if (row?.state !== 'pending' || (row.processAfter !== null && row.processAfter > now)) return null;
      const claimed: DecisionSource = { ...row, processAfter: later(now, LEASE_MS) };
      await tx.upsertDecisionSource(claimed);
      return claimed;
    });
  }

  private async claimDecision(id: number): Promise<Decision | null> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const decision = await tx.getDecision(id);
      if (decision === null || decision.checkedAt !== null || (decision.processAfter !== null && decision.processAfter > now)) return null;
      const processAfter = later(now, LEASE_MS);
      await tx.updateDecision(id, { processAfter });
      return { ...decision, processAfter };
    });
  }

  private async extract(source: DecisionSource): Promise<void> {
    const found = await this.deps.store.transaction(async (tx) => {
      return (await this.discover(tx, source.boardId)).find((s) => s.ref === source.sourceRef) ?? null;
    });
    if (found === null) {
      // Its text is gone (or has no decisions section now): the next sync removes the rows.
      await this.deps.store.transaction((tx) => tx.deleteDecisionSource(source.boardId, source.sourceRef));
      return;
    }
    if (found.hash !== source.contentHash) {
      // Changed since it was queued: queue it as it is now and let the next step take it.
      await this.deps.store.transaction((tx) =>
        tx.upsertDecisionSource({ ...source, contentHash: found.hash, state: 'pending', attempts: 0, processAfter: null, lastError: null, updatedAt: this.deps.clock.now() }),
      );
      return;
    }
    const outcome = await this.ask(found);
    if ('unavailable' in outcome) {
      await this.waitSource(source, outcome.unavailable);
      return;
    }
    if ('failure' in outcome) {
      await this.failSource(source, outcome.failure);
      return;
    }
    const now = this.deps.clock.now();
    const decisions = outcome.ok;
    const globs = await this.deps.store.transaction(async (tx) => {
      const row = await tx.getDecisionSource(source.boardId, source.sourceRef);
      // Gone, or changed again while the model worked: drop the result (a changed source is queued again).
      if (row?.contentHash !== source.contentHash) return null;
      const written = await this.store(tx, source.boardId, found, decisions, now, await tx.listDecisions(source.boardId));
      await tx.upsertDecisionSource({ ...row, state: 'done', attempts: 0, processAfter: null, lastError: null, updatedAt: now });
      return written.changed ? new Set(found.globId === null ? [] : [found.globId]) : new Set<string>();
    });
    if (globs !== null) for (const globId of globs) this.deps.notifier.publish({ kind: 'glob.decisions', boardId: source.boardId, globId });
  }

  private async ask(source: SourceText): Promise<Outcome<Found[]>> {
    try {
      const answer = await completeWithDeadline(
        this.deps.llm,
        {
          system: EXTRACT_SYSTEM,
          prompt: `Document: ${source.label === '' ? source.ref : source.label}\n<<<\n${source.text}\n>>>`,
          maxTokens: EXTRACT_MAX_TOKENS,
        },
        this.deps.llmTimeoutMs ?? DECISIONS_LLM_TIMEOUT_MS,
      );
      const decisions = parseExtract(answer, source.text, source.createdAt);
      return decisions === null ? { failure: 'The decisions answer was not usable JSON' } : { ok: decisions };
    } catch (error) {
      if (error instanceof LlmUnavailable) return { unavailable: error };
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Writes what a source says as decisions, in the caller's transaction: each decision's knowledge item (keeping the
   * status and replacing item it already has) and row, and removes the source's decisions that it no longer states.
   * Nothing is written for a decision whose item is already up to date.
   */
  private async store(
    tx: Tx,
    boardId: number,
    source: Pick<SourceText, 'ref' | 'kind' | 'label' | 'globId' | 'group' | 'url'>,
    found: readonly Found[],
    now: string,
    /** The board's decisions, read once by the caller (a source's own rows are all this needs). */
    all: readonly Decision[],
  ): Promise<{ written: number; removed: number; changed: boolean }> {
    const sourceLabel = decisionSourceLabel(source.kind, source.globId, source.label);
    const keep = new Set<number>();
    let written = 0;
    for (const f of found) {
      const externalRef = decisionRef(source.ref, f.quote);
      const title = decisionTitle(f.statement);
      const body = decisionText(f);
      const globIds = source.globId === null ? [] : [source.globId];
      const input = { sourceType: 'decision', date: f.decidedAt, title, text: body } as const;
      const itemHash = hash([contentHash(input), globIds.join(','), source.group ?? '', source.url, sourceLabel].join('|'));
      const existing = await tx.getItemByRef(boardId, externalRef);
      if (existing?.contentHash === itemHash) {
        const row = all.find((d) => d.itemId === existing.id);
        if (row !== undefined) {
          keep.add(row.id);
          continue;
        }
      }
      await tx.replaceItem(
        {
          boardId,
          sourceType: 'decision',
          externalRef,
          title,
          occurredAt: f.decidedAt,
          authority: 'decision',
          // replaceItem overwrites these: a re-extracted decision keeps what a supersession set on it.
          status: existing?.status ?? 'active',
          supersededBy: existing?.supersededBy ?? null,
          globIds,
          globGroup: source.group,
          externalUrl: source.url,
          contentHash: itemHash,
          state: 'ready',
        },
        chunkDocument(input),
      );
      const item = await tx.getItemByRef(boardId, externalRef);
      if (item === null) throw new Error('Decision item write returned nothing');
      const row = await tx.upsertDecision({
        boardId,
        itemId: item.id,
        globId: source.globId,
        group: source.group,
        statement: f.statement,
        quote: f.quote,
        decidedBy: f.decidedBy,
        decidedAt: f.decidedAt,
        sourceKind: source.kind,
        sourceRef: source.ref,
        sourceLabel,
        sourceUrl: source.url,
        createdAt: now,
      });
      keep.add(row.id);
      written++;
    }
    let removed = 0;
    for (const d of all) {
      if (d.sourceRef !== source.ref || keep.has(d.id)) continue;
      await this.remove(tx, d, all);
      removed++;
    }
    return { written, removed, changed: written > 0 || removed > 0 };
  }

  /** Deletes a decision; older decisions it replaced stand again. */
  private async remove(tx: Tx, decision: Decision, all: readonly Decision[]): Promise<void> {
    for (const older of all) {
      if (older.replacedBy !== decision.id) continue;
      await tx.updateDecision(older.id, { replacedBy: null, replaceState: null, replaceOldQuote: null, replaceNewQuote: null, replaceReason: null });
      if (isSuperseded(older)) await tx.setItemSupersession(older.itemId, 'active', null);
    }
    await tx.deleteDecision(decision.id);
  }

  /** The earlier, still-standing decisions a new one may replace: semantically near ones first, then the same glob or group. */
  private async candidatesFor(next: Decision, embedding: readonly number[] | null): Promise<Decision[]> {
    // A superseded decision can't replace anything (and no replacement may close a cycle).
    if (isSuperseded(next)) return [];
    return this.deps.store.transaction(async (tx) => {
      const all = await tx.listDecisions(next.boardId);
      const byItem = new Map(all.map((d) => [d.itemId, d]));
      const eligible = (d: Decision | undefined): d is Decision =>
        d !== undefined && d.id !== next.id && !sameSource(d, next) && !isSuperseded(d) && d.decidedAt <= next.decidedAt;
      const query = { boardId: next.boardId, query: next.statement.slice(0, MAX_QUERY_LENGTH), mode: 'all_time', sourceTypes: ['decision'] } as const;
      const near: Candidate[] = [];
      if (embedding !== null) near.push(...(await tx.vectorCandidates(query, embedding, NEAR_POOL)).filter((c) => c.relevance >= VECTOR_MIN_RELEVANCE));
      near.push(...(await tx.keywordCandidates(query, NEAR_POOL)));
      const ordered: Decision[] = [];
      const add = (d: Decision | undefined) => {
        if (eligible(d) && !ordered.some((o) => o.id === d.id)) ordered.push(d);
      };
      for (const c of near) add(byItem.get(c.itemId));
      const sameScope = all
        .filter((d) => (next.globId !== null && d.globId === next.globId) || (next.group !== null && d.group === next.group))
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || b.id - a.id);
      for (const d of sameScope) add(d);
      return ordered.slice(0, MAX_CANDIDATES);
    });
  }

  /** The new decision's vector, or null (no embedder, or it failed: supersession then uses keywords and scope only). */
  private async embeddingOf(next: Decision): Promise<number[] | null> {
    if (this.deps.embedder === undefined) return null;
    try {
      const [vector] = await this.deps.embedder.embed([`${next.statement}\n${next.quote}`.slice(0, MAX_QUERY_LENGTH)], AbortSignal.timeout(EMBED_TIMEOUT_MS));
      return vector ?? null;
    } catch {
      return null;
    }
  }

  /** The supersession check of one new decision (claimed). */
  private async check(next: Decision): Promise<void> {
    const candidates = await this.candidatesFor(next, await this.embeddingOf(next));
    let replaces: Replacement[] = [];
    if (candidates.length > 0) {
      try {
        const answer = await completeWithDeadline(
          this.deps.llm,
          { system: SUPERSEDE_SYSTEM, prompt: checkPrompt(next, candidates), maxTokens: CHECK_MAX_TOKENS },
          this.deps.llmTimeoutMs ?? DECISIONS_LLM_TIMEOUT_MS,
        );
        const parsed = parseReplaces(answer, candidates, next);
        if (parsed === null) {
          await this.failCheck(next, 'The supersession answer was not usable JSON');
          return;
        }
        replaces = parsed;
      } catch (error) {
        if (error instanceof LlmUnavailable) await this.waitCheck(next, error);
        else await this.failCheck(next, error instanceof Error ? error.message : String(error));
        return;
      }
    }
    this.busy.clear(next.id);
    const now = this.deps.clock.now();
    const globs = await this.deps.store.transaction(async (tx) => {
      const current = await tx.getDecision(next.id);
      if (current === null) return null;
      const touched = new Set<string>();
      for (const r of replaces) {
        if (await this.applyReplacement(tx, current, r)) if (r.old.globId !== null) touched.add(r.old.globId);
      }
      await tx.updateDecision(next.id, { checkedAt: now, attempts: 0, processAfter: null, lastError: null });
      if (touched.size > 0 && current.globId !== null) touched.add(current.globId);
      return touched;
    });
    if (globs !== null) for (const globId of globs) this.deps.notifier.publish({ kind: 'glob.decisions', boardId: next.boardId, globId });
  }

  /** Records one replacement in the transaction (applied when it is checked and allowed by `mayApply`, else a proposal); false when nothing was written. */
  private async applyReplacement(tx: Tx, next: Decision, r: Replacement): Promise<boolean> {
    const old = await tx.getDecision(r.old.id);
    // Both sides are read again: either may have changed while the model worked.
    if (old === null || isSuperseded(old) || isSuperseded(next) || old.id === next.id || sameSource(old, next)) return false;
    // A person's undo for this pair stands, and a proposal the other way round would make a cycle.
    if (old.replaceState === 'undone' && old.replacedBy === next.id) return false;
    if (next.replacedBy === old.id && next.replaceState !== null && next.replaceState !== 'undone') return false;
    const fields = { replacedBy: next.id, replaceOldQuote: r.oldQuote, replaceNewQuote: r.newQuote, replaceReason: r.reason };
    if (r.checked && mayApply(old, next)) {
      await tx.updateDecision(old.id, { ...fields, replaceState: 'applied' });
      await tx.setItemSupersession(old.itemId, 'superseded', next.itemId);
      return true;
    }
    // A proposal doesn't replace one a person hasn't answered yet.
    if (old.replaceState === 'hint') return false;
    await tx.updateDecision(old.id, { ...fields, replaceState: 'hint' });
    return true;
  }

  private async writeSource(source: DecisionSource, next: (current: DecisionSource) => DecisionSource): Promise<void> {
    await this.deps.store.transaction(async (tx) => {
      const current = await tx.getDecisionSource(source.boardId, source.sourceRef);
      // Gone, or queued again with new text: this attempt's outcome doesn't apply.
      if (current?.contentHash !== source.contentHash) return;
      await tx.upsertDecisionSource(next(current));
    });
  }

  /** A failed extraction: back off and retry, or mark the source failed after the last attempt. */
  private async failSource(source: DecisionSource, reason: string): Promise<void> {
    const now = this.deps.clock.now();
    const attempts = source.attempts + 1;
    const last = attempts >= MAX_PROCESSING_ATTEMPTS;
    await this.writeSource(source, (current) => ({
      ...current,
      attempts,
      lastError: reason.slice(0, 500),
      state: last ? 'failed' : 'pending',
      processAfter: last ? null : later(now, backoffMs(attempts)),
      updatedAt: now,
    }));
  }

  /** The LLM can't be used: the source is tried again after a wait, and no attempt is counted. */
  private async waitSource(source: DecisionSource, unavailable: LlmUnavailable): Promise<void> {
    const wait = this.waitFor(source.sourceRef, unavailable);
    await this.writeSource(source, (current) => ({ ...current, lastError: wait.error, processAfter: wait.processAfter }));
  }

  private async failCheck(decision: Decision, reason: string): Promise<void> {
    const now = this.deps.clock.now();
    const attempts = decision.attempts + 1;
    const last = attempts >= MAX_PROCESSING_ATTEMPTS;
    // After the last attempt the decision counts as checked (with the reason kept) so it doesn't block the queue.
    await this.deps.store.transaction((tx) =>
      tx.updateDecision(decision.id, {
        attempts,
        lastError: reason.slice(0, 500),
        processAfter: last ? null : later(now, backoffMs(attempts)),
        ...(last ? { checkedAt: now } : {}),
      }),
    );
  }

  private async waitCheck(decision: Decision, unavailable: LlmUnavailable): Promise<void> {
    const wait = this.waitFor(decision.id, unavailable);
    await this.deps.store.transaction((tx) => tx.updateDecision(decision.id, { lastError: wait.error, processAfter: wait.processAfter }));
  }

  /** When and why an unusable LLM releases an item: a minute for `LlmUnavailable`, a growing, jittered wait for `LlmBusy`. */
  private waitFor(key: number | string, unavailable: LlmUnavailable): { error: string; processAfter: string } {
    const processAfter = later(this.deps.clock.now(), unavailable instanceof LlmBusy ? this.busy.next(key) : LLM_WAIT_MS);
    const error = unavailable instanceof LlmBusy ? busyMessage(processAfter) : `${LLM_WAITING_PREFIX}${unavailable.reason}`;
    return { error: error.slice(0, 500), processAfter };
  }
}
