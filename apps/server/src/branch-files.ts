import type { BranchFiles, Board, Glob } from '@slop/core';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';

/** A branch's files are re-read after this long, so one evaluation over many globs costs one call each at most. */
const CACHE_MS = 60_000;
/** Most branches kept; the oldest go first. */
const CACHE_MAX = 500;

/**
 * The files a glob's branch changes against the base, from the code host's compare (`<base>...<branch>`, the branch
 * named by the glob ID; the host lists at most 300). Cached briefly per branch head. A failure is logged and reads as
 * unknown (null): the merge policy never holds a glob for a branch it couldn't read.
 */
export class HostBranchFiles implements BranchFiles {
  private readonly cache = new Map<string, { at: number; files: readonly string[] }>();

  constructor(
    private readonly host: () => Pick<CodeHost, 'configured' | 'diffSummary'>,
    private readonly log: (task: string, message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  async filesOf(board: Board, glob: Glob): Promise<readonly string[] | null> {
    const repo = repoOf(board);
    const host = this.host();
    // Without a provisioned branch there is nothing to compare.
    if (repo === null || !host.configured || glob.provisioning !== 'ok') return null;
    const key = `${board.id}|${glob.id}|${glob.pr?.headSha ?? ''}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && this.now() - cached.at < CACHE_MS) return cached.files;
    try {
      const { files } = await host.diffSummary(repo, glob.id);
      if (this.cache.size >= CACHE_MAX) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
      this.cache.set(key, { at: this.now(), files });
      return files;
    } catch (error) {
      this.log('branch-files', `Reading the files of ${glob.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
