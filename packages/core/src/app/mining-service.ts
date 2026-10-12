import { CHOICE_USAGE_RETENTION_DAYS, CHOICE_USAGE_WINDOW_DAYS, summariseUsage, usageFrom } from '../domain/choice-usage.js';
import type { ChoiceActivity } from '../domain/choice-usage.js';
import { isSuperseded } from '../domain/decisions.js';
import { ARTIFACT_KINDS } from '../domain/knowledge.js';
import { learningDecision, learningEvidence, learningFacts, learningLinks, learningStatus } from '../domain/learning.js';
import type { LearningRead } from '../domain/learning.js';
import {
  measureSignals,
  SIGNAL_QUIET_MS,
  SIGNAL_RERAISE_FACTOR,
  SIGNAL_WINDOW_DAYS,
  signalDefinition,
} from '../domain/signals.js';
import type {
  BoardActivity,
  BoardJobResult,
  KbSignal,
  KbSignalState,
  ManifestChange,
  Measurement,
  MergedCommit,
} from '../domain/signals.js';
import type { Hint, Notifier, Store, Tx } from '../ports.js';
import { squash } from './kb-dedupe.js';
import { newLearningId } from './knowledge-service.js';
import { boardLearnings, readLearning } from './learning-reads.js';
import { createLearning, refreshMinedLearning } from './learning-writes.js';

export type MiningResult = Extract<BoardJobResult, { kind: 'mining' }>;

export interface MineOptions {
  /** What the window's merged commits added to dependency manifests; null or absent: not fetched. */
  readonly manifestChanges?: readonly ManifestChange[] | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Who mined items are submitted by. */
export const MINED_BY = 'slop';

/** The start of the mining window ending at `now`. */
export const miningWindowFrom = (now: string): string => new Date(Date.parse(now) - SIGNAL_WINDOW_DAYS * DAY_MS).toISOString();

const percent = (rate: number): string => `${String(Math.round(rate * 100))}%`;

/** How many links to follow from a merged or covered item to the item that survived it. */
const MAX_HOPS = 10;

/**
 * The weekly mining run (spec, self-improvement: "Signals slop mines"): measures every signal over the last
 * 28 days of a board's activity and turns crossed thresholds into `mined` KB items. The items go through the
 * KB pipeline like submitted ones (routing, dedupe, drafting), and nothing reaches the knowledge base without
 * an admin. `kb_signals` keeps a signal from being raised again every week.
 */
export class MiningService {
  constructor(private readonly deps: { store: Store; notifier: Notifier }) {}

  /** The merges to the base branch in the window ending at `now`, oldest first: whose manifests to check. */
  async mergedCommits(boardId: number, now: string): Promise<MergedCommit[]> {
    const events = await this.deps.store.transaction((tx) => tx.listBoardEvents(boardId, miningWindowFrom(now), ['Merged']));
    return events.flatMap((e) => {
      const sha = e.data.sha;
      return typeof sha === 'string' ? [{ globId: e.globId, sha }] : [];
    });
  }

  /** Everything the signals read for the window ending at `now` (by default the mining window; effect checks look further back). */
  async activity(
    tx: Tx,
    boardId: number,
    now: string,
    manifestChanges: readonly ManifestChange[] | null,
    from: string = miningWindowFrom(now),
  ): Promise<BoardActivity> {
    // One transaction's queries run one after another.
    const globs = await tx.listGlobs(boardId, {});
    const events = await tx.listBoardEvents(boardId, from);
    const artifacts = await tx.listArtifactMeta(boardId, ARTIFACT_KINDS, from);
    const findings = await tx.listBoardFindings(boardId, from, now);
    const reviewFeedback = await tx.listReviewFeedback(boardId, from, now);
    const knowledge = await tx.listKnowledge(boardId, ['doc']);
    const learnings = await boardLearnings(tx, boardId);
    const choices = await this.choices(tx, boardId, now, knowledge);
    const settings = await tx.getContextSettings(boardId);
    return {
      window: { from, to: now },
      globs: globs.map((g) => ({ id: g.id, type: g.type, status: g.status, createdAt: g.createdAt })),
      events: events.filter((e) => e.at <= now),
      artifacts: artifacts.filter((a) => a.createdAt <= now),
      findings,
      reviewFeedback,
      manifestChanges,
      documents: knowledge.map((d) => ({ name: d.name, area: d.area, content: d.content })),
      documentAreasKnown: true,
      choices,
      settings,
      learnings: learnings.flatMap(({ glob }) => {
        const facts = learningFacts(glob);
        return facts.source === 'submitted' ? [{ globIds: facts.sourceGlobIds, agentSetVersion: facts.agentSetVersion }] : [];
      }),
    };
  }

  /**
   * The board's choices with their usage over `CHOICE_USAGE_WINDOW_DAYS` ending at `now`. A choice is covered when a
   * document's text has its source quote or its statement (a possible-coverage hint on the raised learning is the
   * pipeline's, after it exists: the signal is raised once per choice, so it counts the same).
   */
  private async choices(tx: Tx, boardId: number, now: string, documents: readonly { content: string }[]): Promise<ChoiceActivity[]> {
    const usage = summariseUsage(await tx.listChoiceUsage(boardId, usageFrom(now, CHOICE_USAGE_WINDOW_DAYS)));
    const text = documents.map((d) => squash(d.content)).join('\n');
    const said = (value: string): boolean => {
      const needle = squash(value);
      return needle !== '' && text.includes(needle);
    };
    return (await tx.listDecisions(boardId)).map((d) => {
      const used = usage.get(d.id);
      // Never the glob it was taken on: a choice counts for the globs that were handed it.
      const globIds = (used?.globIds ?? []).filter((g) => g !== d.globId);
      return {
        id: d.id,
        globId: d.globId,
        statement: d.statement,
        quote: d.quote,
        sourceKind: d.sourceKind,
        sourceLabel: d.sourceLabel,
        current: !isSuperseded(d),
        covered: said(d.quote) || said(d.statement),
        returns: used?.returns ?? 0,
        globIds,
      };
    });
  }

  /**
   * Measures the board's signals for the window ending at `now` and applies the re-raise rules, in one
   * transaction:
   * - a crossed signal with no item yet raises one;
   * - an open item for it gets the new figures and a line of evidence, and is not drafted again;
   * - an approved or covered one is never raised again (the effect check watches it);
   * - a rejected or suppressed one stays quiet for 12 weeks, then is raised again only at 1.5× its rate then;
   * - a signal below its threshold (or not measured) counts the runs in a row it has been below.
   * New dependencies are raised together, once per name.
   */
  async mine(boardId: number, now: string, options: MineOptions = {}): Promise<MiningResult> {
    // The new decision globs' hints, published once the run commits.
    const hints: Hint[] = [];
    const result = await this.deps.store.transaction(async (tx): Promise<MiningResult> => {
      hints.length = 0;
      // The lease keeps runs apart only while it lasts: a second run waits here and then reads the first's rows.
      await tx.lockBoardJob(boardId, 'mining');
      await tx.pruneChoiceUsage(boardId, usageFrom(now, CHOICE_USAGE_RETENTION_DAYS));
      await tx.pruneContextRetrievals(boardId, usageFrom(now, CHOICE_USAGE_RETENTION_DAYS));
      const board = await tx.getBoard(boardId);
      if (board === null) throw new Error(`No board ${boardId}`);
      const activity = await this.activity(tx, boardId, now, options.manifestChanges ?? null);
      const measurements = measureSignals(activity);
      const rows = new Map((await tx.listKbSignals(boardId)).map((r) => [r.key, r]));
      const raised: string[] = [];
      const refreshed: string[] = [];
      const signalOf = (m: Measurement): KbSignal => signalFrom(m, activity, now);

      const raise = async (m: Measurement): Promise<string> => {
        const id = await this.insertItem(tx, board.id, board.agentSetVersion, m, signalOf(m), now, hints);
        raised.push(id);
        return id;
      };
      const record = (key: string, patch: Partial<KbSignalState>): Promise<void> =>
        tx.upsertKbSignal({
          boardId,
          key,
          itemId: null,
          lastFigures: null,
          lastMeasuredAt: null,
          raisedAt: null,
          belowThresholdRuns: 0,
          ...rows.get(key),
          ...patch,
        });

      const newDependencies: Measurement[] = [];
      for (const m of measurements) {
        const row = rows.get(m.key);
        const measured = { lastFigures: m.figures, lastMeasuredAt: now };
        if (m.kind === 'dependency') {
          // Each name is raised once, whatever became of its item.
          if (row === undefined) newDependencies.push(m);
          else await record(m.key, measured);
          continue;
        }
        if (!m.crosses) {
          if (row !== undefined) await record(m.key, { ...measured, belowThresholdRuns: row.belowThresholdRuns + 1 });
          continue;
        }
        const original = row?.itemId == null ? null : await readLearning(tx, row.itemId);
        const survivor = original === null ? null : await surviving(tx, original);
        // A signal raised once (a choice in use) is never raised again, whatever became of its item: not when it was
        // rejected, and not when it was merged into one that is gone.
        const once = signalDefinition(m.key)?.once === true;
        if (survivor === null && once && row?.itemId != null) {
          await record(m.key, { ...measured, belowThresholdRuns: 0 });
          continue;
        }
        if (survivor === null) {
          await record(m.key, { ...measured, itemId: await raise(m), raisedAt: now, belowThresholdRuns: 0 });
          continue;
        }
        const { glob: item } = survivor;
        const status = learningStatus(item, survivor.artifacts);
        if (status === 'open') {
          if (await this.refresh(tx, survivor, m, signalOf(m), now)) refreshed.push(item.id);
          await record(m.key, { ...measured, belowThresholdRuns: 0 });
          continue;
        }
        if ((status === 'rejected' || status === 'suppressed') && !once) {
          const quietSince = learningDecision(item, survivor.artifacts).at ?? row?.raisedAt ?? item.createdAt;
          const signal = learningFacts(item).signal;
          // Rates of different signals aren't comparable: a survivor raised for another signal doesn't count.
          const rateThen =
            (signal?.key === m.key ? signal.figures.rate : undefined) ??
            (original === null ? undefined : learningFacts(original.glob).signal?.figures.rate) ??
            row?.lastFigures?.rate ??
            0;
          const definition = signalDefinition(m.key);
          const quiet = Date.parse(now) - Date.parse(quietSince) >= (definition?.quietMs ?? SIGNAL_QUIET_MS);
          if (quiet && m.figures.rate >= rateThen * (definition?.reraiseFactor ?? SIGNAL_RERAISE_FACTOR)) {
            await record(m.key, { ...measured, itemId: await raise(m), raisedAt: now, belowThresholdRuns: 0 });
            continue;
          }
        }
        // Approved or covered (never again), or rejected and still quiet.
        await record(m.key, { ...measured, belowThresholdRuns: 0 });
      }

      if (newDependencies.length > 0) {
        const id = await raise(dependencies(newDependencies));
        for (const m of newDependencies) await record(m.key, { lastFigures: m.figures, lastMeasuredAt: now, itemId: id, raisedAt: now });
      }

      // Signals with a row that weren't measured at all this run are below their threshold too (not measured:
      // their last figures and when they were measured stand).
      const measuredKeys = new Set(measurements.map((m) => m.key));
      for (const row of rows.values()) {
        if (measuredKeys.has(row.key) || row.key.startsWith('dependency:')) continue;
        await record(row.key, { belowThresholdRuns: row.belowThresholdRuns + 1 });
      }

      return {
        kind: 'mining',
        measured: measurements.length,
        crossed: measurements.filter((m) => m.crosses).length,
        raised,
        refreshed,
      };
    });
    for (const hint of hints) this.deps.notifier.publish(hint);
    if (result.raised.length > 0 || result.refreshed.length > 0) this.deps.notifier.publish({ kind: 'board.kb', boardId });
    return result;
  }

  /**
   * The board's signals as measured now over the mining window, without the dependency signal (it needs the code
   * host): the keys an admin can choose to watch when approving a submitted item. Reads only.
   */
  async measure(tx: Tx, boardId: number, now: string): Promise<KbSignal[]> {
    const activity = await this.activity(tx, boardId, now, null);
    return measureSignals(activity).map((m) => signalFrom(m, activity, now));
  }

  private async insertItem(tx: Tx, boardId: number, agentSetVersion: number, m: Measurement, signal: KbSignal, now: string, hints: Hint[]): Promise<string> {
    const definition = signalDefinition(m.key);
    const id = await newLearningId(tx, boardId);
    // The item is its decision glob, so mined proposals are decided where the board looks; the KB pipeline routes, dedupes and drafts it.
    const created = await createLearning(
      tx,
      { clock: { now: () => now }, raise: (h) => hints.push(h) },
      {
        id,
        boardId,
        type: definition?.type ?? 'agent-behaviour',
        statement: definition?.statement(m) ?? m.label,
        evidence: evidenceOf(m, signal, definition?.threshold ?? null),
        suggestedTarget: definition?.suggestedTarget ?? null,
        sourceGlobIds: m.globIds,
        agentSetVersion,
        submittedBy: MINED_BY,
        createdAt: now,
        document: null,
        target: null,
        source: 'mined',
        signal,
      },
    );
    // The counter is atomic, so a clash means the counter and the globs disagree.
    if (!created) throw new Error(`KB item ${id} already exists`);
    return id;
  }

  /** The open item's new figures and a line of evidence for the week; its draft stands. False if nothing changed. */
  private async refresh(tx: Tx, item: LearningRead, m: Measurement, signal: KbSignal, now: string): Promise<boolean> {
    const { glob } = item;
    const facts = learningFacts(glob);
    const own = facts.signal === null || facts.signal.key === m.key;
    const week = `of ${now.slice(0, 10)}: ${own ? '' : `${m.label}: `}${String(m.figures.affected)}/${String(m.figures.eligible)} (${percent(m.figures.rate)})`;
    // On someone's submitted item the line is slop's, not the submitter's.
    const line = facts.source === 'mined' ? `Week ${week}` : `Mined by ${MINED_BY}, week ${week}`;
    const evidence = learningEvidence(glob, item.artifacts);
    // A second run on the same day with the same figures (a Run now after the weekly run) adds nothing.
    if (evidence.split('\n').at(-1) === line) return false;
    // A conflicting write (the pipeline has it) leaves the refresh to next week.
    return refreshMinedLearning(tx, { clock: { now: () => now } }, glob.id, glob.version, {
      // New evidence clears a stale flag (the signal crossed its threshold again).
      signal: own ? signal : null,
      evidence: `${evidence}\n${line}`,
      sourceGlobIds: [...new Set([...facts.sourceGlobIds, ...m.globIds])],
    });
  }
}

/** A measurement as a KB item's signal. */
const signalFrom = (m: Measurement, activity: BoardActivity, now: string): KbSignal => ({
  key: m.key,
  kind: m.kind,
  agent: signalDefinition(m.key)?.agent ?? null,
  label: m.label,
  window: activity.window,
  figures: m.figures,
  globIds: m.globIds,
  examples: m.examples,
  measuredAt: now,
});

/**
 * The item that stands for `item` now: itself, or the one it was merged into or covered by; null when there is
 * none (a merged item whose survivor is gone, or more than `MAX_HOPS` links).
 */
const surviving = async (tx: Tx, item: LearningRead): Promise<LearningRead | null> => {
  let current = item;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const status = learningStatus(current.glob, current.artifacts);
    const links = learningLinks(current.glob);
    const next =
      status === 'merged' && links.duplicateOf !== null
        ? links.duplicateOf
        : status === 'covered' && links.coveredBy?.kind === 'item'
          ? links.coveredBy.id
          : null;
    if (next === null) return status === 'merged' ? null : current;
    const found = await readLearning(tx, next);
    if (found === null) return status === 'merged' ? null : current;
    current = found;
  }
  // A chain this long (or a loop) has lost its survivor: raise the signal again rather than go silent.
  return null;
};

/** New dependencies found in one run, raised as one item. */
const dependencies = (found: readonly Measurement[]): Measurement => {
  const names = found.map((m) => m.label).sort();
  const globs = [...new Set(found.flatMap((m) => m.globIds))].sort();
  const eligible = Math.max(...found.map((m) => m.figures.eligible));
  return {
    key: `dependency:${names.join(',')}`,
    kind: 'dependency',
    label: names.join(', '),
    figures: {
      affected: globs.length,
      eligible,
      rate: eligible === 0 ? 0 : Math.round((globs.length / eligible) * 1000) / 1000,
      count: names.length,
    },
    globIds: globs,
    examples: found.flatMap((m) => m.examples).slice(0, 5),
    crosses: true,
  };
};

/** The item's evidence: the window, the figures, the threshold they crossed, the globs and the examples. */
const evidenceOf = (m: Measurement, signal: KbSignal, threshold: string | null): string =>
  [
    `Mined by slop from board activity ${signal.window.from.slice(0, 10)} to ${signal.window.to.slice(0, 10)}: ${m.label}.`,
    `Figures: ${String(m.figures.affected)} of ${String(m.figures.eligible)} (${percent(m.figures.rate)})${m.figures.count === m.figures.affected ? '' : `, ${String(m.figures.count)} occurrences`}.`,
    ...(threshold === null ? [] : [`Threshold: ${threshold}.`]),
    `Globs: ${m.globIds.join(', ') || '(none)'}`,
    ...(m.examples.length === 0 ? [] : ['Examples:', ...m.examples.map((e) => `- ${e}`)]),
  ].join('\n');
