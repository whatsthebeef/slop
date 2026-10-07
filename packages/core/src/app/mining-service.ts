import { UNPROCESSED } from '../domain/kb.js';
import type { KbItem } from '../domain/kb.js';
import { ARTIFACT_KINDS } from '../domain/knowledge.js';
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
import type { Notifier, Store, Tx } from '../ports.js';
import { newKbItemId } from './knowledge-service.js';

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

  /** Everything the signals read for the window ending at `now`. */
  async activity(tx: Tx, boardId: number, now: string, manifestChanges: readonly ManifestChange[] | null): Promise<BoardActivity> {
    const from = miningWindowFrom(now);
    // One transaction's queries run one after another.
    const globs = await tx.listGlobs(boardId, {});
    const events = await tx.listBoardEvents(boardId, from);
    const artifacts = await tx.listArtifactMeta(boardId, ARTIFACT_KINDS, from);
    const findings = await tx.listBoardFindings(boardId, from, now);
    const knowledge = await tx.listKnowledge(boardId, ['doc']);
    const items = await tx.listKbItems(boardId);
    return {
      window: { from, to: now },
      globs: globs.map((g) => ({ id: g.id, type: g.type, status: g.status, createdAt: g.createdAt })),
      events: events.filter((e) => e.at <= now),
      artifacts: artifacts.filter((a) => a.createdAt <= now),
      findings,
      manifestChanges,
      documents: knowledge.map((d) => ({ name: d.name, content: d.content })),
      learnings: items.filter((i) => i.source === 'submitted').map((i) => ({ globIds: i.sourceGlobIds, agentSetVersion: i.agentSetVersion })),
    };
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
    const result = await this.deps.store.transaction(async (tx): Promise<MiningResult> => {
      // The lease keeps runs apart only while it lasts: a second run waits here and then reads the first's rows.
      await tx.lockBoardJob(boardId, 'mining');
      const board = await tx.getBoard(boardId);
      if (board === null) throw new Error(`No board ${boardId}`);
      const activity = await this.activity(tx, boardId, now, options.manifestChanges ?? null);
      const measurements = measureSignals(activity);
      const rows = new Map((await tx.listKbSignals(boardId)).map((r) => [r.key, r]));
      const raised: string[] = [];
      const refreshed: string[] = [];
      const signalOf = (m: Measurement): KbSignal => ({
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

      const raise = async (m: Measurement): Promise<string> => {
        const id = await this.insertItem(tx, board.id, board.agentSetVersion, m, signalOf(m), now);
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
        const original = row?.itemId == null ? null : await tx.getKbItem(row.itemId);
        const item = original === null ? null : await surviving(tx, original);
        if (item === null) {
          await record(m.key, { ...measured, itemId: await raise(m), raisedAt: now, belowThresholdRuns: 0 });
          continue;
        }
        if (item.status === 'open') {
          if (await this.refresh(tx, item, m, signalOf(m), now)) refreshed.push(item.id);
          await record(m.key, { ...measured, belowThresholdRuns: 0 });
          continue;
        }
        if (item.status === 'rejected' || item.status === 'suppressed') {
          const quietSince = item.decidedAt ?? row?.raisedAt ?? item.createdAt;
          // Rates of different signals aren't comparable: a survivor raised for another signal doesn't count.
          const rateThen =
            (item.signal?.key === m.key ? item.signal.figures.rate : undefined) ?? original?.signal?.figures.rate ?? row?.lastFigures?.rate ?? 0;
          const quiet = Date.parse(now) - Date.parse(quietSince) >= SIGNAL_QUIET_MS;
          if (quiet && m.figures.rate >= rateThen * SIGNAL_RERAISE_FACTOR) {
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
    if (result.raised.length > 0 || result.refreshed.length > 0) this.deps.notifier.publish({ kind: 'board.kb', boardId });
    return result;
  }

  private async insertItem(tx: Tx, boardId: number, agentSetVersion: number, m: Measurement, signal: KbSignal, now: string): Promise<string> {
    const definition = signalDefinition(m.key);
    const id = await newKbItemId(tx, boardId);
    const inserted = await tx.insertKbItem({
      id,
      boardId,
      status: 'open',
      type: definition?.type ?? 'agent-behaviour',
      statement: definition?.statement(m) ?? m.label,
      evidence: evidenceOf(m, signal, definition?.threshold ?? null),
      suggestedTarget: definition?.suggestedTarget ?? null,
      sourceGlobIds: m.globIds,
      source: 'mined',
      signal,
      agentSetVersion,
      submittedBy: MINED_BY,
      createdAt: now,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      document: null,
      outcome: null,
      // Unprocessed, like a submitted item: the KB pipeline routes, dedupes and drafts it.
      ...UNPROCESSED,
      version: 1,
    });
    // The counter is atomic, so a clash means the counter and the table disagree.
    if (!inserted) throw new Error(`KB item ${id} already exists`);
    return id;
  }

  /** The open item's new figures and a line of evidence for the week; its draft stands. False if nothing changed. */
  private async refresh(tx: Tx, item: KbItem, m: Measurement, signal: KbSignal, now: string): Promise<boolean> {
    const own = item.signal === null || item.signal.key === m.key;
    const week = `of ${now.slice(0, 10)}: ${own ? '' : `${m.label}: `}${String(m.figures.affected)}/${String(m.figures.eligible)} (${percent(m.figures.rate)})`;
    // On someone's submitted item the line is slop's, not the submitter's.
    const line = item.source === 'mined' ? `Week ${week}` : `Mined by ${MINED_BY}, week ${week}`;
    const lines = item.evidence.split('\n');
    // A second run on the same day with the same figures (a Run now after the weekly run) adds nothing.
    if (lines.at(-1) === line) return false;
    const updated: KbItem = {
      ...item,
      signal: own ? signal : item.signal,
      evidence: `${item.evidence}\n${line}`,
      sourceGlobIds: [...new Set([...item.sourceGlobIds, ...m.globIds])],
      version: item.version + 1,
    };
    // A conflicting write (the pipeline has it) leaves the refresh to next week.
    return tx.updateKbItem(updated, item.version);
  }
}

/**
 * The item that stands for `item` now: itself, or the one it was merged into or covered by; null when there is
 * none (a merged item whose survivor is gone, or more than `MAX_HOPS` links).
 */
const surviving = async (tx: Tx, item: KbItem): Promise<KbItem | null> => {
  let current = item;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next =
      current.status === 'merged' && current.duplicateOf !== null
        ? current.duplicateOf
        : current.status === 'covered' && current.coveredBy?.kind === 'item'
          ? current.coveredBy.id
          : null;
    if (next === null) return current.status === 'merged' ? null : current;
    const found = await tx.getKbItem(next);
    if (found === null) return current.status === 'merged' ? null : current;
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
