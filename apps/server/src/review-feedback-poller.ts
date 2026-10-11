import { isWrongReply, miningWindowFrom, parseFindingMarker } from '@slop/core';
import type { Board, ReviewFeedbackService, Store } from '@slop/core';
import type { CodeHost, Repo } from './codehost.js';
import { repoOf } from './codehost.js';

/**
 * Collects what GitHub doesn't push: a thumbs-down reaction on the independent reviewer's inline comment, and `/wrong`
 * replies (also what the webhook sees, but an App that has not accepted the review-thread event misses them). Run just
 * before a board's weekly mining, over the PRs of globs reviewed in the mining window. Idempotent: each comment's verdict is
 * stored once, so rereading the same comments adds nothing.
 */
export class ReviewFeedbackPoller {
  constructor(
    private readonly deps: {
      readonly store: Store;
      readonly host: Pick<CodeHost, 'configured' | 'reviewComments'>;
      readonly feedback: Pick<ReviewFeedbackService, 'record'>;
      readonly log: (message: string) => void;
    },
  ) {}

  /** Returns how many verdicts were new. A PR that can't be read is logged and skipped. */
  async collect(board: Board, now: string): Promise<number> {
    const repo = repoOf(board);
    if (repo === null || !this.deps.host.configured) return 0;
    const reviewed = await this.deps.store.transaction(async (tx) => {
      const artifacts = await tx.listArtifactMeta(
        board.id,
        ['independent_review'],
        miningWindowFrom(now),
      );
      const prs = new Map<number, string>();
      for (const id of new Set(artifacts.map((a) => a.globId))) {
        const number = (await tx.getGlob(id))?.pr?.number;
        if (number !== undefined) prs.set(number, id);
      }
      return prs;
    });
    let recorded = 0;
    for (const [prNumber, globId] of reviewed) {
      try {
        recorded += await this.collectPr(board.id, globId, repo, prNumber, now);
      } catch (error) {
        this.deps.log(
          `review feedback: reading PR ${String(prNumber)} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return recorded;
  }

  private async collectPr(
    boardId: number,
    globId: string,
    repo: Repo,
    prNumber: number,
    now: string,
  ): Promise<number> {
    const comments = await this.deps.host.reviewComments(repo, prNumber);
    let recorded = 0;
    for (const root of comments) {
      if (root.inReplyTo !== null || !root.authorIsBot || parseFindingMarker(root.body) === null) continue;
      const about = { boardId, prGlobId: globId, rootIsBot: root.authorIsBot, body: root.body, path: root.path, line: root.line, at: now };
      const outcomes = [];
      if (root.thumbsDown > 0) {
        outcomes.push(
          this.deps.feedback.record({
            ...about,
            verdict: 'thumbs_down',
            source: 'reaction',
            githubCommentId: root.id,
            actor: null,
            actorIsBot: false,
          }),
        );
      }
      for (const reply of comments) {
        if (reply.inReplyTo !== root.id || !isWrongReply(reply.body)) continue;
        outcomes.push(
          this.deps.feedback.record({
            ...about,
            verdict: 'wrong',
            source: 'reply',
            githubCommentId: reply.id,
            actor: reply.author,
            actorIsBot: reply.authorIsBot,
          }),
        );
      }
      recorded += (await Promise.all(outcomes)).filter((o) => o === 'recorded').length;
    }
    return recorded;
  }
}
