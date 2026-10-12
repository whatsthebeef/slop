import { decisionOf, isAccepted, scopeLabel } from '../domain/decision-glob.js';
import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { knowledgePageEffect } from '../domain/events.js';
import type { EffectOutcome, RetryLater } from '../domain/events.js';
import { LLM_WAITING_PREFIX } from '../domain/kb.js';
import { agentSetKind, parseFrontmatter } from '../domain/knowledge.js';
import {
  KNOWLEDGE_PAGE_CHANGES_DAYS,
  KNOWLEDGE_PAGE_CHANGES_MAX,
  KNOWLEDGE_PAGE_DECISIONS_MAX,
  KNOWLEDGE_PAGE_PROMPT_VERSION,
} from '../domain/knowledge-page.js';
import type {
  KnowledgePageAgent,
  KnowledgePageBasis,
  KnowledgePageChange,
  KnowledgePageChanged,
  KnowledgePageDecisionGroup,
  KnowledgePageReason,
  KnowledgePageVersion,
  KnowledgePageView,
} from '../domain/knowledge-page.js';
import type { LlmSpendSource } from '../domain/spend.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Notifier, Store, Tx } from '../ports.js';
import { adminOf, memberOf } from './access.js';
import { LlmBusy, LlmUnavailable } from './intake-service.js';
import type { Llm } from './intake-service.js';
import { LLM_TIMEOUT_MS } from './kb-pipeline.js';
import type { KnowledgeService } from './knowledge-service.js';
import { BusyBackoff, busyMessage, completeWithDeadline } from './llm-call.js';
import { field, isObject, list, parseJson, text } from './llm-json.js';
import type { SpendService } from './spend-service.js';
import { hash } from './text-hash.js';

/** The ledger's source for the page's model calls. */
export const KNOWLEDGE_PAGE_SPEND_SOURCE: LlmSpendSource = 'knowledge_page';
/** How many versions the history lists. */
export const KNOWLEDGE_PAGE_HISTORY_MAX = 100;
/** Why a regeneration that came too soon waits (the job's last error). */
export const KNOWLEDGE_PAGE_WAIT_REASON = 'Waiting for the minimum interval between regenerations';
/** Enough for the whole decisions section of a full rebuild. */
const ANSWER_MAX_TOKENS = 6_000;
/** A decision's statement and rationale are cut to this many characters in the prompt, so one call stays small. */
const STATEMENT_MAX = 400;
const RATIONALE_MAX = 300;
const LLM_WAIT_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export const KNOWLEDGE_PAGE_SYSTEM = `You keep one section of a software project's knowledge page: the decisions in force, grouped by area. You are given the previous version of the section (JSON), the decisions that are new or changed since (one JSON object per line), and the IDs of decisions that are no longer in force.

Rules:
- Return the whole updated section. Keep the previous section's wording for entries the change does not touch, and keep its areas.
- Each entry states one rule or choice in a plain sentence ("text"), why it was decided in a short phrase ("rationale", empty when unknown), and the IDs of the decisions behind it ("globIds"). Merge decisions that say the same thing into one entry.
- Every decision that is new or changed, and every decision the previous section covers that is still in force, must be behind exactly one entry. Never use an ID you were not given. Drop a decision that is no longer in force from its entry; drop the entry when none are left.
- Never write a decision's ID in "text" or "rationale": the page links them from "globIds".
- Group under short area names a reader would look for (for example "Testing", "Deploys"). Reuse the previous section's names.

Respond with one JSON object and nothing else:
{"groups": [{"area": string, "entries": [{"text": string, "rationale": string, "globIds": [string]}]}]}`;

/** A decision in force, with what the page remembers about it. */
interface InForce {
  readonly glob: Glob;
  readonly fingerprint: string;
  readonly at: string;
}

/** Everything a regeneration reads of the board's data. */
interface Facts {
  readonly decisions: readonly InForce[];
  readonly changes: readonly KnowledgePageChange[];
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 3)}...` : value);
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sameRecord = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** What the decisions section says about a decision: any change to it makes the decision "changed" for the delta. */
const fingerprintOf = (glob: Glob): string => {
  const d = decisionOf(glob);
  return hash(
    [glob.title, glob.summary, d === null ? '' : scopeLabel(d.scope), d?.outcome?.kind ?? '', d?.outcome?.reason ?? '', d?.outcome?.at ?? ''].join('\u0000'),
  );
};

/** A decision as the prompt shows it: one JSON object. */
const promptLine = (d: InForce): string => {
  const attributes = decisionOf(d.glob);
  return JSON.stringify({
    id: d.glob.id,
    title: d.glob.title,
    statement: clip(oneLine(d.glob.summary), STATEMENT_MAX),
    rationale: clip(oneLine(attributes?.outcome?.reason ?? ''), RATIONALE_MAX),
    scope: attributes === null ? null : scopeLabel(attributes.scope),
    area: d.glob.group ?? attributes?.target?.routed?.name ?? null,
  });
};

const nameOf = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/i, '');

/**
 * Reads the model's answer as the decisions section. Ids it was not given are stripped, an entry with none left is
 * dropped, and an answer that leaves a decision that must be covered out is refused (thrown: the job is retried).
 */
export const parseDecisionGroups = (answer: string, allowed: ReadonlySet<string>, required: ReadonlySet<string>): KnowledgePageDecisionGroup[] => {
  const parsed = parseJson(answer);
  const groups = field(parsed, 'groups');
  if (!Array.isArray(groups)) throw new Error('The model did not answer with a list of groups');
  const out: KnowledgePageDecisionGroup[] = [];
  const covered = new Set<string>();
  for (const group of groups) {
    if (!isObject(group)) continue;
    const area = (text(field(group, 'area')) ?? '').trim() || 'General';
    const entries: { text: string; rationale: string; globIds: string[] }[] = [];
    for (const entry of list(field(group, 'entries'))) {
      const body = (text(field(entry, 'text')) ?? '').trim();
      const globIds = [...new Set(list(field(entry, 'globIds')).flatMap((id) => (typeof id === 'string' && allowed.has(id) ? [id] : [])))];
      if (body === '' || globIds.length === 0) continue;
      for (const id of globIds) covered.add(id);
      entries.push({ text: body, rationale: (text(field(entry, 'rationale')) ?? '').trim(), globIds });
    }
    if (entries.length > 0) out.push({ area, entries });
  }
  const missing = [...required].filter((id) => !covered.has(id));
  if (missing.length > 0) throw new Error(`The model left decisions out of the section: ${missing.slice(0, 5).join(', ')}`);
  return out;
};

export interface KnowledgePageDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly notifier: Notifier;
  /** Writes the decisions section; called at most once per regeneration. */
  readonly llm: Llm;
  /** The model behind `llm`, for the spend ledger. */
  readonly model: string;
  readonly spend: Pick<SpendService, 'record'>;
  /** The board's agent set as served (the files and their version). */
  readonly knowledge: Pick<KnowledgeService, 'agentSetForDownload'>;
  /** Deadline for the model call; defaults to LLM_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/**
 * The board's generated knowledge page. A regeneration (the `regenerate_knowledge_page` job) builds the agents and
 * recent-changes sections from the board's data and asks the model only about the decisions that are new, changed or no
 * longer in force, giving it the previous decisions section and nothing else of the board. It writes a version only
 * when what the page is built from changed, and no more often than the board's interval unless an admin asks for a
 * rebuild.
 */
export class KnowledgePageService {
  private readonly busy = new BusyBackoff();

  constructor(private readonly deps: KnowledgePageDeps) {}

  /** The current version, the history and whether a regeneration waits. Members read it. */
  async view(email: string, boardId: number): Promise<Result<KnowledgePageView>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${String(boardId)}`);
      const current = await tx.latestKnowledgePageVersion(boardId);
      const history = await tx.listKnowledgePageVersions(boardId, KNOWLEDGE_PAGE_HISTORY_MAX);
      const [job] = await tx.latestOutboxJobs([knowledgePageEffect(boardId).globId], ['regenerate_knowledge_page']);
      const pending = job?.state === 'pending';
      const next = current === null ? null : new Date(Date.parse(current.createdAt) + board.knowledgePageIntervalMinutes * 60_000).toISOString();
      return ok({ current, history, nextRegenerationAt: pending ? next : null, pending });
    });
  }

  /** One earlier (or the current) version. Members read it. */
  async version(email: string, boardId: number, version: number): Promise<Result<KnowledgePageVersion>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const found = await tx.getKnowledgePageVersion(boardId, version);
      return found === null ? notFound(`No version ${String(version)} of board ${String(boardId)}'s knowledge page`) : ok(found);
    });
  }

  /** Admins ask for a full rebuild: it ignores the minimum interval and rewrites every section. */
  async requestRebuild(email: string, boardId: number): Promise<Result<{ queued: true }>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${String(boardId)}`);
      await tx.enqueueEffects([knowledgePageEffect(boardId, true)]);
      return ok({ queued: true as const });
    });
  }

  /**
   * The job: writes the next version, or nothing when it is too soon (`RetryLater` for the rest of the interval) or when
   * nothing the page is built from changed. A thrown error (a model answer that can't be used) spends an attempt.
   */
  async regenerate(boardId: number, full: boolean): Promise<EffectOutcome> {
    const now = this.deps.clock.now();
    const start = await this.deps.store.transaction(async (tx) => ({ board: await tx.getBoard(boardId), last: await tx.latestKnowledgePageVersion(boardId) }));
    const { board, last } = start;
    if (board === null) return 'dropped';
    if (last !== null && !full) {
      const remaining = Date.parse(last.createdAt) + board.knowledgePageIntervalMinutes * 60_000 - Date.parse(now);
      if (remaining > 0) return { state: 'pending', retryAfterMs: remaining, reason: KNOWLEDGE_PAGE_WAIT_REASON };
    }
    const set = await this.deps.knowledge.agentSetForDownload(boardId);
    if (!set.ok) return 'dropped';
    const facts = await this.deps.store.transaction((tx) => this.gather(tx, boardId, now));

    const previous = last?.basis ?? null;
    const agentSetVersion = set.value.version;
    const files = set.value.files.flatMap((f) => {
      const kind = agentSetKind(f.path);
      return kind === 'agent' || kind === 'command' ? [{ path: f.path, kind, content: f.content }] : [];
    });
    const agents = this.agentsOf(files, previous, agentSetVersion, facts.decisions);
    const bumps = this.bumpsOf(previous, agentSetVersion, now, agents.changedPaths);
    const changes = this.changesOf(facts.changes, bumps);
    const basis: KnowledgePageBasis = {
      agentSetVersion,
      agentsHash: hash(set.value.files.map((f) => `${f.path}\u0000${hash(f.content)}`).join('\u0001')),
      agentSeen: agents.seen,
      decisions: Object.fromEntries(facts.decisions.map((d) => [d.glob.id, d.fingerprint])),
      changesHash: hash(JSON.stringify(changes)),
      promptVersion: KNOWLEDGE_PAGE_PROMPT_VERSION,
      agentSetBumps: bumps,
    };
    if (
      last !== null &&
      !full &&
      previous !== null &&
      previous.promptVersion === basis.promptVersion &&
      previous.agentSetVersion === basis.agentSetVersion &&
      previous.agentsHash === basis.agentsHash &&
      previous.changesHash === basis.changesHash &&
      sameRecord(previous.decisions, basis.decisions)
    ) {
      return 'done';
    }

    const reason: KnowledgePageReason = last === null ? 'first' : full ? 'rebuild' : previous?.promptVersion !== basis.promptVersion ? 'prompt' : 'delta';
    const rebuildDecisions = last === null || full || reason === 'prompt';
    let section: Awaited<ReturnType<KnowledgePageService['decisionsSection']>>;
    try {
      section = await this.decisionsSection(rebuildDecisions ? null : last, facts.decisions);
    } catch (error) {
      if (error instanceof LlmUnavailable) return this.waitFor(boardId, error);
      throw error;
    }
    this.busy.clear(boardId);

    const { groups: decisions, changed: decisionsChanged, usage } = section;
    const sections = { agents: agents.agents, decisions, changes };
    const changed: KnowledgePageChanged = {
      agents: last === null || JSON.stringify(last.sections.agents) !== JSON.stringify(agents.agents),
      decisions: last === null || decisionsChanged,
      changes: last === null || JSON.stringify(last.sections.changes) !== JSON.stringify(changes),
    };
    const next: KnowledgePageVersion = { boardId, version: (last?.version ?? 0) + 1, createdAt: now, reason, sections, changed, basis };
    const written = await this.deps.store.transaction(async (tx) => {
      // Another regeneration may have written meanwhile (a claim that outlived its lease): this one is stale.
      if ((await tx.latestKnowledgePageVersion(boardId))?.version !== last?.version) return false;
      return tx.insertKnowledgePageVersion(next);
    });
    if (!written) return { state: 'pending', retryAfterMs: 1_000 };
    if (usage !== null) {
      await this.deps.spend.record({
        boardId,
        globId: null,
        source: KNOWLEDGE_PAGE_SPEND_SOURCE,
        model: this.deps.model,
        inputTokens: usage.input,
        outputTokens: usage.output,
        ref: String(next.version),
      });
    }
    this.deps.notifier.publish({ kind: 'board.kb', boardId });
    return 'done';
  }

  /** The decisions in force and the recent changes, read in one transaction. */
  private async gather(tx: Tx, boardId: number, now: string): Promise<Facts> {
    const [globs, decisionRows] = await Promise.all([tx.listGlobs(boardId, { include: 'decisions' }), tx.listDecisions(boardId)]);
    // A decision glob taken from an extracted decision stops being in force when a newer decision replaced it.
    const replaced = new Set(decisionRows.filter((d) => d.replaceState === 'applied' || d.replaceState === 'confirmed').map((d) => d.id));
    const decisions = globs
      .filter(isAccepted)
      .flatMap((glob): InForce[] => {
        const origin = decisionOf(glob)?.origin;
        const superseded = origin?.kind === 'extracted' && replaced.has(origin.decisionId);
        return superseded ? [] : [{ glob, fingerprint: fingerprintOf(glob), at: decisionOf(glob)?.outcome?.at ?? glob.updatedAt }];
      })
      .sort((a, b) => b.at.localeCompare(a.at) || a.glob.id.localeCompare(b.glob.id))
      .slice(0, KNOWLEDGE_PAGE_DECISIONS_MAX);

    const since = new Date(Date.parse(now) - KNOWLEDGE_PAGE_CHANGES_DAYS * DAY_MS).toISOString();
    const events = await tx.listBoardEvents(boardId, since, ['StatusChanged', 'DecisionDecided']);
    const globsById = new Map((await tx.getGlobs([...new Set(events.map((e) => e.globId))])).map((g) => [g.id, g]));
    const seen = new Map<string, KnowledgePageChange>();
    for (const e of events) {
      const glob = globsById.get(e.globId);
      if (glob === undefined) continue;
      if (e.type === 'DecisionDecided') {
        const kind = text(field(e.data['outcome'], 'kind'));
        if (kind !== 'accept' && kind !== 'accept_with_edits') continue;
        const reasonText = text(field(e.data['outcome'], 'reason'))?.trim();
        const why = reasonText !== undefined && reasonText !== '' ? reasonText : oneLine(glob.summary) || null;
        seen.set(`decision:${glob.id}`, { at: e.at, kind: 'decision', text: glob.title, why: why === null ? null : clip(why, STATEMENT_MAX), globId: glob.id });
      } else if (e.data['to'] === 'signed_off' && glob.category !== 'decision') {
        // No model call: the glob's own summary says why (a merged change's generated summary is not read here).
        const why = oneLine(glob.summary);
        seen.set(`work:${glob.id}`, { at: e.at, kind: 'work', text: glob.title, why: why === '' ? null : clip(why, STATEMENT_MAX), globId: glob.id });
      }
    }
    return { decisions, changes: [...seen.values()] };
  }

  /** The agent-set versions this page has observed, with the newly observed one stamped now. */
  private bumpsOf(
    previous: KnowledgePageBasis | null,
    agentSetVersion: number,
    now: string,
    changedPaths: readonly string[],
  ): KnowledgePageBasis['agentSetBumps'] {
    const bumps = previous?.agentSetBumps ?? [];
    const moved = previous !== null && agentSetVersion > previous.agentSetVersion;
    return (moved ? [...bumps, { version: agentSetVersion, at: now, changedPaths }] : bumps).slice(-KNOWLEDGE_PAGE_CHANGES_MAX);
  }

  /** The agents and commands, read from their files; `changedInAgentSet` is the version at which the page first saw the text. */
  private agentsOf(
    files: readonly { path: string; kind: 'agent' | 'command'; content: string }[],
    previous: KnowledgePageBasis | null,
    agentSetVersion: number,
    decisions: readonly InForce[],
  ): { agents: KnowledgePageAgent[]; seen: KnowledgePageBasis['agentSeen']; changedPaths: string[] } {
    const seen: Record<string, { hash: string; since: number | null }> = {};
    const changedPaths: string[] = [];
    const agents = files.map((f): KnowledgePageAgent => {
      const fileHash = hash(f.content);
      const before = previous?.agentSeen[f.path];
      // Unchanged text keeps when it was first seen; new or edited text on a later version is stamped with this one.
      const since = before?.hash === fileHash ? before.since : previous === null ? null : agentSetVersion;
      if (previous !== null && before?.hash !== fileHash) changedPaths.push(f.path);
      seen[f.path] = { hash: fileHash, since };
      const target = decisions
        .filter((d) => decisionOf(d.glob)?.target?.routed?.name === f.path)
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      return {
        path: f.path,
        kind: f.kind,
        name: nameOf(f.path),
        description: oneLine(parseFrontmatter(f.content).description),
        hash: fileHash,
        changedInAgentSet: since,
        decisionGlobId: target?.glob.id ?? null,
      };
    });
    return { agents, seen, changedPaths };
  }

  /** The recent changes: decisions accepted and work signed off, with each observed agent-set version, newest first. */
  private changesOf(events: readonly KnowledgePageChange[], bumps: KnowledgePageBasis['agentSetBumps']): KnowledgePageChange[] {
    const sets = bumps.map(
      (b): KnowledgePageChange => ({
        at: b.at,
        kind: 'agent_set',
        text: `Agent set updated to version ${String(b.version)}`,
        why: b.changedPaths.length > 0 ? `Changed: ${b.changedPaths.join(', ')}` : null,
        globId: null,
        agentSetVersion: b.version,
      }),
    );
    return [...events, ...sets]
      .sort((a, b) => b.at.localeCompare(a.at) || (a.globId ?? '').localeCompare(b.globId ?? '') || a.kind.localeCompare(b.kind))
      .slice(0, KNOWLEDGE_PAGE_CHANGES_MAX);
  }

  /**
   * The decisions section. `previous` null writes it whole from every decision in force; otherwise only the decisions
   * that are new, changed or gone reach the model, with the previous section. No model call when none did.
   */
  private async decisionsSection(
    previous: KnowledgePageVersion | null,
    inForce: readonly InForce[],
  ): Promise<{ groups: readonly KnowledgePageDecisionGroup[]; changed: boolean; usage: { input: number; output: number } | null }> {
    if (previous === null && inForce.length === 0) return { groups: [], changed: true, usage: null };
    const before = previous?.basis.decisions ?? {};
    const current = new Map(inForce.map((d) => [d.glob.id, d]));
    const changedNow = inForce.filter((d) => before[d.glob.id] !== d.fingerprint);
    const removed = Object.keys(before).filter((id) => !current.has(id));
    const kept = previous?.sections.decisions ?? [];
    if (previous !== null && changedNow.length === 0 && removed.length === 0) return { groups: kept, changed: false, usage: null };

    // Entries whose decisions all left force are dropped without asking: there is nothing left to word.
    const gone = new Set(removed);
    if (previous !== null && changedNow.length === 0) {
      const affected = kept.flatMap((g) => g.entries).filter((e) => e.globIds.some((id) => gone.has(id)));
      if (affected.every((e) => e.globIds.every((id) => gone.has(id)))) {
        const groups = kept
          .map((g) => ({ area: g.area, entries: g.entries.filter((e) => !e.globIds.every((id) => gone.has(id))) }))
          .filter((g) => g.entries.length > 0);
        return { groups, changed: true, usage: null };
      }
    }

    const prompt = [
      'Previous section (JSON):',
      JSON.stringify({ groups: previous === null ? [] : kept.map((g) => ({ area: g.area, entries: g.entries.map((e) => ({ text: e.text, rationale: e.rationale, globIds: e.globIds })) })) }),
      '',
      previous === null ? 'There is no previous section: write it whole from these decisions.' : 'New or changed decisions (one JSON object per line):',
      ...(previous === null ? inForce : changedNow).map(promptLine),
      '',
      removed.length === 0 ? 'No decision left force.' : `No longer in force: ${removed.join(', ')}`,
    ].join('\n');
    const answer = await completeWithDeadline(this.deps.llm, { system: KNOWLEDGE_PAGE_SYSTEM, prompt, maxTokens: ANSWER_MAX_TOKENS }, this.deps.timeoutMs ?? LLM_TIMEOUT_MS);

    const allowed = new Set(current.keys());
    const covered = new Set(kept.flatMap((g) => g.entries.flatMap((e) => e.globIds)));
    // Everything in force that the previous section covered or that changed must be behind an entry.
    const required = new Set(inForce.filter((d) => previous === null || covered.has(d.glob.id) || before[d.glob.id] !== d.fingerprint).map((d) => d.glob.id));
    const groups = parseDecisionGroups(answer, allowed, required);
    // Tokens as characters over four: the adapter's usage isn't passed up through the `Llm` port.
    return { groups, changed: true, usage: { input: Math.ceil((KNOWLEDGE_PAGE_SYSTEM.length + prompt.length) / 4), output: Math.ceil(answer.length / 4) } };
  }

  /** The model can't be used: run again later without spending an attempt (busy: after a growing delay). */
  private waitFor(boardId: number, unavailable: LlmUnavailable): RetryLater {
    const ms = unavailable instanceof LlmBusy ? this.busy.next(boardId) : LLM_WAIT_MS;
    const retryAt = new Date(Date.parse(this.deps.clock.now()) + ms).toISOString();
    const reason = (unavailable instanceof LlmBusy ? busyMessage(retryAt) : `${LLM_WAITING_PREFIX}${unavailable.reason}`).slice(0, 500);
    return { state: 'pending', retryAfterMs: ms, reason };
  }
}
