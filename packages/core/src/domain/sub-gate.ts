import type { Board } from './types.js';

export interface DiffSummary {
  readonly changedLines: number;
  readonly files: readonly string[];
}

/** Matches a path against a glob: `**` spans directories, `*` stays within one. */
export const matchesGlob = (path: string, glob: string): boolean => {
  const ANY = '@@ANY@@';
  const pattern = glob
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, ANY)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(ANY)
    .join('.*');
  return new RegExp(`^${pattern}$`).test(path);
};

/**
 * The board's sub-gate policy, applied once the repo's own checks pass: a sub that changes
 * too much or touches a sensitive path is flagged and becomes a same (row 13).
 */
export const subGatePolicy = (
  diff: DiffSummary,
  board: Pick<Board, 'subMaxChangedLines' | 'sensitivePaths'>,
): { passed: boolean; reason: string | null } => {
  const sensitive = diff.files.filter((f) => board.sensitivePaths.some((g) => g.trim() !== '' && matchesGlob(f, g)));
  if (sensitive.length > 0) {
    return { passed: false, reason: `Touches sensitive paths: ${sensitive.slice(0, 5).join(', ')}` };
  }
  if (diff.changedLines > board.subMaxChangedLines) {
    return {
      passed: false,
      reason: `Changes ${String(diff.changedLines)} lines (limit ${String(board.subMaxChangedLines)})`,
    };
  }
  return { passed: true, reason: null };
};
