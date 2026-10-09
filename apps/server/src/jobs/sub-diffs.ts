import { countedLines } from '@slop/core';
import type { Board, SubDiffSource } from '@slop/core';
import type { CodeHost } from '../codehost.js';
import { repoOf } from '../codehost.js';

/** How long one code-host call may take: a hung request mustn't hold the sub-limit run past its lease. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * A merged sub's size from its squash-merge commit, for the learned sub limit when the gate verdict it merged on was
 * recorded without a line count. Null when the board's repo can't be read; a failed call is logged and rethrown, and
 * the outcome is recorded without a count.
 */
export class CodeHostSubDiffs implements SubDiffSource {
  constructor(
    private readonly host: Pick<CodeHost, 'configured' | 'commitDiffSummary'>,
    private readonly log: (task: string, message: string) => void,
  ) {}

  async mergedChangedLines(board: Board, sha: string, sizeIgnoredPaths: readonly string[]): Promise<number | null> {
    const repo = repoOf(board);
    if (repo === null || !this.host.configured) return null;
    try {
      return countedLines(await this.host.commitDiffSummary(repo, sha, AbortSignal.timeout(CALL_TIMEOUT_MS)), sizeIgnoredPaths).changedLines;
    } catch (error) {
      this.log(
        'sub_limit',
        `Reading the size of merge ${sha.slice(0, 7)} on board ${String(board.id)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
