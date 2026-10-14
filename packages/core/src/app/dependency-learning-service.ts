import type { Result } from '../domain/errors.js';
import { notFound, ok } from '../domain/errors.js';
import {
  NO_DEFAULTS,
  PREDICT_MIN,
  candidatePatterns,
  defaultWeight,
  movedRule,
  patternsCovering,
  predictedFiles,
  unmergedPrerequisiteIds,
  weightsOf,
} from '../domain/dependency-rules.js';
import type {
  DependencyCause,
  DependencyDefaults,
  DependencyRule,
  DependencyRuleChange,
  DependencyRuleView,
} from '../domain/dependency-rules.js';
import type { ImpliedAfter, Glob, Relation } from '../domain/types.js';
import { MAX_RELATIONS, hasMerged, isActive, wouldCycle } from '../domain/relations.js';
import type { Catalog, IdGenerator, Notifier, Store, Tx } from '../ports.js';
import { adminOf, memberOf } from './access.js';
import { readMergePolicy } from './knowledge-service.js';

/** What the board's dependency rules say, for predicting overlaps: the patterns, their weights and the catalog defaults. */
export interface DependencyPrediction {
  readonly patterns: readonly string[];
  readonly weights: ReadonlyMap<string, number>;
  readonly defaults: DependencyDefaults;
}

/** The board's rules and history, for board settings. */
export interface DependencyRulesView {
  readonly rules: readonly DependencyRuleView[];
  readonly history: readonly DependencyRuleChange[];
  /** The weight below which a pattern is no longer predicted. */
  readonly predictMin: number;
}

/** The strings in a stored list; anything else is ignored. */
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

const merged = hasMerged;

/** The overlaps predicted for a glob (internal data kept on the glob; never shown): entries with no kind, or `overlaps`, not overridden. */
const predictedOverlaps = (glob: Glob): ImpliedAfter[] => (glob.impliedAfter ?? []).filter((i) => (i.kind ?? 'overlaps') === 'overlaps' && i.overridden !== true);

/**
 * Learns, per board, which dependency edges are real (spec, Dependencies). Outcomes move the weight of the path patterns
 * overlaps are predicted from, each recorded once per board, glob, pattern and cause:
 * - an overlap that merged with no conflict and no rework weakens its patterns (three in a row stop a default pattern);
 * - one that conflicted or needed a rebase strengthens them;
 * - a run that failed for unmerged prerequisites makes them a learned `needs` of the glob (an overlap on the same
 *   glob is upgraded) and strengthens the patterns of the edge;
 * - a `needs` that a person overrode with Start now, whose glob then merged without failing for it, drops to an
 *   overlap and weakens its patterns.
 * Cross-board promotion stays a human step (`submit_learning`); nothing here leaves the board.
 */
export class DependencyLearningService {
  constructor(
    private readonly deps: {
      store: Store;
      notifier: Notifier;
      clock: { now(): string };
      /** Names the relations it writes (learned needs). */
      ids: IdGenerator;
      /** Absent: no defaults, so only the board's merge policy is predicted from. */
      catalog?: Catalog;
    },
  ) {}

  private async defaults(): Promise<DependencyDefaults> {
    return (await this.deps.catalog?.dependencyDefaults?.()) ?? NO_DEFAULTS;
  }

  /** The patterns and weights the board predicts overlaps with now. */
  async prediction(boardId: number): Promise<DependencyPrediction> {
    const defaults = await this.defaults();
    return this.deps.store.transaction(async (tx) => {
      const policy = await readMergePolicy(tx, boardId);
      const patterns = candidatePatterns(policy.exclusivePaths, defaults);
      return { patterns, weights: weightsOf(patterns, await tx.listDependencyRules(boardId), defaults), defaults };
    });
  }

  /** The files an overlap is predicted from, given the board's current rules. */
  static predicted(prediction: DependencyPrediction, files: readonly string[]): string[] {
    return predictedFiles(files, prediction.patterns, prediction.weights, prediction.defaults);
  }

  /** Moves one pattern's weight for an outcome, once per glob and cause; false when it was already recorded. */
  private async move(
    tx: Tx,
    boardId: number,
    defaults: DependencyDefaults,
    pattern: string,
    cause: DependencyCause,
    globId: string,
    evidence: string,
  ): Promise<boolean> {
    const learned = (await tx.listDependencyRules(boardId)).find((r) => r.pattern === pattern);
    const from = learned?.weight ?? defaultWeight(pattern, defaults);
    const now = this.deps.clock.now();
    const next = movedRule(boardId, pattern, learned, from, cause, now);
    if (!(await tx.insertDependencyRuleChange({ boardId, at: now, pattern, from, to: next.weight, cause, globId, evidence }))) return false;
    await tx.upsertDependencyRule(next);
    return true;
  }

  /**
   * A glob merged: records how its overlaps went and downgrades the needs a person overrode that proved not needed.
   * Safe to repeat (the outbox may deliver the merge again).
   */
  async onMerged(globId: string): Promise<void> {
    const defaults = await this.defaults();
    const changed = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null || !merged(glob)) return null;
      const policy = await readMergePolicy(tx, glob.boardId);
      const patterns = candidatePatterns(policy.exclusivePaths, defaults);
      const events = (await tx.listBoardEvents(glob.boardId, glob.createdAt, ['ConflictFlagged', 'BehindChanged', 'HoldOverridden', 'EdgeDismissed', 'RelationDismissed'])).filter(
        (e) => e.globId === glob.id,
      );
      const conflicted = events.some((e) => e.type === 'ConflictFlagged');
      const reworked = events.some((e) => e.type === 'BehindChanged' && typeof e.data['behindBy'] === 'number' && e.data['behindBy'] > 0 && Array.isArray(e.data['files']) && e.data['files'].length > 0);
      let touched = false;
      for (const edge of predictedOverlaps(glob)) {
        const cause: DependencyCause = conflicted || reworked ? 'conflicted_overlap' : 'clean_overlap';
        const evidence = `${glob.id} merged ${conflicted ? 'after a conflict' : reworked ? 'after rebasing on main' : 'with no conflict or rework'}; overlap with ${edge.id}`;
        for (const pattern of patternsCovering(edge.paths, patterns)) {
          if (await this.move(tx, glob.boardId, defaults, pattern, cause, glob.id, evidence)) touched = true;
        }
      }
      // A person dismissed an inferred edge: the inference was wrong, so weaken the patterns it came from. Start now
      // (overridden without a dismissal) is not a signal here.
      const mine = await tx.listRelationsFrom([glob.id]);
      for (const e of events.filter((ev) => (ev.type === 'EdgeDismissed' || ev.type === 'RelationDismissed') && ev.data['source'] === 'inferred')) {
        const id = typeof e.data['edgeId'] === 'string' ? e.data['edgeId'] : typeof e.data['to'] === 'string' ? e.data['to'] : null;
        if (id === null) continue;
        // Only a dismissed need teaches the file patterns: a decision or a merge or sign-off relation says nothing about overlaps.
        if (e.data['gate'] !== undefined && e.data['gate'] !== 'start') continue;
        const dismissed = mine.find((r) => r.to === id && r.gate === 'start');
        if (dismissed?.until === 'decided') continue;
        const paths = dismissed?.evidence ?? [];
        const evidence = `${glob.id} dismissed the inferred edge to ${id} as not a dependency`;
        const covering = patternsCovering(paths, patterns);
        if (covering.length === 0) {
          if (await tx.insertDependencyRuleChange({ boardId: glob.boardId, at: this.deps.clock.now(), pattern: `edge ${glob.id} -> ${id}`, from: 1, to: 1, cause: 'edge_dismissed', globId: glob.id, evidence })) touched = true;
        }
        for (const pattern of covering) if (await this.move(tx, glob.boardId, defaults, pattern, 'edge_dismissed', glob.id, evidence)) touched = true;
      }
      // Start now on a need, then a merge that never failed for it: the need was an overlap. Only the inferred and learned
      // relations Start now overrode (`overriddenAt`) are downgraded: the relation goes and the predicted overlap stays.
      const overridden = events.filter((e) => e.type === 'HoldOverridden').flatMap((e) => stringsOf(e.data['for']));
      const history = await tx.listDependencyRuleChanges(glob.boardId);
      const failedFor = new Set(history.filter((c) => c.globId === glob.id && c.cause === 'unmerged_prerequisite').map((c) => c.evidence));
      let next: Glob = glob;
      const released: Relation[] = [];
      for (const id of new Set(overridden)) {
        const edge = mine.find((r) => r.to === id && r.gate === 'start' && r.overriddenAt !== null);
        if (edge === undefined || [...failedFor].some((text) => text.includes(id))) continue;
        const evidence = `${glob.id} started anyway without ${id} and merged without failing for it`;
        const downgraded: ImpliedAfter = { id, paths: edge.evidence, kind: 'overlaps', source: 'learned', evidence };
        next = { ...next, impliedAfter: [...(next.impliedAfter ?? []).filter((i) => i.id !== id), downgraded] };
        released.push(edge);
        const covering = patternsCovering(edge.evidence, patterns);
        if (covering.length === 0) {
          await tx.insertDependencyRuleChange({ boardId: glob.boardId, at: this.deps.clock.now(), pattern: `edge ${glob.id} -> ${id}`, from: 1, to: 1, cause: 'start_anyway_succeeded', globId: glob.id, evidence });
        }
        for (const pattern of covering) await this.move(tx, glob.boardId, defaults, pattern, 'start_anyway_succeeded', glob.id, evidence);
        touched = true;
      }
      if (next !== glob && !(await tx.updateGlob({ ...next, version: glob.version + 1 }, glob.version))) throw new Error(`${glob.id} changed during dependency learning`);
      for (const r of released) await tx.deleteRelation(r.id);
      if (released.length > 0) {
        await tx.appendEvents(released.map((r) => ({ type: 'RelationReleased' as const, globId: glob.id, actor: null, at: this.deps.clock.now(), data: { to: r.to, gate: r.gate, reason: 'downgraded to an overlap: it started anyway and merged without failing for it' } })));
      }
      return touched ? glob.boardId : null;
    });
    if (changed !== null) this.deps.notifier.publish({ kind: 'board.changed', boardId: changed });
  }

  /**
   * A run failed (`report_failure`). When its reason says prerequisites weren't merged, the globs it names become learned
   * needs of this glob, and an overlap on one of them is upgraded and its patterns strengthened. Returns the IDs learned.
   */
  async onFailed(globId: string, reason: string): Promise<string[]> {
    const defaults = await this.defaults();
    const learned = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return [];
      const named = [...new Set(reason.match(/\bs\d+[a-z]\d+\b/g) ?? [])].filter((id) => id !== glob.id);
      const found = named.length === 0 ? [] : await tx.getGlobs(named);
      const byId = new Map(found.filter((g) => g.boardId === glob.boardId).map((g) => [g.id, g]));
      // The board's relations are read under its lock: two failures learning needs on each other must see each other's.
      await tx.lockBoardRelations(glob.boardId);
      const board = await tx.listRelations(glob.boardId);
      const ids = unmergedPrerequisiteIds(reason, new Set(byId.keys()), glob.id).filter((id) => {
        const dep = byId.get(id);
        return dep !== undefined && !hasMerged(dep) && !wouldCycle(board, { from: glob.id, to: id, gate: 'start', until: 'merged' });
      });
      if (ids.length === 0) return [];
      const policy = await readMergePolicy(tx, glob.boardId);
      const patterns = candidatePatterns(policy.exclusivePaths, defaults);
      let next: Glob = glob;
      const added: string[] = [];
      const now = this.deps.clock.now();
      for (const id of ids) {
        const evidence = `${glob.id} failed: ${reason.slice(0, 160)}`;
        if (board.some((r) => r.from === glob.id && r.to === id && r.gate === 'start')) {
          // Already a need: the failure confirms it (and keeps a later start now from downgrading it).
          await tx.insertDependencyRuleChange({ boardId: glob.boardId, at: now, pattern: `edge ${glob.id} -> ${id}`, from: 1, to: 1, cause: 'unmerged_prerequisite', globId: glob.id, evidence });
          continue;
        }
        // The limit every relation writer keeps: a glob with this many start relations learns no more.
        if (board.filter((r) => r.from === glob.id && r.gate === 'start' && isActive(r)).length >= MAX_RELATIONS) continue;
        added.push(id);
        // A predicted overlap on the same glob is upgraded: its paths become the need's evidence and the overlap entry goes.
        const overlap = (glob.impliedAfter ?? []).find((i) => i.id === id && (i.kind ?? 'overlaps') === 'overlaps');
        const paths = overlap?.paths ?? [];
        const relation: Relation = {
          id: `rel_${this.deps.ids.runId()}`,
          boardId: glob.boardId,
          from: glob.id,
          to: id,
          gate: 'start',
          until: 'merged',
          reason: evidence,
          evidence: paths,
          source: 'learned',
          dismissedAt: null,
          dismissedPlanHash: null,
          overriddenAt: null,
          createdAt: now,
        };
        await tx.insertRelation(relation);
        board.push(relation);
        await tx.appendEvents([{ type: 'RelationAdded', globId: glob.id, actor: null, at: now, data: { to: id, gate: 'start', until: 'merged', source: 'learned', reason: evidence } }]);
        next = { ...next, impliedAfter: (next.impliedAfter ?? []).filter((i) => i.id !== id) };
        const covering = patternsCovering(paths, patterns);
        if (covering.length === 0) {
          await tx.insertDependencyRuleChange({ boardId: glob.boardId, at: this.deps.clock.now(), pattern: `edge ${glob.id} -> ${id}`, from: 1, to: 1, cause: 'unmerged_prerequisite', globId: glob.id, evidence });
        }
        for (const pattern of covering) await this.move(tx, glob.boardId, defaults, pattern, 'unmerged_prerequisite', glob.id, evidence);
      }
      if (added.length === 0) return [];
      if (!(await tx.updateGlob({ ...next, version: glob.version + 1 }, glob.version))) throw new Error(`${glob.id} changed during dependency learning`);
      return added;
    });
    if (learned.length > 0) {
      const boardId = await this.deps.store.transaction(async (tx) => (await tx.getGlob(globId))?.boardId ?? null);
      if (boardId !== null) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    }
    return learned;
  }

  /** The board's rules (learned over default) and their history, for members. */
  async view(email: string, boardId: number): Promise<Result<DependencyRulesView>> {
    const defaults = await this.defaults();
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      const policy = await readMergePolicy(tx, boardId);
      const learned = await tx.listDependencyRules(boardId);
      const patterns = [...new Set([...candidatePatterns(policy.exclusivePaths, defaults), ...learned.map((r) => r.pattern)])];
      const rules = patterns.map((pattern): DependencyRuleView => {
        const rule: DependencyRule | undefined = learned.find((r) => r.pattern === pattern);
        const base = defaultWeight(pattern, defaults);
        const weight = rule?.weight ?? base;
        return {
          pattern,
          weight,
          defaultWeight: base,
          state: rule === undefined ? 'default' : 'learned',
          predicted: weight >= PREDICT_MIN,
          cleanCount: rule?.cleanCount ?? 0,
          conflictCount: rule?.conflictCount ?? 0,
          updatedAt: rule?.updatedAt ?? null,
        };
      });
      return ok({ rules, history: await tx.listDependencyRuleChanges(boardId), predictMin: PREDICT_MIN });
    });
  }

  /** Admins: drops what the board learned for one pattern (or all of them), so the catalog default applies again. */
  async reset(email: string, boardId: number, pattern?: string): Promise<Result<null>> {
    const defaults = await this.defaults();
    const result = await this.deps.store.transaction(async (tx): Promise<Result<null>> => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const learned = (await tx.listDependencyRules(boardId)).filter((r) => pattern === undefined || r.pattern === pattern);
      const now = this.deps.clock.now();
      for (const rule of learned) {
        await tx.insertDependencyRuleChange({ boardId, at: now, pattern: rule.pattern, from: rule.weight, to: defaultWeight(rule.pattern, defaults), cause: 'reset', globId: null, evidence: `Reset by ${email}` });
      }
      await tx.deleteDependencyRules(boardId, pattern);
      return ok(null);
    });
    if (result.ok) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    return result;
  }
}
