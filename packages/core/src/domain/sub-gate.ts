import type { SubGateCause } from './sub-limit.js';
import type { Board } from './types.js';

export interface DiffSummary {
  readonly changedLines: number;
  readonly files: readonly string[];
  /** Lines changed per file, when the code host gave them: what leaves generated files out of the size. */
  readonly fileLines?: Readonly<Record<string, number>>;
}

/**
 * Paths left out of a sub's size when the board's merge policy lists none (`sizeIgnoredPaths` empty or no policy):
 * lockfiles and generated Drizzle snapshots.
 */
export const DEFAULT_SIZE_IGNORED_PATHS: readonly string[] = [
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/drizzle/meta/**',
];

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

/** The path globs left out of the size: the policy's own list, or the defaults when it has none. */
export const sizeIgnoredPathsOf = (policy: { readonly sizeIgnoredPaths?: readonly string[] } | null | undefined): readonly string[] =>
  policy?.sizeIgnoredPaths !== undefined && policy.sizeIgnoredPaths.length > 0 ? policy.sizeIgnoredPaths : DEFAULT_SIZE_IGNORED_PATHS;

/** A diff's size without the files matching `ignoredPaths`: the lines counted, and the generated lines left out. */
export const countedLines = (diff: DiffSummary, ignoredPaths: readonly string[]): { readonly changedLines: number; readonly ignoredLines: number } => {
  let ignoredLines = 0;
  for (const [file, lines] of Object.entries(diff.fileLines ?? {})) {
    if (ignoredPaths.some((g) => g.trim() !== '' && matchesGlob(file, g))) ignoredLines += lines;
  }
  ignoredLines = Math.min(ignoredLines, diff.changedLines);
  return { changedLines: diff.changedLines - ignoredLines, ignoredLines };
};

/** The gate's verdict: why a sub converted (`cause`), and the lines it changes, recorded for the learned limit. */
export interface SubGateVerdict {
  readonly passed: boolean;
  readonly reason: string | null;
  readonly cause: SubGateCause | null;
  /** The lines counted against the limit: generated files are left out. */
  readonly changedLines: number;
  /** Generated lines left out of `changedLines`; 0 when none were. */
  readonly ignoredLines: number;
}

/**
 * The board's sub-gate policy, applied once the repo's own checks pass: a sub that changes
 * too much or touches a sensitive path is flagged and becomes a same (row 13). The limit is the board's learned one
 * as read for this decision (`sub-limit.ts`).
 */
export const subGatePolicy = (
  diff: DiffSummary,
  board: Pick<Board, 'subMaxChangedLines' | 'sensitivePaths'>,
  sizeIgnoredPaths: readonly string[] = DEFAULT_SIZE_IGNORED_PATHS,
): SubGateVerdict => {
  // The sensitive-path check sees every file; only the size leaves generated ones out.
  const { changedLines, ignoredLines } = countedLines(diff, sizeIgnoredPaths);
  const sensitive = diff.files.filter((f) => board.sensitivePaths.some((g) => g.trim() !== '' && matchesGlob(f, g)));
  if (sensitive.length > 0) {
    return { passed: false, reason: `Touches sensitive paths: ${sensitive.slice(0, 5).join(', ')}`, cause: 'sensitive', changedLines, ignoredLines };
  }
  if (changedLines > board.subMaxChangedLines) {
    return {
      passed: false,
      reason: `Changes ${String(changedLines)} lines${ignoredLines > 0 ? `, not counting ${ignoredLines.toLocaleString('en-US')} generated` : ''} (limit ${String(board.subMaxChangedLines)})`,
      cause: 'size',
      changedLines,
      ignoredLines,
    };
  }
  return { passed: true, reason: null, cause: null, changedLines, ignoredLines };
};
