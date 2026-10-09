import { invalidInput, llmUnavailable, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { isValidCombination } from '../domain/matrix.js';
import { CATEGORIES, SLOP_TYPES } from '../domain/types.js';
import type { Category, Environment, SlopType } from '../domain/types.js';
import type { Store } from '../ports.js';
import { CONFIDENCES, INTAKE_PROMPT_VERSION, examplesBlock, needsConfirmation } from '../domain/intake-learning.js';
import type { Confidence, IntakeExample } from '../domain/intake-learning.js';
import type { Embedder } from '../ports.js';
import { memberOf } from './access.js';
import { embedRequest, nearestExamples } from './intake-learning-service.js';
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

/**
 * The model is only busy (Bedrock throttling, "unable to process your request", model not ready, SDK
 * timeouts): nothing a person can fix, and it passes. A subclass of `LlmUnavailable`, so callers that
 * wait on an unusable LLM wait on this too without spending an attempt; the background pipelines
 * tell them apart to back off exponentially (`BusyBackoff`), and the health state ignores it.
 */
export class LlmBusy extends LlmUnavailable {
  constructor() {
    super('Bedrock is busy', 'It is retried automatically, with a growing delay');
    this.name = 'LlmBusy';
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
  /** One or two sentences for the card. Never the spec: that is `plan`. */
  readonly summary: string;
  /** The full write-up, with "Done when:" lines: stored as plan.md v1. */
  readonly plan: string;
  readonly type: SlopType;
  readonly category: Category;
  readonly group: string | null;
  /** An environment the request names (one that allows branch deploys); null when it names none. */
  readonly environment: string | null;
  readonly autoTrigger: boolean;
  /** Why auto-trigger was set, quoting the instruction; null when it was not. */
  readonly autoTriggerReason: string | null;
  /** Repo paths the work probably changes (the model's guess; with the plan it decides whether exclusive paths hold the glob). */
  readonly files: readonly string[];
  /** Unmerged globs on the board the request says to wait for ("once s15t7 is merged"); a suggestion, never applied by itself. */
  readonly suggestedAfter: readonly string[];
  /** How sure intake is of the category (an explicit category is `high`); null when the model gave none. */
  readonly categoryConfidence: Confidence | null;
  /** The model's one-line reason for the category; null when none or the category was explicit. */
  readonly categoryReason: string | null;
  /** The board's nearest past globs intake was shown, corrected ones first (the card shows them). */
  readonly examples: readonly IntakeExample[];
  /** The card asks the person to confirm the category: intake is unsure, or the nearest examples disagree. */
  readonly needsConfirmation: boolean;
  /** The model and prompt version that decided, recorded in the glob's snapshot. */
  readonly model: string | null;
  readonly promptVersion: number;
}

export const INTAKE_SYSTEM = `You turn a request for software work into the fields of a "glob", a unit of work on a planning board.

Respond with one JSON object and nothing else:
{"title": string, "summary": string, "plan": string, "type": "sub" | "same" | "super", "category": "feature" | "task" | "bug", "group": string | null, "categoryConfidence": "high" | "medium" | "low", "categoryReason": string, "autoTrigger": boolean, "autoTriggerQuote": string | null, "files": string[]}

- title: a short imperative title, at most 70 characters.
- summary: one or two plain sentences saying what is wanted, for a card on the board. Not the spec.
- plan: what is wanted and why, in plain sentences, keeping every concrete detail from the request and adding none that it does not contain (no guessed motivations or extra requirements). End with "Done when:" lines when the request makes the outcome clear.
- type: "sub" for a small bug fix or minor UI or UX tweak that can be implemented and merged without human review; "super" only when the request says the work is done by a developer pairing with the product owner; otherwise "same".
- category: "feature" for new capability, "bug" for something broken, "task" for other maintenance.
- categoryConfidence: how sure you are of the category: "low" when the request could reasonably be a different category. categoryReason: one short sentence saying why.
- Examples from the board's history may follow the request. Examples marked as changed show what the team wanted after a person corrected the first choice: follow them over your own reading when the request is similar.
- group: reuse an existing group (its exact name) only when the work clearly belongs to that same area; otherwise a new short group name if the request names an area of work, otherwise null. Never pick an existing group just because it is the only one.
- files: repo paths the work most likely changes, only ones the request names or clearly implies (a migration directory for a schema change, a named file); an empty list when unknown. Never invent paths.
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

const GLOB_ID_IN_TEXT = /\bs\d+[ftb]\d+\b/gi;
/** A cue that the glob named next must merge first: "after s15t7", "once s15t7 is merged", "wait for s15t7". */
const WAIT_CUE = /(after|once|when|until|following|wait(?:s|ing)?\s+for)\b[^.\n;]{0,40}$/i;

/**
 * The open globs the request says to wait for. Deterministic, like the environment: only IDs that exist on the board and
 * haven't merged can be suggested.
 */
export const waitedForIn = (request: string, open: ReadonlySet<string>): string[] => {
  const found: string[] = [];
  for (const match of request.matchAll(GLOB_ID_IN_TEXT)) {
    const id = match[0].toLowerCase();
    if (!open.has(id) || found.includes(id)) continue;
    if (WAIT_CUE.test(request.slice(Math.max(0, match.index - 60), match.index))) found.push(id);
  }
  return found;
};

/** The model's file guesses: strings that look like repo-relative paths, a few at most. */
const pathList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((v: unknown): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v !== '' && v.length <= 200 && !v.startsWith('/') && !v.includes('..') && !/[\0\r\n]/.test(v))
        .slice(0, 20)
    : [];

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  values.find((v) => v === value) ?? null;

/**
 * Intake: proposes a glob's fields from free text. The model's answer is validated against the
 * type/category matrix with safe defaults, explicit fields win, existing groups are preferred,
 * and a same only auto-triggers when the request explicitly asks for it (the quoted words must
 * appear in the request).
 */
export class IntakeService {
  constructor(
    private readonly deps: {
      store: Store;
      llm: Llm;
      /** Absent: no examples are retrieved (intake works as before). */
      embedder?: Embedder;
      /** The intake model's ID, recorded with each glob's snapshot. */
      model?: string;
    },
  ) {}

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
        open: new Set(globs.filter((g) => g.status !== 'reviewing' && g.status !== 'signed_off').map((g) => g.id)),
      });
    });
    if (!known.ok) return known;
    const { groups, environments, open } = known.value;

    const examples = await this.examplesFor(boardId, input.text);
    const block = examplesBlock(examples);
    const prompt = [
      `Existing groups: ${groups.length === 0 ? '(none)' : groups.join(', ')}`,
      '',
      'Request:',
      input.text.trim(),
      ...(block === '' ? [] : ['', block]),
    ].join('\n');
    let completion: string;
    try {
      completion = await this.deps.llm.complete({ system: INTAKE_SYSTEM, prompt, maxTokens: 1200 });
    } catch (error) {
      if (error instanceof LlmUnavailable) return llmUnavailable(error.reason, error.fix);
      throw error;
    }
    return ok(this.validate(parseJson(completion), input, groups, environments, open, examples));
  }

  /** The nearest past snapshots; none when there is no embedder, it fails, or the board has none. Never fails intake. */
  private async examplesFor(boardId: number, text: string): Promise<IntakeExample[]> {
    const embedding = await embedRequest(this.deps.embedder, text);
    if (embedding === null) return [];
    try {
      return await this.deps.store.transaction((tx) => nearestExamples(tx, boardId, embedding));
    } catch {
      return [];
    }
  }

  private validate(
    answer: unknown,
    input: IntakeInput,
    groups: readonly string[],
    environments: readonly Environment[],
    open: ReadonlySet<string>,
    examples: readonly IntakeExample[],
  ): IntakeProposal {
    const request = input.text.trim();
    const title = (input.explicit.title ?? text(field(answer, 'title')) ?? '').trim() || request.split('\n')[0]?.slice(0, 70) || 'Untitled';
    const plan = text(field(answer, 'plan')) ?? request;
    const summary = input.explicit.summary ?? text(field(answer, 'summary')) ?? plan.split('\n')[0]?.slice(0, 300) ?? request;

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

    const explicitCategory = input.explicit.category !== undefined;
    const confidence = explicitCategory ? 'high' : (oneOf(CONFIDENCES, field(answer, 'categoryConfidence')));
    const reason = explicitCategory ? null : text(field(answer, 'categoryReason'))?.trim().slice(0, 300) || null;

    return {
      title: title.slice(0, 120),
      summary,
      plan,
      type,
      category,
      group,
      environment: input.explicit.environment ?? environmentNamedIn(request, environments),
      autoTrigger,
      autoTriggerReason: autoTrigger && typeof quote === 'string' ? `The request says: "${quote.trim()}"` : null,
      files: pathList(field(answer, 'files')),
      suggestedAfter: waitedForIn(request, open),
      categoryConfidence: confidence,
      categoryReason: reason,
      examples,
      needsConfirmation: !explicitCategory && needsConfirmation(confidence, examples),
      model: this.deps.model ?? null,
      promptVersion: INTAKE_PROMPT_VERSION,
    };
  }
}
