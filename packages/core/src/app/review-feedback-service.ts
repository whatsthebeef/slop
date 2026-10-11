import { parseFindingHeader, parseFindingMarker } from '../domain/review-feedback.js';
import type { ReviewFeedbackSource, ReviewVerdict } from '../domain/review-feedback.js';
import type { Store } from '../ports.js';

/** One person's reaction to an inline review comment, as the code host reported it. */
export interface ReviewCommentFeedback {
  /** The board whose repo the comment is on; the comment's glob must be on it. */
  readonly boardId: number;
  /** The glob of the PR the comment is on; the marker must name it, so a marker copied from another PR counts for nothing. */
  readonly prGlobId: string;
  /** Whether the comment holding the marker was written by a bot; only the reviewer's own comments are findings. */
  readonly rootIsBot: boolean;
  /** The comment's body, whose hidden marker names the finding. */
  readonly body: string;
  readonly path: string;
  readonly line: number | null;
  readonly verdict: ReviewVerdict;
  readonly source: ReviewFeedbackSource;
  /** The comment the verdict hangs on (a reply's own id for a reply). */
  readonly githubCommentId: number;
  readonly actor: string | null;
  /** Bots' reactions and replies (slop's own among them) are not feedback. */
  readonly actorIsBot: boolean;
  readonly at: string;
}

export type FeedbackOutcome = 'recorded' | 'duplicate' | 'ignored';

/**
 * Stores "this finding was wrong" feedback on the independent reviewer's inline comments, for the weekly mining. Idempotent:
 * webhook redeliveries and the weekly poll see the same comments again. Comments that are not slop's findings (not bot-written, no marker,
 * or a marker naming another PR's glob), other boards' globs and bots are ignored.
 */
export class ReviewFeedbackService {
  constructor(private readonly deps: { readonly store: Store }) {}

  async record(input: ReviewCommentFeedback): Promise<FeedbackOutcome> {
    if (input.actorIsBot || !input.rootIsBot) return 'ignored';
    const marker = parseFindingMarker(input.body);
    const header = parseFindingHeader(input.body);
    if (marker === null || header === null || marker.globId !== input.prGlobId) return 'ignored';
    return this.deps.store.transaction(async (tx): Promise<FeedbackOutcome> => {
      const glob = await tx.getGlob(marker.globId);
      if (glob === null || glob.boardId !== input.boardId) return 'ignored';
      const inserted = await tx.insertReviewFeedback({
        boardId: glob.boardId,
        globId: glob.id,
        artifactVersion: marker.version,
        fingerprint: marker.fingerprint,
        severity: header.severity,
        category: header.category,
        title: header.title,
        path: input.path,
        line: input.line,
        verdict: input.verdict,
        source: input.source,
        githubCommentId: input.githubCommentId,
        actor: input.actor,
        createdAt: input.at,
      });
      return inserted ? 'recorded' : 'duplicate';
    });
  }
}
