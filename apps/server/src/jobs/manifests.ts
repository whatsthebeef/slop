import type { Board, ManifestChange, ManifestSource, MergedCommit } from '@slop/core';
import { addedDependencies, isManifestPath } from '@slop/core';
import type { CodeHost } from '../codehost.js';
import { repoOf } from '../codehost.js';

/** How long one code-host call may take: a hung request mustn't hold the mining run past its lease. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * Reads what merged commits did to dependency manifests, for the mining run's new-dependency signal: each
 * changed manifest's text before and after the commit, parsed in core. A commit that can't be read is left
 * out (logged); a board whose repo can't be reached isn't measured at all (null).
 */
export class CodeHostManifests implements ManifestSource {
  constructor(
    private readonly host: Pick<CodeHost, 'configured' | 'commitFiles' | 'readFile'>,
    private readonly log: (task: string, message: string) => void,
  ) {}

  async manifestChanges(board: Board, commits: readonly MergedCommit[]): Promise<ManifestChange[] | null> {
    const repo = repoOf(board);
    if (repo === null || !this.host.configured) return null;
    const changes: ManifestChange[] = [];
    for (const commit of commits) {
      try {
        const { parent, files } = await this.host.commitFiles(repo, commit.sha, AbortSignal.timeout(CALL_TIMEOUT_MS));
        for (const file of files) {
          if (file.status === 'removed' || !isManifestPath(file.path)) continue;
          const before =
            parent === null || file.status === 'added'
              ? null
              : await this.host.readFile(repo, parent, file.previousPath ?? file.path, AbortSignal.timeout(CALL_TIMEOUT_MS));
          const after = await this.host.readFile(repo, commit.sha, file.path, AbortSignal.timeout(CALL_TIMEOUT_MS));
          changes.push({ globId: commit.globId, sha: commit.sha, path: file.path, dependencies: addedDependencies(file.path, before, after) });
        }
      } catch (error) {
        this.log('mining', `Reading the manifests of ${commit.globId}'s merge ${commit.sha.slice(0, 7)} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return changes;
  }
}
