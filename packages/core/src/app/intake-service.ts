import { invalidInput, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { isValidCombination } from '../domain/matrix.js';
import { CATEGORIES, SLOP_TYPES } from '../domain/types.js';
import type { Category, SlopType } from '../domain/types.js';
import type { Store } from '../ports.js';
import { memberOf } from './access.js';

/** The LLM port: a single completion. The adapter chooses the model (Haiku for intake). */
export interface Llm {
  complete(request: { system: string; prompt: string; maxTokens: number }): Promise<string>;
}

export interface IntakeInput {
  readonly text: string;
  /** Fields the person (or the MCP caller) set explicitly; they always win. */
  readonly explicit: Partial<{ title: string; summary: string; type: SlopType; category: Category; group: string }>;
}

export interface IntakeProposal {
  readonly title: string;
  readonly summary: string;
  readonly type: SlopType;
  readonly category: Category;
  readonly group: string | null;
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

const parseJson = (text: string): unknown => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

const field = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const found: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return found;
};

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

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
    const groups = await this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const globs = await tx.listGlobs(boardId, {});
      return ok([...new Set(globs.flatMap((g) => (g.group === null ? [] : [g.group])))]);
    });
    if (!groups.ok) return groups;

    const prompt = [
      `Existing groups: ${groups.value.length === 0 ? '(none)' : groups.value.join(', ')}`,
      '',
      'Request:',
      input.text.trim(),
    ].join('\n');
    const answer = parseJson(await this.deps.llm.complete({ system: INTAKE_SYSTEM, prompt, maxTokens: 1200 }));
    return ok(this.validate(answer, input, groups.value));
  }

  private validate(answer: unknown, input: IntakeInput, groups: readonly string[]): IntakeProposal {
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
      autoTrigger,
      autoTriggerReason: autoTrigger && typeof quote === 'string' ? `The request says: "${quote.trim()}"` : null,
    };
  }
}
