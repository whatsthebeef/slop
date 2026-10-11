import { costOf, globRegExp, ReviewEngine, reviewMetaOf, renderReviewArtifact } from '@slop/core';
import type {
  ArtifactService,
  Board,
  Glob,
  IndependentReview,
  Llm,
  ReviewInputService,
  ReviewOutcome,
  ReviewSettings,
  SpendService,
} from '@slop/core';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';
import { HostCodeAccess } from './review-code-access.js';
import { publishReview } from './review-publish.js';
import type { RunReview } from './review-executors.js';

export type { ReviewSettings };

export interface ReviewRunDeps {
  readonly host: CodeHost;
  readonly inputs: Pick<ReviewInputService, 'assemble'>;
  readonly artifacts: Pick<ArtifactService, 'addIndependentReview'>;
  readonly boardOf: (id: number) => Promise<Board | null>;
  readonly settings: (boardId: number) => Promise<ReviewSettings>;
  /** Each review's cost goes in the spend ledger. */
  readonly spend: Pick<SpendService, 'record'>;
  /** The reviewer's model on the board's chosen model id; `onUsage` gets the tokens of each call it makes. */
  readonly llmFor: (model: string, onUsage: (usage: { input: number; output: number }) => void) => Llm;
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
    const used = { input: 0, output: 0 };
    let version: number | null = null;
    try {
      const outcome: ReviewOutcome =
        assembled.value.files.length === 0
          ? { review: NOTHING_TO_REVIEW, dropped: [], truncated: false }
          : await new ReviewEngine({
              llm: deps.llmFor(settings.model, (u) => {
                used.input += u.input;
                used.output += u.output;
              }),
            }).reviewChange(assembled.value.input, {
              access: new HostCodeAccess(deps.host, repo, resolved.diff.ref),
              toolCap: settings.toolCap,
            });

      const sha = resolved.diff.sha;
      const cost = costOf(settings.model, used.input, used.output);
      const stored = await deps.artifacts.addIndependentReview(glob.id, {
        content: renderReviewArtifact(outcome.review, {
          stage: resolved.stage,
          sha,
          truncated: outcome.truncated,
        }),
        commitSha: sha,
        meta: {
          ...reviewMetaOf(outcome.review, resolved.stage, glob.pr?.headSha ?? null),
          ...(cost === null ? {} : { costUsd: cost }),
        },
        model: settings.model,
      });
      if (!stored.ok) throw new Error(stored.error.message);
      version = stored.value.version;
      await publishReview(
        deps.host,
        repo,
        glob,
        resolved,
        {
          review: outcome.review,
          truncated: outcome.truncated,
          version,
          minSeverity: settings.minSeverity,
        },
        deps.log,
      );
    } finally {
      // An attempt that failed after calling the model still cost money, so it is recorded too (the retry is another call).
      try {
        await deps.spend.record({
          boardId: glob.boardId,
          globId: glob.id,
          source: 'review',
          model: settings.model,
          inputTokens: used.input,
          outputTokens: used.output,
          ref: version === null ? null : String(version),
        });
      } catch (error) {
        deps.log?.(`review spend: not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
