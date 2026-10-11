import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { globFindings } from '../domain/findings.js';
import type { GlobFindings } from '../domain/findings.js';
import type { Clock, Notifier, Store } from '../ports.js';
import { memberOf } from './access.js';

/**
 * Review findings beside the glob: the glob view's findings (local reviews are queued for the findings pipeline
 * by `ArtifactService.putArtifact`).
 */
export class FindingsService {
  constructor(private readonly deps: { store: Store; clock: Clock; notifier: Notifier }) {}

  /** A glob's findings with their counts per class, for board members. */
  async forGlob(email: string, globId: string): Promise<Result<GlobFindings>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      return ok(globFindings(await tx.listFindings(globId), await tx.listReviewSources(globId)));
    });
  }
}
