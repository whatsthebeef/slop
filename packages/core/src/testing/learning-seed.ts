import { decisionGlobTitle, decisionOf, defaultScope, learningKey } from '../domain/decision-glob.js';
import type { DecisionAttributes } from '../domain/attributes.js';
import type { DomainEvent, Effect } from '../domain/events.js';
import { parseId } from '../domain/ids.js';
import { kbEffectsFor } from '../domain/kb.js';
import type { DraftPreview, LearningWire, LearningStatus } from '../domain/kb.js';
import { kbAttributesOf, kbLinksOf, proposalText } from '../domain/kb-glob.js';
import { learningWire } from '../domain/learning-wire.js';
import * as machine from '../domain/machine.js';
import type { Transition } from '../domain/machine.js';
import type { Result } from '../domain/errors.js';
import type { Actor, Glob, GlobLink } from '../domain/types.js';
import type { Hint, Tx } from '../ports.js';
import { DECISION_SYSTEM_ACTOR, decisionContext } from '../app/decision-glob.js';
import { boardLearnings, readLearnings } from '../app/learning-reads.js';
import { assessLearning, assessmentDue, learningConflicts, refreshOnApproval, writeLearningArtifacts } from '../app/learning-writes.js';
import type { LearningArtifactState, LearningWriteContext } from '../app/learning-writes.js';

/**
 * Test seeding: writes a learning as a test describes it (a `LearningWire`) and reads it back. Production code does not use
 * this; it reads with `domain/learning.ts` and writes with `app/learning-writes.ts`. A learning *is* its decision glob
 * (same `k` ID; `domain/kb-glob.ts` maps the two shapes): this reads the glob, its artifacts and its pipeline jobs, and
 * writes them back in one glob write plus artifact versions. Every status change goes through a decision row (approved:
 * `decisionApproved`; rejected: `decisionRejected`; closed by the pipeline: `closeDecision`, D10′; reopened after a
 * closure: `reopenClosedDecision`, D12; reopened after an agent's decision: `decisionReopened`). The pipeline's queue is
 * the outbox: a write queues the step it makes due (`kbEffectsFor`) in the same transaction, and an open item's pipeline
 * fields are read from its next step's newest job (`withProcessing`). `LearningWire.version` is the glob's version.
 */
export interface LearningSeed {
  readSeeded(id: string): Promise<LearningWire | null>;
  /** A board's items, oldest first, optionally with one status. */
  listSeeded(boardId: number, status?: LearningStatus): Promise<LearningWire[]>;
  /** Inserts a new item as its decision glob (row D1, then the row its status needs) and queues its first step; false if the ID is taken. */
  insertSeeded(item: LearningWire): Promise<boolean>;
  /**
   * Writes `item` if the glob's version is still `expectedVersion` (the glob takes `item.version`) and queues any step the
   * change makes due; false otherwise.
   */
  updateSeeded(item: LearningWire, expectedVersion: number, options?: KbWriteOptions): Promise<boolean>;
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
export type KbWriteContext = LearningWriteContext;

/** Channels whose assessments slop writes by itself as the pipeline works. */
const channelOf = (item: LearningWire): 'agent' | 'mined' => (item.source === 'mined' ? 'mined' : 'agent');

const isClosed = (status: LearningStatus): status is 'merged' | 'suppressed' | 'covered' =>
  status === 'merged' || status === 'suppressed' || status === 'covered';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The link that closed an item, if one names a learning (coverage by a document's text has none). */
const closingLink = (item: LearningWire): GlobLink | null =>
  item.duplicateOf !== null
    ? { id: item.duplicateOf, kind: 'duplicate_of', source: 'pipeline' }
    : item.suppressedBy !== null
      ? { id: item.suppressedBy, kind: 'suppressed_by', source: 'pipeline' }
      : item.coveredBy?.kind === 'item'
        ? { id: item.coveredBy.id, kind: 'covered_by', source: 'pipeline' }
        : null;

/** An item's artifact state, for `writeLearningArtifacts`. */
const artifactStateOf = (item: LearningWire): LearningArtifactState => ({
  origin: { id: item.id, createdAt: item.createdAt, submittedBy: item.submittedBy, source: item.source, agentSetVersion: item.agentSetVersion },
  payload: proposalText(item),
  documentEvidence: item.document === null ? null : item.evidence,
  draft: item.draft,
  draftedAgainstVersion: item.draftedAgainstVersion,
  rationale: item.rationale,
  target: item.target,
  outcome: item.outcome,
  decidedBy: item.decidedBy,
  decidedAt: item.decidedAt,
  effectCheck: item.effectCheck,
  extraEvidence: item.extraEvidence,
  mergeNote: item.mergeNote,
});

export const learningSeed = (tx: Tx, context?: KbWriteContext): LearningSeed => {
  const writes = (): LearningWriteContext => {
    if (context === undefined) throw new Error('KB item writes need a clock (learningSeed(tx, { clock }))');
    return context;
  };
  const clockOf = () => writes().clock;
  const raise = (hint: Hint) => context?.raise?.(hint);

  /** Items from their globs, with artifacts and (for open ones) jobs read in one query each (`readLearnings`). */
  const itemsOf = async (globs: readonly Glob[]): Promise<LearningWire[]> => (await readLearnings(tx, globs)).map(learningWire);
  const boardItems = async (boardId: number): Promise<LearningWire[]> => (await boardLearnings(tx, boardId)).map(learningWire);
  const read = async (id: string): Promise<LearningWire | null> => {
    const glob = await tx.getGlob(id);
    return glob === null ? null : ((await itemsOf([glob]))[0] ?? null);
  };

  /** The artifact versions a change needs (`writeLearningArtifacts`). */
  const writeArtifacts = (glob: Glob, before: LearningWire | null, after: LearningWire, at: string): Promise<boolean> =>
    writeLearningArtifacts(tx, glob, before === null ? null : artifactStateOf(before), artifactStateOf(after), at);

  /** The broader decisions an open learning contradicts (by scope rank). */
  const conflictsOf = (scope: DecisionAttributes['scope'], item: LearningWire): Promise<string[]> => learningConflicts(tx, scope, item.status, item.contradicts);

  /** The decision row a status change needs, if any. */
  const statusStep = (glob: Glob, before: LearningWire | null, after: LearningWire, options: KbWriteOptions, at: string): Result<Transition> | null => {
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
  const nextGlob = async (glob: Glob, before: LearningWire | null, after: LearningWire, options: KbWriteOptions, at: string): Promise<{ glob: Glob; events: readonly DomainEvent[]; effects: readonly Effect[] }> => {
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

  /** Writes the assessment of an automated channel's open learning: at creation, when drafted, and when its conflict flags move. */
  const assess = (glob: Glob, item: LearningWire, preview: DraftPreview | null, due: boolean): Promise<void> => assessLearning(tx, writes(), glob, item, preview, due);

  return {
    readSeeded: read,
    listSeeded: async (boardId, status) => (await boardItems(boardId)).filter((i) => status === undefined || i.status === status),
    insertSeeded: async (item) => {
      const clock = clockOf();
      const board = await tx.getBoard(item.boardId);
      const parsed = parseId(item.id);
      if (board === null || parsed?.letter !== 'k' || parsed.boardId !== item.boardId) throw new Error(`${item.id} is not a KB item ID on board ${String(item.boardId)}`);
      const open: LearningWire = { ...item, status: 'open' };
      const created = machine.create(
        {
          id: item.id,
          boardId: item.boardId,
          title: decisionGlobTitle(item.statement),
          summary: item.statement,
          type: 'same',
          category: 'decision',
          attributes: { scope: defaultScope(), origin: { kind: item.source }, channel: channelOf(item), outcome: null, ...kbAttributesOf(open) },
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
      if (!(await tx.insertGlob(written.glob, learningKey(item.id)))) return false;
      await tx.appendEvents([...created.value.events, ...written.events]);
      await writeArtifacts(written.glob, null, item, clock.now());
      await assess(written.glob, item, null, true);
      await tx.enqueueEffects([...written.effects, ...kbEffectsFor(null, item)]);
      raise({ kind: 'glob.changed', boardId: item.boardId, globId: item.id, version: written.glob.version });
      return true;
    },
    updateSeeded: async (item, expectedVersion, options = {}) => {
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
      await refreshOnApproval(tx, writes(), item, before.status, item.status);
      const due = assessmentDue({
        statusBefore: before.status,
        statusAfter: item.status,
        draftBefore: before.draft,
        draftAfter: item.draft,
        conflictsBefore: decisionOf(glob)?.conflictsWith ?? [],
        conflictsAfter: decisionOf(written.glob)?.conflictsWith ?? [],
      });
      await assess(written.glob, item, options.preview ?? null, due);
      await tx.enqueueEffects([...written.effects, ...kbEffectsFor(before, item)]);
      if (!same(glob, written.glob)) raise({ kind: 'glob.changed', boardId: glob.boardId, globId: glob.id, version: written.glob.version });
      if (artifacts) raise({ kind: 'glob.artifacts', boardId: glob.boardId, globId: glob.id });
      return true;
    },
  };
};
