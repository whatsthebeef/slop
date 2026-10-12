import { learningExtraEvidence, learningLinks } from '../domain/learning.js';
import type { LearningRead } from '../domain/learning.js';
import { text } from './llm-json.js';

/**
 * What the KB pipeline's intake dedupe and weekly consolidation share: the checks that keep a model's answer from
 * closing an item on its own say-so (a relation compared as normalised text, a quote found verbatim) and the
 * check that an admin's separation of two items holds.
 */

/** A `checked` ref or relation as compared: lower case, `_` and `-` as spaces, spaces collapsed ("Same_Fact" is "same fact"). */
export const normalised = (value: unknown): string =>
  (text(value) ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();

/** Text as quotes are compared: whitespace collapsed, lower case. */
export const squash = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** Sentence punctuation and quote marks at either end of a quote, which a model adds or drops when copying. */
const QUOTE_ENDS = /^[\s.!?;:,"'“”‘’]+|[\s.!?;:,"'“”‘’]+$/g;

/**
 * The model's quote, when it really appears (ignoring case and whitespace, and sentence punctuation and quote marks
 * at either end) in the text it was shown; null otherwise, so a claim it can't back up is dropped. It is returned
 * without those ends, so a period the model added neither fails the check nor counts towards `longEnoughQuote`.
 * `shown` is null when the model saw no text (a new document, an empty overlay), which nothing can quote. The
 * findings pipeline uses it too: a split finding is kept only when its quote is in the review.
 */
export const verifiedQuote = (value: unknown, shown: string | null): string | null => {
  const quote = text(value)?.replace(QUOTE_ENDS, '') ?? '';
  if (shown === null || quote === '' || !squash(shown).includes(squash(quote))) return null;
  return quote;
};

/**
 * The shortest quote a closure rests on (whitespace collapsed): a consolidation merge's quote on each side, an
 * intake merge's or suppression's quote on each side, and an intake coverage's quote from the approved item. A word
 * or two found in a statement checks nothing, and every closure takes the item's own wording out of the queue. A
 * shorter quote leaves the item open for an admin. The target hint (which only flags), contradictions and the
 * findings pipeline don't use it.
 */
export const MIN_MERGE_QUOTE_WORDS = 4;
export const MIN_MERGE_QUOTE_CHARS = 20;

/** Whether a quote is long enough to close an item on (`MIN_MERGE_QUOTE_WORDS`, `MIN_MERGE_QUOTE_CHARS`). */
export const longEnoughQuote = (quote: string): boolean => {
  const squashed = squash(quote);
  return squashed.length >= MIN_MERGE_QUOTE_CHARS && squashed.split(' ').length >= MIN_MERGE_QUOTE_WORDS;
};

/** What the kept-apart check reads of a learning. */
export interface KeepsApart {
  readonly id: string;
  readonly extraEvidence: readonly { readonly itemId: string }[];
  readonly keptApartFrom: readonly string[];
}

/** The kept-apart check's view of a learning as read (`LearningRead`). */
export const keepsApartOf = ({ glob, artifacts }: LearningRead): KeepsApart => ({
  id: glob.id,
  extraEvidence: learningExtraEvidence(artifacts),
  keptApartFrom: learningLinks(glob).keptApartFrom,
});

/** The items whose evidence `item` holds: itself and every item merged into it (directly or through another). */
const holding = (item: KeepsApart): string[] => [item.id, ...item.extraEvidence.map((e) => e.itemId)];

/**
 * Whether an admin separated the two (by reopening a merge): either keeps apart an item whose evidence the other
 * holds. A merge carries both items' `keptApartFrom` and evidence onto the survivor, so this holds through any
 * chain of merges, in one run or across runs: a model-verified merge never joins what an admin split.
 */
export const keptApart = (a: KeepsApart, b: KeepsApart): boolean =>
  holding(a).some((id) => b.keptApartFrom.includes(id)) ||
  holding(b).some((id) => a.keptApartFrom.includes(id));
