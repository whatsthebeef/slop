import type { FileConflict } from './conflict-record.js';
import type { ContextSettings } from './context-settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What makes a file a hotspot, read from the board's settings. */
export interface HotspotSettings {
  /** Conflicts older than this many days don't count. */
  readonly windowDays: number;
  /** Distinct globs that conflicted on the file inside the window. */
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
    if (globs.length < settings.minGlobs && real < settings.minReal) continue;
    hot.push({
      path,
      conflicts: ordered.length,
      globs,
      real,
      lastConflictAt: ordered[ordered.length - 1]?.flaggedAt ?? from,
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
