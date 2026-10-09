import { findClash, machine } from '@slop/core';
import type { Board, BranchFiles, EffectKind, Store } from '@slop/core';
import type { Executor } from './jobs/outbox.js';

/**
 * Outbox executors for the board's merge policy. `check_exclusive_paths` reads which exclusive paths the glob's branch
 * changes and whether another open glob changes them too, and records or clears the warning on the glob (never a block).
 */
export const exclusivePathExecutors = (
  store: Store,
  branchFiles: BranchFiles,
  boardOf: (id: number) => Promise<Board | null>,
): Partial<Record<EffectKind, Executor>> => ({
  check_exclusive_paths: async (effect, glob, { globs }) => {
    if (effect.kind !== 'check_exclusive_paths' || glob === null || glob.status !== 'in_progress' || glob.pr === null) return 'dropped';
    const board = await boardOf(glob.boardId);
    if (board === null) return 'dropped';
    const clash = await findClash(store, branchFiles, board, glob);
    await globs.applyEvent(glob.id, (g, ctx) => machine.clashChanged(g, clash, ctx));
    return 'done';
  },
});
