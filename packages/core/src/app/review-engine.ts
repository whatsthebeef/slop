import { applyVerdicts, REVIEW_FINDINGS_SYSTEM, findingsPrompt, parseReview, parseVerdicts, REVIEW_VERIFY_SYSTEM, verifyPrompt } from '../domain/independent-review.js';
import type { IndependentFinding, IndependentReview, ReviewInput, Verdict } from '../domain/independent-review.js';
import { completeWithDeadline } from './llm-call.js';
import type { Llm } from './intake-service.js';

/** A findings pass reads a whole diff and writes a list; the verification pass reads it again. */
export const REVIEW_PASS_TIMEOUT_MS = 120_000;
const FINDINGS_MAX_TOKENS = 6_000;
const VERIFY_MAX_TOKENS = 3_000;
/** The diff the model sees; past this the tail is cut and the review says so. */
export const REVIEW_DIFF_LIMIT = 150_000;

export interface ReviewOutcome {
  /** What survived verification: the review as it is stored and published. */
  readonly review: IndependentReview;
  /** What the findings pass reported and verification removed, with the reason, for the record and for tuning. */
  readonly dropped: readonly { readonly finding: IndependentFinding; readonly reason: string }[];
  /** True when the diff was cut to fit `REVIEW_DIFF_LIMIT`. */
  readonly truncated: boolean;
}

export class ReviewAnswerInvalid extends Error {
  constructor(
    readonly pass: 'findings' | 'verification',
    problem: string,
  ) {
    super(`The reviewer's ${pass} answer did not match the schema after a retry: ${problem}`);
    this.name = 'ReviewAnswerInvalid';
  }
}

export interface ReviewEngineDeps {
  /** The reviewer model (a non-Claude Bedrock model, chosen per board by the adapter). */
  readonly llm: Llm;
  readonly timeoutMs?: number;
}

/**
 * The core of the independent review: a findings pass, then a verification pass that drops weak findings.
 * Each pass's JSON is validated against its schema; an invalid answer is sent back once with what was wrong,
 * and a second one throws `ReviewAnswerInvalid`. `LlmUnavailable` and `LlmBusy` pass through for the caller's
 * waiting and retry rules. The engine only reads: it holds no code-host or store port.
 */
export class ReviewEngine {
  private readonly timeoutMs: number;

  constructor(private readonly deps: ReviewEngineDeps) {
    this.timeoutMs = deps.timeoutMs ?? REVIEW_PASS_TIMEOUT_MS;
  }

  async reviewChange(input: ReviewInput): Promise<ReviewOutcome> {
    const truncated = input.diff.length > REVIEW_DIFF_LIMIT;
    const shown: ReviewInput = truncated ? { ...input, diff: `${input.diff.slice(0, REVIEW_DIFF_LIMIT)}\n[diff cut here: it was too long to review whole]` } : input;

    const first = await this.ask(
      REVIEW_FINDINGS_SYSTEM,
      findingsPrompt(shown),
      FINDINGS_MAX_TOKENS,
      'findings',
      (answer) => {
        const parsed = parseReview(answer);
        return parsed.ok ? { ok: true, value: parsed.review } : parsed;
      },
    );
    if (first.findings.length === 0) return { review: first, dropped: [], truncated };

    const count = first.findings.length;
    const verdicts: readonly Verdict[] = await this.ask(
      REVIEW_VERIFY_SYSTEM,
      verifyPrompt(shown, first),
      VERIFY_MAX_TOKENS,
      'verification',
      (answer) => {
        const parsed = parseVerdicts(answer, count);
        return parsed.ok ? { ok: true, value: parsed.verdicts } : parsed;
      },
    );
    const kept = applyVerdicts(first, verdicts);
    const dropped = verdicts.flatMap((verdict) => {
      const finding = first.findings[verdict.index];
      return verdict.keep || finding === undefined ? [] : [{ finding, reason: verdict.reason }];
    });
    return { review: kept, dropped, truncated };
  }

  /** One pass: ask, validate, and on an invalid answer ask once more with the problem stated. */
  private async ask<T>(
    system: string,
    prompt: string,
    maxTokens: number,
    pass: 'findings' | 'verification',
    validate: (answer: string) => { ok: true; value: T } | { ok: false; problem: string },
  ): Promise<T> {
    const first = await completeWithDeadline(this.deps.llm, { system, prompt, maxTokens }, this.timeoutMs);
    const checked = validate(first);
    if (checked.ok) return checked.value;
    const retry = `${prompt}\n\n## Your previous answer was rejected\n\n${checked.problem}\nAnswer again with the one JSON object the instructions describe, and nothing else.`;
    const second = validate(await completeWithDeadline(this.deps.llm, { system, prompt: retry, maxTokens }, this.timeoutMs));
    if (second.ok) return second.value;
    throw new ReviewAnswerInvalid(pass, second.problem);
  }
}
