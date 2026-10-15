import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';
import type { KbTarget, LearningStatus } from './kb.js';
import { learningDecision, learningDraft, learningFacts, learningStatement, learningStatus, learningTarget } from './learning.js';
import type { LearningRead } from './learning.js';
import { isHumanCategory } from './types.js';
import type { Glob } from './types.js';

/**
 * Suggest: an on-demand model recommendation for a decision glob (approve, approve with an edit, merge into another open
 * learning, or reject). Everything here is pure: what the model reads is picked and bounded here, its answer is validated
 * here (an unknown `mergeInto` or a missing text is refused, never guessed at), and the stored form says which draft and
 * target it was made for, so it can be marked stale when either moves.
 */

export const SUGGEST_ACTIONS = ['approve', 'approve_with_edit', 'merge_into', 'reject'] as const;
export type SuggestAction = (typeof SUGGEST_ACTIONS)[number];

/** The `assessment` artifact's label for a suggestion; the label-less assessment stays the deterministic one. */
export const SUGGESTION_LABEL = 'suggestion';

/** Bumped when the prompt or the output contract changes, so older suggestions read as stale. */
export const SUGGEST_PROMPT_VERSION = 1;

export const SUGGEST_SIBLINGS_MAX = 8;
export const SUGGEST_MERGES_MAX = 8;
export const SUGGEST_OUTCOMES_MAX = 5;
/** Cuts that keep one call small: a section, a draft, a statement, a reason. */
export const SUGGEST_SECTION_MAX = 12_000;
export const SUGGEST_DRAFT_MAX = 4_000;
export const SUGGEST_STATEMENT_MAX = 1_200;
export const SUGGEST_REASON_MAX = 1_000;
export const SUGGEST_OUTPUT_TEXT_MAX = 100_000;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What the suggestion was made against: when either moved, it is stale. */
export interface SuggestionStamp {
  /** The version of the draft artifact (null: no draft). */
  readonly draftVersion: number | null;
  /** The version of the target document the draft applies to (null: none). */
  readonly targetVersion: number | null;
  readonly promptVersion: number;
}

export interface Suggestion {
  readonly action: SuggestAction;
  /** approve_with_edit: the full section text (or a new document's body). */
  readonly editedDraft: string | null;
  /** merge_into: the open learning that takes this one's evidence. */
  readonly mergeInto: string | null;
  /** merge_into: the combined section text for that learning. */
  readonly mergedText: string | null;
  readonly reason: string;
}

export interface StoredSuggestion {
  readonly suggestion: Suggestion;
  readonly model: string;
  readonly at: string;
  readonly stamp: SuggestionStamp;
}

/** The deterministic flags (as the assessment shows them), passed to the model as given. */
export interface SuggestFlags {
  readonly suggestedOutcome: string | null;
  readonly flags: readonly string[];
}

export interface SuggestSibling {
  readonly id: string;
  readonly statement: string;
  readonly section: string | null;
  readonly draft: string | null;
}

export interface SuggestMerge {
  readonly id: string;
  readonly title: string;
}

export interface SuggestOutcome {
  readonly id: string;
  readonly statement: string;
  readonly status: LearningStatus;
  readonly reason: string | null;
}

/** Everything the model reads, already bounded. `learning` is null for a decision with no knowledge item. */
export interface SuggestInputs {
  readonly glob: { readonly id: string; readonly title: string };
  readonly learning: {
    readonly statement: string;
    readonly type: string;
    readonly evidence: string;
    readonly sourceGlobs: readonly string[];
    readonly occurrences: number;
    readonly target: KbTarget | null;
    readonly draft: { readonly section: string | null; readonly content: string } | null;
    readonly diff: readonly string[];
    readonly targetText: string | null;
    readonly headings: readonly string[];
  } | null;
  readonly siblings: readonly SuggestSibling[];
  readonly merges: readonly SuggestMerge[];
  readonly outcomes: readonly SuggestOutcome[];
  readonly flags: SuggestFlags;
}

const sameTarget = (a: KbTarget | null, b: KbTarget | null): boolean => a !== null && b !== null && a.kind === b.kind && a.name === b.name;

/** The statement of a learning glob, read from its plan.md. */
const statementOf = (l: LearningRead): string => cut(learningStatement(l.glob, l.artifacts), SUGGEST_STATEMENT_MAX);

/**
 * The other open learnings aimed at the same file as `self`, oldest first, with their drafts: candidates to consolidate
 * with. Approving one re-drafts the others, so the model is told which sections compete.
 */
export const siblingLearnings = (self: LearningRead, learnings: readonly LearningRead[]): SuggestSibling[] => {
  const target = learningTarget(self.glob).routed;
  if (target === null) return [];
  return learnings
    .filter((l) => l.glob.id !== self.glob.id && learningStatus(l.glob, l.artifacts) === 'open' && sameTarget(learningTarget(l.glob).routed, target))
    .sort((a, b) => a.glob.createdAt.localeCompare(b.glob.createdAt) || a.glob.id.localeCompare(b.glob.id))
    .slice(0, SUGGEST_SIBLINGS_MAX)
    .map((l) => {
      const draft = learningDraft(l.artifacts)?.draft ?? null;
      return { id: l.glob.id, statement: statementOf(l), section: draft?.section ?? null, draft: draft === null ? null : cut(draft.content, SUGGEST_DRAFT_MAX) };
    });
};

/** The last few decided learnings aimed at the same file, newest first, with their reasons. */
export const recentOutcomes = (self: LearningRead, learnings: readonly LearningRead[]): SuggestOutcome[] => {
  const target = learningTarget(self.glob).routed;
  if (target === null) return [];
  return learnings
    .filter((l) => l.glob.id !== self.glob.id && learningStatus(l.glob, l.artifacts) !== 'open' && sameTarget(learningTarget(l.glob).routed, target))
    .map((l) => ({ l, decision: learningDecision(l.glob, l.artifacts) }))
    .sort((a, b) => (b.decision.at ?? b.l.glob.updatedAt).localeCompare(a.decision.at ?? a.l.glob.updatedAt))
    .slice(0, SUGGEST_OUTCOMES_MAX)
    .map(({ l, decision }) => ({ id: l.glob.id, statement: statementOf(l), status: learningStatus(l.glob, l.artifacts), reason: decision.reason === null ? null : cut(decision.reason, SUGGEST_REASON_MAX) }));
};

const WORD = /[a-z0-9_.-]{4,}/g;
const words = (text: string): Set<string> => new Set(text.toLowerCase().match(WORD) ?? []);

/**
 * Work globs merged since the learning was submitted whose title shares words with its area (target file and
 * section, statement): the changes that may have made it moot, or changed what it should say. Titles and summaries only,
 * best overlap first.
 */
export const overlappingMerges = (self: Glob, area: readonly string[], merged: readonly Glob[]): SuggestMerge[] => {
  const wanted = words(area.join(' '));
  if (wanted.size === 0) return [];
  return merged
    .filter((g) => g.id !== self.id && !isHumanCategory(g.category) && g.updatedAt > self.createdAt)
    .map((g) => {
      const have = words(g.title);
      let score = 0;
      for (const w of have) if (wanted.has(w)) score++;
      return { g, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.g.updatedAt.localeCompare(a.g.updatedAt) || a.g.id.localeCompare(b.g.id))
    .slice(0, SUGGEST_MERGES_MAX)
    .map(({ g }) => ({ id: g.id, title: g.title }));
};

export const suggestSystem = (learning: boolean): string => `You advise a board's admin on one open decision about the project's knowledge base. You are given the proposal and what surrounds it, and you recommend what to do with it.

${
  learning
    ? `Choose exactly one action:
- "approve": the draft is right as it is.
- "approve_with_edit": the draft needs a change first (trim, de-duplicate, fix wording); give the whole section text as "editedDraft".
- "merge_into": another open learning from the input covers the same section or fact; give its ID as "mergeInto" and the combined section text as "mergedText". Use only an ID listed under siblings.
- "reject": a later change made it moot, it is already covered, it belongs in another document or the catalog, or it is wrong.`
    : `This decision has no knowledge item, so choose "approve" or "reject".`
}

Rules:
- Ground the reason in the input: cite glob IDs (from merges), learning IDs (siblings, outcomes) and the section by name. Do not invent IDs, files or facts that are not in the input.
- "reason" is 2 to 3 sentences.
- Prefer approve when the draft is sound; do not edit for style alone.
- Answer with one JSON object and nothing else: {"action": "...", "reason": "...", "editedDraft": null, "mergeInto": null, "mergedText": null}. Fill only the fields the action needs.`;

/** The user prompt: the inputs as labelled sections the model can cite. */
export const suggestPrompt = (inputs: SuggestInputs): string => {
  const out: string[] = [`Decision ${inputs.glob.id}: ${inputs.glob.title}`];
  const l = inputs.learning;
  if (l !== null) {
    out.push(
      '',
      '## Learning',
      `Type: ${l.type}. Seen ${String(l.occurrences)} time(s). Source globs: ${l.sourceGlobs.length === 0 ? 'none' : l.sourceGlobs.join(', ')}.`,
      `Target: ${l.target === null ? 'not routed' : `${l.target.kind} ${l.target.name}${l.target.section === null ? '' : `, section "${l.target.section}"`}`}`,
      `Evidence:\n${l.evidence}`,
      '',
      '## Draft',
      l.draft === null ? 'No draft yet.' : `Section: ${l.draft.section ?? '(whole document)'}\n${l.draft.content}`,
      '',
      '## Diff the draft would make',
      l.diff.length === 0 ? 'None.' : l.diff.join('\n'),
      '',
      '## Current text of the target section',
      l.targetText ?? 'Not available.',
      '',
      '## Headings of the target document',
      l.headings.length === 0 ? 'None.' : l.headings.join('\n'),
    );
  }
  out.push('', '## Siblings: other open learnings aimed at the same file');
  out.push(...(inputs.siblings.length === 0 ? ['None.'] : inputs.siblings.map((s) => `- ${s.id} (${s.section === null ? 'whole document' : `section "${s.section}"`}): ${s.statement}${s.draft === null ? '' : `\n  Draft: ${s.draft}`}`)));
  out.push('', '## Changes merged since it was submitted that overlap its area');
  out.push(...(inputs.merges.length === 0 ? ['None.'] : inputs.merges.map((m) => `- ${m.id}: ${m.title}`)));
  out.push('', '## Recent outcomes on this file');
  out.push(...(inputs.outcomes.length === 0 ? ['None.'] : inputs.outcomes.map((o) => `- ${o.id} ${o.status}: ${o.statement}${o.reason === null ? '' : ` (reason: ${o.reason})`}`)));
  out.push('', '## Automatic flags', `Rule-based outcome: ${inputs.flags.suggestedOutcome ?? 'none'}`, ...(inputs.flags.flags.length === 0 ? ['No flags.'] : inputs.flags.flags.map((f) => `- ${f}`)));
  return out.join('\n');
};

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/**
 * The model's answer, checked against what it was given: a known action, a reason, and the text or ID that action needs.
 * `siblingIds` are the open learnings it may merge into; `learning` says whether the decision has a knowledge item
 * (without one only approve and reject exist).
 */
export const checkSuggestion = (raw: unknown, context: { readonly siblingIds: readonly string[]; readonly learning: boolean }): Result<Suggestion> => {
  if (typeof raw !== 'object' || raw === null) return invalidInput('The suggestion is not a JSON object');
  const get = (key: string): unknown => Object.getOwnPropertyDescriptor(raw, key)?.value;
  const action = SUGGEST_ACTIONS.find((a) => a === get('action'));
  if (action === undefined) return invalidInput(`Unknown action ${JSON.stringify(get('action'))}`);
  const reason = str(get('reason'));
  if (reason === null) return invalidInput('The suggestion has no reason');
  const editedDraft = str(get('editedDraft'));
  const mergeInto = str(get('mergeInto'));
  const mergedText = str(get('mergedText'));
  if (!context.learning && (action === 'approve_with_edit' || action === 'merge_into')) return invalidInput(`${action} needs a knowledge item`);
  if (action === 'approve_with_edit' && editedDraft === null) return invalidInput('approve_with_edit needs editedDraft');
  if (action === 'merge_into') {
    if (mergeInto === null || !context.siblingIds.includes(mergeInto)) return invalidInput(`mergeInto ${JSON.stringify(mergeInto)} is not an open learning from the input`);
    if (mergedText === null) return invalidInput('merge_into needs mergedText');
  }
  if ((editedDraft ?? '').length > SUGGEST_OUTPUT_TEXT_MAX || (mergedText ?? '').length > SUGGEST_OUTPUT_TEXT_MAX) return invalidInput('The suggested text is too long');
  return ok({
    action,
    reason: cut(reason.trim(), SUGGEST_REASON_MAX * 2),
    editedDraft: action === 'approve_with_edit' ? editedDraft : null,
    mergeInto: action === 'merge_into' ? mergeInto : null,
    mergedText: action === 'merge_into' ? mergedText : null,
  });
};

/** True when the draft or the target moved (or the prompt changed) since the suggestion was made. */
export const suggestionStale = (stored: StoredSuggestion, now: SuggestionStamp): boolean =>
  stored.stamp.draftVersion !== now.draftVersion || stored.stamp.targetVersion !== now.targetVersion || stored.stamp.promptVersion !== now.promptVersion;

const ACTION_TEXT: Readonly<Record<SuggestAction, string>> = {
  approve: 'Approve as drafted',
  approve_with_edit: 'Approve with an edit',
  merge_into: 'Merge into another learning',
  reject: 'Reject',
};

const FENCE = '```suggestion';

/** The artifact's content: readable Markdown, then the structured fields in a fenced block that `readSuggestion` parses back. */
export const renderSuggestion = (stored: StoredSuggestion): string => {
  const s = stored.suggestion;
  const lines = ['## Suggestion', '', `**${ACTION_TEXT[s.action]}.** ${s.reason}`];
  if (s.mergeInto !== null) lines.push('', `Merge into ${s.mergeInto}.`);
  const text = s.editedDraft ?? s.mergedText;
  if (text !== null) lines.push('', s.action === 'merge_into' ? 'Combined text:' : 'Edited text:', '', ...text.split('\n').map((l) => `> ${l}`));
  lines.push('', `_Made by ${stored.model} at ${stored.at}._`, '', FENCE, JSON.stringify(stored), '```', '');
  return lines.join('\n');
};

const isStamp = (value: unknown): value is SuggestionStamp =>
  typeof value === 'object' &&
  value !== null &&
  'promptVersion' in value &&
  typeof value.promptVersion === 'number' &&
  'draftVersion' in value &&
  (value.draftVersion === null || typeof value.draftVersion === 'number') &&
  'targetVersion' in value &&
  (value.targetVersion === null || typeof value.targetVersion === 'number');

const isSuggestion = (value: unknown): value is Suggestion =>
  typeof value === 'object' &&
  value !== null &&
  'action' in value &&
  SUGGEST_ACTIONS.some((a) => a === value.action) &&
  'reason' in value &&
  typeof value.reason === 'string' &&
  'editedDraft' in value &&
  (value.editedDraft === null || typeof value.editedDraft === 'string') &&
  'mergeInto' in value &&
  (value.mergeInto === null || typeof value.mergeInto === 'string') &&
  'mergedText' in value &&
  (value.mergedText === null || typeof value.mergedText === 'string');

/** The structured suggestion stored in an artifact's content; null when there is none or it doesn't read. */
export const readSuggestion = (content: string): StoredSuggestion | null => {
  const start = content.lastIndexOf(`${FENCE}\n`);
  if (start < 0) return null;
  const body = content.slice(start + FENCE.length + 1);
  const end = body.indexOf('\n```');
  if (end < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(0, end));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const get = (key: string): unknown => Object.getOwnPropertyDescriptor(raw, key)?.value;
  const suggestion = get('suggestion');
  const stamp = get('stamp');
  const model = get('model');
  const at = get('at');
  return isSuggestion(suggestion) && isStamp(stamp) && typeof model === 'string' && typeof at === 'string' ? { suggestion, model, at, stamp } : null;
};

/** Where the decision section pre-fills the decide form from a suggestion: the outcome and its text, for the person to edit and confirm. */
export interface SuggestionPrefill {
  readonly outcome: 'accept' | 'accept_with_edits' | 'reject';
  readonly editedDraft?: string;
  readonly reason?: string;
}

/** What Apply fills in for this decision. A merge rejects this learning ("merged into <id>"); the other learning's approval is its own decision. */
export const prefillOf = (suggestion: Suggestion): SuggestionPrefill => {
  switch (suggestion.action) {
    case 'approve':
      return { outcome: 'accept' };
    case 'approve_with_edit':
      return { outcome: 'accept_with_edits', ...(suggestion.editedDraft === null ? {} : { editedDraft: suggestion.editedDraft }) };
    case 'merge_into':
      return { outcome: 'reject', reason: `Merged into ${suggestion.mergeInto ?? 'another learning'}: ${suggestion.reason}` };
    case 'reject':
      return { outcome: 'reject', reason: suggestion.reason };
  }
};

/** A learning's own facts for the prompt (type, occurrences, source globs). */
export const learningPromptFacts = (read: LearningRead): { type: string; sourceGlobs: readonly string[]; occurrences: number } => {
  const facts = learningFacts(read.glob);
  return { type: facts.kind, sourceGlobs: facts.sourceGlobIds, occurrences: facts.occurrenceCount };
};
