import {
  effectBasisOf,
  effectEvidence,
  effectGlobs,
  effectSignalKey,
  effectStatement,
  evaluateEffect,
  isEffectMeasured,
  raisesItem,
  startEffectCheck,
} from '../domain/effect-check.js';
import type {
  EffectCheck,
  EffectFigures,
  EffectGlob,
  EffectState,
} from '../domain/effect-check.js';
import {
  learningDecision,
  learningEffectCheck,
  learningFacts,
  learningOutcome,
  learningStatus,
  learningTarget,
} from '../domain/learning.js';
import type { LearningRead } from '../domain/learning.js';
import { MAX_SIGNAL_GLOBS, signalKindOf } from '../domain/signals.js';
import type { BoardActivity, BoardJobResult, KbSignal } from '../domain/signals.js';
import type { Board } from '../domain/types.js';
import type { Hint, Notifier, Store, Tx } from '../ports.js';
import { newLearningId } from './knowledge-service.js';
import { MINED_BY } from './mining-service.js';
import type { MiningService } from './mining-service.js';
import { boardLearnings, readLearning } from './learning-reads.js';
import { createLearning, recordLearningEffectCheck } from './learning-writes.js';

export type EffectCheckResult = Extract<BoardJobResult, { kind: 'effect_check' }>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far before a watched approval every run's activity reaches: the before side's globs merged in it. */
export const EFFECT_LOOKBACK_DAYS = 365;

/**
 * Whether an item's effect check still runs: approved with a signal the check measures, and absent (approved before
 * checks) or watching.
 */
const isWatched = ({ glob, artifacts }: LearningRead): boolean => {
  const signal = learningFacts(glob).signal;
  const check = learningEffectCheck(artifacts);
  return (
    learningStatus(glob, artifacts) === 'approved' &&
    signal !== null &&
    isEffectMeasured(signal.key) &&
    learningDecision(glob, artifacts).at !== null &&
    (check === null || check.state === 'watching')
  );
};

/** A conditional write lost to another writer; thrown so the item's transaction (and any raised item) rolls back. */
class EffectCheckConflict extends Error {
  constructor(id: string) {
    super(`KB item ${id} changed during its effect check`);
  }
}

/**
 * The daily effect check (spec, self-improvement: "Effect check"): for each approved item with a signal, compares
 * the signal over the board's last N eligible globs merged before the approval with the first N merged after it that
 * ran with the change, N from the board's setting. Figures are refreshed while it watches; once the after side has N
 * globs the verdict is final, and a change that didn't work (or made another signal markedly worse) raises a mined
 * revise-or-revert item that goes through the KB pipeline. No LLM calls.
 */
export class EffectCheckService {
  constructor(private readonly deps: { store: Store; notifier: Notifier; mining: MiningService }) {}

  /** A run over the board's watched items, or over `only` those of them (an approval's check, see `LearningJobService`). */
  async check(boardId: number, now: string, only?: readonly string[]): Promise<EffectCheckResult> {
    const read = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) throw new Error(`No board ${boardId}`);
      const items = (await boardLearnings(tx, boardId)).filter(
        (i) => isWatched(i) && (only === undefined || only.includes(i.glob.id)),
      );
      if (items.length === 0) return null;
      const earliest = Math.min(...items.map((i) => Date.parse(learningDecision(i.glob, i.artifacts).at ?? now)));
      const from = new Date(earliest - EFFECT_LOOKBACK_DAYS * DAY_MS).toISOString();
      const activity = await this.deps.mining.activity(tx, boardId, now, null, from);
      return { board, items, activity };
    });
    if (read === null) return { kind: 'effect_check', watching: 0, decided: [], raised: [] };
    const { board, items, activity } = read;
    const globs = effectGlobs(activity);

    let watching = 0;
    let written = false;
    const decided: { id: string; state: EffectState }[] = [];
    const raised: string[] = [];
    const hints: Hint[] = [];
    for (const { glob: item } of items) {
      let outcome: { state: EffectState; raisedItemId: string | null } | null;
      try {
        outcome = await this.deps.store.transaction((tx) =>
          this.checkItem(tx, board, item.id, activity, globs, now, hints),
        );
      } catch (error) {
        // Someone else wrote the item meanwhile: the next run checks it again.
        if (error instanceof EffectCheckConflict) continue;
        throw error;
      }
      if (outcome === null) continue;
      written = true;
      if (outcome.state === 'watching') watching++;
      else decided.push({ id: item.id, state: outcome.state });
      if (outcome.raisedItemId !== null) raised.push(outcome.raisedItemId);
    }
    for (const hint of hints) this.deps.notifier.publish(hint);
    if (written) this.deps.notifier.publish({ kind: 'board.kb', boardId });
    return { kind: 'effect_check', watching, decided, raised };
  }

  /**
   * One item's check, under the board's effect-check lock: the item is read again, so a run that waited on another
   * sees its verdict and raised item and does nothing. Null when the item no longer needs checking.
   */
  private async checkItem(
    tx: Tx,
    board: Board,
    itemId: string,
    activity: BoardActivity,
    globs: readonly EffectGlob[],
    now: string,
    hints: Hint[],
  ): Promise<{ state: EffectState; raisedItemId: string | null } | null> {
    await tx.lockBoardJob(board.id, 'effect_check');
    const item = await readLearning(tx, itemId);
    if (item === null || !isWatched(item)) return null;
    const { glob, artifacts } = item;
    const signal = learningFacts(glob).signal;
    const decidedAt = learningDecision(glob, artifacts).at;
    if (signal === null || decidedAt === null) return null;
    // Approved before effect checks: watched from the approval, by its outcome.
    const started =
      learningEffectCheck(artifacts) ??
      startEffectCheck(signal, effectBasisOf(learningOutcome(artifacts), decidedAt), board.effectCheckGlobs);
    // A watching check follows the board's setting; a final one keeps the N it was decided on.
    const watched = { ...started, n: board.effectCheckGlobs };
    const check: EffectCheck = {
      ...watched,
      ...evaluateEffect(activity, globs, watched, decidedAt),
      checkedAt: now,
    };
    const raisedItemId = raisesItem(check.state)
      ? await this.raise(tx, board, item, signal, decidedAt, check, now, hints)
      : null;
    // The glob's version moved if the pipeline or a person wrote it meanwhile: roll back with any raised item.
    const written = await recordLearningEffectCheck(
      tx,
      { clock: { now: () => now }, raise: (h) => hints.push(h) },
      glob.id,
      glob.version,
      { ...check, raisedItemId },
    );
    if (!written) throw new EffectCheckConflict(glob.id);
    return { state: check.state, raisedItemId };
  }

  /** The revise-or-revert item: mined, of the original's type, aimed at the original's target, through the KB pipeline. */
  private async raise(
    tx: Tx,
    board: Board,
    original: LearningRead,
    watched: KbSignal,
    decidedAt: string,
    check: EffectCheck,
    now: string,
    hints: Hint[],
  ): Promise<string> {
    const { after } = check;
    const { glob } = original;
    if (after === null) throw new Error(`${glob.id}'s effect check has no figures`);
    const id = await newLearningId(tx, board.id);
    const signal: KbSignal = {
      key: effectSignalKey(glob.id),
      kind: signalKindOf(check.key) ?? watched.kind,
      agent: watched.agent,
      label: check.label,
      window: { from: decidedAt, to: now },
      figures: signalFigures(after),
      globIds: after.affectedGlobIds.slice(0, MAX_SIGNAL_GLOBS),
      examples: [],
      measuredAt: now,
    };
    const created = await createLearning(
      tx,
      { clock: { now: () => now }, raise: (h) => hints.push(h) },
      {
        id,
        boardId: board.id,
        type: learningFacts(glob).kind,
        statement: effectStatement({ id: glob.id, statement: glob.summary }, check),
        evidence: effectEvidence({ id: glob.id, decidedAt }, check),
        suggestedTarget: targetOf(original),
        sourceGlobIds: [
          ...new Set([...after.affectedGlobIds, ...check.worse.flatMap((w) => w.after.affectedGlobIds)]),
        ].slice(0, MAX_SIGNAL_GLOBS),
        agentSetVersion: board.agentSetVersion,
        submittedBy: MINED_BY,
        createdAt: now,
        document: null,
        target: null,
        source: 'mined',
        signal,
      },
    );
    if (!created) throw new Error(`KB item ${id} already exists`);
    return id;
  }
}

const signalFigures = (f: EffectFigures): KbSignal['figures'] => ({
  affected: f.affected,
  eligible: f.eligible,
  rate: f.rate,
  count: f.affected,
});

/** Where the original change went: the document or agent file it was applied to, else its target or the submitter's hint. */
const targetOf = ({ glob, artifacts }: LearningRead): string | null => {
  const outcome = learningOutcome(artifacts);
  const target = learningTarget(glob);
  return outcome?.kind === 'applied' ? outcome.name : (target.routed?.name ?? target.suggested);
};
