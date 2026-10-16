import type { FileConflict } from './conflict-record.js';
import type { ContextSettings } from './context-settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Conflicts that all fall inside this span are one burst of parallel work. */
export const HOTSPOT_BURST_MS = DAY_MS;

/** What makes a file a hotspot, read from the board's settings. */
export interface HotspotSettings {
  /** Conflicts older than this many days don't count. */
  readonly windowDays: number;
  /** Distinct globs (or workstreams of a glob) that conflicted on the file inside the window. */
  readonly minGlobs: number;
  /** Real (not purely additive) conflicts on the file inside the window. */
  readonly minReal: number;
}

export const hotspotSettingsOf = (settings: ContextSettings): HotspotSettings => ({
  windowDays: settings.hotspot_window_days,
  minGlobs: settings.hotspot_min_globs,
  minReal: settings.hotspot_min_real,
});

/** A file that keeps conflicting, with the numbers inside the window. `merges` and `lines` come from the code host. */
export interface Hotspot {
  readonly path: string;
  /** Conflicts the file got inside the window (one per glob per conflict). */
  readonly conflicts: number;
  /** The globs that conflicted on it, oldest first. */
  readonly globs: readonly string[];
  /** Conflicts resolved as a real clash, as against purely additive ones or ones not known. */
  readonly real: number;
  readonly lastConflictAt: string;
  /** Of `conflicts`, those met when workstreams of one glob were integrated; absent when none. */
  readonly workstreamConflicts?: number;
  /** Of `conflicts`, those resolved as purely additive (both sides added different things). */
  readonly additive?: number;
  /** When the first conflict inside the window happened. */
  readonly firstConflictAt?: string;
  /** True when every conflict inside the window fell within a day of the others: one burst of related work, not a standing pattern. */
  readonly burst?: boolean;
  /** Merges that changed the file inside the window; null when the code host couldn't say. */
  readonly merges: number | null;
  /** The file's size on the base branch; null when it couldn't be read. */
  readonly lines: number | null;
}

/** When the window ending at `now` starts. */
export const hotspotWindowFrom = (now: string, windowDays: number): string =>
  new Date(Date.parse(now) - windowDays * DAY_MS).toISOString();

/**
 * The files that are hotspots at `now`: those with conflicts inside the window from at least `minGlobs` different globs
 * or at least `minReal` real ones. A file whose conflicts have all left the window is not listed, so a quiet window
 * clears it. Hottest first (most conflicts, then most globs, then path).
 */
export const detectHotspots = (
  conflicts: readonly FileConflict[],
  now: string,
  settings: HotspotSettings,
): Hotspot[] => {
  const from = hotspotWindowFrom(now, settings.windowDays);
  const byPath = new Map<string, FileConflict[]>();
  for (const c of conflicts) {
    if (c.flaggedAt < from || c.flaggedAt > now) continue;
    byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
  }
  const hot: Hotspot[] = [];
  for (const [path, rows] of byPath) {
    const ordered = [...rows].sort((a, b) => a.flaggedAt.localeCompare(b.flaggedAt));
    const globs = [...new Set(ordered.map((r) => r.globId))];
    const real = ordered.filter((r) => r.kind === 'real').length;
    const workstream = ordered.filter((r) => r.workstream !== undefined).length;
    const additive = ordered.filter((r) => r.kind === 'additive').length;
    const firstConflictAt = ordered[0]?.flaggedAt ?? from;
    const lastConflictAt = ordered[ordered.length - 1]?.flaggedAt ?? from;
    // A workstream that conflicted on the file counts as one more party, like a glob: parallel work keeps landing in it.
    const parties = new Set(ordered.map((r) => (r.workstream === undefined ? r.globId : `${r.globId}/${r.workstream}`)));
    if (parties.size < settings.minGlobs && real < settings.minReal) continue;
    hot.push({
      path,
      conflicts: ordered.length,
      globs,
      real,
      lastConflictAt,
      firstConflictAt,
      additive,
      burst: Date.parse(lastConflictAt) - Date.parse(firstConflictAt) <= HOTSPOT_BURST_MS,
      ...(workstream === 0 ? {} : {workstreamConflicts: workstream}),
      merges: null,
      lines: null,
    });
  }
  return hot.sort(
    (a, b) =>
      b.conflicts - a.conflicts || b.globs.length - a.globs.length || a.path.localeCompare(b.path),
  );
};

/** The hotspots with the window they were found in, as the Knowledge page and `get_context` read them. */
export interface HotspotView {
  readonly windowDays: number;
  readonly hotspots: readonly Hotspot[];
}

/** One conflict on a hotspot's file, in the words the recommendation cites. */
export interface HotspotConflictFact {
  readonly globId: string;
  readonly workstream: string | null;
  readonly flaggedAt: string;
  /** Minutes from the conflict to its resolution; null while open or when not known. */
  readonly minutesToFix: number | null;
  readonly kind: 'additive' | 'real' | 'unknown';
  readonly by: 'run' | 'human' | null;
}

/** What the recommendation reads about a hotspot: the conflicts inside the window, newest last, and how they add up. */
export interface HotspotFacts {
  readonly path: string;
  readonly windowDays: number;
  readonly conflicts: readonly HotspotConflictFact[];
  readonly additive: number;
  readonly real: number;
  readonly burst: boolean;
  /** The span from the first to the last conflict, in hours. */
  readonly spanHours: number;
}

/** The conflicts on `path` inside the window ending at `now`, as facts. */
export const hotspotFacts = (path: string, conflicts: readonly FileConflict[], now: string, windowDays: number): HotspotFacts => {
  const from = hotspotWindowFrom(now, windowDays);
  const rows = conflicts.filter((c) => c.path === path && c.flaggedAt >= from && c.flaggedAt <= now).sort((a, b) => a.flaggedAt.localeCompare(b.flaggedAt));
  const spanMs = rows.length === 0 ? 0 : Date.parse(rows[rows.length - 1]?.flaggedAt ?? now) - Date.parse(rows[0]?.flaggedAt ?? now);
  return {
    path,
    windowDays,
    conflicts: rows.map((c) => ({
      globId: c.globId,
      workstream: c.workstream ?? null,
      flaggedAt: c.flaggedAt,
      minutesToFix: c.resolvedAt === null ? null : Math.max(0, Math.round((Date.parse(c.resolvedAt) - Date.parse(c.flaggedAt)) / 60_000)),
      kind: c.kind ?? 'unknown',
      by: c.by,
    })),
    additive: rows.filter((c) => c.kind === 'additive').length,
    real: rows.filter((c) => c.kind === 'real').length,
    burst: rows.length > 1 && spanMs <= HOTSPOT_BURST_MS,
    spanHours: Math.round(spanMs / 3_600_000),
  };
};
