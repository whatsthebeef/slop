/**
 * The automatic relation pass, pure parts: which sentences of a change mention a glob, the verbs that say which way a relation
 * goes, the hash a decision is remembered under, and the shapes the pass shares with the service and the stores. The model call
 * and the writes live in `app/relation-scan-service.ts` and `GlobService.applyAutomatic`.
 *
 * Cheap by construction: `idSentences` is the prefilter. A change with no glob ID in its new sentences queues nothing, so most
 * saves cost no model call.
 */
import { hash } from '../app/text-hash.js';
import { globIdInText } from './ids.js';
import type { HeldBack } from './relations.js';
import type { RelationGate, RelationUntil } from './types.js';

/** A reason quoted from a sentence is cut to this many characters. */
export const REASON_MAX_CHARS = 240;

const normalise = (sentence: string): string => sentence.replace(/\s+/g, ' ').trim().toLowerCase();

/** A list marker, checkbox or heading mark at the start of a line is not part of the sentence. */
const LEAD = /^\s*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/;

/**
 * The sentences of a text: split at `.`, `!`, `?` followed by white space, and at line breaks (so a bullet or a step title is its own
 * sentence), with list markers dropped. Empty pieces are left out; order is kept.
 */
export const sentencesOf = (text: string): string[] =>
  text
    .split(/\r?\n+/)
    // The marker goes first: "1. Hand over" must not split after "1.".
    .flatMap((line) => line.replace(LEAD, '').split(/(?<=[.!?])\s+/))
    .map((piece) => piece.replace(/\s+/g, ' ').trim())
    .filter((piece) => piece !== '');

const hasGlobId = (sentence: string): boolean => globIdInText('').test(sentence);

/** The distinct glob IDs a sentence mentions, in order. */
export const globIdsIn = (sentence: string): string[] => [...new Set(sentence.match(globIdInText('g')) ?? [])];

/**
 * The prefilter: the sentences of the new text that the old text did not have (after normalising case and white space) and that
 * mention a glob ID. `prevText` is null for a first version. Whether a mention is a prerequisite or only history ("after s14t13
 * merged we removed the token") is for the classifier; this only says it is worth asking.
 */
export const idSentences = (prevText: string | null | undefined, nextText: string): string[] => {
  const before = new Set(sentencesOf(prevText ?? '').map(normalise));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sentence of sentencesOf(nextText)) {
    const key = normalise(sentence);
    if (before.has(key) || seen.has(key) || !hasGlobId(sentence)) continue;
    seen.add(key);
    out.push(sentence);
  }
  return out;
};

/** A verb in a sentence that points at a glob: the glob and the words that did it (lower case). */
export interface RelationCue {
  readonly id: string;
  readonly cue: string;
}

const ID = '(s[1-9]\\d*[ftbhka][1-9]\\d*)\\b';
const OBJECT = `(?:(?:the|of|for|up on|glob|globs)\\s+)*${ID}`;

const cuesOf = (sentence: string, verbs: string): RelationCue[] => {
  const pattern = new RegExp(`\\b(${verbs})\\s+${OBJECT}`, 'gi');
  return [...sentence.matchAll(pattern)].flatMap((m) => (m[1] === undefined || m[2] === undefined ? [] : [{ id: m[2], cue: m[1].toLowerCase().replace(/\s+/g, ' ') }]));
};

/**
 * "fixes s14t14", "continues s14t16", "follow-up to s14t16", "unblocks s14t19": the glob this one serves, so the relation goes on
 * that glob and points at this one. Only a verb directly before the ID counts.
 */
export const reverseCuesIn = (sentence: string): RelationCue[] => cuesOf(sentence, 'fix(?:es|ed)?|continues|follow(?:-| )ups?\\s+(?:to|of)|unblocks');

/** "replaces s14t11", "supersedes s14t11", "undoes s14t11": the glob this one makes obsolete (only ever a suggestion). */
export const supersedeCuesIn = (sentence: string): RelationCue[] => cuesOf(sentence, 'replac(?:es|ed|ing)|supersed(?:es|ed|ing)|undo(?:es)?|undid');

/** What a decision about a sentence is remembered under: the same sentence (any case, any spacing) hashes the same. */
export const sentenceHash = (sentence: string): string => hash(normalise(sentence));

/** The sentence as a relation's reason: white space collapsed, at most `REASON_MAX_CHARS` characters (cut with an ellipsis). */
export const quoteReason = (sentence: string): string => {
  const one = sentence.replace(/\s+/g, ' ').trim();
  return one.length <= REASON_MAX_CHARS ? one : `${one.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…`;
};

// ---------------------------------------------------------------------------
// Stored decisions and suggestions

/** `mention`: a glob ID in a sentence. `step_failed`: a failed rollout step (`mentionedId` is the step, the hash is of step id and failure time). */
export const RELATION_SCAN_KINDS = ['mention', 'step_failed'] as const;
export type RelationScanKind = (typeof RELATION_SCAN_KINDS)[number];

/** What the pass decided: added a relation, history, context, not a prerequisite (a person said no), suggested (reverse or supersede), or unsure. */
export const RELATION_SCAN_DECISIONS = ['added', 'history', 'context', 'not_prerequisite', 'suggested', 'unsure'] as const;
export type RelationScanDecision = (typeof RELATION_SCAN_DECISIONS)[number];

/** `done`: decided, nothing to show. `open`: a card suggestion waiting for a person. `dismissed`: a person said no; never asked again. */
export const RELATION_SCAN_STATES = ['done', 'open', 'dismissed'] as const;
export type RelationScanState = (typeof RELATION_SCAN_STATES)[number];

/** One remembered decision of the pass, keyed by (glob, mentioned ID, sentence hash). Also the card's suggestion while `state` is `open`. */
export interface RelationScanRow {
  readonly globId: string;
  readonly mentionedId: string;
  readonly sentenceHash: string;
  readonly boardId: number;
  readonly kind: RelationScanKind;
  readonly decision: RelationScanDecision;
  readonly gate: RelationGate | null;
  readonly reason: string | null;
  /** The sentence (or, for a failed step, its title and note) the decision is about. */
  readonly sentence: string;
  /** The relation the decision added or a person accepted. */
  readonly relationId: string | null;
  readonly state: RelationScanState;
  /** The model that answered; null for a decision made without one. */
  readonly model: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

/** What can change on a stored decision. */
export type RelationScanPatch = Partial<Pick<RelationScanRow, 'decision' | 'gate' | 'reason' | 'relationId' | 'state' | 'decidedAt'>>;

/** A card suggestion, as the glob view and the board list carry it (non-blocking; a person accepts or dismisses it). */
export interface RelationSuggestion {
  /** Names the row: `<mentionedId>:<sentenceHash>`, what the accept and dismiss routes take. */
  readonly id: string;
  readonly kind: 'prerequisite' | 'supersedes' | 'reverse' | 'step_failed';
  /** One line for the card: "Mentions s15t220: is it a prerequisite?" with the quoted sentence. */
  readonly text: string;
  /** The glob it is about; null for a failed step. */
  readonly mentioned: string | null;
  readonly gate?: RelationGate;
  /** Set for `step_failed`. */
  readonly stepId?: string;
}

/** The suggestion ID of a stored decision. */
export const suggestionIdOf = (row: Pick<RelationScanRow, 'mentionedId' | 'sentenceHash'>): string => `${row.mentionedId}:${row.sentenceHash}`;

/** The fields the board list and the glob view add for the new relation features (the services add them to their own result types). */
export interface RelationListExtras {
  /** Cards of other globs that wait for this one, redacted for viewers outside their board. */
  readonly holdsBack?: readonly HeldBack[];
  readonly suggestions?: readonly RelationSuggestion[];
}

// ---------------------------------------------------------------------------
// Applying an automatic pass (implemented by GlobService)

/** One relation the pass wants to add: the other glob, the gate and until, and the sentence it came from (the reason is its quote). */
export interface AutomaticAdd {
  /** The other glob. */
  readonly to: string;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
  /** At most `REASON_MAX_CHARS` characters: `quoteReason(sentence)`. */
  readonly reason: string;
  readonly sentence: string;
  /** `holding` (default): this glob waits for `to`. `holds_back`: the row goes on `to` and points at this glob (a fix or a follow-up). */
  readonly direction?: 'holding' | 'holds_back';
}

/** What `applyAutomatic` did with each add. */
export interface AutomaticResult {
  /** The other glob IDs a relation was added for. */
  readonly added: readonly string[];
  /** Adds not written, and why (already related, would cycle, target not viewable, glob already past the gate, ...). */
  readonly skipped: readonly { readonly to: string; readonly why: string }[];
  /** The plan changed since `planHash`: nothing was written. */
  readonly stale: boolean;
}

/** What the relation scan needs from `GlobService`: one transaction that re-reads the plan hash and writes `source: 'auto'` rows. */
export interface AutomaticRelations {
  applyAutomatic(globId: string, planHash: string, adds: readonly AutomaticAdd[], actorEmail: string | null): Promise<AutomaticResult>;
}
