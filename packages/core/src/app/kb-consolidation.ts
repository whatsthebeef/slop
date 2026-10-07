import { evidenceCount, staleReasonAt } from '../domain/kb.js';
import type { KbItem, KbMergeNote } from '../domain/kb.js';
import type { BoardJobResult } from '../domain/signals.js';
import type { Clock, Notifier, Store } from '../ports.js';
import { LlmUnavailable } from './intake-service.js';
import type { Llm, LlmRequest } from './intake-service.js';
import { keptApart, longEnoughQuote, mergeItems, normalised, verifiedQuote } from './kb-dedupe.js';
import { LLM_TIMEOUT_MS } from './kb-pipeline.js';
import { completeWithDeadline } from './llm-call.js';
import { field, isObject, list, parseJson, text } from './llm-json.js';

export type ConsolidationResult = Extract<BoardJobResult, { kind: 'consolidation' }>;

/** The most open items one run compares (newest first): one candidate-pair call has to hold them all. */
export const MAX_CONSOLIDATION_CANDIDATES = 200;
/** The most pairs one run verifies (one call each). */
export const MAX_CONSOLIDATION_PAIRS = 20;
/** The most not-same pairs the memory keeps (the newest): it lives in `board_jobs.state` and the pair prompt. */
export const MAX_REMEMBERED_NOT_SAME = 500;

export const PAIRS_SYSTEM = `You look through the open learnings in a software project's knowledge-base review queue for pairs that may state the same fact or rule, so that each pair can be checked closely on its own. Proposing a pair closes nothing: every pair is verified separately afterwards, and anything not verified stays open for an admin.

You get one JSON object per line for each open learning: its ID, type, target, how much evidence it has, and its statement. Then, when there are any, one JSON object per line for each pair already checked: the two learning IDs.

Rules:
- Propose a pair only when both statements may state the same specific fact or rule, however worded.
- Learnings about the same tool, area or subject that state different facts are not a pair, and a more general rule is not the same fact as a specific one.
- Pairs listed as already checked were found not to be the same fact: never propose them again.
- At most ${String(MAX_CONSOLIDATION_PAIRS)} pairs, the most likely first. When unsure, leave the pair out. No pairs is a normal answer.

Respond with one JSON object and nothing else:
{"pairs": [{"a": string, "b": string}]}
- a, b: learning IDs exactly as given. {"pairs": []} when no pair may state the same fact.`;

export const VERIFY_SYSTEM = `You check whether two open learnings in a software project's knowledge-base review queue state the same fact. If they do, they are merged: one keeps both learnings' evidence and the other is closed. An admin reviews every learning left open, so a repeat left open costs a minute; a learning merged by mistake loses its own wording.

Work in this order:
1. fact: restate learning A's specific fact or rule in one sentence.
2. relation: learning B's relation to that fact: "same fact" (B states this fact or rule, however worded), "related topic only" (same tool, area or subject, but not this fact), "unrelated", or "contradicts" (both cannot be followed).
3. For "same fact" only, quoteA and quoteB: the sentence or phrase, copied word for word from A's statement and from B's statement, that states the fact. No such sentence in either means the relation is not "same fact".

Overlapping topic, tool or area is not the same fact, and a more general rule is not the same fact as a specific one. When unsure, the relation is "related topic only".

Respond with one JSON object and nothing else:
{"fact": string, "relation": "same fact" | "related topic only" | "unrelated" | "contradicts", "quoteA": string | null, "quoteB": string | null}`;

/** A proposed pair that the model then classified as the same fact, quoting each statement verbatim. */
interface Verified {
  readonly quoteA: string;
  readonly quoteB: string;
}

/**
 * What consolidation keeps between runs (`board_jobs.state`), so it doesn't pay for the same answers every week.
 * Each entry is keyed on what the pair and verification calls read of an item (`itemKey`: its statement, type and
 * target), so it holds through writes that change none of them (new evidence, mining's weekly refresh, a stale
 * flag, a merge into the item) and drops when an admin edits the statement or changes the target.
 */
export interface ConsolidationMemory {
  /**
   * The candidates (`candidateKey`) after the last run, when that run left no pair unanswered and they were the
   * candidates it compared (with its own merges): null otherwise.
   */
  readonly candidates: string | null;
  /**
   * Pairs verified as not the same fact, each a sorted pair of `itemKey`s: the newest `MAX_REMEMBERED_NOT_SAME`,
   * oldest first.
   */
  readonly notSame: readonly (readonly [string, string])[];
}

const EMPTY_MEMORY: ConsolidationMemory = { candidates: null, notSame: [] };

/** cyrb53: a 53-bit string hash, as hex. A collision after an edit only keeps a pair from being asked again. */
const hash = (value: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

/** An item as the pair and verification calls see it: its ID and a hash of its type, target and statement. */
const itemKey = (item: KbItem): string => {
  const target = item.target === null ? null : [item.target.kind, item.target.name, item.target.section];
  return `${item.id}#${hash(JSON.stringify([item.type, target, item.statement]))}`;
};
const pairKey = (a: KbItem, b: KbItem): [string, string] => {
  const [x, y] = [itemKey(a), itemKey(b)];
  return x < y ? [x, y] : [y, x];
};
/** The candidate set: equal only when no candidate came or went and none's statement, type or target changed. */
const candidateKey = (candidates: readonly KbItem[]): string => candidates.map(itemKey).sort().join(' ');

const isKeyPair = (value: unknown): value is [string, string] =>
  Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string');

/** The stored memory, narrowed; anything unreadable is forgotten (the run just checks again). */
export const consolidationMemoryOf = (stored: unknown): ConsolidationMemory => {
  if (!isObject(stored)) return EMPTY_MEMORY;
  const candidates = field(stored, 'candidates');
  return {
    candidates: typeof candidates === 'string' ? candidates : null,
    notSame: list(field(stored, 'notSame')).filter(isKeyPair),
  };
};

/** An item changed between the read and the merge write; thrown so both writes roll back. */
class MergeConflict extends Error {
  constructor(a: string, b: string) {
    super(`KB items ${a} and ${b} changed before they could be merged`);
  }
}

/**
 * Settled open statements: drafted, or given up on by the pipeline. Items still being routed or drafted are left to
 * the pipeline (it holds them by lease, and its dedupe sees the open queue), and document proposals aren't facts.
 */
const isCandidate = (item: KbItem): boolean =>
  item.status === 'open' &&
  item.document === null &&
  (item.processing === 'drafted' || item.processing === 'failed');

const newestFirst = (a: KbItem, b: KbItem): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);

const drafted = (item: KbItem): number => (item.processing === 'drafted' ? 1 : 0);

/**
 * The survivor of a merge: a drafted item before one the pipeline gave up on (the draft stays reviewable), then the
 * more repeated item, then the older one (it has stood in the queue longer).
 */
const survivorFirst = (a: KbItem, b: KbItem): [KbItem, KbItem] => {
  const order =
    drafted(b) - drafted(a) ||
    b.occurrenceCount - a.occurrenceCount ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    a.id.localeCompare(b.id);
  return order <= 0 ? [a, b] : [b, a];
};

const targetOf = (item: KbItem): string =>
  item.target === null
    ? '(none)'
    : `${item.target.name}${item.target.section === null ? '' : ` › ${item.target.section}`}`;

/**
 * Weekly consolidation (spec, self-improvement processing step 4): merges open items that state the same fact,
 * under the same safeguard as intake dedupe, flags stale ones by a documented rule, and leaves the queue's order
 * to `byEvidence`. A model never closes an item on its own say-so:
 * 1. one call proposes candidate pairs among the settled open statements (proposing closes nothing; pairs an admin
 *    kept apart by reopening a merge are dropped, including through any item either has merged in: `keptApart`);
 * 2. one call per pair classifies the second against the first's fact, and a pair merges only as "same fact" with a
 *    quote from each statement that slop finds verbatim in it;
 * 3. the merge keeps both items' evidence and `keptApartFrom` on the survivor, in one transaction conditional on
 *    both items' versions (an item that changed meanwhile skips the pair).
 * Stale items (no evidence for 60 days, or a mined signal below its threshold for 4 runs) are only flagged.
 */
export class KbConsolidation {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      /** Candidate pairs and verification: the KB pipeline's routing model. */
      llm: Llm;
      /** Deadline for each LLM call; defaults to the KB pipeline's LLM_TIMEOUT_MS. */
      llmTimeoutMs?: number;
    },
  ) {}

  private complete(request: Omit<LlmRequest, 'signal'>): Promise<string> {
    return completeWithDeadline(this.deps.llm, request, this.deps.llmTimeoutMs ?? LLM_TIMEOUT_MS);
  }

  /**
   * One run on a board. An `LlmUnavailable` from any call propagates (the job is skipped and tried again on the next
   * hourly check; merges already written stand, and the memory stays as the last finished run left it); any other
   * failure of the candidate-pair call fails the run. A pair whose verification fails or is unusable is skipped,
   * leaving both items open. The run remembers (`ConsolidationMemory`) the pairs it found not the same fact and,
   * when it left no pair unanswered and no other writer changed the candidates meanwhile, the candidates as it left
   * them: the next run lists those pairs as already checked and doesn't verify them again, and makes no
   * candidate-pair call at all while the candidates are unchanged.
   */
  async consolidate(boardId: number): Promise<ConsolidationResult> {
    const now = this.deps.clock.now();
    const { open, memory } = await this.deps.store.transaction(async (tx) => ({
      open: await tx.listKbItems(boardId, 'open'),
      memory: consolidationMemoryOf(await tx.getBoardJobState(boardId, 'consolidation')),
    }));
    const candidates = candidatesOf(open);
    // The items as this run last saw or wrote them: a merge's conditions are on these versions.
    const current = new Map(candidates.map((i) => [i.id, i]));
    const merged: { id: string; into: string }[] = [];
    // Each item merged away this run, to the item it was merged into.
    const mergedInto = new Map<string, string>();
    const survivorOf = (id: string): string => {
      let at = id;
      for (let next = mergedInto.get(at); next !== undefined; next = mergedInto.get(at)) at = next;
      return at;
    };
    // Pairs verified this run, by sorted IDs.
    const asked = new Set<string>();
    const notSame = new Map(memory.notSame.map((k) => [k.join(' '), k]));
    let verified = 0;
    let skipped = 0;
    // Whether every proposed pair got an answer that holds until an item changes (merged, not the same fact, or
    // refused by the rules); a pair left unanswered is proposed again next run even if nothing changes.
    let answered = true;

    const unchanged = candidates.length >= 2 && memory.candidates === candidateKey(candidates);
    const keys = new Set(candidates.map(itemKey));
    // Unchanged: every remembered pair among the candidates still holds, and none is asked about.
    const { pairs, alreadyChecked } =
      candidates.length < 2
        ? { pairs: [], alreadyChecked: 0 }
        : unchanged
          ? { pairs: [], alreadyChecked: memory.notSame.filter(([x, y]) => keys.has(x) && keys.has(y)).length }
          : await this.proposePairs(candidates, new Set(notSame.keys()));
    for (const [proposedA, proposedB] of pairs) {
      // An item an earlier pair of this run merged away is asked about as its survivor: "merged away" is no answer
      // about the other item.
      const [aId, bId] = [survivorOf(proposedA), survivorOf(proposedB)];
      const a = current.get(aId);
      const b = current.get(bId);
      const askedKey = [aId, bId].sort().join(' ');
      // Merged together already, or asked this run (through another pair or as proposed): answered.
      if (a === undefined || b === undefined || aId === bId || asked.has(askedKey)) {
        skipped++;
        continue;
      }
      const key = pairKey(a, b);
      // Found not the same fact (a survivor's statement is unchanged), or kept apart from what an earlier merge put on
      // the other: answers that hold too.
      if (notSame.has(key.join(' ')) || keptApart(a, b)) {
        skipped++;
        continue;
      }
      asked.add(askedKey);
      const verdict = await this.verify(a, b);
      if (verdict === 'unusable') {
        skipped++;
        answered = false;
        continue;
      }
      if (verdict === 'different') {
        notSame.set(key.join(' '), key);
        continue;
      }
      // The same fact by the model, without quotes slop could check: asked again next run.
      if (verdict === 'unverified') {
        answered = false;
        continue;
      }
      verified++;
      const written = await this.merge(boardId, a, b, verdict, now);
      if (written === null) {
        skipped++;
        answered = false;
        continue;
      }
      current.set(written.survivor.id, written.survivor);
      current.delete(written.loser.id);
      mergedInto.set(written.loser.id, written.survivor.id);
      merged.push({ id: written.loser.id, into: written.survivor.id });
    }

    const stale = await this.flagStale(boardId, now, (after) => {
      // What still holds after this run's writes: entries whose items are still candidates as verification saw them.
      const settled = new Set(after.filter(isCandidate).map(itemKey));
      const left = candidateKey(candidatesOf(after));
      // The candidates as this run left them count as checked only when they are the ones it compared: none added,
      // none gone but the ones it merged away, and none's statement, type or target changed. Another writer
      // meanwhile (a new item drafted, an admin's edit) leaves the candidates unremembered, so the next run asks again.
      const accounted = left === candidateKey([...current.values()]);
      return {
        candidates: answered && accounted ? left : null,
        notSame: [...notSame.values()]
          .filter(([x, y]) => settled.has(x) && settled.has(y))
          .slice(-MAX_REMEMBERED_NOT_SAME),
      };
    });
    if (merged.length > 0 || stale.flagged > 0 || stale.cleared > 0)
      this.deps.notifier.publish({ kind: 'board.kb', boardId });
    return {
      kind: 'consolidation',
      candidates: candidates.length,
      proposed: unchanged ? 0 : pairs.length + alreadyChecked,
      verified,
      merged,
      skipped,
      alreadyChecked,
      unchanged,
      flaggedStale: stale.flagged,
      clearedStale: stale.cleared,
    };
  }

  /**
   * The candidate-pair call: up to `MAX_CONSOLIDATION_PAIRS` pairs of distinct candidates, each once, without the
   * pairs an admin kept apart. Pairs an earlier run found not the same fact (`notSame`, at the items' current
   * statements, types and targets) are listed in the prompt as already checked, and any the model proposes anyway are counted
   * (`alreadyChecked`) and dropped before the cap, so they don't crowd out new ones. Anything else in the answer is
   * ignored; an answer that isn't JSON fails the run.
   */
  private async proposePairs(
    candidates: readonly KbItem[],
    notSame: ReadonlySet<string>,
  ): Promise<{ pairs: [string, string][]; alreadyChecked: number }> {
    const checked: [KbItem, KbItem][] = [];
    for (const [i, a] of candidates.entries())
      for (const b of candidates.slice(i + 1)) if (notSame.has(pairKey(a, b).join(' '))) checked.push([a, b]);
    const answer = await this.complete({
      system: PAIRS_SYSTEM,
      prompt: pairsPrompt(candidates, checked),
      maxTokens: 1_500,
    });
    const parsed = parseJson(answer);
    if (!isObject(parsed)) throw new Error('The candidate-pair answer was not usable JSON');
    const byId = new Map(candidates.map((i) => [i.id, i]));
    const seen = new Set<string>();
    const pairs: [string, string][] = [];
    let alreadyChecked = 0;
    for (const entry of list(field(parsed, 'pairs'))) {
      const a = byId.get(text(field(entry, 'a'))?.trim() ?? '');
      const b = byId.get(text(field(entry, 'b'))?.trim() ?? '');
      if (a === undefined || b === undefined || a.id === b.id || keptApart(a, b)) continue;
      const key = pairKey(a, b).join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      if (notSame.has(key)) {
        alreadyChecked++;
        continue;
      }
      pairs.push([a.id, b.id]);
      if (pairs.length === MAX_CONSOLIDATION_PAIRS) break;
    }
    return { pairs, alreadyChecked };
  }

  /**
   * The verification call for one pair: the quotes when the model classes B as the same fact as A and both quotes
   * are verbatim in their statements and long enough (`longEnoughQuote`); `different` when it classes B as anything
   * else, `unverified` when it says the same fact without such quotes (both stay open either way); `unusable` when
   * the call failed or the answer isn't JSON. An `LlmUnavailable` propagates.
   */
  private async verify(a: KbItem, b: KbItem): Promise<Verified | 'different' | 'unverified' | 'unusable'> {
    let answer: string;
    try {
      answer = await this.complete({
        system: VERIFY_SYSTEM,
        prompt: verifyPrompt(a, b),
        maxTokens: 600,
      });
    } catch (error) {
      if (error instanceof LlmUnavailable) throw error;
      return 'unusable';
    }
    const parsed = parseJson(answer);
    if (!isObject(parsed)) return 'unusable';
    if (normalised(field(parsed, 'relation')) !== 'same fact') return 'different';
    const quoteA = verifiedQuote(field(parsed, 'quoteA'), a.statement);
    const quoteB = verifiedQuote(field(parsed, 'quoteB'), b.statement);
    if (quoteA === null || quoteB === null || !longEnoughQuote(quoteA) || !longEnoughQuote(quoteB))
      return 'unverified';
    return { quoteA, quoteB };
  }

  /**
   * Merges a verified pair in one transaction: both items must still be the versions verified (and still settled
   * and open, and not kept apart), else the pair is skipped (null). The survivor keeps its draft and gains the
   * loser's evidence, globs, count and `keptApartFrom`, and the loser's signal when it has none; the loser is closed
   * as `merged` with the quotes.
   */
  private async merge(
    boardId: number,
    a: KbItem,
    b: KbItem,
    verdict: Verified,
    now: string,
  ): Promise<{ survivor: KbItem; loser: KbItem } | null> {
    try {
      return await this.deps.store.transaction(async (tx) => {
        // Mining holds this lock for its whole run: a merge doesn't interleave with its reads and writes of the
        // board's kb_signals rows (whose items it repoints) or its refreshes of open items.
        await tx.lockBoardJob(boardId, 'mining');
        const storedA = await tx.getKbItem(a.id);
        const storedB = await tx.getKbItem(b.id);
        if (storedA?.version !== a.version || storedB?.version !== b.version) return null;
        if (!isCandidate(storedA) || !isCandidate(storedB) || keptApart(storedA, storedB))
          return null;
        const [survivor, loser] = survivorFirst(storedA, storedB);
        const note: KbMergeNote = {
          by: 'consolidation',
          quote: loser.id === a.id ? verdict.quoteA : verdict.quoteB,
          survivorQuote: survivor.id === a.id ? verdict.quoteA : verdict.quoteB,
          at: now,
        };
        const closed: KbItem = {
          ...loser,
          status: 'merged',
          duplicateOf: survivor.id,
          mergeNote: note,
          processAfter: null,
          // A closed item isn't flagged; reopened, it is flagged again by the next run if the rule still holds.
          staleSince: null,
          staleReason: null,
        };
        const takesSignal = loser.signal !== null && survivor.signal === null;
        const wrote = await mergeItems(tx, survivor, loser, closed, (m) =>
          takesSignal ? { ...m, signal: loser.signal } : m,
        );
        if (!wrote) throw new MergeConflict(a.id, b.id);
        // The loser's signal rows point at the survivor now (mining would follow the merge to it anyway).
        for (const row of await tx.listKbSignals(boardId)) {
          if (row.itemId === loser.id) await tx.upsertKbSignal({ ...row, itemId: survivor.id });
        }
        const written = await tx.getKbItem(survivor.id);
        if (written === null) throw new MergeConflict(a.id, b.id);
        return { survivor: written, loser: { ...closed, version: loser.version + 1 } };
      });
    } catch (error) {
      if (error instanceof MergeConflict) return null;
      throw error;
    }
  }

  /**
   * Flags settled open items that are stale by the rule (`staleReasonAt`) and clears flags that no longer hold, in
   * one transaction; a conditional write that loses to another writer leaves that item to the next run. The same
   * transaction stores the run's memory, worked out (`remember`) from the open items as it leaves them.
   */
  private async flagStale(
    boardId: number,
    now: string,
    remember: (open: readonly KbItem[]) => ConsolidationMemory,
  ): Promise<{ flagged: number; cleared: number }> {
    return this.deps.store.transaction(async (tx) => {
      // The below-threshold counts are mining's: read them as its last run left them.
      await tx.lockBoardJob(boardId, 'mining');
      const runs = new Map(
        (await tx.listKbSignals(boardId)).map((r) => [r.key, r.belowThresholdRuns]),
      );
      let flagged = 0;
      let cleared = 0;
      const after: KbItem[] = [];
      for (const item of await tx.listKbItems(boardId, 'open')) {
        after.push(item);
        if (!(item.processing === 'drafted' || item.processing === 'failed')) continue;
        const reason = staleReasonAt(
          item,
          now,
          item.signal === null ? null : (runs.get(item.signal.key) ?? null),
        );
        if (reason === item.staleReason) continue;
        const next: KbItem =
          reason === null
            ? { ...item, staleSince: null, staleReason: null, version: item.version + 1 }
            : {
                ...item,
                staleSince: item.staleSince ?? now,
                staleReason: reason,
                version: item.version + 1,
              };
        if (!(await tx.updateKbItem(next, item.version))) continue;
        after[after.length - 1] = next;
        if (reason === null) cleared++;
        else if (item.staleSince === null) flagged++;
      }
      await tx.setBoardJobState(boardId, 'consolidation', remember(after));
      return { flagged, cleared };
    });
  }
}

/** The newest settled open statements, as one run compares them. */
const candidatesOf = (open: readonly KbItem[]): KbItem[] =>
  open.filter(isCandidate).sort(newestFirst).slice(0, MAX_CONSOLIDATION_CANDIDATES);

// One JSON object per line: a statement's newlines (or text that looks like another entry) stay inside its string.
const pairsPrompt = (candidates: readonly KbItem[], checked: readonly (readonly [KbItem, KbItem])[]): string =>
  [
    'Open learnings:',
    ...candidates.map((i) =>
      JSON.stringify({
        id: i.id,
        type: i.type,
        target: targetOf(i),
        evidence: evidenceCount(i),
        statement: i.statement,
      }),
    ),
    ...(checked.length === 0
      ? []
      : [
          '',
          'Already checked, not the same fact (never propose these pairs):',
          ...checked.map(([a, b]) => JSON.stringify({ a: a.id, b: b.id })),
        ]),
  ].join('\n');

const verifyPrompt = (a: KbItem, b: KbItem): string =>
  [
    `Learning A, ${a.id} (${a.type}; target: ${targetOf(a)}):`,
    '<<<',
    a.statement,
    '>>>',
    '',
    `Learning B, ${b.id} (${b.type}; target: ${targetOf(b)}):`,
    '<<<',
    b.statement,
    '>>>',
  ].join('\n');
