import type { Hotspot } from '../../domain/hotspots.js';

/** A hotspot as `get_context` shows it: the path with its counts inside the window. */
export type GlobHotspot = Pick<Hotspot, 'path' | 'conflicts' | 'real' | 'lastConflictAt'> & {
  readonly globs: number;
  readonly windowDays: number;
};

/** Whether `path` appears in `text` as a whole path (not inside a longer name such as `data.ts` for `a.ts`). */
const namesPath = (text: string, path: string): boolean => {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const before = text[at - 1];
    const after = text[at + path.length];
    if ((before === undefined || !/[\w./-]/.test(before)) && (after === undefined || !/[\w-]/.test(after) && !/\.\w/.test(text.slice(at + path.length, at + path.length + 2)))) return true;
  }
  return false;
};

/** The board's hotspots that are among the files a glob plans to change, or that it conflicted on itself. */
export const hotspotsOfGlob = (
  view: { readonly windowDays: number; readonly hotspots: readonly Hotspot[] },
  globId: string,
  planned: readonly string[],
  plan: string,
): GlobHotspot[] =>
  view.hotspots
    .filter((h) => planned.includes(h.path) || namesPath(plan, h.path) || h.globs.includes(globId))
    .map((h) => ({
      path: h.path,
      conflicts: h.conflicts,
      globs: h.globs.length,
      real: h.real,
      lastConflictAt: h.lastConflictAt,
      windowDays: view.windowDays,
    }));
