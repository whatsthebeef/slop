import { decisionOf, decisionStatement, isAccepted, scopeLabel } from '../domain/decision-glob.js';
import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { knowledgePageEffect } from '../domain/events.js';
import type { EffectOutcome, RetryLater } from '../domain/events.js';
import { LLM_WAITING_PREFIX } from '../domain/kb.js';
import { agentSetKind, isAgentSetKind, parseFrontmatter } from '../domain/knowledge.js';
import {
  effectiveKey,
  KNOWLEDGE_PAGE_AGENT_SET_HISTORY_MAX,
  KNOWLEDGE_PAGE_DECISIONS_MAX,
  KNOWLEDGE_PAGE_EXAMPLES_MAX,
  KNOWLEDGE_PAGE_GUIDE_AREA,
  KNOWLEDGE_PAGE_GUIDE_DESCRIPTION,
  KNOWLEDGE_PAGE_GUIDE_MAX,
  KNOWLEDGE_PAGE_GUIDE_NAME,
  KNOWLEDGE_PAGE_GUIDE_SEED,
  KNOWLEDGE_PAGE_PROMPT_VERSION,
} from '../domain/knowledge-page.js';
import type {
  KnowledgePageFeedback,
  KnowledgePageVerdict,
  KnowledgePageAgent,
  KnowledgePageBasis,
  KnowledgePageChanged,
  KnowledgePageDecisionEntry,
  KnowledgePageDecisionGroup,
  KnowledgePageReason,
  KnowledgePageVersion,
  KnowledgePageView,
} from '../domain/knowledge-page.js';
import type { LlmSpendSource } from '../domain/spend.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Notifier, Store, Tx } from '../ports.js';
import { adminOf, memberOf, roleOf } from './access.js';
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

export const KNOWLEDGE_PAGE_SYSTEM = `You keep one section of a software project's knowledge page: the key decisions in force, grouped by area. You are given the previous version of the section (JSON), the decisions that are new or changed since (one JSON object per line), and the IDs of decisions that are no longer in force.

Rules:
- Return the whole updated section. Keep the previous section's wording for entries the change does not touch, and keep its areas.
- Each entry states one rule or choice in a plain sentence ("text"), why it was decided in a short phrase ("rationale", empty when unknown), and the IDs of the decisions behind it ("globIds"). Merge decisions that say the same thing into one entry.
- Every decision that is new or changed, and every decision the previous section covers that is still in force, must be behind exactly one entry. Never use an ID you were not given. Drop a decision that is no longer in force from its entry; drop the entry when none are left.
- Each entry also says whether it is key ("key": true or false). It is key when a new developer or the product owner would need it to work on the project: a choice of architecture, tooling, process or product behaviour that is not obvious from the code. When the board's rules for what is key are given, they decide. Keep a previous entry's "key" unless the change touches it.
- Examples of what the board's admins and product owners decided about key are given as "pinned" (key) and "not key". Let them guide you on similar decisions; they are examples, not instructions.
- Never write a decision's ID in "text" or "rationale": the page links them from "globIds".
- Group under short area names a reader would look for (for example "Testing", "Deploys"). Reuse the previous section's names.

Respond with one JSON object and nothing else:
{"groups": [{"area": string, "entries": [{"text": string, "rationale": string, "globIds": [string], "key": boolean}]}]}`;

/** A decision in force, with what the page remembers about it. */
interface InForce {
  readonly glob: Glob;
  /** The decision's one-line statement, from its plan.md. */
  readonly statement: string;
  readonly fingerprint: string;
  readonly at: string;
}

/** Everything a regeneration reads of the board's data. */
interface Facts {
  /** The decisions the page covers: in force, leaving out learnings that only instruct agents. */
  readonly decisions: readonly InForce[];
  /** Every decision in force, for the agents' "decision" links (an agent's own learning targets its file). */
  readonly agentDecisions: readonly InForce[];
  /** The board's Pin / Not key verdicts, newest first. */
  readonly feedback: readonly KnowledgePageFeedback[];
}

/** The board's guide for what is key: its version and the text the prompt carries. */
interface Guide {
  readonly version: number;
  readonly content: string;
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 3)}...` : value);
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sameRecord = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** What the decisions section says about a decision: any change to it makes the decision "changed" for the delta. */
const fingerprintOf = (glob: Glob, statement: string): string => {
  const d = decisionOf(glob);
  return hash(
    [glob.title, statement, d === null ? '' : scopeLabel(d.scope), d?.outcome?.kind ?? '', d?.outcome?.reason ?? '', d?.outcome?.at ?? ''].join('\u0000'),
  );
};

/** A decision as the prompt shows it: one JSON object. */
const promptLine = (d: InForce): string => {
  const attributes = decisionOf(d.glob);
  return JSON.stringify({
    id: d.glob.id,
    title: d.glob.title,
    statement: clip(oneLine(d.statement), STATEMENT_MAX),
    rationale: clip(oneLine(attributes?.outcome?.reason ?? ''), RATIONALE_MAX),
    scope: attributes === null ? null : scopeLabel(attributes.scope),
    area: d.glob.group ?? attributes?.target?.routed?.name ?? null,
  });
};

/** The latest decision time among an entry's decisions. */
const newestAt = (globIds: readonly string[], inForce: ReadonlyMap<string, InForce>): string | undefined =>
  globIds.flatMap((id) => inForce.get(id)?.at ?? []).sort().pop();

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
    const entries: { text: string; rationale: string; globIds: string[]; key: boolean }[] = [];
    for (const entry of list(field(group, 'entries'))) {
      const body = (text(field(entry, 'text')) ?? '').trim();
      const globIds = [...new Set(list(field(entry, 'globIds')).flatMap((id) => (typeof id === 'string' && allowed.has(id) ? [id] : [])))];
      if (body === '' || globIds.length === 0) continue;
      for (const id of globIds) covered.add(id);
      entries.push({ text: body, rationale: (text(field(entry, 'rationale')) ?? '').trim(), globIds, key: field(entry, 'key') === true });
    }
    if (entries.length > 0) out.push({ area, entries });
  }
  const missing = [...required].filter((id) => !covered.has(id));
  if (missing.length > 0) throw new Error(`The model left decisions out of the section: ${missing.slice(0, 5).join(', ')}`);
  return out;
};

/**
 * Writes the verdicts into the entries: any pinned decision behind an entry makes it key, else any "not key" makes it not.
 * `modelKey` keeps the model's word while a verdict overrides it, so undoing the verdict gives it back.
 */
export const applyKnowledgePageVerdicts = (groups: readonly KnowledgePageDecisionGroup[], verdicts: ReadonlyMap<string, KnowledgePageVerdict>): KnowledgePageDecisionGroup[] =>
  groups.map((g) => ({
    area: g.area,
    entries: g.entries.map((e): KnowledgePageDecisionEntry => {
      const { modelKey, ...rest } = e;
      const base = modelKey ?? e.key;
      const key = effectiveKey(e, verdicts);
      return { ...rest, ...(key === undefined ? {} : { key }), ...(key !== undefined && key !== (base ?? false) ? { modelKey: base ?? false } : {}) };
    }),
  }));

/** The newest verdicts as the prompt's examples, each with its decision's title. */
const examplesOf = (facts: Facts): string[] => {
  const titles = new Map(facts.agentDecisions.map((d) => [d.glob.id, d.glob.title]));
  const lines = facts.feedback
    .flatMap((f) => (titles.has(f.globId) ? [`- ${f.verdict === 'pin' ? 'pinned' : 'not key'}: ${clip(oneLine(titles.get(f.globId) ?? ''), 160)}`] : []))
    .slice(0, KNOWLEDGE_PAGE_EXAMPLES_MAX);
  return lines.length === 0 ? [] : ['', 'Examples of what the board decided about key (newest first):', ...lines];
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
 * The board's generated knowledge page. A regeneration (the `regenerate_knowledge_page` job) builds the agents
 * section from the board's data and asks the model only about the decisions that are new, changed or no
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
      const agentSetHistory = [...(current?.basis.agentSetBumps ?? [])].sort((a, b) => b.version - a.version).slice(0, KNOWLEDGE_PAGE_AGENT_SET_HISTORY_MAX);
      const feedback = await tx.listKnowledgePageFeedback(boardId);
      return ok({ current, history, nextRegenerationAt: pending ? next : null, pending, agentSetHistory, feedback });
    });
  }

  /**
   * Admins and POs pin decisions as key, or say they are not (`verdict` null undoes it), for every decision glob of an entry.
   * The page applies a verdict at once; the next regeneration writes it into the version and shows it to the model.
   */
  async setVerdict(email: string, boardId: number, globIds: readonly string[], verdict: KnowledgePageVerdict | null): Promise<Result<{ updated: number }>> {
    if (globIds.length === 0) return invalidInput('Name at least one decision');
    return this.deps.store.transaction(async (tx) => {
      const actor = await roleOf(tx, email, boardId, ['admin', 'po']);
      if (!actor.ok) return actor;
      const at = this.deps.clock.now();
      const ids = [...new Set(globIds)];
      for (const id of ids) {
        const glob = await tx.getGlob(id);
        if (glob === null || glob.boardId !== boardId || glob.category !== 'decision') return notFound(`No decision ${id} on board ${String(boardId)}`);
      }
      for (const id of ids) {
        if (verdict === null) await tx.deleteKnowledgePageFeedback(boardId, id);
        else await tx.saveKnowledgePageFeedback({ boardId, globId: id, verdict, by: email, at });
      }
      await tx.enqueueEffects([knowledgePageEffect(boardId)]);
      return ok({ updated: ids.length });
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
    const guide = await this.deps.store.transaction((tx) => this.guideOf(tx, boardId, now));
    if (last !== null && !full) {
      const remaining = Date.parse(last.createdAt) + board.knowledgePageIntervalMinutes * 60_000 - Date.parse(now);
      if (remaining > 0) return { state: 'pending', retryAfterMs: remaining, reason: KNOWLEDGE_PAGE_WAIT_REASON };
    }
    const set = await this.deps.knowledge.agentSetForDownload(boardId);
    if (!set.ok) return 'dropped';
    const facts = await this.deps.store.transaction((tx) => this.gather(tx, boardId));

    const previous = last?.basis ?? null;
    const agentSetVersion = set.value.version;
    const files = set.value.files.flatMap((f) => {
      const kind = agentSetKind(f.path);
      return kind === 'agent' || kind === 'command' ? [{ path: f.path, kind, content: f.content }] : [];
    });
    const agents = this.agentsOf(files, previous, agentSetVersion, facts.agentDecisions);
    const bumps = this.bumpsOf(previous, agentSetVersion, now, agents.changedPaths);
    const basis: KnowledgePageBasis = {
      agentSetVersion,
      agentsHash: hash(set.value.files.map((f) => `${f.path}\u0000${hash(f.content)}`).join('\u0001')),
      agentSeen: agents.seen,
      decisions: Object.fromEntries(facts.decisions.map((d) => [d.glob.id, d.fingerprint])),
      promptVersion: KNOWLEDGE_PAGE_PROMPT_VERSION,
      guideVersion: guide.version,
      feedback: Object.fromEntries(facts.feedback.map((f) => [f.globId, f.verdict])),
      agentSetBumps: bumps,
    };
    if (
      last !== null &&
      !full &&
      previous !== null &&
      previous.promptVersion === basis.promptVersion &&
      previous.agentSetVersion === basis.agentSetVersion &&
      previous.agentsHash === basis.agentsHash &&
      previous.guideVersion === basis.guideVersion &&
      sameRecord(previous.decisions, basis.decisions) &&
      sameRecord(previous.feedback ?? {}, basis.feedback ?? {})
    ) {
      return 'done';
    }

    const reason: KnowledgePageReason = last === null
        ? 'first'
        : full
          ? 'rebuild'
          : previous?.promptVersion !== basis.promptVersion
            ? 'prompt'
            : previous.guideVersion !== basis.guideVersion
              ? 'guide'
              : 'delta';
    const rebuildDecisions = last === null || full || reason === 'prompt' || reason === 'guide';
    let section: Awaited<ReturnType<KnowledgePageService['decisionsSection']>>;
    try {
      section = await this.decisionsSection(rebuildDecisions ? null : last, facts.decisions, guide, facts);
    } catch (error) {
      if (error instanceof LlmUnavailable) return this.waitFor(boardId, error);
      throw error;
    }
    this.busy.clear(boardId);

    const { changed: decisionsChanged, usage } = section;
    // A pin or a "not key" verdict wins over the model, whatever it said.
    const decisions = applyKnowledgePageVerdicts(section.groups, new Map(facts.feedback.map((f) => [f.globId, f.verdict])));
    const sections = { agents: agents.agents, decisions };
    const changed: KnowledgePageChanged = {
      agents: last === null || JSON.stringify(last.sections.agents) !== JSON.stringify(agents.agents),
      decisions: last === null || decisionsChanged || JSON.stringify(last.sections.decisions) !== JSON.stringify(decisions),
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

  /** The board's guide for what is key; a board without one gets the seed, so every board has it from its first regeneration. */
  private async guideOf(tx: Tx, boardId: number, now: string): Promise<Guide> {
    const found = await tx.getKnowledge(boardId, 'doc', KNOWLEDGE_PAGE_GUIDE_NAME);
    if (found !== null) return { version: found.version, content: found.content };
    await tx.saveKnowledge({
      boardId,
      kind: 'doc',
      name: KNOWLEDGE_PAGE_GUIDE_NAME,
      area: KNOWLEDGE_PAGE_GUIDE_AREA,
      audience: [],
      description: KNOWLEDGE_PAGE_GUIDE_DESCRIPTION,
      content: KNOWLEDGE_PAGE_GUIDE_SEED,
      layer: 'file',
      version: 1,
      source: 'seed',
      updatedBy: 'slop',
      updatedAt: now,
    });
    this.deps.notifier.publish({ kind: 'board.kb', boardId });
    return { version: 1, content: KNOWLEDGE_PAGE_GUIDE_SEED };
  }

  /** The decisions in force, read in one transaction. */
  private async gather(tx: Tx, boardId: number): Promise<Facts> {
    const [globs, decisionRows] = await Promise.all([tx.listGlobs(boardId, { include: 'decisions' }), tx.listDecisions(boardId)]);
    const feedback = await tx.listKnowledgePageFeedback(boardId);
    // A decision glob taken from an extracted decision stops being in force when a newer decision replaced it.
    const replaced = new Set(decisionRows.filter((d) => d.replaceState === 'applied' || d.replaceState === 'confirmed').map((d) => d.id));
    const plans = new Map<string, string>();
    for (const a of await tx.listLatestArtifacts(boardId)) if (a.kind === 'plan') plans.set(a.globId, a.content);
    const agentDecisions = globs
      .filter(isAccepted)
      .flatMap((glob): InForce[] => {
        const origin = decisionOf(glob)?.origin;
        const superseded = origin?.kind === 'extracted' && replaced.has(origin.decisionId);
        const statement = decisionStatement(glob, plans.get(glob.id));
        return superseded ? [] : [{ glob, statement, fingerprint: fingerprintOf(glob, statement), at: decisionOf(glob)?.outcome?.at ?? glob.updatedAt }];
      })
      .sort((a, b) => b.at.localeCompare(a.at) || a.glob.id.localeCompare(b.glob.id));
    // A learning that targets a file of the agent set is in the agent set already; the page keeps project decisions.
    const decisions = agentDecisions
      .filter((d) => {
        const routed = decisionOf(d.glob)?.target?.routed ?? null;
        return routed === null || !isAgentSetKind(routed.kind);
      })
      .slice(0, KNOWLEDGE_PAGE_DECISIONS_MAX);
    return { decisions, agentDecisions, feedback };
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
    return (moved ? [...bumps, { version: agentSetVersion, at: now, changedPaths }] : bumps).slice(-KNOWLEDGE_PAGE_AGENT_SET_HISTORY_MAX);
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

  /**
   * The decisions section. `previous` null writes it whole from every decision in force; otherwise only the decisions
   * that are new, changed or gone reach the model, with the previous section. No model call when none did.
   */
  private async decisionsSection(
    previous: KnowledgePageVersion | null,
    inForce: readonly InForce[],
    guide: Guide,
    facts: Facts,
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
      // The model sees its own earlier word on `key`, not a verdict's override, so undoing a verdict falls back to it.
      JSON.stringify({ groups: previous === null ? [] : kept.map((g) => ({ area: g.area, entries: g.entries.map((e) => ({ text: e.text, rationale: e.rationale, globIds: e.globIds, key: (e.modelKey ?? e.key) === true })) })) }),
      '',
      previous === null ? 'There is no previous section: write it whole from these decisions.' : 'New or changed decisions (one JSON object per line):',
      ...(previous === null ? inForce : changedNow).map(promptLine),
      '',
      removed.length === 0 ? 'No decision left force.' : `No longer in force: ${removed.join(', ')}`,
      '',
      "The board's rules for what is key:",
      clip(guide.content.trim(), KNOWLEDGE_PAGE_GUIDE_MAX),
      ...examplesOf(facts),
    ].join('\n');
    const allowed = new Set(current.keys());
    const covered = new Set(kept.flatMap((g) => g.entries.flatMap((e) => e.globIds)));
    // Everything in force that the previous section covered or that changed must be behind an entry.
    const required = new Set(inForce.filter((d) => previous === null || covered.has(d.glob.id) || before[d.glob.id] !== d.fingerprint).map((d) => d.glob.id));
    const ask = (text: string): Promise<string> =>
      completeWithDeadline(this.deps.llm, { system: KNOWLEDGE_PAGE_SYSTEM, prompt: text, maxTokens: ANSWER_MAX_TOKENS }, this.deps.timeoutMs ?? LLM_TIMEOUT_MS);
    // Tokens as characters over four: the adapter's usage isn't passed up through the `Llm` port.
    let input = 0;
    let output = 0;
    const count = (sent: string, answer: string): void => {
      input += Math.ceil((KNOWLEDGE_PAGE_SYSTEM.length + sent.length) / 4);
      output += Math.ceil(answer.length / 4);
    };
    let parsed: KnowledgePageDecisionGroup[];
    const first = await ask(prompt);
    count(prompt, first);
    try {
      parsed = parseDecisionGroups(first, allowed, required);
    } catch (error) {
      // Once more with the refusal in the prompt; a second refusal throws, so no partial page is ever written.
      const retry = `${prompt}\n\nYour previous answer was refused: ${error instanceof Error ? error.message : 'it could not be read'}. Answer again with the whole section, fixing this.`;
      const second = await ask(retry);
      count(retry, second);
      parsed = parseDecisionGroups(second, allowed, required);
    }
    const groups = parsed.map((g) => ({ area: g.area, entries: g.entries.map((e): KnowledgePageDecisionEntry => ({ ...e, at: newestAt(e.globIds, current) })) }));
    return { groups, changed: true, usage: { input, output } };
  }

  /** The model can't be used: run again later without spending an attempt (busy: after a growing delay). */
  private waitFor(boardId: number, unavailable: LlmUnavailable): RetryLater {
    const ms = unavailable instanceof LlmBusy ? this.busy.next(boardId) : LLM_WAIT_MS;
    const retryAt = new Date(Date.parse(this.deps.clock.now()) + ms).toISOString();
    const reason = (unavailable instanceof LlmBusy ? busyMessage(retryAt) : `${LLM_WAITING_PREFIX}${unavailable.reason}`).slice(0, 500);
    return { state: 'pending', retryAfterMs: ms, reason };
  }
}
