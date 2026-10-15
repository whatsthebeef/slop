import { decisionOf } from '../domain/decision-glob.js';
import { CONTEXT_REPORT_DAYS, CONTEXT_REPORT_TOP, CONTEXT_REPORT_TOP_GLOBS, countShares, sharesOf } from '../domain/context-report.js';
import type { ContextReport, TopRetrieved } from '../domain/context-report.js';
import { NO_GLOB, summariseUsage, usageFrom } from '../domain/choice-usage.js';
import { ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { AuthorityTier, SourceType } from '../domain/search.js';
import type { Clock, Store } from '../ports.js';
import { memberOf } from './access.js';
import { contextSettingsView } from './context-tuning-service.js';
import type { ContextTuningService } from './context-tuning-service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const NO_CONFLICTS =
  'Contradiction checks run on open learnings, not on choices, and the result is not stored against a choice, so no conflicts can be listed.';

const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';

/**
 * The board's context report (spec, Context tuning): reads what the stores already hold. Members read it; the settings
 * section comes from the same view the Knowledge page's "What slop has learned" (Context tuning) uses.
 */
export class ContextReportService {
  constructor(private readonly deps: { store: Store; clock: Clock; tuning: ContextTuningService }) {}

  async report(email: string, boardId: number): Promise<Result<ContextReport>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const since = new Date(Date.parse(now) - CONTEXT_REPORT_DAYS * DAY_MS).toISOString();
      const weekAgo = new Date(Date.parse(now) - 7 * DAY_MS).toISOString();
      const facts = await this.deps.tuning.facts(tx, boardId, now);

      const bySource = new Map<SourceType, number>();
      const byTier = new Map<AuthorityTier, number>();
      for (const row of await tx.listContextRetrievals(boardId, usageFrom(now, CONTEXT_REPORT_DAYS))) {
        bySource.set(row.sourceType, (bySource.get(row.sourceType) ?? 0) + row.count);
        byTier.set(row.tier, (byTier.get(row.tier) ?? 0) + row.count);
      }
      const total = [...bySource.values()].reduce((a, b) => a + b, 0);

      const decisions = await tx.listDecisions(boardId);
      const usage = summariseUsage(await tx.listChoiceUsage(boardId, usageFrom(now, CONTEXT_REPORT_DAYS)));
      const byId = new Map(decisions.map((d) => [d.id, d]));
      const ranked = [...usage]
        .filter(([id, u]) => u.returns > 0 && byId.has(id))
        .sort((a, b) => b[1].returns - a[1].returns || a[0] - b[0])
        .slice(0, CONTEXT_REPORT_TOP);
      const topRetrieved: TopRetrieved[] = [];
      for (const [id, u] of ranked) {
        const d = byId.get(id);
        if (d === undefined) continue;
        const globs: { id: string; title: string }[] = [];
        for (const globId of u.globIds.filter((g) => g !== NO_GLOB).slice(0, CONTEXT_REPORT_TOP_GLOBS)) {
          const glob = await tx.getGlob(globId);
          globs.push({ id: globId, title: glob?.title ?? globId });
        }
        topRetrieved.push({ decisionId: id, statement: firstLine(d.statement), sourceKind: d.sourceKind, returns: u.returns, globs, globCount: u.globs });
      }

      let raised = 0;
      for (const glob of await tx.listGlobs(boardId, { include: 'decisions', origins: ['mined'] })) {
        if (glob.createdAt >= since && decisionOf(glob)?.signal?.key.startsWith('choice_in_use:') === true) raised += 1;
      }
      const inWindow = <T extends { at: string }>(rows: readonly T[]): T[] => rows.filter((r) => r.at >= since);
      const promotions = inWindow(facts.promotions);
      const cards = inWindow(facts.cards);
      const attaches = inWindow(facts.attaches);
      const items = await tx.listInboxItems(boardId, ['kept', 'discarded']);
      const settings = await contextSettingsView(tx, boardId);
      const state = (s: string): number => decisions.filter((d) => d.replaceState === s).length;

      return ok<ContextReport>({
        generatedAt: now,
        windowDays: CONTEXT_REPORT_DAYS,
        retrievals: { total, bySource: sharesOf(bySource), byTier: sharesOf(byTier) },
        topRetrieved,
        choices: {
          total: decisions.length,
          bySource: countShares(decisions.map((d) => d.sourceKind)),
          newThisWeek: decisions.filter((d) => d.createdAt >= weekAgo).length,
          replaced: { autoApplied: state('applied'), confirmed: state('confirmed'), undone: state('undone') },
          cards: { confirmed: cards.filter((c) => c.accepted).length, dismissed: cards.filter((c) => !c.accepted).length },
          promoted: { raised, accepted: promotions.filter((p) => p.accepted).length, rejected: promotions.filter((p) => !p.accepted).length },
        },
        conflicts: [],
        conflictsNote: NO_CONFLICTS,
        inbox: {
          attachedViaSuggestion: attaches.filter((a) => a.suggested).length,
          attachedElsewhere: attaches.filter((a) => !a.suggested).length,
          kept: items.filter((i) => i.status === 'kept').length,
          discarded: items.filter((i) => i.status === 'discarded').length,
        },
        settings: settings.settings,
        history: settings.history,
      });
    });
  }
}
