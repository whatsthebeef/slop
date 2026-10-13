import { rolloutPathsOf, touchesRolloutPaths } from '@slop/core';
import type { Board, ChangeSource, EffectKind } from '@slop/core';
import type { Executor } from './jobs/outbox.js';

/**
 * Outbox executors for rollout detection. `check_rollout_paths` reads the files of a glob's merge commit and, when they
 * touch the board's rollout paths and the glob's record wrote no rollout steps, adds the "Rollout steps not written"
 * step. A diff that can't be read flags nothing and doesn't retry: a missed flag is better than a false one.
 */
export const rolloutExecutors = (
  changes: ChangeSource,
  boardOf: (id: number) => Promise<Board | null>,
  /** The board's merge policy's `rolloutPaths` (undefined: none set, so the defaults apply). */
  rolloutPaths: (boardId: number) => Promise<readonly string[] | undefined>,
  log: (task: string, message: string) => void,
): Partial<Record<EffectKind, Executor>> => ({
  check_rollout_paths: async (effect, glob, { globs }) => {
    if (effect.kind !== 'check_rollout_paths' || glob === null || (glob.status !== 'reviewing' && glob.status !== 'signed_off')) return 'dropped';
    const board = await boardOf(glob.boardId);
    if (board === null) return 'dropped';
    let files: readonly string[];
    try {
      const diff = await changes.mergedDiff(board, effect.sha);
      if (diff === null) return 'done';
      files = diff.files;
    } catch (error) {
      log('rollout', `Reading the files of ${glob.id}'s merge ${effect.sha.slice(0, 7)} failed, so no rollout check: ${error instanceof Error ? error.message : String(error)}`);
      return 'done';
    }
    if (touchesRolloutPaths(files, rolloutPathsOf({ rolloutPaths: await rolloutPaths(board.id) }))) await globs.flagUnwrittenRollout(glob.id);
    return 'done';
  },
});
