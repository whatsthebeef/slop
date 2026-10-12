import { replacementOf } from '../domain/decision-glob.js';
import { decisionViews, isSuperseded } from '../domain/decisions.js';
import type { Decision, DecisionView } from '../domain/decisions.js';
import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { knowledgePageEffect } from '../domain/events.js';
import * as machine from '../domain/machine.js';
import type { Glob, Role } from '../domain/types.js';
import type { Clock, Hint, Notifier, Store, Tx } from '../ports.js';
import { memberOf, roleOf } from './access.js';
import { applyDecisionStep, closeStaleReplacements, decisionContext, replacementOpen } from './decision-glob.js';

/** Who may confirm or dismiss a replacement card. */
const DECIDERS: readonly Role[] = ['admin', 'po'];

/** A decision after a person's change, and where the board's open views must refetch. */
interface Changed {
  readonly view: DecisionView;
  readonly boardId: number;
  readonly globs: readonly string[];
  /** Cards that closed because their pair was answered here. */
  readonly hints?: readonly Hint[];
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
          await this.cardsOf(tx, boardId, all),
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
      // A replaced decision leaves the decisions in force.
      await tx.enqueueEffects([knowledgePageEffect(d.boardId)]);
      return ok(await this.viewOf(tx, d.id, [d.globId, newer.globId], await this.closeCards(tx, d.boardId)));
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
      await tx.enqueueEffects([knowledgePageEffect(d.boardId)]);
      return ok(await this.viewOf(tx, d.id, [d.globId, newer?.globId ?? null], await this.closeCards(tx, d.boardId)));
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

  /** A proposal answered through the choice itself leaves its card with nothing to ask: the card closes. */
  private async closeCards(tx: Tx, boardId: number): Promise<Hint[]> {
    return closeStaleReplacements(tx, { clock: this.deps.clock }, boardId, await tx.listDecisions(boardId));
  }

  private async viewOf(tx: Tx, id: number, globs: readonly (string | null)[], hints: readonly Hint[] = []): Promise<Changed> {
    const d = await tx.getDecision(id);
    if (d === null) throw new Error(`Decision ${String(id)} vanished`);
    const all = await tx.listDecisions(d.boardId);
    const view = decisionViews([d], all, await this.cardsOf(tx, d.boardId, all))[0];
    if (view === undefined) throw new Error('No decision view');
    return { view, boardId: d.boardId, globs: globs.flatMap((g) => (g === null ? [] : [g])), hints };
  }

  /** The open replacement cards of a board, by the older choice each asks about. */
  private async cardsOf(tx: Tx, boardId: number, all: readonly Decision[]): Promise<Map<number, string>> {
    const byId = new Map(all.map((d) => [d.id, d]));
    const cards = await tx.listGlobs(boardId, { include: 'decisions', origins: ['replacement'], status: ['planning', 'in_progress'] });
    const out = new Map<number, string>();
    for (const card of cards) {
      const pair = replacementOf(card);
      if (pair !== null && replacementOpen(byId.get(pair.oldId), byId.get(pair.newId))) out.set(pair.oldId, card.id);
    }
    return out;
  }

  /** The board's open glob views refetch after the commit. */
  private published(result: Result<Changed>): Result<DecisionView> {
    if (!result.ok) return result;
    const { view, boardId, globs, hints = [] } = result.value;
    for (const globId of new Set(globs)) this.deps.notifier.publish({ kind: 'glob.decisions', boardId, globId });
    for (const hint of hints) this.deps.notifier.publish(hint);
    return ok(view);
  }

  /**
   * A person's answer on a replacement card (a decision glob of origin `replacement`): Confirm applies the replacement (the
   * older choice is replaced), Dismiss keeps it standing and the pair is never proposed again. Either way the card is
   * Signed off and archived. A card whose pair changed meanwhile (a choice was replaced or deleted) closes instead, and is returned closed.
   */
  async decideReplacement(email: string, boardId: number, globId: string, outcome: 'confirm' | 'dismiss', reason?: string): Promise<Result<Glob>> {
    const deps = { clock: this.deps.clock };
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ glob: Glob; hints: Hint[] }>> => {
      const actor = await roleOf(tx, email, boardId, DECIDERS);
      if (!actor.ok) return actor;
      const card = await tx.getGlob(globId);
      if (card?.boardId !== boardId) return notFound(`No glob ${globId} on board ${String(boardId)}`);
      const pair = replacementOf(card);
      if (pair === null) return invalidInput(`${globId} is not a replacement decision`);
      const ctx = decisionContext(this.deps.clock, actor.value);
      const hints: Hint[] = [{ kind: 'glob.changed', boardId, globId, version: card.version + 1 }];
      const old = await tx.getDecision(pair.oldId);
      const next = await tx.getDecision(pair.newId);
      if (card.status === 'signed_off') return invalidInput('This replacement has already been decided');
      if (!replacementOpen(old ?? undefined, next ?? undefined) || old === null || next === null) {
        const closed = await applyDecisionStep(tx, globId, (glob) => machine.closeReplacement(glob, ctx));
        return closed.ok ? ok({ glob: closed.value.glob, hints }) : closed;
      }
      const step = await applyDecisionStep(tx, globId, (glob) => machine.decideReplacement(glob, { confirm: outcome === 'confirm', ...(reason === undefined ? {} : { reason }) }, ctx));
      if (!step.ok) return step;
      if (outcome === 'confirm') {
        await tx.updateDecision(old.id, { replaceState: 'confirmed' });
        await tx.setItemSupersession(old.itemId, 'superseded', next.itemId);
      } else {
        await tx.updateDecision(old.id, { replaceState: 'undone' });
      }
      // The decisions in force changed only when the replacement applied.
      if (outcome === 'confirm') await tx.enqueueEffects([knowledgePageEffect(boardId)]);
      for (const g of [old.globId, next.globId]) if (g !== null) hints.push({ kind: 'glob.decisions', boardId, globId: g });
      hints.push(...(await closeStaleReplacements(tx, deps, boardId, await tx.listDecisions(boardId))));
      return ok({ glob: step.value.glob, hints });
    });
    if (!result.ok) return result;
    for (const hint of result.value.hints) this.deps.notifier.publish(hint);
    return ok(result.value.glob);
  }
}
