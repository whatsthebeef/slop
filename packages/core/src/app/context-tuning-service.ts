import { decisionOf } from '../domain/decision-glob.js';
import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { CONTEXT_SETTING_KEYS, CONTEXT_SETTING_SPECS, isContextSettingKey } from '../domain/context-settings.js';
import type { ContextSettingChange, ContextSettingKey, ContextSettingSpec } from '../domain/context-settings.js';
import { NO_GLOB, usageFrom } from '../domain/choice-usage.js';
import { namesChoice, tuneContext } from '../domain/context-tuning.js';
import type { AttachFact, CardFact, ChoiceFact, PromotionFact, RetrievalFact, TuningFacts } from '../domain/context-tuning.js';
import type { Decision } from '../domain/decisions.js';
import type { BoardJobResult } from '../domain/signals.js';
import type { Clock, Notifier, Store, Tx } from '../ports.js';
import { adminOf, memberOf } from './access.js';

export type ContextTuningResult = Extract<BoardJobResult, { kind: 'context_tuning' }>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Usage rows are kept this long (`CHOICE_USAGE_RETENTION_DAYS`), so no older retrieval can be read. */
const RETRIEVAL_WINDOW_DAYS = 90;

/** One setting as the admin page shows it. */
export interface ContextSettingView extends ContextSettingSpec {
  readonly value: number;
}

export interface ContextSettingsView {
  readonly settings: readonly ContextSettingView[];
  /** Every move and reset, newest first. */
  readonly history: readonly ContextSettingChange[];
}

const idOfChoiceKey = (key: string): number | null => {
  const [kind, id] = key.split(':');
  const n = Number(id);
  return kind === 'choice_in_use' && Number.isInteger(n) ? n : null;
};

/**
 * The weekly `context_tuning` job (spec, Context tuning): reads what people did with the numbers that decide what agents
 * are handed, applies `tuneContext`'s rules and records each move with its evidence. No model calls. Admins can reset a
 * setting to its default; members read the settings and their history.
 */
export class ContextTuningService {
  constructor(private readonly deps: { store: Store; clock: Clock; notifier: Notifier }) {}

  /** The facts the rules read, from what the board has stored. */
  private async facts(tx: Tx, boardId: number, now: string): Promise<TuningFacts> {
    const settings = await tx.getContextSettings(boardId);
    const lastChangeAt: Partial<Record<ContextSettingKey, string>> = {};
    // Newest first: the first row of a key is its last change.
    for (const change of await tx.listContextSettingChanges(boardId)) lastChangeAt[change.key] ??= change.at;
    const decisions = await tx.listDecisions(boardId);
    const byId = new Map(decisions.map((d) => [d.id, d]));
    const choices: ChoiceFact[] = decisions.map((d) => ({ sourceKind: d.sourceKind, replaceState: d.replaceState, createdAt: d.createdAt }));

    const promotions: PromotionFact[] = [];
    for (const glob of await tx.listGlobs(boardId, { include: 'decisions', origins: ['mined'] })) {
      const attributes = decisionOf(glob);
      const id = attributes?.signal === undefined ? null : idOfChoiceKey(attributes.signal.key);
      const choice = id === null ? undefined : byId.get(id);
      const outcome = attributes?.outcome;
      if (choice === undefined || outcome === null || outcome === undefined) continue;
      const accepted = outcome.kind === 'accept' || outcome.kind === 'accept_with_edits';
      if (!accepted && outcome.kind !== 'reject') continue;
      promotions.push({
        discussion: choice.sourceKind === 'inbox',
        fromPlan: choice.sourceKind === 'plan' || choice.sourceKind === 'attachment',
        accepted,
        at: outcome.at,
      });
    }

    const cards: CardFact[] = [];
    for (const glob of await tx.listGlobs(boardId, { include: 'decisions', origins: ['replacement'] })) {
      const outcome = decisionOf(glob)?.outcome;
      if (outcome?.kind === 'accept') cards.push({ accepted: true, at: outcome.at });
      else if (outcome?.kind === 'reject') cards.push({ accepted: false, at: outcome.at });
    }

    const items = new Map((await tx.listInboxItems(boardId)).map((i) => [i.id, i]));
    const attaches: AttachFact[] = [];
    for (const link of await tx.listInboxLinks(boardId)) {
      const item = items.get(link.inboxId);
      // Only a person's attach to an item that had suggestions says whether the suggestions were right.
      if (link.linkedBy === null || item === undefined || item.suggestions.length === 0) continue;
      attaches.push({ suggested: item.suggestions.some((s) => s.globId === link.globId), at: link.linkedAt });
    }

    return { now, settings, lastChangeAt, choices, promotions, cards, retrievals: await this.retrievals(tx, boardId, now, byId), attaches };
  }

  /**
   * Each usage row of a choice on a glob, with the choice's age that day and whether the glob's implementation record names
   * it. Only choices are counted: retrievals of other knowledge items aren't recorded.
   */
  private async retrievals(tx: Tx, boardId: number, now: string, byId: ReadonlyMap<number, Decision>): Promise<RetrievalFact[]> {
    const rows = (await tx.listChoiceUsage(boardId, usageFrom(now, RETRIEVAL_WINDOW_DAYS))).filter((r) => r.globId !== NO_GLOB);
    const records = new Map(
      (await tx.latestArtifacts([...new Set(rows.map((r) => r.globId))], ['implementation_plan'])).map((a) => [a.globId, a.content]),
    );
    const facts: RetrievalFact[] = [];
    for (const row of rows) {
      const choice = byId.get(row.decisionId);
      const record = records.get(row.globId);
      // Without a record there is nothing to cite from: the retrieval says nothing either way.
      if (choice === undefined || record === undefined) continue;
      facts.push({
        ageDays: (Date.parse(`${row.day}T00:00:00.000Z`) - Date.parse(choice.decidedAt)) / DAY_MS,
        cited: namesChoice(record, choice),
        count: row.count,
        day: row.day,
      });
    }
    return facts;
  }

  /** One weekly run: applies the rules under the board's job lock and records each move. */
  async tune(boardId: number, now: string): Promise<ContextTuningResult> {
    const result = await this.deps.store.transaction(async (tx): Promise<ContextTuningResult> => {
      await tx.lockBoardJob(boardId, 'context_tuning');
      const proposals = tuneContext(await this.facts(tx, boardId, now));
      const moves: { key: ContextSettingKey; before: number; after: number; outcome: string }[] = [];
      for (const p of proposals) {
        if (p.kind !== 'move') continue;
        await tx.setContextSetting(boardId, p.key, p.after, now);
        await tx.insertContextSettingChange({ boardId, at: now, key: p.key, before: p.before, after: p.after, outcome: p.outcome, evidence: p.evidence });
        moves.push({ key: p.key, before: p.before, after: p.after, outcome: p.outcome });
      }
      return { kind: 'context_tuning', moves, held: proposals.length - moves.length };
    });
    if (result.moves.length > 0) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    return result;
  }

  /** Members: every setting with its default, bounds, what it does and its current value, and the history of moves. */
  async view(email: string, boardId: number): Promise<Result<ContextSettingsView>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return ok(await this.viewIn(tx, boardId));
    });
  }

  private async viewIn(tx: Tx, boardId: number): Promise<ContextSettingsView> {
    const values = await tx.getContextSettings(boardId);
    return {
      settings: CONTEXT_SETTING_KEYS.map((key) => ({ ...CONTEXT_SETTING_SPECS[key], value: values[key] })),
      history: await tx.listContextSettingChanges(boardId),
    };
  }

  /** Admins: puts one setting back on its default and files the reset in the history. */
  async reset(email: string, boardId: number, key: string): Promise<Result<ContextSettingsView>> {
    if (!isContextSettingKey(key)) return invalidInput(`${key} is not a context setting`);
    const now = this.deps.clock.now();
    const done = await this.deps.store.transaction(async (tx): Promise<Result<{ changed: boolean; view: ContextSettingsView }>> => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${String(boardId)}`);
      await tx.lockBoardJob(boardId, 'context_tuning');
      const before = (await tx.getContextSettings(boardId))[key];
      const after = CONTEXT_SETTING_SPECS[key].default;
      if (before !== after) {
        await tx.resetContextSetting(boardId, key);
        await tx.insertContextSettingChange({ boardId, at: now, key, before, after, outcome: 'reset', evidence: `Reset to the default by ${email}` });
      }
      return ok({ changed: before !== after, view: await this.viewIn(tx, boardId) });
    });
    if (!done.ok) return done;
    if (done.value.changed) this.deps.notifier.publish({ kind: 'board.changed', boardId });
    return ok(done.value.view);
  }
}
