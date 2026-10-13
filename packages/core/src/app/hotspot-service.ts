import { CONFLICT_EVENT_TYPES, conflictRecords } from '../domain/conflict-record.js';
import { detectHotspots, hotspotSettingsOf, hotspotWindowFrom } from '../domain/hotspots.js';
import type { Hotspot, HotspotView } from '../domain/hotspots.js';
import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { BoardJobResult } from '../domain/signals.js';
import type { Store } from '../ports.js';
import { memberOf } from './access.js';
import type { CodeView } from './code-view.js';
import type { HotspotDecisions } from './hotspot-decisions.js';

export type HotspotsResult = Extract<BoardJobResult, { kind: 'hotspots' }>;

/** The most commits read per file when counting the merges that changed it. */
const HISTORY_LIMIT = 100;
/** The files a job result names. */
const RESULT_FILES = 10;
/** The most files the view reads merges and lines for (the hottest first); the rest are listed without them. */
const ENRICHED_FILES = 10;

/**
 * Conflict hotspots (spec, Conflict hotspots): files that keep conflicting. They are worked out from the board's conflict
 * events each time (nothing is stored), so a file stops being hot as soon as its conflicts leave the window. The merges
 * that touched a hot file and its size come from the code host's history of the base branch, when it can be read.
 */
export class HotspotService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: { now(): string };
      /** Absent: merges and lines are not filled in. */
      codeView?: Pick<CodeView, 'history' | 'read'>;
      /** Absent: the job lists hotspots but raises no decisions. */
      decisions?: HotspotDecisions;
    },
  ) {}

  /** The board's hotspots at `now`; the hottest files get merges and lines where the code host can say (`enrich` false: none, as the job needs). */
  async hotspots(boardId: number, now: string, enrich = true): Promise<HotspotView> {
    const settings = hotspotSettingsOf(
      await this.deps.store.transaction((tx) => tx.getContextSettings(boardId)),
    );
    const from = hotspotWindowFrom(now, settings.windowDays);
    const events = await this.deps.store.transaction((tx) =>
      tx.listBoardEvents(boardId, from, CONFLICT_EVENT_TYPES),
    );
    const found = detectHotspots(conflictRecords(events), now, settings);
    const hotspots = enrich
      ? await Promise.all(
          found.map((h, i) =>
            i < ENRICHED_FILES ? this.enrich(boardId, h, from) : Promise.resolve(h),
          ),
        )
      : found;
    return { windowDays: settings.windowDays, hotspots };
  }

  /** For members: the board's hotspots now. */
  async view(email: string, boardId: number): Promise<Result<HotspotView>> {
    const allowed = await this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return (await tx.getBoard(boardId)) === null ? notFound(`No board ${boardId}`) : ok(null);
    });
    if (!allowed.ok) return allowed;
    return ok(await this.hotspots(boardId, this.deps.clock.now()));
  }

  /** The hotspots job: what is hot at `now`, for the Knowledge page's last-run line. */
  async run(boardId: number, now: string): Promise<HotspotsResult> {
    const { decisions } = this.deps;
    const { hotspots, windowDays } = await this.hotspots(boardId, now, decisions !== undefined);
    const raised = decisions === undefined ? [] : await decisions.raise(boardId, hotspots, windowDays, now);
    return {
      kind: 'hotspots',
      hot: hotspots.length,
      ...(raised.length === 0 ? {} : { raised }),
      files: hotspots
        .slice(0, RESULT_FILES)
        .map((h) => ({ path: h.path, conflicts: h.conflicts, globs: h.globs.length })),
    };
  }

  /** Merges since `from` and the lines on the base branch; either stays null when the code host can't answer. */
  private async enrich(boardId: number, hotspot: Hotspot, from: string): Promise<Hotspot> {
    const { codeView } = this.deps;
    if (codeView === undefined) return hotspot;
    const [merges, lines] = await Promise.all([
      codeView.history(boardId, hotspot.path, HISTORY_LIMIT).then(
        (commits) => commits.filter((c) => Date.parse(c.date) >= Date.parse(from)).length,
        () => null,
      ),
      codeView.read(boardId, null, hotspot.path).then(
        (file) => (file === null || file.binary ? null : file.totalLines),
        () => null,
      ),
    ]);
    return { ...hotspot, merges, lines };
  }
}
