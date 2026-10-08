import { CODE_REVIEW_BODY_LIMIT, codeReviewBadge, globCodeReview } from '../domain/code-review.js';
import type { CodeReviewBadge, CodeReviewKind, GlobCodeReview } from '../domain/code-review.js';
import { forbidden, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Clock, Notifier, Store } from '../ports.js';

export interface CodeReviewServiceDeps {
  readonly store: Store;
  readonly notifier: Notifier;
  readonly clock: Clock;
}

/** One CodeRabbit item as the code host delivered it. */
export interface ReceivedCodeReview {
  readonly prNumber: number;
  readonly externalId: string;
  readonly kind: CodeReviewKind;
  readonly author: string;
  readonly commitSha: string | null;
  readonly path: string | null;
  readonly line: string | null;
  readonly body: string;
  readonly url: string | null;
  /** When the code host says it was written and last edited; now when it doesn't say. */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * Application service for CodeRabbit's results on a glob's PR, stored verbatim beside the glob (no version bump, a
 * `glob.reviews` hint). It doesn't classify anything: the findings pipeline queues each new inline comment separately.
 */
export class CodeReviewService {
  constructor(private readonly deps: CodeReviewServiceDeps) {}

  /** Stores a new item or an edit of a stored one (CodeRabbit edits its summary in place). False: nothing changed. */
  async record(globId: string, item: ReceivedCodeReview): Promise<boolean> {
    const now = this.deps.clock.now();
    const boardId = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return null;
      const createdAt = item.createdAt ?? now;
      const changed = await tx.upsertCodeReviewComment({
        ...item,
        boardId: glob.boardId,
        globId,
        body: item.body.slice(0, CODE_REVIEW_BODY_LIMIT),
        createdAt,
        updatedAt: item.updatedAt ?? createdAt,
      });
      return changed ? glob.boardId : null;
    });
    if (boardId === null) return false;
    this.deps.notifier.publish({ kind: 'glob.reviews', boardId, globId });
    return true;
  }

  /**
   * Forgets an item deleted on the code host, keeping a tombstone so a late redelivery of it doesn't store it again.
   * False when it wasn't stored.
   */
  async remove(externalId: string): Promise<boolean> {
    const now = this.deps.clock.now();
    const removed = await this.deps.store.transaction((tx) => tx.deleteCodeReviewComment(externalId, now));
    if (removed === null) return false;
    this.deps.notifier.publish({ kind: 'glob.reviews', boardId: removed.boardId, globId: removed.globId });
    return true;
  }

  /** The cards' badges for the given globs (globs with nothing stored are left out). */
  async boardBadges(email: string, boardId: number, globIds: readonly string[]): Promise<Result<Map<string, CodeReviewBadge>>> {
    return this.deps.store.transaction(async (tx) => {
      if ((await tx.getMember(boardId, email)) === null) return forbidden(`You are not a member of board ${String(boardId)}`);
      const badges = new Map<string, CodeReviewBadge>();
      if (globIds.length === 0) return ok(badges);
      const stored = await tx.listCodeReviewComments(boardId, globIds);
      for (const globId of new Set(stored.map((c) => c.globId))) {
        const badge = codeReviewBadge(stored.filter((c) => c.globId === globId));
        if (badge !== null) badges.set(globId, badge);
      }
      return ok(badges);
    });
  }

  /** Everything stored for one glob, for the glob view (board members only). */
  async forGlob(email: string, globId: string): Promise<Result<GlobCodeReview>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      if ((await tx.getMember(glob.boardId, email)) === null) {
        return forbidden(`You are not a member of board ${String(glob.boardId)}`);
      }
      return ok(globCodeReview(await tx.listCodeReviewComments(glob.boardId, [globId])));
    });
  }
}
