import { applyVerdicts, REVIEW_FINDINGS_SYSTEM, findingsPrompt, parseReview, parseVerdicts, REVIEW_VERIFY_SYSTEM, verifyPrompt } from '../domain/independent-review.js';
import type { IndependentFinding, IndependentReview, ReviewInput, Verdict } from '../domain/independent-review.js';
import { isToolRequest, parseToolCall, reviewToolsInstructions } from '../domain/review-tools.js';
import { completeWithDeadline } from './llm-call.js';
import { ReviewToolSession } from './review-tools.js';
import type { CodeAccess } from './review-tools.js';
import type { Llm } from './intake-service.js';
import type { LlmSchema } from './intake-service.js';
import { REVIEW_FINDINGS_SCHEMA, REVIEW_VERDICTS_SCHEMA } from './llm-schemas.js';

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

/** What the verification pass is shown of the code the findings pass read; the rest is cut. */
const TOOL_TRANSCRIPT_LIMIT = 40_000;

export interface ReviewOptions {
  /** Read-only access to the code (Level 2). Without it the reviewer sees only the input. The engine disposes it when done. */
  readonly access?: CodeAccess;
  /** The board's tool-call cap; the default applies when it is missing. */
  readonly toolCap?: number | null;
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

const validateReview = (answer: string): { ok: true; value: IndependentReview } | { ok: false; problem: string } => {
  const parsed = parseReview(answer);
  return parsed.ok ? { ok: true, value: parsed.review } : parsed;
};

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

  async reviewChange(input: ReviewInput, options: ReviewOptions = {}): Promise<ReviewOutcome> {
    const { access } = options;
    try {
      return await this.review(input, options);
    } finally {
      // The clone behind `grep` goes whether the review finished, failed or timed out.
      await access?.dispose();
    }
  }

  private async review(input: ReviewInput, options: ReviewOptions): Promise<ReviewOutcome> {
    const truncated = input.diff.length > REVIEW_DIFF_LIMIT;
    let shown: ReviewInput = truncated ? { ...input, diff: `${input.diff.slice(0, REVIEW_DIFF_LIMIT)}\n[diff cut here: it was too long to review whole]` } : input;

    let first: IndependentReview;
    if (options.access === undefined) {
      first = await this.ask(REVIEW_FINDINGS_SYSTEM, findingsPrompt(shown), FINDINGS_MAX_TOKENS, 'findings', validateReview, REVIEW_FINDINGS_SCHEMA);
    } else {
      const session = new ReviewToolSession(options.access, options.toolCap);
      const result = await this.findingsWithTools(shown, session);
      first = result.review;
      if (result.transcript !== '') shown = { ...shown, context: `${shown.context ?? ''}\n\n## Code the first reviewer read\n\n${result.transcript.slice(0, TOOL_TRANSCRIPT_LIMIT)}` };
    }
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
      REVIEW_VERDICTS_SCHEMA,
    );
    const kept = applyVerdicts(first, verdicts);
    const dropped = verdicts.flatMap((verdict) => {
      const finding = first.findings[verdict.index];
      return verdict.keep || finding === undefined ? [] : [{ finding, reason: verdict.reason }];
    });
    return { review: kept, dropped, truncated };
  }

  /**
   * The findings pass with tools: each turn the model either asks for a tool or gives the review. A tool call past the
   * cap gets a "limit reached" answer instead of a result, so a model that keeps asking ends in `ReviewAnswerInvalid`
   * after a few more turns rather than looping.
   */
  private async findingsWithTools(input: ReviewInput, session: ReviewToolSession): Promise<{ review: IndependentReview; transcript: string }> {
    const system = REVIEW_FINDINGS_SYSTEM + reviewToolsInstructions(session.callsLeft);
    const base = findingsPrompt(input);
    let transcript = '';
    let rejected = 0;
    let pastCap = 0;
    for (;;) {
      const answer = await completeWithDeadline(this.deps.llm, { system, prompt: `${base}${transcript === '' ? '' : `\n\n## Tool results so far\n${transcript}`}`, maxTokens: FINDINGS_MAX_TOKENS }, this.timeoutMs);
      if (!isToolRequest(answer)) {
        const checked = validateReview(answer);
        if (checked.ok) return { review: checked.value, transcript };
        rejected += 1;
        if (rejected > 1) throw new ReviewAnswerInvalid('findings', checked.problem);
        transcript += `\n\n### Your previous answer was rejected\n${checked.problem}\nAnswer again with the one JSON object the instructions describe, and nothing else.`;
        continue;
      }
      const call = parseToolCall(answer);
      if (!call.ok) {
        rejected += 1;
        if (rejected > 1) throw new ReviewAnswerInvalid('findings', call.problem);
        transcript += `\n\n### Your tool request was rejected\n${call.problem}`;
        continue;
      }
      if (session.callsLeft <= 0) {
        pastCap += 1;
        if (pastCap > 2) throw new ReviewAnswerInvalid('findings', 'The reviewer kept asking for tools after the limit was reached.');
      }
      const label = call.call.tool === 'grep' ? `grep ${JSON.stringify(call.call.pattern)}` : `${call.call.tool} ${JSON.stringify(call.call.path)}`;
      const result = await session.run(call.call);
      transcript += `\n\n### ${label}\n${result}`;
    }
  }

  /** One pass: ask, validate, and on an invalid answer ask once more with the problem stated. */
  private async ask<T>(
    system: string,
    prompt: string,
    maxTokens: number,
    pass: 'findings' | 'verification',
    validate: (answer: string) => { ok: true; value: T } | { ok: false; problem: string },
    schema: LlmSchema,
  ): Promise<T> {
    const first = await completeWithDeadline(this.deps.llm, { system, prompt, maxTokens, schema }, this.timeoutMs);
    const checked = validate(first);
    if (checked.ok) return checked.value;
    const retry = `${prompt}\n\n## Your previous answer was rejected\n\n${checked.problem}\nAnswer again with the one JSON object the instructions describe, and nothing else.`;
    const second = validate(await completeWithDeadline(this.deps.llm, { system, prompt: retry, maxTokens, schema }, this.timeoutMs));
    if (second.ok) return second.value;
    throw new ReviewAnswerInvalid(pass, second.problem);
  }
}
