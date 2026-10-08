import type { Board, ChangeSource, DiffSummary } from '@slop/core';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';

/** How long one code-host call may take: a hung request mustn't hold the indexer. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * The files and size of a merged change from its squash-merge commit, for the search index. Null when the board's repo
 * can't be read; a failed call is logged and rethrown (the change is retried, then indexed without its files).
 */
export class CodeHostChanges implements ChangeSource {
  constructor(
    private readonly host: Pick<CodeHost, 'configured' | 'commitDiffSummary'>,
    private readonly log: (task: string, message: string) => void,
  ) {}

  async mergedDiff(board: Board, sha: string): Promise<DiffSummary | null> {
    const repo = repoOf(board);
    if (repo === null || !this.host.configured) return null;
    try {
      return await this.host.commitDiffSummary(repo, sha, AbortSignal.timeout(CALL_TIMEOUT_MS));
    } catch (error) {
      this.log('search', `Reading the files of merge ${sha.slice(0, 7)} on board ${String(board.id)} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
