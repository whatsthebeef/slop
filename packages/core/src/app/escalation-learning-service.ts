import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import {
  ESCALATION_EVENT_TYPES,
  criteriaOf,
  criterionForPaths,
  escalationCandidates,
  guidanceEvidence,
  guidanceStatement,
  OUTCOME_WEIGHT,
  recordKey,
} from '../domain/escalation-learning.js';
import type { EscalationCandidate, EscalationRecord, EscalationView } from '../domain/escalation-learning.js';
import type { Board } from '../domain/types.js';
import type { Hint, Notifier, Store, Tx } from '../ports.js';
import { adminOf, memberOf } from './access.js';
import { newLearningId } from './knowledge-service.js';
import type { RiskAreaService } from './risk-area-service.js';
import { createLearning } from './learning-writes.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the learning reads events: an outcome older than this is settled. */
const LOOKBACK_DAYS = 90;
const SUBMITTED_BY = 'slop';

/**
 * Escalation outcome learning (spec, Subs and escalation), the background half: each hour it reads the board's
 * escalations and merged subs, records every outcome once (`escalationCandidates`) with its cause, passes the signal to
 * the board's risk areas, and, when a criterion's stance changes, submits a KB learning for the admins to approve so the
 * agents' escalation guidance moves with it. The history is shown in board settings, with a reset for admins.
 */
export class EscalationLearningService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: { now(): string };
      /** Absent: outcomes are recorded but not passed to risk areas. */
      riskAreas?: RiskAreaService;
      /** Absent: a submitted learning's decision glob reaches the board on its next load. */
      notifier?: Notifier;
    },
  ) {}

  /** The board's criteria with their stance (learned vs default) and its history, for members. */
  async view(email: string, boardId: number): Promise<Result<EscalationView>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      return ok(this.read(await tx.listEscalationRecords(boardId)));
    });
  }

  /** Admins: criteria go back to the defaults. The history stays, with the reset in it. */
  async reset(email: string, boardId: number): Promise<Result<EscalationView>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      await tx.insertEscalationRecord({ boardId, at: now, globId: null, criterion: 'other', outcome: 'reset', weight: 0, cause: `Reset by ${email}` });
      return ok(this.read(await tx.listEscalationRecords(boardId)));
    });
  }

  private read(records: readonly EscalationRecord[]): EscalationView {
    return { criteria: criteriaOf(records), history: records };
  }

  /**
   * One pass over the board's recent globs: records the outcomes not yet recorded and, for each criterion whose stance
   * changed, submits one learning. Returns how many outcomes were recorded.
   */
  async learn(boardId: number, now: string): Promise<number> {
    const read = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return null;
      const since = new Date(Date.parse(now) - LOOKBACK_DAYS * DAY_MS).toISOString();
      const [events, globs, records, snapshots] = await Promise.all([
        tx.listBoardEvents(boardId, since, ESCALATION_EVENT_TYPES),
        tx.listGlobs(boardId, {}),
        tx.listEscalationRecords(boardId),
        tx.listLatestIntakeSnapshots(boardId),
      ]);
      return { board, events, globs, records, snapshots };
    });
    if (read === null) return 0;
    const { board, events, globs, records, snapshots } = read;
    const recorded = new Set(records.filter((r) => r.globId !== null).map((r) => recordKey(r.globId ?? '', r.outcome)));
    const planned = new Map(snapshots.map((s) => [s.globId, s.features.filePaths]));
    const candidates = escalationCandidates({ events, globs, recorded, now });
    let changed = 0;
    for (const candidate of candidates) {
      const paths = planned.get(candidate.globId) ?? [];
      const criterion = candidate.needsPaths ? criterionForPaths(paths) : candidate.criterion;
      if (await this.record(board, { ...candidate, criterion }, paths)) changed++;
    }
    return changed;
  }

  /** Records one outcome, passes it to the risk areas and, when it changes a criterion's stance, submits the learning. */
  private async record(board: Board, candidate: EscalationCandidate, paths: readonly string[]): Promise<boolean> {
    const hints: Hint[] = [];
    const stored = await this.deps.store.transaction(async (tx) => {
      // A retried transaction starts again, so it publishes only what its last attempt made.
      hints.length = 0;
      const before = criteriaOf(await tx.listEscalationRecords(board.id));
      const inserted = await tx.insertEscalationRecord({
        boardId: board.id,
        at: candidate.at,
        globId: candidate.globId,
        criterion: candidate.criterion,
        outcome: candidate.outcome,
        weight: candidate.weight,
        cause: candidate.cause,
      });
      if (!inserted) return false;
      const records = await tx.listEscalationRecords(board.id);
      const after = criteriaOf(records).find((c) => c.criterion === candidate.criterion);
      const was = before.find((c) => c.criterion === candidate.criterion);
      if (after !== undefined && was !== undefined && after.stance !== was.stance) {
        hints.push(...(await this.submit(tx, board, candidate, after.stance, records)));
      }
      return true;
    });
    if (!stored) return false;
    for (const hint of hints) this.deps.notifier?.publish(hint);
    await this.passToRiskAreas(board.id, candidate, paths);
    return true;
  }

  /**
   * A learning for the board's admins: the guidance for a criterion whose stance changed, fronted by its decision glob
   * like every other new KB item. Never edits the knowledge itself. Returns what to publish after the commit.
   */
  private async submit(
    tx: Tx,
    board: Board,
    candidate: EscalationCandidate,
    stance: 'loosened' | 'default' | 'strengthened',
    records: readonly EscalationRecord[],
  ): Promise<Hint[]> {
    const id = await newLearningId(tx, board.id);
    const hints: Hint[] = [];
    // Slop raised it from outcomes, as mining does: a mined proposal.
    const created = await createLearning(
      tx,
      { clock: this.deps.clock, raise: (h) => hints.push(h) },
      {
        id,
        boardId: board.id,
        type: 'agent-behaviour',
        statement: guidanceStatement(candidate.criterion, stance),
        evidence: guidanceEvidence(candidate.criterion, records),
        suggestedTarget: 'risk_and_size',
        sourceGlobIds: [candidate.globId],
        agentSetVersion: board.agentSetVersion,
        submittedBy: SUBMITTED_BY,
        createdAt: this.deps.clock.now(),
        document: null,
        target: null,
        source: 'mined',
      },
    );
    if (!created) throw new Error(`KB item ${id} already exists`);
    return hints;
  }

  /**
   * The outcome as a risk-area signal, for escalations made for a risk area and for a person's de-escalation (a strong
   * correction). Missed escalations reach the areas through their own revert and bug learning, so they aren't passed again.
   */
  private async passToRiskAreas(boardId: number, c: EscalationCandidate, paths: readonly string[]): Promise<void> {
    const areas = this.deps.riskAreas;
    if (areas === undefined || c.outcome === 'missed') return;
    const deescalated = c.weight === OUTCOME_WEIGHT.deescalated;
    if (!deescalated && c.criterion !== 'risk_area') return;
    const kind = c.outcome === 'justified' ? 'blocked' : deescalated ? 'type_to_sub' : 'clean';
    await areas.record(boardId, { kind, globId: c.globId, paths, at: c.at });
  }
}
