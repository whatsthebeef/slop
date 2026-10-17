import * as deploys from '../domain/deploys.js';
import type { BuildFailed } from '../domain/deploys.js';
import type { Tx } from '../ports.js';

/**
 * The failed builds to show on globs: each glob's latest deploy when its build failed and nobody has acted on the glob since
 * (a push, Retry, Pick up, Take over or a new deploy). Read in the caller's transaction.
 */
export const buildFailedFor = async (tx: Tx, boardId: number, globIds: readonly string[]): Promise<Map<string, BuildFailed>> => {
  const out = new Map<string, BuildFailed>();
  if (globIds.length === 0) return out;
  for (const d of await tx.latestDeploys(boardId, globIds)) {
    if (d.state !== 'failed' || d.providerRef === null) continue;
    const since = d.finishedAt ?? d.requestedAt;
    const acted = await tx.listBoardEvents(boardId, since, deploys.ACTED_EVENTS, [d.globId]);
    const failed = deploys.buildFailedOf(d, acted.length > 0);
    if (failed !== null) out.set(d.globId, failed);
  }
  return out;
};
