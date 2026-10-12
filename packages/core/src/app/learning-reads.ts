import { KB_STEP_KINDS } from '../domain/kb.js';
import { isLearning, LEARNING_ARTIFACT_KINDS, learningArtifactsOf } from '../domain/learning.js';
import type { LearningRead } from '../domain/learning.js';
import type { Glob } from '../domain/types.js';
import type { Tx } from '../ports.js';

/**
 * Reads learnings as raw rows: each glob with the latest version of its artifacts by role and its pipeline jobs, the
 * artifacts and jobs of all of them in one query each. Other globs are left out.
 */
export const readLearnings = async (tx: Tx, globs: readonly Glob[]): Promise<LearningRead[]> => {
  const learnings = globs.filter(isLearning);
  if (learnings.length === 0) return [];
  const ids = learnings.map((g) => g.id);
  const [artifacts, jobs] = await Promise.all([
    tx.latestArtifacts(ids, LEARNING_ARTIFACT_KINDS),
    tx.latestOutboxJobs(ids, KB_STEP_KINDS),
  ]);
  return learnings.map((glob) => ({
    glob,
    artifacts: learningArtifactsOf(glob.id, artifacts),
    jobs: jobs.filter((j) => j.globId === glob.id),
  }));
};

/** One learning, or null when there is no glob `id` or it isn't a learning. */
export const readLearning = async (tx: Tx, id: string): Promise<LearningRead | null> => {
  const glob = await tx.getGlob(id);
  return glob === null ? null : ((await readLearnings(tx, [glob]))[0] ?? null);
};

/** A board's learnings, oldest first (then by ID). */
export const boardLearnings = async (tx: Tx, boardId: number): Promise<LearningRead[]> =>
  (
    await readLearnings(
      tx,
      await tx.listGlobs(boardId, { include: 'decisions', origins: ['submitted', 'mined'] }),
    )
  ).sort(
    (a, b) =>
      a.glob.createdAt.localeCompare(b.glob.createdAt) || a.glob.id.localeCompare(b.glob.id),
  );
