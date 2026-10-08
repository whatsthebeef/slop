import type { Board, Containment, EffectKind, EnvironmentService } from '@slop/core';
import type { CommitGraph } from './codehost.js';
import { repoOf } from './codehost.js';
import type { Executor } from './jobs/outbox.js';

/** How many compare calls one containment check makes at once. */
const CONCURRENCY = 4;

/**
 * Outbox executors for release and integration environments. A reported deploy's check asks the code host whether
 * the deployed commit contains each candidate glob's merge commit, then stores the answers through the environment
 * service. Answers are recomputed in full on every attempt, so a retry is idempotent; a compare that fails throws,
 * and the outbox retries the whole check.
 */
export const environmentExecutors = (
  environments: Pick<EnvironmentService, 'candidates' | 'recordContainment'>,
  graph: CommitGraph,
  configured: () => boolean,
  boardOf: (id: number) => Promise<Board | null>,
  log: (task: string, message: string) => void,
): Partial<Record<EffectKind, Executor>> => ({
  check_environment: async (effect) => {
    if (effect.kind !== 'check_environment') return 'dropped';
    const board = await boardOf(effect.boardId);
    const repo = board === null ? null : repoOf(board);
    if (repo === null || !configured()) return 'dropped';
    const candidates = await environments.candidates(effect.boardId, effect.environment, effect.sha);
    // A newer deploy's check will run, or the environment is no longer observed.
    if (candidates === null) return 'dropped';
    const results: Containment[] = [];
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      results.push(
        ...(await Promise.all(
          batch.map(async ({ globId, mergeSha }) => {
            const contained = await graph.contains(repo, effect.sha, mergeSha);
            if (contained === null) {
              log('environments', `${globId}: ${repo.owner}/${repo.name} doesn't know ${mergeSha} or ${effect.sha}; counted as not in ${effect.environment}`);
            }
            return { globId, mergeSha, contained: contained === true };
          }),
        )),
      );
    }
    const outcome = await environments.recordContainment(effect.boardId, effect.environment, effect.sha, results);
    return outcome === 'stale' ? 'dropped' : 'done';
  },
});
