import type { Result } from '../domain/errors.js';
import { notFound, ok } from '../domain/errors.js';
import { hasMerged, isMet } from '../domain/relations.js';
import type { ToState } from '../domain/relations.js';
import {
  RELATION_LEARNING_SOURCES,
  normaliseSource,
  pinned,
  posturesOf,
  precisionRecall,
  signalKey,
  thresholdsOf,
  unpinned,
  validatePins,
} from '../domain/relation-learning.js';
import type {
  RelationLearningSource,
  RelationLearningSettings,
  RelationLearningView,
  RelationSignalKind,
  RelationSignalSource,
  RelationSourcePosture,
  RelationSourceView,
} from '../domain/relation-learning.js';
import type { Glob, Relation } from '../domain/types.js';
import type { Clock, IdGenerator, Notifier, Store, Tx } from '../ports.js';
import { adminOf, memberOf } from './access.js';

/** Whether glob `a` uses what glob `b` added (the post-merge check's test); absent: only predicted overlaps are blamed for a red main. */
export type UsesTest = (a: Glob, b: Glob) => Promise<boolean>;

/** What is recorded for one signal (the service adds the ID). */
export interface SignalInput {
  readonly boardId: number;
  readonly from: string;
  readonly to: string;
  readonly relationId: string | null;
  readonly source: RelationSignalSource;
  readonly signal: RelationSignalKind;
  readonly evidence: string;
  readonly key: string;
}

const DAY_MS = 86_400_000;

/**
 * Learns, per board and relation source, how readily to create gating relations (spec, Dependencies). Every override, dismissal,
 * promotion, person-added relation and collision is recorded once as a signal; precision and recall are computed from the signals
 * over a rolling window when read, so nothing stored can drift. A source below the precision threshold makes only weak links
 * (`may_relate`, holding nothing); a source with low recall gets bolder; an admin's pins win. Cross-board promotion stays a human
 * step: nothing here leaves the board.
 *
 * Signals are recorded in the transaction of their cause where there is one (`overridden`, `dismissed`, `personAdded`,
 * `failedRun`, `promoted`); the merge-time ones follow `DependencyLearningService`: best effort, never failing the transition.
 */
export class RelationLearningService {
  constructor(
    private readonly deps: {
      store: Store;
      notifier: Notifier;
      clock: Clock;
      ids: IdGenerator;
      /** Reads two globs' diffs; without it a red main blames only the culprit's predicted overlaps. */
      uses?: UsesTest;
      log?: (task: string, message: string) => void;
    },
  ) {}

  // -------------------------------------------------------------------------
  // Recording

  /** Records one signal once per board and key; false when it was recorded before. */
  async record(tx: Tx, input: SignalInput): Promise<boolean> {
    return tx.insertRelationSignal({ ...input, id: `sig_${this.deps.ids.runId()}`, at: this.deps.clock.now() });
  }

  private about(relation: Relation, signal: RelationSignalKind, key: string, evidence: string): SignalInput {
    return { boardId: relation.boardId, from: relation.from, to: relation.to, relationId: relation.id, source: normaliseSource(relation.source), signal, evidence, key };
  }

  /** Start now, Merge anyway or Sign off anyway went ahead of a relation that was still holding: it was too aggressive. */
  async overridden(tx: Tx, relation: Relation): Promise<void> {
    await this.record(tx, this.about(relation, 'fp_override', signalKey.override(relation.id), `${relation.from} went ahead of its ${relation.gate} relation to ${relation.to} anyway`));
  }

  /** A person dismissed a relation: a false positive only when `to` had not reached `until` (a met relation had already opened its gate). */
  async dismissed(tx: Tx, relation: Relation, toStateNow: ToState): Promise<void> {
    if (isMet(relation, toStateNow)) return;
    await this.record(tx, this.about(relation, 'fp_dismissed', signalKey.dismissed(relation.id), `${relation.from} dismissed its ${relation.gate} relation to ${relation.to} before it was met`));
  }

  /** The relation was needed: the post-merge check found a use, or a run failed for the missing prerequisite. Once per relation. */
  async confirmed(tx: Tx, relation: Relation, evidence: string): Promise<void> {
    await this.record(tx, this.about(relation, 'tp_needed', signalKey.verdict(relation.id), evidence));
  }

  /** The relation was not needed (the post-merge check). Once per relation. */
  async refuted(tx: Tx, relation: Relation, evidence: string): Promise<void> {
    await this.record(tx, this.about(relation, 'fp_not_needed', signalKey.verdict(relation.id), evidence));
  }

  /** A person made a weak link a gate: it was right to suggest it. */
  async promoted(tx: Tx, relation: Relation): Promise<void> {
    await this.record(tx, this.about(relation, 'tp_promoted', signalKey.promoted(relation.id), `${relation.from}'s weak link to ${relation.to} was made a ${relation.gate} gate`));
  }

  /**
   * A person added a relation. It is a false negative (slop missed a dependency) only when the glob was already created, and no
   * relation of any kind (inferred, mention, learned, weak, dismissed) to the same glob existed before: `before` is every
   * relation row of the glob read before this write.
   */
  async personAdded(tx: Tx, glob: Glob, added: Relation, before: readonly Relation[]): Promise<void> {
    if (added.source !== 'person' || added.kind === 'superseded_by') return;
    if (before.some((r) => r.to === added.to && r.source !== 'person' && r.kind !== 'superseded_by')) return;
    await this.record(tx, {
      boardId: glob.boardId,
      from: glob.id,
      to: added.to,
      relationId: added.id,
      source: 'person',
      signal: 'fn_person_added',
      evidence: `A person added a ${added.gate} relation from ${glob.id} to ${added.to} that slop had not made`,
      key: signalKey.personAdded(glob.id, added.to),
    });
  }

  /** A run failed because code from another glob was not merged, and no relation to it existed: slop learned the need too late. */
  async failedRun(tx: Tx, glob: Glob, learned: Relation): Promise<void> {
    await this.record(tx, {
      boardId: glob.boardId,
      from: glob.id,
      to: learned.to,
      relationId: learned.id,
      source: 'learned',
      signal: 'fn_failed_run',
      evidence: `${glob.id} failed because ${learned.to} was not merged, and no relation said so`,
      key: signalKey.failedRun(glob.id, learned.to),
    });
  }

  /**
   * A glob merged: records the collisions it was part of between globs that had no relation either way.
   * - `fn_conflict`: its PR was flagged with a conflict caused by another glob's merge (`ConflictFlagged.since`).
   * - `fn_red_main`: it turned the base branch red (`Board.baseChecks.since`) together with a glob that merged while it was open:
   *   one it uses (`uses`), or, without that test, one it was predicted to overlap with.
   * Safe to repeat (the outbox may deliver the merge again): keys make each collision count once. Never throws.
   */
  async onMerged(globId: string): Promise<void> {
    try {
      await this.deps.store.transaction(async (tx) => {
        const glob = await tx.getGlob(globId);
        if (glob === null || !hasMerged(glob)) return;
        await this.collisions(tx, glob);
      });
    } catch (e) {
      this.deps.log?.('relation learning', e instanceof Error ? e.message : String(e));
    }
  }

  /** The base branch just turned red because of `board.baseChecks.since`: records the red-main collision if that glob merged. Never throws. */
  async onBaseRed(boardId: number): Promise<void> {
    try {
      await this.deps.store.transaction(async (tx) => {
        const since = (await tx.getBoard(boardId))?.baseChecks?.since ?? null;
        const glob = since === null ? null : await tx.getGlob(since);
        if (glob !== null && glob.boardId === boardId && hasMerged(glob)) await this.collisions(tx, glob);
      });
    } catch (e) {
      this.deps.log?.('relation learning', e instanceof Error ? e.message : String(e));
    }
  }

  /** Whether any relation row of any kind joins the two globs, in either direction. */
  private async related(tx: Tx, a: string, b: string): Promise<boolean> {
    const rows = [...(await tx.listRelationsFrom([a, b])), ...(await tx.listWeakRelationsFrom([a, b]))];
    return rows.some((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a));
  }

  private async collisions(tx: Tx, glob: Glob): Promise<void> {
    const boardId = glob.boardId;
    const events = (await tx.listBoardEvents(boardId, glob.createdAt, ['ConflictFlagged'], [glob.id])).filter((e) => e.globId === glob.id);
    for (const e of events) {
      const since = e.data['since'];
      if (typeof since !== 'string' || since === glob.id) continue;
      const other = await tx.getGlob(since);
      if (other === null || other.boardId !== boardId || (await this.related(tx, glob.id, since))) continue;
      await this.record(tx, {
        boardId,
        from: glob.id,
        to: since,
        relationId: null,
        source: 'none',
        signal: 'fn_conflict',
        evidence: `${glob.id} conflicted with main after ${since} merged, and no relation joined them`,
        key: signalKey.conflict(glob.id, since),
      });
    }
    const board = await tx.getBoard(boardId);
    if (board?.baseChecks?.state !== 'failed' || board.baseChecks.since !== glob.id) return;
    const merges = await tx.listBoardEvents(boardId, glob.createdAt, ['Merged']);
    const others = new Set(merges.filter((m) => m.globId !== glob.id).map((m) => m.globId));
    const predicted = new Set((glob.impliedAfter ?? []).map((i) => i.id));
    for (const id of others) {
      const other = await tx.getGlob(id);
      if (other === null || other.boardId !== boardId || !hasMerged(other) || (await this.related(tx, glob.id, id))) continue;
      const collided = this.deps.uses === undefined ? predicted.has(id) : await this.deps.uses(glob, other);
      if (!collided) continue;
      await this.record(tx, {
        boardId,
        from: glob.id,
        to: id,
        relationId: null,
        source: 'none',
        signal: 'fn_red_main',
        evidence: `main went red at ${glob.id}, which ${this.deps.uses === undefined ? 'overlapped' : 'uses what was added by'} ${id}, and no relation joined them`,
        key: signalKey.redMain(glob.id, id),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Reading

  private async stateOf(tx: Tx, boardId: number): Promise<{ settings: RelationLearningSettings; stats: ReturnType<typeof precisionRecall> }> {
    const settings = await tx.getRelationLearning(boardId);
    const now = this.deps.clock.now();
    const windowDays = thresholdsOf(settings).windowDays;
    const since = new Date(Date.parse(now) - windowDays * DAY_MS).toISOString();
    return { settings, stats: precisionRecall(await tx.listRelationSignals(boardId, since), now, windowDays) };
  }

  /** How readily each source creates gating relations on the board now, read inside the caller's transaction (creation paths). */
  async posturesIn(tx: Tx, boardId: number): Promise<Record<RelationLearningSource, RelationSourcePosture>> {
    const { settings, stats } = await this.stateOf(tx, boardId);
    return posturesOf(stats, settings);
  }

  /** One source's posture; `auto` is read as `mention`. */
  async posture(boardId: number, source: RelationLearningSource | 'auto'): Promise<RelationSourcePosture> {
    return this.deps.store.transaction(async (tx) => (await this.posturesIn(tx, boardId))[source === 'auto' ? 'mention' : source]);
  }

  /** The board's metrics, postures and pins, for its members. */
  async view(email: string, boardId: number): Promise<Result<RelationLearningView>> {
    return this.deps.store.transaction(async (tx): Promise<Result<RelationLearningView>> => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      return ok(await this.viewIn(tx, boardId));
    });
  }

  /** The view without the member check, for callers already inside an authorised read (`get_context`). */
  async viewIn(tx: Tx, boardId: number): Promise<RelationLearningView> {
    const { settings, stats } = await this.stateOf(tx, boardId);
    const postures = posturesOf(stats, settings);
    const sources = RELATION_LEARNING_SOURCES.map((s): RelationSourceView => ({ ...stats[s], posture: postures[s] }));
    return { thresholds: thresholdsOf(settings), defaults: thresholdsOf(), sources, pins: settings };
  }

  // -------------------------------------------------------------------------
  // Pins (admins)

  /** Admins: pins thresholds or a source's posture over what was learned; the change goes in the pin history (the last 50). */
  async pin(email: string, boardId: number, input: unknown): Promise<Result<RelationLearningView>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<RelationLearningView>> => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const pins = validatePins(input);
      if (!pins.ok) return pins;
      const next = pinned(await tx.getRelationLearning(boardId), pins.value, { at: this.deps.clock.now(), by: email, what: `pinned ${JSON.stringify(pins.value)}` });
      await tx.setRelationLearning(boardId, next);
      return ok(await this.viewIn(tx, boardId));
    });
    if (result.ok) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    return result;
  }

  /** Admins: drops every pin, or one (a threshold's name or a source), so the learned value or the default applies again. */
  async resetPins(email: string, boardId: number, what?: string): Promise<Result<RelationLearningView>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<RelationLearningView>> => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const next = unpinned(await tx.getRelationLearning(boardId), what, { at: this.deps.clock.now(), by: email, what: what === undefined ? 'reset all pins' : `reset ${what}` });
      await tx.setRelationLearning(boardId, next);
      return ok(await this.viewIn(tx, boardId));
    });
    if (result.ok) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    return result;
  }
}
