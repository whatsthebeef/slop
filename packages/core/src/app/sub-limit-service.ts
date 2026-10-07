import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { BoardJobResult } from '../domain/signals.js';
import {
  SUB_LIMIT_EVENT_TYPES,
  SUB_LIMIT_MAX,
  SUB_LIMIT_MIN,
  SUB_LIMIT_STEP,
  SUB_LIMIT_WINDOW_DAYS,
  bugText,
  nextLimit,
  outcomeKey,
  subLimitCandidates,
} from '../domain/sub-limit.js';
import type { SubLimitCandidate, SubLimitOutcome, SubLimitView } from '../domain/sub-limit.js';
import type { Board } from '../domain/types.js';
import type { Notifier, Store, SubDiffSource } from '../ports.js';
import { memberOf } from './access.js';
import { LlmUnavailable } from './intake-service.js';
import type { Llm } from './intake-service.js';
import { longEnoughQuote, verifiedQuote } from './kb-dedupe.js';
import { completeWithDeadline } from './llm-call.js';
import { field, isObject, parseJson } from './llm-json.js';
import { hash } from './text-hash.js';

export type SubLimitResult = Extract<BoardJobResult, { kind: 'sub_limit' }>;

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long after a sub's window ends its merge is still read: an outcome that arrived in the window's last hour, or a
 * candidate that waited (the model unavailable) when the window ended, is still decided on a later run.
 * Recorded outcomes and remembered answers keep the re-reads idempotent.
 */
const MERGE_MARGIN_DAYS = SUB_LIMIT_WINDOW_DAYS;
/** How far before the merges it considers the job reads events: a converted sub's gate verdict can be weeks older. */
const GATE_LOOKBACK_DAYS = 90;
/** Haiku answers a yes or no with a quote in seconds. */
export const SUB_LIMIT_LLM_TIMEOUT_MS = 30_000;
/** The most bug references whose answers the job remembers (the newest), so it doesn't ask again hourly. */
export const MAX_REMEMBERED_ANSWERS = 500;
/** Asks about one bug reference that end without a usable answer (unusable JSON, a timeout) before it is skipped. */
export const MAX_ANSWER_ATTEMPTS = 3;

const SYSTEM = `You read a bug report and decide whether it says the defect was introduced by one earlier change.
Answer with JSON only: {"caused": true or false, "quote": "..."}.
"caused" is true only when the report itself says that change introduced or caused the defect (for example it broke,
reverted or regressed something). Naming the change as related work, a reference or a place to look is not enough.
"quote" is the words of the report that say so, copied exactly; an empty string when "caused" is false.`;

/**
 * What the job keeps between runs: the bug references not asked about again (answered "not caused" or without a
 * usable quote, or skipped after `MAX_ANSWER_ATTEMPTS` failed asks), and the failed asks so far of the others.
 */
interface SubLimitMemory {
  readonly answered: readonly string[];
  readonly attempts: Readonly<Record<string, number>>;
}

const memoryOf = (stored: unknown): SubLimitMemory => {
  const answered = field(stored, 'answered');
  const attempts = field(stored, 'attempts');
  return {
    answered: Array.isArray(answered)
      ? answered.filter((a): a is string => typeof a === 'string')
      : [],
    attempts: isObject(attempts)
      ? Object.fromEntries(
          Object.entries(attempts).filter(
            (e): e is [string, number] => typeof e[1] === 'number' && Number.isInteger(e[1]),
          ),
        )
      : {},
  };
};

/** A bug reference as remembered: the sub, the bug and its text, so an edited bug report is asked about again. */
const answerKey = (candidate: Extract<SubLimitCandidate, { kind: 'bug_reference' }>): string =>
  `${candidate.globId}:${candidate.bug.id}:${hash(bugText(candidate.bug))}`;

/** The model's answer: the verified quote when it says the sub caused the bug, else a null quote. */
const parseAnswer = (answer: string, shown: string): { quote: string | null } | 'unusable' => {
  const parsed = parseJson(answer);
  const caused = field(parsed, 'caused');
  if (typeof caused !== 'boolean') return 'unusable';
  if (!caused) return { quote: null };
  const quote = verifiedQuote(field(parsed, 'quote'), shown);
  return { quote: quote !== null && longEnoughQuote(quote) ? quote : null };
};

const outcomeOf = (candidate: SubLimitCandidate): SubLimitOutcome =>
  candidate.kind === 'merged_unchanged' ? 'merged_unchanged' : 'needed_fixes';

/** The limit changed meanwhile without the board's lock: the transaction rolls back and the next run tries again. */
class SubLimitConflict extends Error {
  constructor(boardId: number) {
    super(`Board ${boardId}'s sub limit changed during the learning run`);
  }
}

/**
 * The learned sub size limit (spec, Sub review). Hourly, it reads the board's subs merged up to 28 days before its
 * last successful run (the 14-day window plus a 14-day margin, so an outcome near the window's end or a candidate that
 * waited is still decided) and records each outcome once, moving the limit by the rule in `sub-limit.ts`: a converted
 * sub merged unchanged raises it, a sub that needed fixes lowers it. A bug that names a sub counts only when the
 * findings model (Haiku) says the bug report blames it and its quote is found verbatim in the report; the quote is the
 * change's evidence. While the model is unavailable those candidates wait for the next run; a reference that gets no
 * usable answer `MAX_ANSWER_ATTEMPTS` times is skipped. The gate reads the board's limit when it decides, so a
 * decision uses the limit of that moment.
 */
export class SubLimitService {
  constructor(
    private readonly deps: {
      store: Store;
      notifier: Notifier;
      /** The findings model; absent: bug references aren't checked (they wait). */
      llm?: Llm;
      /** Whether the findings model is known to be down (`llmHealth`): bug references then wait without calls. */
      findingsDown?: () => boolean;
      /** Null without a code host: a passed sub recorded without a line count is recorded with none. */
      diffs: SubDiffSource | null;
      llmTimeoutMs?: number;
    },
  ) {}

  /**
   * One run at `now`. `lastRunAt` is the job's last successful run (a failed run doesn't move it), so merges are read
   * from `MERGE_MARGIN_DAYS` before the window that run could still see.
   */
  async learn(boardId: number, now: string, lastRunAt: string | null): Promise<SubLimitResult> {
    const from =
      lastRunAt === null ? Date.parse(now) : Math.min(Date.parse(now), Date.parse(lastRunAt));
    const mergedSince = new Date(
      from - (SUB_LIMIT_WINDOW_DAYS + MERGE_MARGIN_DAYS) * DAY_MS,
    ).toISOString();
    const read = await this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) throw new Error(`No board ${boardId}`);
      const since = new Date(Date.parse(mergedSince) - GATE_LOOKBACK_DAYS * DAY_MS).toISOString();
      const events = await tx.listBoardEvents(boardId, since, SUB_LIMIT_EVENT_TYPES);
      const globs = await tx.listGlobs(boardId, {});
      const recorded = new Set(
        (await tx.listSubLimitChanges(boardId)).map((c) => outcomeKey(c.globId, c.outcome)),
      );
      const memory = memoryOf(await tx.getBoardJobState(boardId, 'sub_limit'));
      return {
        board,
        candidates: subLimitCandidates({ events, globs, recorded, mergedSince, now }),
        memory,
        recorded,
      };
    });
    const { board, candidates, recorded } = read;
    const answered = new Set(read.memory.answered);
    const newlyAnswered: string[] = [];
    // Failed asks this run, per reference, added to the remembered counts.
    const failedAsks = new Map<string, number>();
    // Subs whose bug outcome is recorded: their references are never asked about again, so their counts are dropped.
    const blamed = new Set<string>();
    const changes: SubLimitResult['changes'][number][] = [];
    let limit = board.subMaxChangedLines;
    let asked = 0;
    let waiting = 0;
    let gaveUp = 0;
    let llmDown = this.deps.findingsDown?.() === true;
    // One code-host call per merge, however many bugs name the sub.
    const fetched = new Map<string, number | null>();
    const failed = (key: string) => {
      const attempts = (read.memory.attempts[key] ?? 0) + 1;
      if (attempts >= MAX_ANSWER_ATTEMPTS) {
        // Skipped: remembered as answered, so it isn't asked about every hour for the rest of its window.
        answered.add(key);
        newlyAnswered.push(key);
        gaveUp++;
      } else {
        failedAsks.set(key, attempts);
        waiting++;
      }
    };
    for (const candidate of candidates) {
      const outcome = outcomeOf(candidate);
      if (recorded.has(outcomeKey(candidate.globId, outcome))) continue;
      let evidence: string;
      if (candidate.kind === 'bug_reference') {
        const key = answerKey(candidate);
        if (answered.has(key)) continue;
        if (this.deps.llm === undefined || llmDown) {
          waiting++;
          continue;
        }
        const shown = bugText(candidate.bug);
        let answer: string;
        try {
          asked++;
          answer = await completeWithDeadline(
            this.deps.llm,
            {
              system: SYSTEM,
              prompt: `Does this bug report say the defect was introduced by ${candidate.globId} (${candidate.title})?\n\nBug report ${candidate.bug.id}:\n<<<\n${shown}\n>>>`,
              maxTokens: 300,
            },
            this.deps.llmTimeoutMs ?? SUB_LIMIT_LLM_TIMEOUT_MS,
          );
        } catch (error) {
          // Unavailable: every other reference waits too, and this ask isn't counted. Another failure (a timeout)
          // counts towards skipping this reference.
          if (error instanceof LlmUnavailable) {
            llmDown = true;
            waiting++;
          } else failed(key);
          continue;
        }
        const parsed = parseAnswer(answer, shown);
        if (parsed === 'unusable') {
          failed(key);
          continue;
        }
        const { quote } = parsed;
        if (quote === null) {
          answered.add(key);
          newlyAnswered.push(key);
          continue;
        }
        evidence = `${candidate.bug.id}: "${quote}"`;
      } else {
        evidence = candidate.evidence;
      }
      // The line count is evidence only (the step is fixed): read it from the merge commit when the verdict has
      // none, and record the outcome without one when that fails.
      let changedLines = candidate.changedLines;
      if (changedLines === null && candidate.kind !== 'merged_unchanged') {
        if (!fetched.has(candidate.mergeSha))
          fetched.set(candidate.mergeSha, await this.changedLines(board, candidate.mergeSha));
        changedLines = fetched.get(candidate.mergeSha) ?? null;
      }
      const change = await this.record(
        board.id,
        outcome,
        candidate.globId,
        changedLines,
        evidence,
        now,
      );
      if (outcome === 'needed_fixes') blamed.add(candidate.globId);
      if (change === null) continue;
      recorded.add(outcomeKey(candidate.globId, outcome));
      changes.push(change);
      limit = change.to;
    }
    const settled = (key: string) => blamed.has(key.slice(0, key.indexOf(':')));
    if (
      newlyAnswered.length > 0 ||
      failedAsks.size > 0 ||
      Object.keys(read.memory.attempts).some(settled)
    ) {
      await this.deps.store.transaction(async (tx) => {
        await tx.lockBoardJob(boardId, 'sub_limit');
        const stored = memoryOf(await tx.getBoardJobState(boardId, 'sub_limit'));
        const merged = [...new Set([...stored.answered, ...newlyAnswered])].slice(
          -MAX_REMEMBERED_ANSWERS,
        );
        const remembered = new Set(merged);
        const attempts = Object.entries({ ...stored.attempts, ...Object.fromEntries(failedAsks) })
          .filter(([key]) => !remembered.has(key) && !settled(key))
          .slice(-MAX_REMEMBERED_ANSWERS);
        await tx.setBoardJobState(boardId, 'sub_limit', {
          answered: merged,
          attempts: Object.fromEntries(attempts),
        } satisfies SubLimitMemory);
      });
    }
    if (changes.some((c) => c.from !== c.to))
      this.deps.notifier.publish({ kind: 'board.changed', boardId });
    return {
      kind: 'sub_limit',
      limit,
      changes,
      asked,
      waiting,
      ...(gaveUp > 0 ? { gaveUp } : {}),
    };
  }

  /** The board's limit and its history, for members (board settings). */
  async view(email: string, boardId: number): Promise<Result<SubLimitView>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${boardId}`);
      return ok({
        current: board.subMaxChangedLines,
        bounds: { min: SUB_LIMIT_MIN, max: SUB_LIMIT_MAX, step: SUB_LIMIT_STEP },
        history: await tx.listSubLimitChanges(boardId),
      });
    });
  }

  /** A passed sub's line count from its merge commit, when its gate verdict didn't record one. Null when unknown. */
  private async changedLines(board: Board, sha: string): Promise<number | null> {
    if (this.deps.diffs === null || sha === '') return null;
    try {
      return await this.deps.diffs.mergedChangedLines(board, sha);
    } catch {
      // The code host failed (logged by the adapter): the outcome is recorded without a count.
      return null;
    }
  }

  /**
   * Records one outcome and moves the limit, in one transaction under the board's sub-limit lock: the limit is read
   * again there, so a concurrent run (Run now) waits and then sees the outcome recorded. Null when it already was.
   */
  private async record(
    boardId: number,
    outcome: SubLimitOutcome,
    globId: string,
    changedLines: number | null,
    evidence: string,
    now: string,
  ): Promise<SubLimitResult['changes'][number] | null> {
    try {
      return await this.deps.store.transaction(async (tx) => {
        await tx.lockBoardJob(boardId, 'sub_limit');
        const board = await tx.getBoard(boardId);
        if (board === null) return null;
        const from = board.subMaxChangedLines;
        const to = nextLimit(outcome, from);
        const inserted = await tx.insertSubLimitChange({
          boardId,
          at: now,
          fromLines: from,
          toLines: to,
          outcome,
          globId,
          changedLines,
          evidence,
        });
        if (!inserted) return null;
        if (to !== from && !(await tx.setSubLimit(boardId, from, to)))
          throw new SubLimitConflict(boardId);
        return { globId, outcome, from, to };
      });
    } catch (error) {
      if (error instanceof SubLimitConflict) return null;
      throw error;
    }
  }
}
