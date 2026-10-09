import { decisionViews, isSuperseded } from '../domain/decisions.js';
import type { Decision, DecisionView } from '../domain/decisions.js';
import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Clock, Notifier, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';

/** A decision after a person's change, and where the board's open views must refetch. */
interface Changed {
  readonly view: DecisionView;
  readonly boardId: number;
  readonly globs: readonly string[];
}

/**
 * Decisions beside the glob (spec, Decisions and supersession): the decisions taken on a glob with their sources and
 * what replaced them, and a person's control over supersession: confirming a proposed replacement, or undoing one
 * (applied by the pipeline, confirmed, or proposed), which stays undone.
 */
export class DecisionService {
  constructor(private readonly deps: { store: Store; clock: Clock; notifier: Notifier }) {}

  /** The decisions taken on a glob, newest first, for board members. */
  async forGlob(email: string, boardId: number, globId: string): Promise<Result<readonly DecisionView[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const glob = await tx.getGlob(globId);
      if (glob?.boardId !== boardId) return notFound(`No glob ${globId} on board ${String(boardId)}`);
      const all = await tx.listDecisions(boardId);
      return ok(
        decisionViews(
          all.filter((d) => d.globId === globId),
          all,
        ),
      );
    });
  }

  /** Confirms a proposed replacement: the older decision becomes superseded. */
  async confirm(email: string, decisionId: number, boardId?: number): Promise<Result<DecisionView>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Changed>> => {
      const found = await this.member(tx, email, decisionId, boardId);
      if (!found.ok) return found;
      const d = found.value;
      if (d.replaceState !== 'hint' || d.replacedBy === null) return invalidInput('Only a proposed replacement can be confirmed');
      const newer = await tx.getDecision(d.replacedBy);
      if (newer === null) return invalidInput('The newer decision is gone');
      // A replacement into a decision that is itself replaced, or replaced by this one, would never end.
      if (isSuperseded(newer) || (newer.replacedBy === d.id && newer.replaceState !== null && newer.replaceState !== 'undone')) {
        return invalidInput('The newer decision is itself superseded');
      }
      await tx.updateDecision(d.id, { replaceState: 'confirmed' });
      await tx.setItemSupersession(d.itemId, 'superseded', newer.itemId);
      return ok(await this.viewOf(tx, d.id, [d.globId, newer.globId]));
    });
    return this.published(result);
  }

  /** Undoes a replacement (or dismisses a proposed one): the older decision stands again and the pair is never applied again. */
  async undo(email: string, decisionId: number, boardId?: number): Promise<Result<DecisionView>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<Changed>> => {
      const found = await this.member(tx, email, decisionId, boardId);
      if (!found.ok) return found;
      const d = found.value;
      if (d.replaceState === null || d.replaceState === 'undone') return invalidInput('This decision has no replacement to undo');
      const newer = d.replacedBy === null ? null : await tx.getDecision(d.replacedBy);
      await tx.updateDecision(d.id, { replaceState: 'undone' });
      await tx.setItemSupersession(d.itemId, 'active', null);
      return ok(await this.viewOf(tx, d.id, [d.globId, newer?.globId ?? null]));
    });
    return this.published(result);
  }

  /** The decision when the caller is a member of its board (and it is on `boardId`, when the caller names one). */
  private async member(tx: Tx, email: string, decisionId: number, boardId?: number): Promise<Result<Decision>> {
    const d = await tx.getDecision(decisionId);
    if (d === null || (boardId !== undefined && d.boardId !== boardId)) return notFound(`No decision ${String(decisionId)}`);
    const actor = await memberOf(tx, email, d.boardId);
    return actor.ok ? ok(d) : actor;
  }

  private async viewOf(tx: Tx, id: number, globs: readonly (string | null)[]): Promise<Changed> {
    const d = await tx.getDecision(id);
    if (d === null) throw new Error(`Decision ${String(id)} vanished`);
    const view = decisionViews([d], await tx.listDecisions(d.boardId))[0];
    if (view === undefined) throw new Error('No decision view');
    return { view, boardId: d.boardId, globs: globs.flatMap((g) => (g === null ? [] : [g])) };
  }

  /** The board's open glob views refetch after the commit. */
  private published(result: Result<Changed>): Result<DecisionView> {
    if (!result.ok) return result;
    const { view, boardId, globs } = result.value;
    for (const globId of new Set(globs)) this.deps.notifier.publish({ kind: 'glob.decisions', boardId, globId });
    return ok(view);
  }
}
