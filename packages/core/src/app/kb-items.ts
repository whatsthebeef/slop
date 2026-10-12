import { broaderConflicts, decisionGlobTitle, decisionOf, defaultScope, kbItemKey } from '../domain/decision-glob.js';
import type { DecisionAttributes } from '../domain/attributes.js';
import type { DomainEvent, Effect, OutboxJob } from '../domain/events.js';
import { parseId } from '../domain/ids.js';
import { KB_STEP_KIND, KB_STEP_KINDS, kbEffectsFor, kbStepOf, withProcessing } from '../domain/kb.js';
import type { DraftPreview, KbItem, KbItemStatus } from '../domain/kb.js';
import {
  DOCUMENT_EVIDENCE_LABEL,
  EVIDENCE_PREFIX,
  MERGE_NOTE_LABEL,
  isKbGlob,
  kbAttributesOf,
  kbItemOf,
  kbLinksOf,
  mergeNoteText,
  proposalText,
} from '../domain/kb-glob.js';
import type { ArtifactKind, Provenance } from '../domain/knowledge.js';
import * as machine from '../domain/machine.js';
import type { Transition } from '../domain/machine.js';
import type { Result } from '../domain/errors.js';
import type { Actor, Glob, GlobLink } from '../domain/types.js';
import type { Clock, Hint, Tx } from '../ports.js';
import { applyDecisionStep, DECISION_SYSTEM_ACTOR, decisionContext, writeAssessment } from './decision-glob.js';

/**
 * KB items as the pipeline, the Knowledge page and the services read and write them. A KB item *is* its decision glob
 * (same `k` ID; `domain/kb-glob.ts` maps the two shapes): this reads the glob, its artifacts and its pipeline jobs, and
 * writes them back in one glob write plus artifact versions. Every status change goes through a decision row (approved:
 * `decisionApproved`; rejected: `decisionRejected`; closed by the pipeline: `closeDecision`, D10′; reopened after a
 * closure: `reopenClosedDecision`, D12; reopened after an agent's decision: `decisionReopened`). The pipeline's queue is
 * the outbox: a write queues the step it makes due (`kbEffectsFor`) in the same transaction, and an open item's pipeline
 * fields are read from its next step's newest job (`withProcessing`). `KbItem.version` is the glob's version.
 */
export interface KbItems {
  getKbItem(id: string): Promise<KbItem | null>;
  /** A board's items, oldest first, optionally with one status. */
  listKbItems(boardId: number, status?: KbItemStatus): Promise<KbItem[]>;
  /** A board's newest `limit` items with one of `statuses`, newest first by decision (else submission), and how many there are. */
  listRecentKbItems(boardId: number, statuses: readonly KbItemStatus[], limit: number): Promise<{ items: KbItem[]; total: number }>;
  /** Inserts a new item as its decision glob (row D1, then the row its status needs) and queues its first step; false if the ID is taken. */
  insertKbItem(item: KbItem): Promise<boolean>;
  /**
   * Writes `item` if the glob's version is still `expectedVersion` (the glob takes `item.version`) and queues any step the
   * change makes due; false otherwise.
   */
  updateKbItem(item: KbItem, expectedVersion: number, options?: KbWriteOptions): Promise<boolean>;
  /** Queues the item's step again (an admin's Retry after it failed); the item as it reads afterwards. */
  retryStep(item: KbItem): Promise<KbItem>;
  /**
   * Self-healing: queues the due step of every open learning on the board whose step has no job waiting (none, or the
   * newest finished or was dropped). A failed one is left for an admin's Retry. Returns how many it queued.
   */
  queueDueSteps(boardId: number): Promise<number>;
}

export interface KbWriteOptions {
  /** Who acts: an admin reopening a closure (row D12 needs one). */
  readonly actor?: Actor;
  /** An approval of an edited draft: the decision's outcome is `accept_with_edits`. */
  readonly edited?: boolean;
  /** The draft's preview, when the caller has it, for the assessment. */
  readonly preview?: DraftPreview | null;
}

/** What writes need: the time, and where to raise live hints (published after the caller's commit). */
export interface KbWriteContext {
  readonly clock: Clock;
  readonly raise?: (hint: Hint) => void;
}

const KB_ARTIFACT_KINDS: readonly ArtifactKind[] = ['plan', 'draft', 'outcome', 'effect_check', 'attachment'];

/** Channels whose assessments slop writes by itself as the pipeline works. */
const channelOf = (item: KbItem): 'agent' | 'mined' => (item.source === 'mined' ? 'mined' : 'agent');

const isClosed = (status: KbItemStatus): status is 'merged' | 'suppressed' | 'covered' =>
  status === 'merged' || status === 'suppressed' || status === 'covered';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The link that closed an item, if one names a learning (coverage by a document's text has none). */
const closingLink = (item: KbItem): GlobLink | null =>
  item.duplicateOf !== null
    ? { id: item.duplicateOf, kind: 'duplicate_of', source: 'pipeline' }
    : item.suppressedBy !== null
      ? { id: item.suppressedBy, kind: 'suppressed_by', source: 'pipeline' }
      : item.coveredBy?.kind === 'item'
        ? { id: item.coveredBy.id, kind: 'covered_by', source: 'pipeline' }
        : null;

export const kbItems = (tx: Tx, context?: KbWriteContext): KbItems => {
  const raise = (hint: Hint) => context?.raise?.(hint);
  const clockOf = (): Clock => {
    if (context === undefined) throw new Error('KB item writes need a clock (kbItems(tx, { clock }))');
    return context.clock;
  };

  /** Items from their globs, with artifacts and (for open ones) jobs read in one query each. */
  const itemsOf = async (globs: readonly Glob[]): Promise<KbItem[]> => {
    const kb = globs.filter(isKbGlob);
    if (kb.length === 0) return [];
    const ids = kb.map((g) => g.id);
    const [artifacts, jobs] = await Promise.all([tx.latestArtifacts(ids, KB_ARTIFACT_KINDS), tx.latestOutboxJobs(ids, KB_STEP_KINDS)]);
    return kb.flatMap((g) => {
      const item = kbItemOf(g, artifacts);
      return item === null ? [] : [withProcessing(item, jobs)];
    });
  };
  const boardItems = async (boardId: number): Promise<KbItem[]> =>
    (await itemsOf(await tx.listGlobs(boardId, { include: 'decisions', origins: ['submitted', 'mined'] }))).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const read = async (id: string): Promise<KbItem | null> => {
    const glob = await tx.getGlob(id);
    return glob === null ? null : ((await itemsOf([glob]))[0] ?? null);
  };

  /** A new artifact version on the learning's glob. */
  const put = async (glob: Glob, kind: ArtifactKind, label: string, content: string, at: string, extra: Partial<Provenance> & { actor?: string } = {}): Promise<void> => {
    const provenance: Provenance = { by: 'sessionator', actor: DECISION_SYSTEM_ACTOR, runId: null, agentSetVersion: null, ...extra };
    await tx.insertArtifact({ globId: glob.id, kind, label, content, link: null, commitSha: null, provenance, createdAt: at });
  };

  /** The artifact versions a change needs: only what changed, with empty content where a value was cleared. */
  const writeArtifacts = async (glob: Glob, before: KbItem | null, after: KbItem, at: string): Promise<boolean> => {
    let wrote = false;
    const payload = proposalText(after);
    if (before === null || proposalText(before) !== payload) {
      await put(glob, 'plan', '', payload, before === null ? after.createdAt : at, {
        by: before === null ? (after.source === 'mined' ? 'sessionator' : 'routine') : 'sessionator',
        actor: before === null ? after.submittedBy : DECISION_SYSTEM_ACTOR,
        agentSetVersion: before === null ? after.agentSetVersion : null,
      });
      wrote = true;
    }
    if (after.document !== null && (before === null || before.evidence !== after.evidence)) {
      await put(glob, 'attachment', DOCUMENT_EVIDENCE_LABEL, after.evidence, before === null ? after.createdAt : at, { actor: after.submittedBy });
      wrote = true;
    }
    const draftOf = (i: KbItem | null) => (i === null ? null : [i.draft, i.rationale, i.draftedAgainstVersion]);
    if (!(before === null && after.draft === null) && !same(draftOf(before), draftOf(after))) {
      await put(glob, 'draft', '', after.draft?.content ?? '', at, {
        ...(after.draft === null
          ? {}
          : { draft: { section: after.draft.section, targetVersion: after.draftedAgainstVersion, target: after.target, rationale: after.rationale } }),
      });
      wrote = true;
    }
    if (!(before === null && after.outcome === null) && !same(before?.outcome ?? null, after.outcome)) {
      await put(glob, 'outcome', '', after.outcome === null ? '' : JSON.stringify(after.outcome), after.decidedAt ?? at, {
        by: 'human',
        actor: after.decidedBy ?? DECISION_SYSTEM_ACTOR,
        ...(after.outcome === null ? {} : { kbOutcome: after.outcome }),
      });
      wrote = true;
    }
    if (!(before === null && after.effectCheck === null) && !same(before?.effectCheck ?? null, after.effectCheck)) {
      await put(glob, 'effect_check', '', after.effectCheck === null ? '' : JSON.stringify(after.effectCheck), at, {
        ...(after.effectCheck === null ? {} : { effectCheck: after.effectCheck }),
      });
      wrote = true;
    }
    const had = before?.extraEvidence ?? [];
    if (after.extraEvidence.length < had.length || !same(after.extraEvidence.slice(0, had.length), had)) {
      throw new Error(`${after.id}: evidence merged into a learning is never taken away`);
    }
    const labels = new Set(had.map((e) => `${EVIDENCE_PREFIX}${e.itemId}`));
    for (const e of after.extraEvidence.slice(had.length)) {
      let label = `${EVIDENCE_PREFIX}${e.itemId}`;
      for (let n = 2; labels.has(label); n++) label = `${EVIDENCE_PREFIX}${e.itemId}#${String(n)}`;
      labels.add(label);
      await put(glob, 'attachment', label, e.evidence, e.at, { actor: e.submittedBy, evidence: { itemId: e.itemId, globIds: e.globIds } });
      wrote = true;
    }
    if (!(before === null && after.mergeNote === null) && !same(before?.mergeNote ?? null, after.mergeNote)) {
      await put(glob, 'attachment', MERGE_NOTE_LABEL, after.mergeNote === null ? '' : mergeNoteText(after.mergeNote), at, {
        ...(after.mergeNote === null ? {} : { mergeNote: after.mergeNote }),
      });
      wrote = true;
    }
    return wrote;
  };

  /** The broader decisions an open learning contradicts (by scope rank). */
  const conflictsOf = async (scope: DecisionAttributes['scope'], item: KbItem): Promise<string[]> => {
    if (item.status !== 'open') return [];
    const others = new Map<string, Glob>();
    for (const c of item.contradicts) {
      if (c.kind !== 'item') continue;
      const other = await tx.getGlob(c.ref);
      if (other !== null) others.set(c.ref, other);
    }
    return broaderConflicts(scope, item, (id) => others.get(id));
  };

  /** The decision row a status change needs, if any. */
  const statusStep = (glob: Glob, before: KbItem | null, after: KbItem, options: KbWriteOptions, at: string): Result<Transition> | null => {
    const from = before?.status ?? 'open';
    if (from === after.status) return null;
    const ctx = decisionContext(clockOf(), options.actor ?? null, at);
    if (after.status === 'approved') {
      return machine.decisionApproved(glob, { by: after.decidedBy ?? DECISION_SYSTEM_ACTOR, kind: options.edited === true ? 'accept_with_edits' : 'accept', reason: after.decisionReason }, ctx);
    }
    if (after.status === 'rejected') return machine.decisionRejected(glob, { by: after.decidedBy ?? DECISION_SYSTEM_ACTOR, reason: after.decisionReason ?? '' }, ctx);
    if (isClosed(after.status)) return machine.closeDecision(glob, after.status, closingLink(after), ctx);
    // Back to open: a closure undone by an admin (D12), or an agent's decision reopened.
    return isClosed(from) ? machine.reopenClosedDecision(glob, ctx) : machine.decisionReopened(glob, ctx);
  };

  /**
   * The glob after `after` is written over `glob` (as `before`): the status row, then the item's fields, links and
   * conflict flags. Throws when the row refuses: callers check what may happen before they write.
   */
  const nextGlob = async (glob: Glob, before: KbItem | null, after: KbItem, options: KbWriteOptions, at: string): Promise<{ glob: Glob; events: readonly DomainEvent[]; effects: readonly Effect[] }> => {
    const step = statusStep(glob, before, after, options, at);
    if (step !== null && !step.ok) throw new Error(`${after.id}: ${step.error.message}`);
    const moved = step?.value.glob ?? glob;
    const base = decisionOf(moved);
    if (base === null) throw new Error(`${glob.id} is not a decision glob`);
    const conflicts = await conflictsOf(base.scope, after);
    const attributes: DecisionAttributes = {
      scope: base.scope,
      origin: base.origin,
      channel: base.channel,
      outcome: base.outcome,
      ...(base.archived === true ? { archived: true as const } : {}),
      ...(conflicts.length === 0 ? {} : { conflictsWith: conflicts }),
      ...kbAttributesOf(after),
      // The rows own the closure: a reopen clears it, a close sets it.
      ...(base.closedAs === undefined ? {} : { closedAs: base.closedAs }),
    };
    return {
      glob: {
        ...moved,
        // A person may have retitled the decision: only a new statement gives it a new title.
        title: before !== null && before.statement === after.statement ? moved.title : decisionGlobTitle(after.statement),
        summary: after.statement,
        attributes,
        links: kbLinksOf(after),
        version: after.version,
      },
      events: step?.value.events ?? [],
      effects: step?.value.effects ?? [],
    };
  };

  /** After an approval, the open learnings that contradict it may now conflict with a broader decision. */
  const refreshContradicting = async (approved: KbItem): Promise<void> => {
    for (const other of await boardItems(approved.boardId)) {
      if (other.status !== 'open' || !other.contradicts.some((c) => c.kind === 'item' && c.ref === approved.id)) continue;
      const glob = await tx.getGlob(other.id);
      const attributes = glob === null ? null : decisionOf(glob);
      if (glob === null || attributes === null) continue;
      const ids = await conflictsOf(attributes.scope, other);
      const result = await applyDecisionStep(tx, glob.id, (g) => machine.decisionConflicts(g, ids, decisionContext(clockOf(), null)));
      if (result.ok && result.value.changed) raise({ kind: 'glob.changed', boardId: glob.boardId, globId: glob.id, version: result.value.glob.version });
    }
  };

  /** Writes the assessment of an automated channel's open learning: at creation, when drafted, and when its conflict flags move. */
  const assess = async (glob: Glob, item: KbItem, preview: DraftPreview | null, due: boolean): Promise<void> => {
    if (item.status !== 'open' || !due) return;
    if (await writeAssessment(tx, { clock: clockOf() }, glob, item, preview)) raise({ kind: 'glob.artifacts', boardId: glob.boardId, globId: glob.id });
  };

  return {
    getKbItem: read,
    listKbItems: async (boardId, status) => (await boardItems(boardId)).filter((i) => status === undefined || i.status === status),
    listRecentKbItems: async (boardId, statuses, limit) => {
      // Newest by decision (an item joins the decided group when decided); closed items have none.
      const all = (await boardItems(boardId))
        .filter((i) => statuses.includes(i.status))
        .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt) || b.id.localeCompare(a.id));
      return { items: all.slice(0, limit), total: all.length };
    },
    insertKbItem: async (item) => {
      const clock = clockOf();
      const board = await tx.getBoard(item.boardId);
      const parsed = parseId(item.id);
      if (board === null || parsed?.letter !== 'k' || parsed.boardId !== item.boardId) throw new Error(`${item.id} is not a KB item ID on board ${String(item.boardId)}`);
      const open: KbItem = { ...item, status: 'open' };
      const created = machine.create(
        {
          id: item.id,
          boardId: item.boardId,
          title: decisionGlobTitle(item.statement),
          summary: item.statement,
          type: 'same',
          category: 'decision',
          attributes: { scope: defaultScope(item.type), origin: { kind: item.source }, channel: channelOf(item), outcome: null, ...kbAttributesOf(open) },
          group: null,
          environment: null,
          autoTrigger: false,
        },
        board,
        decisionContext({ now: () => item.createdAt }, { email: item.submittedBy, role: 'dev' }),
      );
      if (!created.ok) throw new Error(`${item.id}: ${created.error.message}`);
      // A seeded item that isn't open goes through the row its status needs, as if it had been decided.
      const written = await nextGlob({ ...created.value.glob, version: item.version }, open, item, {}, item.decidedAt ?? clock.now());
      if (!(await tx.insertGlob(written.glob, kbItemKey(item.id)))) return false;
      await tx.appendEvents([...created.value.events, ...written.events]);
      await writeArtifacts(written.glob, null, item, clock.now());
      await assess(written.glob, item, null, true);
      await tx.enqueueEffects([...written.effects, ...kbEffectsFor(null, item)]);
      raise({ kind: 'glob.changed', boardId: item.boardId, globId: item.id, version: written.glob.version });
      return true;
    },
    updateKbItem: async (item, expectedVersion, options = {}) => {
      const now = clockOf().now();
      const glob = await tx.getGlob(item.id);
      if (glob?.version !== expectedVersion) return false;
      const before = (await itemsOf([glob]))[0];
      if (before === undefined) throw new Error(`${item.id} is not a KB item`);
      const at = item.status !== before.status && (item.status === 'approved' || item.status === 'rejected') ? (item.decidedAt ?? now) : now;
      const written = await nextGlob(glob, before, item, options, at);
      // A write that changes nothing still writes the row: it holds the lock a dedupe check relies on.
      if (!(await tx.updateGlob(written.glob, expectedVersion))) return false;
      await tx.appendEvents(written.events);
      const artifacts = await writeArtifacts(written.glob, before, item, now);
      if (item.status === 'approved' && before.status !== 'approved') await refreshContradicting(item);
      const conflictsMoved = !same(decisionOf(glob)?.conflictsWith ?? [], decisionOf(written.glob)?.conflictsWith ?? []);
      await assess(written.glob, item, options.preview ?? null, !same(before.draft, item.draft) || conflictsMoved || before.status !== 'open');
      await tx.enqueueEffects([...written.effects, ...kbEffectsFor(before, item)]);
      if (!same(glob, written.glob)) raise({ kind: 'glob.changed', boardId: glob.boardId, globId: glob.id, version: written.glob.version });
      if (artifacts) raise({ kind: 'glob.artifacts', boardId: glob.boardId, globId: glob.id });
      return true;
    },
    queueDueSteps: async (boardId) => {
      const open = (await boardItems(boardId)).filter((i) => i.status === 'open');
      const jobs = await tx.latestOutboxJobs(
        open.map((i) => i.id),
        KB_STEP_KINDS,
      );
      const due: Effect[] = [];
      for (const item of open) {
        const step = kbStepOf(item);
        if (step === null) continue;
        const kind = KB_STEP_KIND[step];
        const newest = jobs.filter((j) => j.globId === item.id && j.kind === kind).reduce<OutboxJob | null>((a, j) => (a === null || j.id > a.id ? j : a), null);
        if (newest === null || newest.state === 'done' || newest.state === 'dropped') due.push({ kind, globId: item.id });
      }
      await tx.enqueueEffects(due);
      return due.length;
    },
    retryStep: async (item) => {
      const step = kbStepOf(item);
      if (step !== null) {
        const effect: Effect = { kind: KB_STEP_KIND[step], globId: item.id };
        await tx.enqueueEffects([effect]);
      }
      return (await read(item.id)) ?? item;
    },
  };
};

/**
 * The live hint for a pipeline job the outbox settled (failed, retrying, or waiting with a new reason): the board's
 * Knowledge page refetches. Null for any other effect.
 */
export const kbJobHint = (effect: Effect): Hint | null => {
  if (effect.kind !== 'kb_route' && effect.kind !== 'kb_draft') return null;
  const parsed = parseId(effect.globId);
  return parsed === null ? null : { kind: 'board.kb', boardId: parsed.boardId };
};
