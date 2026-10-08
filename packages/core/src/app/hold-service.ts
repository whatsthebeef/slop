import { exclusiveFiles, MAX_HOLD_PATHS, namesExclusivePath } from '../domain/exclusive-paths.js';
import type { Board, Glob, ImpliedAfter } from '../domain/types.js';
import { reaches } from '../domain/waiting.js';
import type { BranchFiles, Store } from '../ports.js';
import { readMergePolicy } from './knowledge-service.js';

/** What is about to start: its plan, and the files intake guessed it changes (advisory). */
export interface HoldCandidate {
  /** Null for a glob that doesn't exist yet. */
  readonly id: string | null;
  readonly plan: string;
  readonly files?: readonly string[];
}

/** Globs that are neither merged nor, for want of a branch, able to have changed anything. */
const hasBranch = (glob: Glob): boolean =>
  glob.provisioning !== 'none' && glob.status !== 'planning' && glob.status !== 'reviewing' && glob.status !== 'signed_off';

/**
 * The board's merge policy applied to a glob about to start: which open globs it should wait for because both may
 * change an exclusive path. The hold applies only when the plan names an exclusive path or a migration, or intake's
 * file guess includes one; otherwise the glob starts and is warned later (`check_exclusive_paths`).
 *
 * An open glob counts when its branch already changes an exclusive path (the code host's compare, read through
 * `branchFiles`), or when it is in Doing with a plan that names one and no file there yet: two globs released together
 * would otherwise both see the other's empty branch and start. Failures to read a branch count as unknown, never a
 * hold. `skip` are globs not to hold for (already waited for, or a hold a person overrode).
 */
export const findHolds = async (
  store: Store,
  branchFiles: BranchFiles,
  board: Board,
  candidate: HoldCandidate,
  skip: ReadonlySet<string>,
): Promise<ImpliedAfter[]> => {
  const read = await store.transaction(async (tx) => {
    const policy = await readMergePolicy(tx, board.id);
    if ((policy.exclusivePaths ?? []).length === 0) return null;
    const guess = exclusiveFiles(policy, candidate.files ?? []).length > 0;
    if (!guess && !namesExclusivePath(policy, candidate.plan)) return null;
    const globs = await tx.listGlobs(board.id, {});
    const byId = new Map(globs.map((g) => [g.id, g]));
    const others = globs.filter(
      (g) =>
        g.id !== candidate.id &&
        !skip.has(g.id) &&
        hasBranch(g) &&
        // A glob that waits (even through others) for the candidate can't be waited for.
        (candidate.id === null || !reaches(g.id, candidate.id, (id) => byId.get(id))),
    );
    const plans = new Map<string, string>();
    for (const other of others) {
      const plan = (await tx.listArtifacts(other.id, 'plan'))[0];
      if (plan !== undefined) plans.set(other.id, plan.content);
    }
    return { policy, others, plans };
  });
  if (read === null) return [];

  const holds: ImpliedAfter[] = [];
  for (const other of read.others) {
    const files = await branchFiles.filesOf(board, other);
    const hits = exclusiveFiles(read.policy, files ?? []);
    if (hits.length > 0) {
      holds.push({ id: other.id, paths: hits.slice(0, MAX_HOLD_PATHS) });
    } else if ((files ?? []).length === 0 && other.status !== 'failed' && namesExclusivePath(read.policy, read.plans.get(other.id) ?? '')) {
      holds.push({ id: other.id, paths: (read.policy.exclusivePaths ?? []).slice(0, MAX_HOLD_PATHS) });
    }
  }
  return holds;
};

/**
 * Whether the glob's branch changes an exclusive path that another open glob's branch changes too (a warning for the
 * card, never a block): the other glob and the shared paths, or null when there is no clash.
 */
export const findClash = async (
  store: Store,
  branchFiles: BranchFiles,
  board: Board,
  glob: Glob,
): Promise<{ with: string; paths: readonly string[] } | null> => {
  const policy = await store.transaction((tx) => readMergePolicy(tx, board.id));
  if ((policy.exclusivePaths ?? []).length === 0) return null;
  const mine = exclusiveFiles(policy, (await branchFiles.filesOf(board, glob)) ?? []);
  if (mine.length === 0) return null;
  const others = (await store.transaction((tx) => tx.listGlobs(board.id, {}))).filter((g) => g.id !== glob.id && hasBranch(g));
  for (const other of others) {
    const theirs = new Set(exclusiveFiles(policy, (await branchFiles.filesOf(board, other)) ?? []));
    const shared = mine.filter((file) => theirs.has(file));
    // The same files, or any exclusive file on both sides (two migrations: different names, one journal).
    if (shared.length > 0 || theirs.size > 0) return { with: other.id, paths: (shared.length > 0 ? shared : mine).slice(0, MAX_HOLD_PATHS) };
  }
  return null;
};
