import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { globFindings } from '../domain/findings.js';
import type { GlobFindings, ReviewSource } from '../domain/findings.js';
import type { Clock, Notifier, Store } from '../ports.js';
import { memberOf } from './access.js';

/** The most of a CodeRabbit comment kept; the finding itself is cut shorter (`coderabbitText`). */
export const CODERABBIT_BODY_LIMIT = 20_000;

export interface CodeRabbitComment {
  /** `coderabbit:<comment id>`: a redelivered or repeated comment is recorded once. */
  readonly externalId: string;
  readonly body: string;
  readonly path: string | null;
  readonly line: string | null;
  readonly commitSha: string | null;
}

/**
 * Review findings beside the glob: CodeRabbit comments queued for the findings pipeline (local
 * reviews are queued by `ArtifactService.putArtifact`), and the glob view's findings.
 */
export class FindingsService {
  constructor(private readonly deps: { store: Store; clock: Clock; notifier: Notifier }) {}

  /**
   * Queues one CodeRabbit inline comment on a glob's PR, from the GitHub webhook (already
   * filtered to CodeRabbit's bot and the glob's own repo). Null when it was already recorded.
   */
  async recordCodeRabbitComment(globId: string, comment: CodeRabbitComment): Promise<Result<ReviewSource | null>> {
    const now = this.deps.clock.now();
    const recorded = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return null;
      return {
        boardId: glob.boardId,
        source: await tx.insertReviewSource({
          boardId: glob.boardId,
          globId,
          kind: 'coderabbit_comment',
          artifactId: null,
          externalId: comment.externalId,
          commitSha: comment.commitSha,
          agentSetVersion: null,
          content: comment.body.slice(0, CODERABBIT_BODY_LIMIT),
          path: comment.path,
          line: comment.line,
          createdAt: now,
        }),
      };
    });
    if (recorded === null) return notFound(`No glob ${globId}`);
    if (recorded.source !== null) this.deps.notifier.publish({ kind: 'glob.findings', boardId: recorded.boardId, globId });
    return ok(recorded.source);
  }

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
