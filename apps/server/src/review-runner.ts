import { globRegExp, ReviewEngine, reviewMetaOf, renderReviewArtifact } from '@slop/core';
import type {
  ArtifactService,
  Board,
  Glob,
  IndependentReview,
  Llm,
  ReviewInputService,
  ReviewOutcome,
  ReviewSeverity,
} from '@slop/core';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';
import { HostCodeAccess } from './review-code-access.js';
import { publishReview } from './review-publish.js';
import type { RunReview } from './review-executors.js';

/** What a board decides about its reviews; every field has a default until the board settings exist. */
export interface ReviewSettings {
  /** The Bedrock model that reviews (not a Claude model). */
  readonly model: string;
  /** Findings at or above this are inline comments on GitHub. */
  readonly minSeverity: ReviewSeverity;
  /** Path globs the reviewer never reads. */
  readonly ignoredPaths: readonly string[];
  /** The cap on the reviewer's tool calls; null for the default. */
  readonly toolCap: number | null;
}

export interface ReviewRunDeps {
  readonly host: CodeHost;
  readonly inputs: Pick<ReviewInputService, 'assemble'>;
  readonly artifacts: Pick<ArtifactService, 'addIndependentReview'>;
  readonly boardOf: (id: number) => Promise<Board | null>;
  readonly settings: (boardId: number) => Promise<ReviewSettings>;
  /** The reviewer's model on the board's chosen model id. */
  readonly llmFor: (model: string) => Llm;
  readonly log?: (message: string) => void;
}

const NOTHING_TO_REVIEW: IndependentReview = {
  summary:
    'There is nothing to review: the change touches only lockfiles, generated or ignored files.',
  findings: [],
};

/**
 * Builds `RunReview`: assembles what the reviewer reads, runs the findings and verification passes with read-only code
 * access, stores the result as the glob's `independent_review` artifact and publishes it. `LlmUnavailable`, `LlmBusy` and
 * `ReviewAnswerInvalid` are thrown, so the outbox retries the job with its backoff.
 */
export const makeRunReview =
  (deps: ReviewRunDeps): RunReview =>
  async (glob: Glob, resolved) => {
    const board = await deps.boardOf(glob.boardId);
    const repo = board === null ? null : repoOf(board);
    if (repo === null) return;
    const settings = await deps.settings(glob.boardId);
    const assembled = await deps.inputs.assemble(
      resolved.target,
      settings.ignoredPaths.map(globRegExp),
    );
    if (!assembled.ok) throw new Error(assembled.error.message);

    // A change of only skipped files costs no model call, but still gets its (empty) review so "Review now" answers.
    const outcome: ReviewOutcome =
      assembled.value.files.length === 0
        ? { review: NOTHING_TO_REVIEW, dropped: [], truncated: false }
        : await new ReviewEngine({ llm: deps.llmFor(settings.model) }).reviewChange(
            assembled.value.input,
            {
              access: new HostCodeAccess(deps.host, repo, resolved.diff.ref),
              toolCap: settings.toolCap,
            },
          );

    const sha = resolved.diff.sha;
    const stored = await deps.artifacts.addIndependentReview(glob.id, {
      content: renderReviewArtifact(outcome.review, {
        stage: resolved.stage,
        sha,
        truncated: outcome.truncated,
      }),
      commitSha: sha,
      meta: reviewMetaOf(outcome.review, resolved.stage, glob.pr?.headSha ?? null),
      model: settings.model,
    });
    if (!stored.ok) throw new Error(stored.error.message);
    await publishReview(
      deps.host,
      repo,
      glob,
      resolved,
      {
        review: outcome.review,
        truncated: outcome.truncated,
        version: stored.value.version,
        minSeverity: settings.minSeverity,
      },
      deps.log,
    );
  };
