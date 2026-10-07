import type { KbItem } from '../domain/kb.js';
import type { Tx } from '../ports.js';
import { text } from './llm-json.js';

/**
 * What the KB pipeline's intake dedupe and weekly consolidation share: the checks that keep a model's answer from
 * closing an item on its own say-so (a relation compared as normalised text, a quote found verbatim), and the
 * merge write that folds one item's evidence into another.
 */

/** A `checked` ref or relation as compared: lower case, `_` and `-` as spaces, spaces collapsed ("Same_Fact" is "same fact"). */
export const normalised = (value: unknown): string =>
  (text(value) ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();

/** Text as quotes are compared: whitespace collapsed, lower case. */
export const squash = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The model's quote, when it really appears (ignoring case and whitespace) in the text it was
 * shown; null otherwise, so a claim it can't back up is dropped. `shown` is null when the model
 * saw no text (a new document, an empty overlay), which nothing can quote. The findings pipeline
 * uses it too: a split finding is kept only when its quote is in the review.
 */
export const verifiedQuote = (value: unknown, shown: string | null): string | null => {
  const quote = text(value)?.trim() ?? '';
  if (shown === null || quote === '' || !squash(shown).includes(squash(quote))) return null;
  return quote;
};

/**
 * The shortest quote a closure rests on (whitespace collapsed): a consolidation merge's quote on each side, and an
 * intake coverage's quote from the approved item. A word or two found in a statement checks nothing, and either
 * closure takes the item's own wording out of the queue. A shorter quote leaves the item open for an admin. The
 * target hint (which only flags), contradictions and the findings pipeline don't use it.
 */
export const MIN_MERGE_QUOTE_WORDS = 4;
export const MIN_MERGE_QUOTE_CHARS = 20;

/** Whether a quote is long enough to close an item on (`MIN_MERGE_QUOTE_WORDS`, `MIN_MERGE_QUOTE_CHARS`). */
export const longEnoughQuote = (quote: string): boolean => {
  const squashed = squash(quote);
  return squashed.length >= MIN_MERGE_QUOTE_CHARS && squashed.split(' ').length >= MIN_MERGE_QUOTE_WORDS;
};

/** The items whose evidence `item` holds: itself and every item merged into it (directly or through another). */
const holding = (item: KbItem): string[] => [item.id, ...item.extraEvidence.map((e) => e.itemId)];

/**
 * Whether an admin separated the two (by reopening a merge): either keeps apart an item whose evidence the other
 * holds. A merge carries both items' `keptApartFrom` and evidence onto the survivor, so this holds through any
 * chain of merges, in one run or across runs: a model-verified merge never joins what an admin split.
 */
export const keptApart = (a: KbItem, b: KbItem): boolean =>
  holding(a).some((id) => b.keptApartFrom.includes(id)) ||
  holding(b).some((id) => a.keptApartFrom.includes(id));

/**
 * `into` with `from`'s evidence, globs and count added (and its version bumped), and everything either was kept
 * apart from. New evidence clears a stale flag; the next consolidation run flags it again if that evidence is old too.
 */
export const withEvidenceFrom = (into: KbItem, from: KbItem): KbItem => ({
  ...into,
  // A pending item may already carry near-duplicates of its own; they move with it.
  occurrenceCount: into.occurrenceCount + from.occurrenceCount,
  extraEvidence: [
    ...into.extraEvidence,
    {
      itemId: from.id,
      globIds: from.sourceGlobIds,
      evidence: from.evidence,
      submittedBy: from.submittedBy,
      at: from.createdAt,
    },
    ...from.extraEvidence,
  ],
  sourceGlobIds: [...new Set([...into.sourceGlobIds, ...from.sourceGlobIds])],
  keptApartFrom: [...new Set([...into.keptApartFrom, ...from.keptApartFrom])].filter((id) => id !== into.id),
  staleSince: null,
  staleReason: null,
  version: into.version + 1,
});

/**
 * Writes `into` (as read in this transaction) with `from`'s evidence, conditional on its version; false when it
 * changed meanwhile, and the caller rolls the transaction back.
 */
export const addEvidenceTo = async (
  tx: Tx,
  into: KbItem,
  from: KbItem,
  adjust: (merged: KbItem) => KbItem = (m) => m,
): Promise<boolean> => {
  let merged = withEvidenceFrom(into, from);
  // The write bumps its version, so a claim running on it now drops its result: make it due
  // again at once rather than after the claim's lease. An item with an error is backing off
  // after a failure (or retrying one); it keeps its time so a failing model isn't hammered.
  const waiting = merged.processing === 'pending' || merged.processing === 'routed';
  if (waiting && merged.processingError === null) merged = { ...merged, processAfter: null };
  return tx.updateKbItem(adjust(merged), into.version);
};

/**
 * Merges `loser` into `survivor` (both as read in this transaction): the survivor gains the loser's evidence
 * (`adjust` changes anything else it takes), and the loser is written as `closed`. Both writes are conditional on
 * the versions read; false when either changed, and the caller must roll the transaction back (the first write
 * may have landed).
 */
export const mergeItems = async (
  tx: Tx,
  survivor: KbItem,
  loser: KbItem,
  closed: KbItem,
  adjust: (merged: KbItem) => KbItem = (m) => m,
): Promise<boolean> => {
  if (!(await addEvidenceTo(tx, survivor, loser, adjust))) return false;
  return tx.updateKbItem({ ...closed, version: loser.version + 1 }, loser.version);
};
