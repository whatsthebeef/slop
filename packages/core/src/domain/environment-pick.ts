import type { Deploy } from './deploys.js';
import { listOf } from './matrix.js';
import type { Environment, Glob, List } from './types.js';
import { isHumanCategory } from './types.js';

/** The environments a new glob may be given automatically: branch deploys allowed. */
export const autoEnvironments = (environments: readonly Environment[]): readonly Environment[] =>
  environments.filter((e) => e.allowBranchDeploy);

/** How far along each list is: a holder further along keeps its environment, so it is the one the newcomer should share. */
const PROGRESS: Readonly<Record<List, number>> = { planning: 0, doing: 1, reviewing: 2, signed_off: -1 };

export interface EnvironmentPick {
  readonly environment: string;
  /** One line for the glob's details: why this environment. */
  readonly reason: string;
}

/**
 * The environment a new code glob gets when nobody chose one: the first free candidate in the board's order; when none is free, the one whose holder is furthest along (Reviewing before
 * Doing), then the least recently deployed, then the board's order. `open` are the board's globs; `latest` each glob's latest deploy.
 * Null when the board has no candidate.
 */
export const pickEnvironment = (
  environments: readonly Environment[],
  open: readonly Glob[],
  latest: readonly Deploy[],
): EnvironmentPick | null => {
  const candidates = autoEnvironments(environments);
  if (candidates.length === 0) return null;
  const live = open.filter((g) => !isHumanCategory(g.category) && g.status !== 'signed_off' && listOf(g.status) !== 'signed_off');
  const byId = new Map(live.map((g) => [g.id, g]));
  // Holders per environment, with when each was last deployed there (epoch 0 when it never was).
  const holders = new Map<string, { glob: Glob; at: number }[]>();
  const hold = (environment: string, glob: Glob, at: number): void => {
    const list = holders.get(environment) ?? [];
    if (!list.some((h) => h.glob.id === glob.id)) list.push({ glob, at });
    holders.set(environment, list);
  };
  const deployedAt = new Map<string, number>();
  for (const d of latest) deployedAt.set(`${d.globId}\u0000${d.environment}`, Date.parse(d.requestedAt));
  for (const g of live) {
    if (g.environment !== null) hold(g.environment, g, deployedAt.get(`${g.id}\u0000${g.environment}`) ?? 0);
  }
  for (const d of latest) {
    const g = byId.get(d.globId);
    if (g !== undefined) hold(d.environment, g, Date.parse(d.requestedAt));
  }
  const free = candidates.find((e) => (holders.get(e.name) ?? []).length === 0);
  if (free !== undefined) return { environment: free.name, reason: `${free.name}: free` };
  const ranked = candidates.map((e, index) => {
    const hs = holders.get(e.name) ?? [];
    const progress = Math.max(...hs.map((h) => PROGRESS[listOf(h.glob.status)]));
    const at = Math.max(...hs.map((h) => h.at));
    const holder = [...hs].sort((a, b) => PROGRESS[listOf(b.glob.status)] - PROGRESS[listOf(a.glob.status)] || b.at - a.at)[0]?.glob.id ?? '';
    return { e, index, progress, at, holder };
  });
  ranked.sort((a, b) => b.progress - a.progress || a.at - b.at || a.index - b.index);
  const chosen = ranked[0];
  if (chosen === undefined) return null;
  return { environment: chosen.e.name, reason: `${chosen.e.name}: shared with ${chosen.holder} (all busy)` };
};
