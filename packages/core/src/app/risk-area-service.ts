import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import {
  CLEAN_WINDOW_DAYS,
  applyOutcome,
  defaultAreas,
  evidenceGlobs,
  isWideArea,
  MIN_EVIDENCE_GLOBS,
  subSafe,
} from '../domain/risk-area.js';
import type { RiskArea, RiskAreaView, RiskOutcome } from '../domain/risk-area.js';
import { SUB_LIMIT_WINDOW_DAYS, namesGlob, nearLimit } from '../domain/sub-limit.js';
import type { Board } from '../domain/types.js';
import type { ChangeSource, Store, Tx } from '../ports.js';
import { adminOf, memberOf } from './access.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the learning reads events: a merge older than this is settled. */
const LOOKBACK_DAYS = 90;
const EVENTS = ['Merged', 'MergeReverted', 'DeployFailed'] as const;

/** Seeds the defaults when the board has no areas yet, and returns the areas. */
const seeded = async (tx: Tx, boardId: number, now: string): Promise<RiskArea[]> => {
  const stored = await tx.listRiskAreas(boardId);
  if (stored.length > 0) return stored;
  const areas = defaultAreas(boardId, now);
  for (const area of areas) await tx.putRiskArea(area);
  return areas;
};

/**
 * Per-board risk areas (spec, Intake): the work that needs a human review. Seeds the defaults on first use, shows the
 * areas and their history, resets them, and learns from outcomes (`applyOutcome`): the sub-limit learning, a person's
 * correction of intake's type, and the board's merge, revert and deploy events, read hourly.
 */
export class RiskAreaService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: { now(): string };
      /** Null without a code host: a merged sub's paths come from its plan only. */
      changes?: ChangeSource | null;
      /**
       * De-escalates the globs in Planning that were escalated only for the named (gone) risk areas, and returns how many.
       * Absent: the cleanup drops areas but leaves the globs as they are.
       */
      lift?: (boardId: number, names: readonly string[]) => Promise<number>;
    },
  ) {}

  /** The board's areas (defaults seeded on first use) and history, for members. */
  async view(email: string, boardId: number): Promise<Result<RiskAreaView>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      return ok(await this.read(tx, boardId));
    });
  }

  /** Admins: drops the learned areas, restores the defaults as they were and keeps the history. */
  async reset(email: string, boardId: number): Promise<Result<RiskAreaView>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      for (const area of await tx.listRiskAreas(boardId)) if (area.source === 'learned') await tx.deleteRiskArea(boardId, area.name);
      for (const area of defaultAreas(boardId, now)) await tx.putRiskArea(area);
      await tx.insertRiskAreaChange({ boardId, at: now, areaName: null, kind: 'reset', globId: null, cause: 'reset' });
      return ok(await this.read(tx, boardId));
    });
  }

  /** Admins: removes one learned area (a default is reset instead); the history keeps why it was there. */
  async remove(email: string, boardId: number, name: string): Promise<Result<RiskAreaView>> {
    const now = this.deps.clock.now();
    const removed = await this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      const area = (await tx.listRiskAreas(boardId)).find((a) => a.name === name);
      if (area === undefined) return notFound(`No risk area ${name}`);
      if (area.source !== 'learned') return invalidInput('Only a learned area can be removed; reset restores the defaults');
      await tx.deleteRiskArea(boardId, name);
      await tx.insertRiskAreaChange({ boardId, at: now, areaName: name, kind: 'removed', globId: null, cause: 'reset' });
      return ok(await this.read(tx, boardId));
    });
    if (removed.ok) await this.lift(boardId);
    return removed;
  }

  /** De-escalates the unstarted globs escalated only for areas that no longer exist (every pass, so a failed one is retried). */
  private async lift(boardId: number): Promise<void> {
    const lift = this.deps.lift;
    if (lift === undefined) return;
    const gone = await this.deps.store.transaction(async (tx) => {
      const present = new Set((await tx.listRiskAreas(boardId)).map((a) => a.name));
      const names = (await tx.listRiskAreaChanges(boardId)).flatMap((c) => (c.kind === 'removed' && c.areaName !== null && !present.has(c.areaName) ? [c.areaName] : []));
      return [...new Set(names)];
    });
    if (gone.length > 0) await lift(boardId, gone);
  }

  /**
   * Drops the learned areas that break the rule for them (a package or app root, or fewer than `MIN_EVIDENCE_GLOBS` separate
   * globs of evidence in the history), keeping a `removed` row for each in the history, then de-escalates the globs in
   * Planning that were escalated only for an area that is gone (retried on every pass). Idempotent. Returns the dropped names.
   */
  async cleanup(boardId: number): Promise<string[]> {
    const now = this.deps.clock.now();
    const dropped = await this.deps.store.transaction(async (tx) => {
      const history = await tx.listRiskAreaChanges(boardId);
      const names: string[] = [];
      for (const area of await tx.listRiskAreas(boardId)) {
        if (area.source !== 'learned') continue;
        if (!isWideArea(area) && evidenceGlobs(history, area.name).length >= MIN_EVIDENCE_GLOBS) continue;
        await tx.deleteRiskArea(boardId, area.name);
        await tx.insertRiskAreaChange({ boardId, at: now, areaName: area.name, kind: 'removed', globId: null, cause: 'cleanup' });
        names.push(area.name);
      }
      return names;
    });
    await this.lift(boardId);
    return dropped;
  }

  /**
   * Applies one outcome, once per glob and kind. Returns whether it changed anything (an outcome already applied, or
   * one no area is affected by, doesn't).
   */
  async record(boardId: number, outcome: RiskOutcome): Promise<boolean> {
    return this.deps.store.transaction(async (tx) => {
      const history = await tx.listRiskAreaChanges(boardId);
      if (history.some((c) => c.globId === outcome.globId && c.cause === outcome.kind)) return false;
      const areas = await seeded(tx, boardId, outcome.at);
      const applied = applyOutcome(boardId, areas, outcome, history);
      for (const area of applied.put) await tx.putRiskArea(area);
      for (const name of applied.removed) await tx.deleteRiskArea(boardId, name);
      for (const change of applied.changes) await tx.insertRiskAreaChange(change);
      // An outcome that changes no area is still marked done (a row without an area), so `learn` doesn't redo it hourly.
      if (applied.changes.length === 0)
        await tx.insertRiskAreaChange({ boardId, at: outcome.at, areaName: null, kind: outcome.kind === 'clean' ? 'clean' : 'strengthened', globId: outcome.globId, cause: outcome.kind });
      return applied.changes.length > 0;
    });
  }

  /**
   * One hourly pass over the board's recent merges: a revert or a failed deploy after the merge is a bad outcome for the
   * sub's paths; a sub merged at least `CLEAN_WINDOW_DAYS` ago with none of those, no bug naming it and no needed fix
   * recorded by the sub-limit learning is clean. Returns how many outcomes changed areas.
   */
  async learn(boardId: number, now: string): Promise<number> {
    await this.cleanup(boardId);
    const read = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return null;
      const since = new Date(Date.parse(now) - LOOKBACK_DAYS * DAY_MS).toISOString();
      const [events, globs, snapshots, limitChanges, history] = await Promise.all([
        tx.listBoardEvents(boardId, since, EVENTS),
        tx.listGlobs(boardId, {}),
        tx.listLatestIntakeSnapshots(boardId),
        tx.listSubLimitChanges(boardId),
        tx.listRiskAreaChanges(boardId),
      ]);
      return { board, events, globs, snapshots, limitChanges, done: new Set(history.map((c) => `${c.globId ?? ''}:${c.cause}`)) };
    });
    if (read === null) return 0;
    const { board, events, globs, snapshots, limitChanges, done } = read;
    const planned = new Map(snapshots.map((s) => [s.globId, s.features.filePaths]));
    const bugs = globs.filter((g) => g.category === 'bug');
    const merges = new Map<string, { at: string; sha: string }>();
    for (const e of events)
      if (e.type === 'Merged') merges.set(e.globId, { at: e.at, sha: typeof e.data.sha === 'string' ? e.data.sha : '' });
    const pathsOf = async (globId: string): Promise<readonly string[]> => {
      const merge = merges.get(globId);
      const diff = merge === undefined || merge.sha === '' ? null : await this.merged(board, merge.sha);
      return diff ?? planned.get(globId) ?? [];
    };
    let changed = 0;
    for (const e of events) {
      const merge = merges.get(e.globId);
      const kind = e.type === 'MergeReverted' ? 'reverted' : e.type === 'DeployFailed' && merge !== undefined && e.at >= merge.at ? 'deploy_failed' : null;
      if (kind === null || done.has(`${e.globId}:${kind}`)) continue;
      done.add(`${e.globId}:${kind}`);
      if (await this.record(boardId, { kind, globId: e.globId, paths: await pathsOf(e.globId), at: e.at })) changed++;
    }
    // Signals the sub-limit learning couldn't pass on (it logs a failure and goes on): its needed-fix rows say them again.
    for (const row of limitChanges) {
      if (row.outcome !== 'needed_fixes') continue;
      const kind = /^s\d+[ftb]\d+: "/.test(row.evidence) ? 'bug' : row.toLines === row.fromLines && row.changedLines !== null && !nearLimit(row.changedLines, row.fromLines) ? 'small_fix' : null;
      if (kind === null || done.has(`${row.globId}:${kind}`)) continue;
      done.add(`${row.globId}:${kind}`);
      if (await this.record(boardId, { kind, globId: row.globId, paths: await pathsOf(row.globId), at: row.at })) changed++;
    }
    const bad = new Set(events.filter((e) => e.type === 'MergeReverted' || e.type === 'DeployFailed').map((e) => e.globId));
    const fixed = new Set(limitChanges.filter((c) => c.outcome === 'needed_fixes').map((c) => c.globId));
    for (const glob of globs) {
      const merge = merges.get(glob.id);
      if (merge === undefined || glob.type !== 'sub' || done.has(`${glob.id}:clean`)) continue;
      const mergedMs = Date.parse(merge.at);
      if (Date.parse(now) < mergedMs + CLEAN_WINDOW_DAYS * DAY_MS || bad.has(glob.id) || fixed.has(glob.id)) continue;
      const blamed = bugs.some(
        (b) =>
          Date.parse(b.createdAt) >= mergedMs &&
          Date.parse(b.createdAt) <= mergedMs + SUB_LIMIT_WINDOW_DAYS * DAY_MS &&
          namesGlob(b.title, glob.id),
      );
      if (blamed) continue;
      if (await this.record(boardId, { kind: 'clean', globId: glob.id, paths: await pathsOf(glob.id), at: now })) changed++;
    }
    return changed;
  }

  /**
   * Records an outcome of a merged glob whose paths aren't at hand: the merge commit's files, else the paths its plan
   * named at intake.
   */
  async recordFor(board: Board, kind: RiskOutcome['kind'], globId: string, sha: string, at: string): Promise<boolean> {
    const diff = sha === '' ? null : await this.merged(board, sha);
    const paths =
      diff ??
      (await this.deps.store.transaction((tx) => tx.listLatestIntakeSnapshots(board.id))).find((x) => x.globId === globId)?.features.filePaths ??
      [];
    return this.record(board.id, { kind, globId, paths, at });
  }

  /** A merge commit's files; null when there is no code host or it fails. */
  private async merged(board: Board, sha: string): Promise<readonly string[] | null> {
    const source = this.deps.changes;
    if (source === undefined || source === null) return null;
    try {
      return (await source.mergedDiff(board, sha))?.files ?? null;
    } catch {
      return null;
    }
  }

  private async read(tx: Tx, boardId: number): Promise<RiskAreaView> {
    const areas = await seeded(tx, boardId, this.deps.clock.now());
    const history = await tx.listRiskAreaChanges(boardId);
    return {
      areas: areas.map((a) => ({ ...a, subSafe: subSafe(a), evidence: a.source === 'learned' ? evidenceGlobs(history, a.name) : [] })),
      history,
    };
  }
}
