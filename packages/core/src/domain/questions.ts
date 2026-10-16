/**
 * Open questions: one marker for "the AI (or a person) is unsure". A question sits on a glob and, while it is open, can hold
 * the glob's start or its merge until a person answers or dismisses it. Answering writes the question and answer into the
 * glob's Clarifications attachment (the service does that in the same transaction), so agents read it like any clarification.
 *
 * The questions live on the glob document (`Glob.questions`), so a hold needs no extra facts: the start gate reads them
 * beside the relations (`startHoldsOf`) and the merge gate through `mergeQuestions`. Pure: nothing here reads a store.
 */
import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';
import { awaitedOf } from './relations.js';
import type { AwaitedDependency, RelationFacts } from './relations.js';
import type { Glob } from './types.js';

export const QUESTION_SOURCES = ['create', 'plan_save', 'record_save', 'run', 'relation', 'learning', 'other'] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

/** `start`: holds the glob in Planning. `merge`: a run goes on, but the merge waits. `none`: a notice. */
export const QUESTION_BLOCKING = ['start', 'merge', 'none'] as const;
export type QuestionBlocking = (typeof QUESTION_BLOCKING)[number];

export const QUESTION_RAISERS = ['intake', 'agent', 'routine', 'person', 'system'] as const;
export type QuestionRaiserKind = (typeof QUESTION_RAISERS)[number];

export const MAX_QUESTIONS = 20;
export const MAX_QUESTION_TEXT = 1000;
export const MAX_QUESTION_OPTIONS = 6;
export const MAX_QUESTION_OPTION = 120;
export const MAX_QUESTION_COMMANDS = 5;
export const MAX_QUESTION_COMMAND = 300;
export const MAX_QUESTION_ANSWER = 4000;
export const MAX_QUESTION_KEY = 120;
export const MAX_QUESTION_NOTE = 1000;

export interface QuestionRaiser {
  readonly kind: QuestionRaiserKind;
  /** The account or the system part that raised it (null for slop itself). */
  readonly actor: string | null;
  /** The routine run that raised it. */
  readonly runId?: string;
}

export interface QuestionAnswer {
  readonly text: string;
  /** The option chosen, when the answer was one of the question's options. */
  readonly option?: string;
  readonly by: string;
  readonly at: string;
  /** A plan-changed question answered Re-run: the PR head when it was answered (null: no PR yet). The merge stays held until the head moves. */
  readonly rerunFrom?: string | null;
}

export interface QuestionDismissal {
  readonly by: string;
  readonly at: string;
  readonly note: string | null;
}

export interface OpenQuestion {
  /** `q<n>`, unique on the glob. */
  readonly id: string;
  /** A dedupe key (`plan:v3`, `escalation:size`): raising a question with a key the glob already has (open or not) changes nothing. */
  readonly key?: string;
  readonly text: string;
  readonly options?: readonly string[];
  /** Shell commands the question shows, each in its own copyable box under the text (one command per entry). */
  readonly commands?: readonly string[];
  readonly raisedBy: QuestionRaiser;
  readonly source: QuestionSource;
  readonly blocking: QuestionBlocking;
  readonly raisedAt: string;
  readonly answer?: QuestionAnswer;
  readonly dismissed?: QuestionDismissal;
  /** Start now: a start hold a person went past; it no longer holds. */
  readonly startOverridden?: { readonly by: string; readonly at: string };
}

/** A question to raise: the machine gives it its ID and time. */
export interface NewQuestion {
  readonly key?: string;
  readonly text: string;
  readonly options?: readonly string[];
  readonly commands?: readonly string[];
  readonly blocking: QuestionBlocking;
  readonly source: QuestionSource;
  readonly raisedBy: QuestionRaiser;
}

export const isQuestionSource = (v: unknown): v is QuestionSource => QUESTION_SOURCES.some((s) => s === v);
export const isQuestionBlocking = (v: unknown): v is QuestionBlocking => QUESTION_BLOCKING.some((s) => s === v);

/** No answer and not dismissed. */
export const isOpenQuestion = (q: Pick<OpenQuestion, 'answer' | 'dismissed'>): boolean => q.answer === undefined && q.dismissed === undefined;

/** The questions a glob has (older globs have none). */
export const questionsOf = (glob: Pick<Glob, 'questions'>): readonly OpenQuestion[] => glob.questions ?? [];

export const openQuestions = (glob: Pick<Glob, 'questions'>): OpenQuestion[] => questionsOf(glob).filter(isOpenQuestion);

/** Open questions that hold the start (not overridden by Start now). */
export const holdsStart = (q: OpenQuestion): boolean => isOpenQuestion(q) && q.blocking === 'start' && q.startOverridden === undefined;

export const startQuestions = (glob: Pick<Glob, 'questions'>): OpenQuestion[] => questionsOf(glob).filter(holdsStart);

/** The answer option of a plan-changed question (`plan:vN`) that asks for a new run on the new plan. */
export const RERUN_OPTION = 'Re-run';

export const isPlanChangedQuestion = (q: Pick<OpenQuestion, 'key'>): boolean => q.key?.startsWith('plan:v') === true;

/**
 * A plan-changed question answered Re-run holds the merge after it is answered, until the run it starts has pushed a new head
 * (the checks on that head are the merge's own condition). Dismissing or any other option releases the hold at once.
 */
const holdsAfterRerun = (q: OpenQuestion, head: string | null): boolean =>
  q.blocking === 'merge' && q.answer?.rerunFrom !== undefined && (head === null || head === q.answer.rerunFrom);

/** Questions that hold the merge: the open ones, and a Re-run answer whose new run has not pushed a new head. */
export const mergeQuestions = (glob: Pick<Glob, 'questions' | 'pr'>): OpenQuestion[] =>
  questionsOf(glob).filter((q) => (isOpenQuestion(q) && q.blocking === 'merge') || holdsAfterRerun(q, glob.pr?.headSha ?? null));

/** The next free question ID on a glob: one more than the highest `q<n>`. */
export const nextQuestionId = (existing: readonly Pick<OpenQuestion, 'id'>[]): string => {
  let max = 0;
  for (const q of existing) {
    const n = /^q(\d+)$/.exec(q.id);
    if (n?.[1] !== undefined) max = Math.max(max, Number(n[1]));
  }
  return `q${String(max + 1)}`;
};

const shorten = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  // Cut at a word, never mid-word.
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** The first sentence of a text, with fenced blocks and code spans taken out: plain words for a title. */
const firstSentence = (text: string): string => {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return text.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const end = /[.!?](?=\s|$)/.exec(plain);
  return end === null ? plain : plain.slice(0, end.index + 1);
};

/** One plain line of a question, for a title or a refusal: its first sentence, no code spans, cut at a word. */
export const questionLine = (q: Pick<OpenQuestion, 'text'>): string => shorten(firstSentence(q.text), 100);

// ---------------------------------------------------------------------------
// Holds

/** The wording of a start hold from a question: what the refusal and the hold reason say. */
export const questionWhy = (q: Pick<OpenQuestion, 'text'>): string => `Waiting for an answer: ${questionLine(q)}`;

const awaitOf = (q: OpenQuestion): AwaitedDependency => ({ id: q.id, state: 'question', why: questionWhy(q) });

/** What the open start questions hold the glob for, shaped like a start relation's wait. */
export const questionAwaits = (glob: Pick<Glob, 'questions'>): AwaitedDependency[] => startQuestions(glob).map(awaitOf);

/** Everything that holds a glob's start: its unmet start relations, then its open start questions. */
export const startHoldsOf = (glob: Pick<Glob, 'questions'>, relations: RelationFacts): AwaitedDependency[] => [
  ...awaitedOf(relations),
  ...questionAwaits(glob),
];

/** Why a merge can't go now because of open questions, or null. */
export const questionGateText = (questions: readonly OpenQuestion[]): string | null => {
  const first = questions[0];
  if (first === undefined) return null;
  const more = questions.length > 1 ? ` (and ${String(questions.length - 1)} more)` : '';
  return `${questionWhy(first)}${more}`;
};

// ---------------------------------------------------------------------------
// Checking what is asked

const trimmed = (v: string | undefined): string => (v ?? '').trim();

/** Validates a question to raise: text, options, key; returns it cleaned. */
export const checkNewQuestion = (input: NewQuestion): Result<NewQuestion> => {
  const text = trimmed(input.text);
  if (text === '') return invalidInput('A question needs text');
  if (text.length > MAX_QUESTION_TEXT) return invalidInput(`A question is limited to ${String(MAX_QUESTION_TEXT)} characters`);
  const options = (input.options ?? []).map((o) => o.trim()).filter((o) => o !== '');
  if (options.length > MAX_QUESTION_OPTIONS) return invalidInput(`A question has at most ${String(MAX_QUESTION_OPTIONS)} options`);
  if (options.some((o) => o.length > MAX_QUESTION_OPTION)) return invalidInput(`An option is limited to ${String(MAX_QUESTION_OPTION)} characters`);
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return invalidInput('A question\'s options must differ');
  const commands = (input.commands ?? []).map((c) => c.trim()).filter((c) => c !== '');
  if (commands.length > MAX_QUESTION_COMMANDS) return invalidInput(`A question has at most ${String(MAX_QUESTION_COMMANDS)} commands`);
  if (commands.some((c) => c.length > MAX_QUESTION_COMMAND || c.includes('\n'))) {
    return invalidInput(`A command is one line of at most ${String(MAX_QUESTION_COMMAND)} characters`);
  }
  const key = trimmed(input.key);
  if (key.length > MAX_QUESTION_KEY) return invalidInput(`A question key is limited to ${String(MAX_QUESTION_KEY)} characters`);
  return ok({
    text,
    blocking: input.blocking,
    source: input.source,
    raisedBy: input.raisedBy,
    ...(options.length === 0 ? {} : { options }),
    ...(commands.length === 0 ? {} : { commands }),
    ...(key === '' ? {} : { key }),
  });
};

/** The option of `q` an answer names (matched ignoring case), or null. */
export const matchOption = (q: Pick<OpenQuestion, 'options'>, option: string): string | null => {
  const wanted = option.trim().toLowerCase();
  return (q.options ?? []).find((o) => o.toLowerCase() === wanted) ?? null;
};

/**
 * Whether the call may answer or dismiss a question on this glob. Membership is checked by the service. A call that names a
 * routine run of this glob never can: a run answering would clear a hold that is meant for a person (a routine runs as its
 * owner's account, so without a `runId` slop cannot tell it from the person: the agent docs require passing it).
 */
export const canAnswer = (glob: Pick<Glob, 'runs'>, runId: string | null | undefined): boolean =>
  runId === null || runId === undefined || runId === '' ? true : !glob.runs.some((r) => r.id === runId);

// ---------------------------------------------------------------------------
// The Clarifications text

const dayOf = (at: string): string => at.slice(0, 10);

const raisedLine = (q: OpenQuestion): string => {
  const by = q.raisedBy.actor === null ? q.raisedBy.kind : `${q.raisedBy.kind} ${q.raisedBy.actor}`;
  return `${q.id}, ${q.source.replace(/_/g, ' ')}, raised by ${by}, ${dayOf(q.raisedAt)}`;
};

/** The Markdown block an answered or dismissed question adds to the Clarifications attachment. */
export const clarificationEntry = (q: OpenQuestion): string => {
  const head = `### Q (${raisedLine(q)})\n${q.text}`;
  if (q.answer !== undefined) return `${head}\n**Answer (${q.answer.by}, ${dayOf(q.answer.at)}):** ${q.answer.text}`;
  if (q.dismissed !== undefined) {
    const note = q.dismissed.note === null || q.dismissed.note === '' ? '' : ` ${q.dismissed.note}`;
    return `${head}\n**Dismissed (${q.dismissed.by}, ${dayOf(q.dismissed.at)}):** go ahead as is.${note}`;
  }
  return head;
};

/** The attachment's new text: what it said, then the entry. */
export const appendClarification = (previous: string, q: OpenQuestion): string => {
  const entry = clarificationEntry(q);
  return previous.trim() === '' ? entry : `${previous.replace(/\s+$/, '')}\n\n${entry}`;
};

// ---------------------------------------------------------------------------
// Plan changed while a run was working

export interface PlanVersionFact {
  readonly version: number;
  readonly createdAt: string;
}

const time = (iso: string): number => Date.parse(iso);

/**
 * The question for a plan.md saved after a run started and before the change merged: "plan.md changed to vN during the run; the
 * run used vM". The version the run used is the latest one saved before the run was queued (`Run` carries no plan version).
 * Investigate-only runs don't count as work. Null when there is no such run, the glob has merged, or nothing changed.
 */
export const planChangedQuestion = (
  glob: Pick<Glob, 'runs' | 'status' | 'category'>,
  versions: readonly PlanVersionFact[],
  latest: number,
): NewQuestion | null => {
  if (glob.category === 'decision' || glob.category === 'action') return null;
  if (glob.status === 'reviewing' || glob.status === 'signed_off') return null;
  const run = glob.runs.filter((r) => r.purpose !== 'investigate').at(-1);
  if (run === undefined) return null;
  const saved = versions.find((v) => v.version === latest);
  if (saved === undefined || !(time(saved.createdAt) > time(run.queuedAt))) return null;
  // v1 is written with the glob, a moment after a run it queued in the same transaction: it is always one the run used.
  const used = versions.filter((v) => time(v.createdAt) <= time(run.queuedAt)).reduce((max, v) => Math.max(max, v.version), 1);
  if (used >= latest) return null;
  return {
    key: `plan:v${String(latest)}`,
    text: `plan.md changed to v${String(latest)} during the run; the run used v${String(used)}. Re-run, accept as is, or follow up?`,
    options: ['Re-run', 'Accept as is', 'Follow up'],
    blocking: 'merge',
    source: 'plan_save',
    raisedBy: { kind: 'system', actor: null },
  };
};

/** The options of a question about an automatic relation: a person's click on the first adds the relation (the server does not). */
export const RELATION_QUESTION_OPTIONS = ['add relation', 'not a prerequisite'] as const;

/** A notice that `target` may be a prerequisite of a glob (intake or inference was not sure enough to add the relation). */
export const relationQuestion = (target: string, why: string, raisedBy: QuestionRaiser): NewQuestion => ({
  key: `relation:${target}`,
  text: `Is ${target} a prerequisite? ${why}`.slice(0, MAX_QUESTION_TEXT),
  options: [...RELATION_QUESTION_OPTIONS],
  blocking: 'none',
  source: 'relation',
  raisedBy,
});
