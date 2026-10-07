import { invalidInput, llmUnavailable, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { isValidCombination } from '../domain/matrix.js';
import { CATEGORIES, SLOP_TYPES } from '../domain/types.js';
import type { Category, Environment, SlopType } from '../domain/types.js';
import type { Store } from '../ports.js';
import { memberOf } from './access.js';
import { field, parseJson, text } from './llm-json.js';

/**
 * The LLM port: a single completion. The adapter chooses the model (Haiku for intake). An adapter
 * must give up when `signal` aborts (a caller's deadline), rejecting the call.
 */
export interface LlmRequest {
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

export interface Llm {
  complete(request: LlmRequest): Promise<string>;
}

/**
 * The model can't be used for reasons outside the request: the adapter's credentials expired or
 * are missing, or it lacks access to the model. Retrying won't help until someone acts on `fix`,
 * unlike throttling, timeouts and model errors, which adapters throw as ordinary errors.
 */
export class LlmUnavailable extends Error {
  constructor(
    /** What is wrong, in plain language (e.g. "AWS sign-in expired"). */
    readonly reason: string,
    /** What a person can do about it; never secrets or raw provider messages. */
    readonly fix: string,
  ) {
    super(`${reason}. ${fix}`);
    this.name = 'LlmUnavailable';
  }
}

export interface IntakeInput {
  readonly text: string;
  /** Fields the person (or the MCP caller) set explicitly; they always win. */
  readonly explicit: Partial<{
    title: string;
    summary: string;
    type: SlopType;
    category: Category;
    group: string;
    environment: string;
  }>;
}

export interface IntakeProposal {
  readonly title: string;
  readonly summary: string;
  readonly type: SlopType;
  readonly category: Category;
  readonly group: string | null;
  /** An environment the request names (one that allows branch deploys); null when it names none. */
  readonly environment: string | null;
  readonly autoTrigger: boolean;
  /** Why auto-trigger was set, quoting the instruction; null when it was not. */
  readonly autoTriggerReason: string | null;
}

export const INTAKE_SYSTEM = `You turn a request for software work into the fields of a "glob", a unit of work on a planning board.

Respond with one JSON object and nothing else:
{"title": string, "summary": string, "type": "sub" | "same" | "super", "category": "feature" | "task" | "bug", "group": string | null, "autoTrigger": boolean, "autoTriggerQuote": string | null}

- title: a short imperative title, at most 70 characters.
- summary: what is wanted and why, in plain sentences, keeping every concrete detail from the request and adding none that it does not contain (no guessed motivations or extra requirements). End with "Done when:" lines when the request makes the outcome clear.
- type: "sub" for a small bug fix or minor UI or UX tweak that can be implemented and merged without human review; "super" only when the request says the work is done by a developer pairing with the product owner; otherwise "same".
- category: "feature" for new capability, "bug" for something broken, "task" for other maintenance.
- group: reuse an existing group (its exact name) only when the work clearly belongs to that same area; otherwise a new short group name if the request names an area of work, otherwise null. Never pick an existing group just because it is the only one.
- autoTrigger: true only if the request explicitly says to start the work immediately or to let an agent implement it now. Then autoTriggerQuote is the exact words from the request that say so; otherwise null.`;

const normalise = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first of the board's branch-deploy environments the request names as a target: "to", "on",
 * "in" or "into" (optionally "the") followed by the name as a whole word, case-insensitive. The cue
 * keeps environments named after common words ("test", "qa") from matching ordinary requests.
 * Deterministic rather than asked of the model, so it can only suggest environments that exist.
 */
export const environmentNamedIn = (request: string, environments: readonly Environment[]): string | null =>
  environments.find(
    (e) =>
      e.allowBranchDeploy &&
      new RegExp(
        `(^|[^\\p{L}\\p{N}_-])(to|on|in|into)\\s+(the\\s+)?${escapeRegExp(e.name)}($|[^\\p{L}\\p{N}_-])`,
        'iu',
      ).test(request),
  )?.name ?? null;

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  values.find((v) => v === value) ?? null;

/**
 * Intake: proposes a glob's fields from free text. The model's answer is validated against the
 * type/category matrix with safe defaults, explicit fields win, existing groups are preferred,
 * and a same only auto-triggers when the request explicitly asks for it (the quoted words must
 * appear in the request).
 */
export class IntakeService {
  constructor(private readonly deps: { store: Store; llm: Llm }) {}

  async propose(email: string, boardId: number, input: IntakeInput): Promise<Result<IntakeProposal>> {
    if (input.text.trim() === '') return invalidInput('Describe the work first');
    const known = await this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const globs = await tx.listGlobs(boardId, {});
      const board = await tx.getBoard(boardId);
      return ok({
        groups: [...new Set(globs.flatMap((g) => (g.group === null ? [] : [g.group])))],
        environments: board?.environments ?? [],
      });
    });
    if (!known.ok) return known;
    const { groups, environments } = known.value;

    const prompt = [
      `Existing groups: ${groups.length === 0 ? '(none)' : groups.join(', ')}`,
      '',
      'Request:',
      input.text.trim(),
    ].join('\n');
    let completion: string;
    try {
      completion = await this.deps.llm.complete({ system: INTAKE_SYSTEM, prompt, maxTokens: 1200 });
    } catch (error) {
      if (error instanceof LlmUnavailable) return llmUnavailable(error.reason, error.fix);
      throw error;
    }
    return ok(this.validate(parseJson(completion), input, groups, environments));
  }

  private validate(
    answer: unknown,
    input: IntakeInput,
    groups: readonly string[],
    environments: readonly Environment[],
  ): IntakeProposal {
    const request = input.text.trim();
    const title = (input.explicit.title ?? text(field(answer, 'title')) ?? '').trim() || request.split('\n')[0]?.slice(0, 70) || 'Untitled';
    const summary = input.explicit.summary ?? text(field(answer, 'summary')) ?? request;

    let category = input.explicit.category ?? oneOf(CATEGORIES, field(answer, 'category')) ?? 'task';
    let type = input.explicit.type ?? oneOf(SLOP_TYPES, field(answer, 'type')) ?? 'same';
    if (!isValidCombination(type, category)) {
      // Keep whatever the person set explicitly and repair the other field.
      if (input.explicit.type !== undefined && input.explicit.category === undefined) {
        category = type === 'sub' ? 'task' : 'feature';
      } else {
        type = 'same';
      }
    }

    const proposedGroup = input.explicit.group ?? text(field(answer, 'group'));
    const group =
      proposedGroup === null || proposedGroup.trim() === ''
        ? null
        : (groups.find((g) => normalise(g) === normalise(proposedGroup)) ?? proposedGroup.trim());

    const quote = field(answer, 'autoTriggerQuote');
    const explicitInstruction =
      field(answer, 'autoTrigger') === true &&
      typeof quote === 'string' &&
      quote.trim() !== '' &&
      normalise(request).includes(normalise(quote));
    const autoTrigger = type === 'same' && explicitInstruction;

    return {
      title: title.slice(0, 120),
      summary,
      type,
      category,
      group,
      environment: input.explicit.environment ?? environmentNamedIn(request, environments),
      autoTrigger,
      autoTriggerReason: autoTrigger && typeof quote === 'string' ? `The request says: "${quote.trim()}"` : null,
    };
  }
}
