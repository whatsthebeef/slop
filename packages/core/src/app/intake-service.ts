import { invalidInput, llmUnavailable, ok } from '../domain/errors.js';
import { globIdInText } from '../domain/ids.js';
import type { Result } from '../domain/errors.js';
import { isValidCombination } from '../domain/matrix.js';
import { SLOP_TYPES, WORK_CATEGORIES, WORK_KINDS } from '../domain/types.js';
import type { Environment, InferenceSource, SlopType, WorkCategory, WorkKind } from '../domain/types.js';
import type { Store } from '../ports.js';
import { CONFIDENCES, INTAKE_PROMPT_VERSION, examplesBlock, needsConfirmation } from '../domain/intake-learning.js';
import type { Confidence, IntakeExample } from '../domain/intake-learning.js';
import { SUB_LIMIT_DEFAULT } from '../domain/sub-limit.js';
import { riskPathsOf } from '../domain/merge-policy.js';
import { parseRollout } from '../domain/rollout.js';
import { estimateFromText, oversizedReasons } from '../domain/size-check.js';
import { touchRiskPaths } from '../domain/sub-gate.js';
import type { SizeThreshold } from '../domain/size-check.js';
import type { Embedder } from '../ports.js';
import { defaultAreas, riskAreaLine } from '../domain/risk-area.js';
import type { RiskArea } from '../domain/risk-area.js';
import { normaliseGroup } from '../domain/group.js';
import { typeLearningBlock } from '../domain/type-learning.js';
import { memberOf } from './access.js';
import { readMergePolicy } from './knowledge-service.js';
import { recentTypeCorrections } from './type-learning-service.js';
import { embedRequest, nearestExamples } from './intake-learning-service.js';
import { field, parseJson, text } from './llm-json.js';
import { MAX_QUESTION_OPTION, MAX_QUESTION_OPTIONS, MAX_QUESTION_TEXT } from '../domain/questions.js';
import type { NewQuestion } from '../domain/questions.js';
import type { LlmSpendTag } from '../domain/spend.js';
import { INTAKE_GROUP_SCHEMA, INTAKE_SCHEMA } from './llm-schemas.js';

/**
 * A JSON Schema the model's answer must follow (structured outputs). A plain object, so core needs no schema library:
 * `additionalProperties: false` and a `required` list on every object, as the model API demands.
 */
export interface LlmSchema {
  /** A short name for the answer's shape, e.g. `kb_dedupe`. */
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

/**
 * The LLM port: a single completion. The adapter chooses the model (Haiku for intake). An adapter
 * must give up when `signal` aborts (a caller's deadline), rejecting the call.
 */
export interface LlmRequest {
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
  /**
   * Constrains the answer to this schema, so it always parses as JSON. Adapters that can't (or a model that can't)
   * ignore it, and the caller's `parseJson` then reads the free text as it always did.
   */
  readonly schema?: LlmSchema;
  /**
   * Which board and source the call is for. Local metadata: adapters never send it to the model. The
   * server's usage callback writes one ledger row per tagged call; untagged calls are only logged.
   */
  readonly spend?: LlmSpendTag;
}

export interface Llm {
  complete(request: LlmRequest): Promise<string>;
  /** Like `complete`, but hands each piece of text over as it arrives; resolves with the whole answer. Adapters that can't stream leave it out. */
  stream?(request: LlmRequest, onText: (text: string) => void): Promise<string>;
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
    type: SlopType;
    /** Old alias, kept for one release: bug is a fix, feature is R&D (stored as a task), task is maintenance. `fix` and `workKind` win over it. */
    category: WorkCategory;
    fix: boolean;
    workKind: WorkKind;
    group: string;
    environment: string;
  }>;
}

export interface IntakeProposal {
  readonly title: string;
  /** The full write-up, with "Done when:" lines: stored as plan.md v1. */
  readonly plan: string;
  readonly type: SlopType;
  /** The model's one-line reason for the type (when a person is needed); null when none or the type was explicit. */
  readonly typeReason: string | null;
  /** Derived for the stored category (fix: bug, else task); nobody picks it. */
  readonly category: WorkCategory;
  /** Whether the work repairs something broken or regressed (the bug behaviours). */
  readonly fix: boolean;
  /** `person` when the request set `fix` explicitly (an alias category counts), else `inferred`. */
  readonly fixSource: InferenceSource;
  /** The one-line reason for `fix`; null when explicit or none was given. */
  readonly fixReason: string | null;
  /** Whether time on it counts as R&D or maintenance in the time report. */
  readonly workKind: WorkKind;
  readonly workKindSource: InferenceSource;
  readonly workKindReason: string | null;
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
  /** Questions intake raises instead of guessing (at most `MAX_INTAKE_QUESTIONS`); the create path passes them to the new glob. */
  readonly questions: readonly NewQuestion[];
  /** Why the plan looks oversized by its text (more tasks than the board's threshold); empty when it doesn't. Creating the glob judges it again with the model. */
  readonly oversized: readonly string[];
}

/** What inference decided about a glob's fix flag and work kind, with a reason each. */
export interface WorkInference {
  readonly fix: boolean;
  readonly fixReason: string | null;
  readonly workKind: WorkKind;
  readonly workKindReason: string | null;
}

/** The stored category that stands for a fix flag: bug or task. The work kind is stored beside it; `feature` is never stored for new globs. */
export const categoryFor = (fix: boolean): WorkCategory => (fix ? 'bug' : 'task');

/** The two reasons as the one line stored on the glob (`inferenceReason`); null when there is none. */
export const inferenceReasonOf = (p: Pick<WorkInference, 'fixReason' | 'workKindReason'>): string | null => {
  const parts = [p.fixReason, p.workKindReason].filter((r): r is string => r !== null && r.trim() !== '');
  return parts.length === 0 ? null : [...new Set(parts)].join(' ').slice(0, 500);
};

const FIX_WORDS = /\b(fails?|failing|failed|failures?|broken|breaks?|errors?|regress(?:ion|ed|es)?|crash(?:es|ed|ing)?|bugs?|exceptions?|not working|doesn'?t work|stopped working|stops? working)\b/i;
const NEW_WORDS = /\b(add|adds|new|introduce|build|implement|support|create|prototype|experiment|explore|feature)\b/i;

/**
 * The fallback when the model gives no usable answer: words in the request. A repair vocabulary ("fails", "broken", "error",
 * "regression", "crash") makes it a fix and maintenance; otherwise new-capability words make it R&D and anything else is maintenance.
 * Crude on purpose: it only ever fills a gap, and a person's override always wins.
 */
export const inferWorkByRules = (request: string): WorkInference => {
  const fix = FIX_WORDS.exec(request);
  if (fix !== null) {
    const word = `"${fix[0].toLowerCase()}"`;
    return { fix: true, fixReason: `The request mentions ${word}`, workKind: 'maintenance', workKindReason: 'A fix is maintenance' };
  }
  const added = NEW_WORDS.exec(request);
  return added === null
    ? { fix: false, fixReason: null, workKind: 'maintenance', workKindReason: 'No new capability named' }
    : { fix: false, fixReason: null, workKind: 'rnd', workKindReason: `The request says "${added[0].toLowerCase()}"` };
};

/** The old category's meaning as a fix flag and work kind (a model that still answers the old shape, an alias from a caller). */
const fromCategory = (category: WorkCategory): { fix: boolean; workKind: WorkKind } => ({
  fix: category === 'bug',
  workKind: category === 'feature' ? 'rnd' : 'maintenance',
});

const WORK_SYSTEM = `You judge one unit of software work on a planning board.

Respond with one JSON object and nothing else: {"fix": boolean, "fixReason": string, "workKind": "rnd" | "maintenance", "workKindReason": string}

- fix: true when the work repairs something broken or regressed (it fails, errors, crashes, behaves wrongly); false for new capability or any other change.
- workKind: "rnd" for new capability or exploration; "maintenance" for repairs, upkeep and chores. A fix is maintenance.
- fixReason and workKindReason: one short sentence each.`;

/** What the board has learned, for the prompt: its risk areas (path patterns and why) and its sub size. */
export const boardContextBlock = (areas: readonly RiskArea[], subMaxChangedLines: number): string =>
  [
    'Risk areas of this board (work in one needs a person to review it afterwards, so type "same"; match your "files" against the path patterns):',
    ...(areas.length === 0 ? ['(none)'] : areas.map(riskAreaLine)),
    `Learned sub size of this board: about ${String(subMaxChangedLines)} changed lines. Settled work beyond it stays one glob, sized for one review (the agents divide it into workstreams in the run); it is not typed "same" for its size alone.`,
  ].join('\n');

const EPOCH = '1970-01-01T00:00:00.000Z';

export const INTAKE_SYSTEM = `You turn a request for software work into the fields of a "glob", a unit of work on a planning board.

Respond with one JSON object and nothing else:
{"title": string, "plan": string, "type": "sub" | "same" | "super", "typeReason": string, "fix": boolean, "workKind": "rnd" | "maintenance", "group": string | null, "confidence": "high" | "medium" | "low", "fixReason": string, "workKindReason": string, "autoTrigger": boolean, "autoTriggerQuote": string | null, "files": string[], "questions": [{"kind": "type" | "environment" | "scope" | "acceptance", "text": string, "options": string[], "blocking": "start" | "none"}]}

- title: a short imperative title, at most 70 characters.
- plan: what is wanted and why, in plain sentences, keeping every concrete detail from the request and adding none that it does not contain (no guessed motivations or extra requirements). End with "Done when:" lines when the request makes the outcome clear.
- type: choose by WHEN A PERSON IS NEEDED, not by how big the work is.
  - "sub" (the default; be optimistic): the plan is settled and has no open questions. One routine can implement it and merge it; a person at most spot-checks it afterwards. Whatever its area, and whether or not it overlaps work in progress (merge order is handled elsewhere).
  - "same": the plan is settled, but a person must review the result afterwards: the work matches one of the board's risk areas (listed after the request; the path patterns are matched against your "files"), it is user-facing or sensitive, or the request asks for a review. Work on infrastructure, IAM, builds, stacks, properties files, workflows or rollout scripts, or whose plan has rollout steps, is always "same" (slop applies this rule itself).
  - "super": the plan still has decisions only a person can make during the work: a design to agree, options to choose between, "discuss with…", open questions, or a decisions section with no tasks. Claude would otherwise have to guess. Do not choose "super" just because the work is big or the request says "design" about something already decided.
  - Size is separate: big settled work stays one glob, sized for one review; the agents divide it into workstreams in the run, so do not split it or choose "super" for it. A "super" is for unsettled work that needs a person to pair on it.
  - When unsure, choose "sub" rather than "same". Choose "super" only on real evidence of an open decision.
- typeReason: one short sentence saying when a person is needed (or that none is), e.g. "Settled plan, no open questions" or "The plan leaves the storage design open".
- fix: true when the work repairs something broken or regressed (it fails, errors, crashes, behaves wrongly); false for new capability or any other change. fixReason: one short sentence saying why.
- workKind: "rnd" for new capability or exploration; "maintenance" for repairs, upkeep and chores. A fix is maintenance. workKindReason: one short sentence saying why.
- confidence: how sure you are of fix and workKind: "low" when the request could reasonably be judged differently.
- Examples from the board's history may follow the request. Examples marked as changed show what the team wanted after a person corrected the first choice: follow them over your own reading when the request is similar.
- group: reuse an existing group (its exact name) only when the work clearly belongs to that same area; otherwise a new short group name if the request names an area of work, otherwise null. Never pick an existing group just because it is the only one.
- files: repo paths the work most likely changes, only ones the request names or clearly implies (a migration directory for a schema change, a named file); an empty list when unknown. Never invent paths. List every one you expect: the board's risk-area path patterns are matched against them.
- autoTrigger: true only if the request explicitly says to start the work immediately or to let an agent implement it now. Then autoTriggerQuote is the exact words from the request that say so; otherwise null.
- questions: usually an empty list. Raise one only when a person's answer would change the type, the environment or the scope of the work and the request does not say (kind "type", "environment" or "scope"), or when "Done when" cannot be written (kind "acceptance"). Never ask about style, naming or anything the agents can decide. At most 3, each one sentence with 2 to 4 short options when the choices are clear (otherwise an empty options list). blocking: "start" when the work should not begin before the answer (the default for type, environment and scope), "none" for a notice.`;

const normalise = normaliseGroup;

const GROUP_SYSTEM = `You choose the group of a unit of work on a planning board.

Respond with one JSON object and nothing else: {"group": string | null}

- group: reuse an existing group (its exact name) only when the work clearly belongs to that same area; otherwise a new short group name (at most 4 words) if the work names an area of work, otherwise null. Never pick an existing group just because it is the only one.`;

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

const GLOB_ID_IN_TEXT = globIdInText('gi');
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

/** The most questions intake may raise on one glob. */
export const MAX_INTAKE_QUESTIONS = 3;
const QUESTION_KINDS = ['type', 'environment', 'scope', 'acceptance'] as const;

/**
 * The questions the model raised, narrowed: a known kind, text and options within the question limits, at most three. A question
 * about something the request set explicitly (the type, the environment) is dropped. `start` holds the glob; `acceptance` is a
 * notice unless the model asked for a hold.
 */
const questionList = (value: unknown, explicit: IntakeInput['explicit']): NewQuestion[] => {
  if (!Array.isArray(value)) return [];
  const made: NewQuestion[] = [];
  const raws: unknown[] = value;
  for (const raw of raws) {
    const kind = oneOf(QUESTION_KINDS, field(raw, 'kind'));
    const asked = text(field(raw, 'text'))?.trim() ?? '';
    if (kind === null || asked === '' || asked.length > MAX_QUESTION_TEXT) continue;
    if ((kind === 'type' && explicit.type !== undefined) || (kind === 'environment' && explicit.environment !== undefined)) continue;
    const rawOptions = field(raw, 'options');
    const options = Array.isArray(rawOptions)
      ? [...new Set(rawOptions.filter((o): o is string => typeof o === 'string').map((o) => o.trim()).filter((o) => o !== '' && o.length <= MAX_QUESTION_OPTION))].slice(0, MAX_QUESTION_OPTIONS)
      : [];
    const modelBlocking = field(raw, 'blocking');
    const blocking = kind === 'acceptance' ? (modelBlocking === 'start' ? 'start' : 'none') : modelBlocking === 'none' ? 'none' : 'start';
    made.push({
      key: `intake:${kind}:${String(made.length + 1)}`,
      text: asked,
      ...(options.length === 0 ? {} : { options }),
      blocking,
      source: 'create',
      raisedBy: { kind: 'intake', actor: null },
    });
    if (made.length >= MAX_INTAKE_QUESTIONS) break;
  }
  return made;
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
      const riskAreasOf = async () => {
        const stored = await tx.listRiskAreas(boardId);
        return stored.length > 0 ? stored : defaultAreas(boardId, EPOCH);
      };
      return ok({
        groups: [...new Set(globs.flatMap((g) => (g.group === null ? [] : [g.group])))],
        environments: board?.environments ?? [],
        threshold: await tx.getSizeThreshold(boardId),
        subMaxChangedLines: board?.subMaxChangedLines ?? SUB_LIMIT_DEFAULT,
        areas: await riskAreasOf(),
        riskPaths: riskPathsOf(await readMergePolicy(tx, boardId)),
        corrections: await recentTypeCorrections(tx, boardId),
        open: new Set(globs.filter((g) => g.status !== 'reviewing' && g.status !== 'signed_off').map((g) => g.id)),
      });
    });
    if (!known.ok) return known;
    const { groups, environments, open, threshold, areas, riskPaths, subMaxChangedLines, corrections } = known.value;

    const examples = await this.examplesFor(boardId, input.text);
    const block = examplesBlock(examples);
    const prompt = [
      `Existing groups: ${groups.length === 0 ? '(none)' : groups.join(', ')}`,
      '',
      'Request:',
      input.text.trim(),
      '',
      boardContextBlock(areas, subMaxChangedLines),
      '',
      typeLearningBlock(corrections),
      ...(block === '' ? [] : ['', block]),
    ].join('\n');
    let completion: string;
    try {
      completion = await this.deps.llm.complete({
        system: INTAKE_SYSTEM,
        schema: INTAKE_SCHEMA,
        prompt,
        maxTokens: 1200,
        spend: { boardId, source: 'intake' },
      });
    } catch (error) {
      if (error instanceof LlmUnavailable) return llmUnavailable(error.reason, error.fix);
      throw error;
    }
    return ok(this.validate(parseJson(completion), input, groups, environments, open, examples, threshold, riskPaths));
  }

  /**
   * A group for a glob that has a title and plan but no group: intake's group rule alone, on the intake model, with the board's
   * existing groups. Null when there is no clear area; a model that is down gives null too, so creating never fails for it.
   */
  async suggestGroup(email: string, boardId: number, input: {readonly title: string; readonly plan: string}): Promise<Result<string | null>> {
    const groups = await this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const globs = await tx.listGlobs(boardId, {});
      return ok([...new Set(globs.flatMap((g) => (g.group === null ? [] : [g.group])))]);
    });
    if (!groups.ok) return groups;
    let completion: string;
    try {
      completion = await this.deps.llm.complete({
        system: GROUP_SYSTEM,
        schema: INTAKE_GROUP_SCHEMA,
        prompt: [
          `Existing groups: ${groups.value.length === 0 ? '(none)' : groups.value.join(', ')}`,
          '',
          `Title: ${input.title.trim()}`,
          '',
          'Plan:',
          input.plan.trim().slice(0, 4000),
        ].join('\n'),
        maxTokens: 100,
        spend: { boardId, source: 'intake' },
      });
    } catch (error) {
      if (error instanceof LlmUnavailable) return ok(null);
      throw error;
    }
    const proposed = text(field(parseJson(completion), 'group'));
    if (proposed === null || proposed.trim() === '') return ok(null);
    return ok(groups.value.find((g) => normalise(g) === normalise(proposed)) ?? proposed.trim().slice(0, 60));
  }

  /**
   * The fix flag and work kind of a glob already created, for re-inference when its plan changes (`GlobService.reinferWork`).
   * Never fails and never throws for the model being down: no usable answer (unavailable, unparseable, partial) falls back to
   * the request's words, field by field.
   */
  async inferWork(boardId: number, input: { readonly title: string; readonly plan: string }): Promise<WorkInference> {
    const request = `${input.title.trim()}\n${input.plan.trim()}`.trim();
    const rules = inferWorkByRules(request);
    let completion: string;
    try {
      completion = await this.deps.llm.complete({
        system: WORK_SYSTEM,
        prompt: `Title: ${input.title.trim()}\n\nPlan:\n${input.plan.trim().slice(0, 6000)}`,
        maxTokens: 300,
        spend: { boardId, source: 'intake' },
      });
    } catch (error) {
      if (error instanceof LlmUnavailable) return rules;
      throw error;
    }
    const answer = parseJson(completion);
    const modelFix = field(answer, 'fix');
    const modelKind = oneOf(WORK_KINDS, field(answer, 'workKind'));
    const fix = typeof modelFix === 'boolean' ? modelFix : rules.fix;
    const reason = (key: string): string | null => text(field(answer, key))?.trim().slice(0, 300) || null;
    return {
      fix,
      fixReason: typeof modelFix === 'boolean' ? reason('fixReason') : rules.fixReason,
      workKind: modelKind ?? (fix ? 'maintenance' : rules.workKind),
      workKindReason: modelKind === null ? rules.workKindReason : reason('workKindReason'),
    };
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
    threshold: SizeThreshold,
    riskPaths: readonly string[],
  ): IntakeProposal {
    const request = input.text.trim();
    const title = (input.explicit.title ?? text(field(answer, 'title')) ?? '').trim() || request.split('\n')[0]?.slice(0, 70) || 'Untitled';
    const plan = text(field(answer, 'plan')) ?? request;

    // The old `category` is still understood, from a caller (an alias) and from a model that answers the old shape.
    const aliased = input.explicit.category === undefined ? null : fromCategory(input.explicit.category);
    const modelCategory = oneOf(WORK_CATEGORIES, field(answer, 'category'));
    const modelOld = modelCategory === null ? null : fromCategory(modelCategory);
    const rules = inferWorkByRules(request);
    const modelFix = field(answer, 'fix');
    const modelKind = oneOf(WORK_KINDS, field(answer, 'workKind'));
    const reasonOf = (key: string): string | null => text(field(answer, key))?.trim().slice(0, 300) || null;
    const oldReason = reasonOf('categoryReason');

    const explicitFix = input.explicit.fix ?? aliased?.fix;
    const explicitKind = input.explicit.workKind ?? aliased?.workKind;
    let fix = explicitFix ?? (typeof modelFix === 'boolean' ? modelFix : (modelOld?.fix ?? rules.fix));
    let workKind = explicitKind ?? modelKind ?? modelOld?.workKind ?? (fix ? 'maintenance' : rules.workKind);
    let fixSource: InferenceSource = explicitFix === undefined ? 'inferred' : 'person';
    let fixReason = explicitFix !== undefined ? null : typeof modelFix === 'boolean' || modelOld !== null ? (reasonOf('fixReason') ?? oldReason) : rules.fixReason;
    const workKindSource: InferenceSource = explicitKind === undefined ? 'inferred' : 'person';
    const workKindReason =
      explicitKind !== undefined ? null : modelKind !== null || modelOld !== null ? (reasonOf('workKindReason') ?? oldReason) : rules.workKindReason;

    // Optimistic: an unclear type is a sub.
    let type = input.explicit.type ?? oneOf(SLOP_TYPES, field(answer, 'type')) ?? 'sub';
    if (!isValidCombination(type, 'task', fix)) {
      // A fix is never a super. Keep whatever the person set explicitly and repair the other field.
      if (input.explicit.type !== undefined && explicitFix === undefined) {
        fix = false;
        fixSource = 'inferred';
        fixReason = null;
        if (explicitKind === undefined) workKind = 'rnd';
      } else {
        type = 'sub';
      }
    }
    // A rule, not a judgement: work on risk paths or with rollout steps is never a sub. A person's explicit type stands, and
    // a super (open decisions) is already a person's.
    const files = pathList(field(answer, 'files'));
    const risky = touchRiskPaths(files, riskPaths);
    const rolloutSteps = parseRollout(plan).length;
    let forcedReason: string | null = null;
    if (type === 'sub' && input.explicit.type === undefined && (risky.length > 0 || rolloutSteps > 0)) {
      type = 'same';
      forcedReason =
        risky.length > 0 ? `Touches risk paths: ${risky.slice(0, 3).join(', ')}` : 'The plan has rollout steps a person carries out after the merge';
    }
    const category = categoryFor(fix);

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

    const explicitCategory = explicitFix !== undefined && explicitKind !== undefined;
    const confidence = explicitCategory ? 'high' : (oneOf(CONFIDENCES, field(answer, 'confidence')) ?? oneOf(CONFIDENCES, field(answer, 'categoryConfidence')));
    const typeReason =
      input.explicit.type !== undefined ? null : (forcedReason ?? (text(field(answer, 'typeReason'))?.trim().slice(0, 300) || null));

    return {
      title: title.slice(0, 120),
      plan,
      type,
      typeReason,
      category,
      fix,
      fixSource,
      fixReason,
      workKind,
      workKindSource,
      workKindReason,
      group,
      environment: input.explicit.environment ?? environmentNamedIn(request, environments),
      autoTrigger,
      autoTriggerReason: autoTrigger && typeof quote === 'string' ? `The request says: "${quote.trim()}"` : null,
      files,
      suggestedAfter: waitedForIn(request, open),
      questions: questionList(field(answer, 'questions'), input.explicit),
      categoryConfidence: confidence,
      categoryReason: explicitCategory ? null : (fixReason ?? workKindReason),
      examples,
      needsConfirmation: !explicitCategory && needsConfirmation(confidence, examples),
      model: this.deps.model ?? null,
      promptVersion: INTAKE_PROMPT_VERSION,
      oversized: oversizedReasons(estimateFromText(plan), threshold),
    };
  }
}
