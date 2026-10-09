import { forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import type { BoardJobResult } from '../domain/signals.js';
import {
  SIZE_BOUNDS,
  SIZE_EVENT_TYPES,
  buildProposal,
  estimateFromText,
  evidenceOf,
  nextThreshold,
  oversizedReasons,
  prHoursOf,
  prRangeOf,
  sizeOutcomeOf,
  splitAfterStartOf,
  withModelParts,
} from '../domain/size-check.js';
import type { ModelPart, SizeCheck, SizeOutcome, SizeProposal, SizeThreshold, SizeThresholdView } from '../domain/size-check.js';
import type { Clock, Notifier, Store } from '../ports.js';
import { memberOf } from './access.js';
import type { Llm } from './intake-service.js';
import { completeWithDeadline } from './llm-call.js';
import { field, list, parseJson, text } from './llm-json.js';
import { hash } from './text-hash.js';

export type SizeThresholdResult = Extract<BoardJobResult, { kind: 'size_threshold' }>;

const EPOCH = '1970-01-01T00:00:00.000Z';
/** The size judgement and the proposal each get this long: a slow model must not hold up creating a glob. */
export const SIZE_LLM_TIMEOUT_MS = 20_000;
/** Plans shorter than this are not worth a model call. */
const MIN_JUDGED_CHARS = 200;
const MAX_PLAN_CHARS = 30_000;

/** What an assessment decides; the glob's check is this plus its decision and dates. */
export type SizeAssessment = Pick<SizeCheck, 'planHash' | 'estimate' | 'evidence' | 'threshold' | 'flagged' | 'reasons' | 'proposal'>;

/** What `GlobService` and `ArtifactService` need: assess a plan before creating a glob, and refresh a glob's check after a plan save. */
export interface SizeAssessor {
  assess(boardId: number, plan: string): Promise<SizeAssessment>;
  /** Re-assesses a glob in Planning after its plan.md changed. Never throws. */
  refresh(globId: string): Promise<void>;
}

/** The glob's check from an assessment, keeping what a person decided and when it was first made. */
export const checkFrom = (globId: string, boardId: number, assessment: SizeAssessment, previous: SizeCheck | null, now: string): SizeCheck => ({
  globId,
  boardId,
  ...assessment,
  decision: previous?.decision ?? null,
  decidedBy: previous?.decidedBy ?? null,
  decidedAt: previous?.decidedAt ?? null,
  createdAt: previous?.createdAt ?? now,
  updatedAt: now,
});

const JUDGE_SYSTEM = `You judge whether the plan of a piece of software work is one pull request's worth of work.
Count its independent parts: pieces that could be built, reviewed and merged on their own. A schema migration and the server code that uses it are one part; a separate screen, a separate integration or a separate migration's worth of work is another.
Answer with JSON only: {"independentParts": a whole number, at least 1, "reason": "one short sentence"}.`;

const PROPOSE_SYSTEM = `You split a plan that is too big for one pull request into parts that can each be built and merged on their own.
Answer with JSON only: {"parts": [{"title": "...", "summary": "one or two sentences", "plan": "...", "after": [0]}]}.
- 2 to 6 parts, in the order they should be built. Part 0 stays the original task.
- "plan" is the part's share of the original plan, copied verbatim (keep the goal and any context it needs): every task goes to exactly one part, and a section with no task of its own is a part of its own.
- "after" lists the earlier parts (their index) this one must wait for, only where it needs their code, changes the same files or needs a migration; otherwise leave it empty so parts run in parallel.`;

const intOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The model's proposed parts from its answer; empty when it gave no usable ones. */
export const parseParts = (answer: string): ModelPart[] =>
  list(field(parseJson(answer), 'parts')).flatMap((p) => {
    const title = text(field(p, 'title'));
    const plan = text(field(p, 'plan'));
    if (title === null || plan === null) return [];
    return [
      {
        title,
        summary: text(field(p, 'summary')) ?? '',
        plan,
        after: list(field(p, 'after')).flatMap((n) => {
          const found = intOf(n);
          return found === null ? [] : [found];
        }),
      },
    ];
  });

/**
 * The learned size check (spec, Intake). `assess` judges a plan against the board's threshold: the estimate from the plan's
 * text, with the model's count of independent parts when the model answers, and for a flagged plan a proposed split. A
 * model that fails or is unavailable leaves the text estimate: creating a glob never waits on it. Hourly, `learn` moves the
 * threshold with the outcomes of merged globs (the `size_threshold` board job).
 */
export class SizeCheckService implements SizeAssessor {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      /** The intake model; absent: estimates come from the text alone. */
      llm?: Llm;
      llmTimeoutMs?: number;
    },
  ) {}

  async assess(boardId: number, plan: string): Promise<SizeAssessment> {
    const threshold = await this.deps.store.transaction((tx) => tx.getSizeThreshold(boardId));
    let estimate = estimateFromText(plan);
    if (this.deps.llm !== undefined && plan.trim().length >= MIN_JUDGED_CHARS) {
      try {
        const answer = await completeWithDeadline(
          this.deps.llm,
          { system: JUDGE_SYSTEM, prompt: `Plan:\n<<<\n${plan.slice(0, MAX_PLAN_CHARS)}\n>>>`, maxTokens: 300 },
          this.deps.llmTimeoutMs ?? SIZE_LLM_TIMEOUT_MS,
        );
        const parsed = parseJson(answer);
        const parts = intOf(field(parsed, 'independentParts'));
        if (parts !== null && parts >= 1) estimate = withModelParts(estimate, parts, text(field(parsed, 'reason'))?.trim().slice(0, 300) ?? null);
      } catch {
        // Unavailable, slow or unusable: the text estimate stands.
      }
    }
    const reasons = oversizedReasons(estimate, threshold);
    return {
      planHash: hash(plan),
      estimate,
      evidence: evidenceOf(estimate),
      threshold,
      flagged: reasons.length > 0,
      reasons,
      proposal: reasons.length > 0 ? await this.propose(plan) : null,
    };
  }

  /** The model's split of a flagged plan; null when it is unavailable or gives fewer than 2 usable parts. */
  private async propose(plan: string): Promise<SizeProposal | null> {
    if (this.deps.llm === undefined) return null;
    try {
      const answer = await completeWithDeadline(
        this.deps.llm,
        { system: PROPOSE_SYSTEM, prompt: `Plan:\n<<<\n${plan.slice(0, MAX_PLAN_CHARS)}\n>>>`, maxTokens: 4000 },
        this.deps.llmTimeoutMs ?? SIZE_LLM_TIMEOUT_MS,
      );
      return buildProposal(plan, parseParts(answer));
    } catch {
      return null;
    }
  }

  async refresh(globId: string): Promise<void> {
    try {
      const read = await this.deps.store.transaction(async (tx) => {
        const glob = await tx.getGlob(globId);
        if (glob === null || glob.status !== 'planning') return null;
        const plan = (await tx.artifactVersions(globId, 'plan', '')).at(-1)?.content ?? glob.summary;
        return { boardId: glob.boardId, plan, previous: await tx.getSizeCheck(globId) };
      });
      if (read === null) return;
      // Same plan as the stored check: nothing to judge again.
      if (read.previous?.planHash === hash(read.plan)) return;
      const assessment = await this.assess(read.boardId, read.plan);
      const written = await this.deps.store.transaction(async (tx) => {
        const glob = await tx.getGlob(globId);
        if (glob === null || glob.status !== 'planning') return false;
        const latest = (await tx.artifactVersions(globId, 'plan', '')).at(-1)?.content ?? glob.summary;
        // The plan was saved again meanwhile: that save's own refresh writes.
        if (hash(latest) !== assessment.planHash) return false;
        await tx.updateSizeAssessment(checkFrom(globId, read.boardId, assessment, await tx.getSizeCheck(globId), this.deps.clock.now()));
        return true;
      });
      if (written) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: read.boardId, globId });
    } catch {
      // Best effort: the check made at creation stands.
    }
  }

  /**
   * Keep whole: a person decides a flagged glob stays one glob. Recorded as an outcome input (the learning reads it when
   * the glob merges). The caller releases a glob that was held for the flag.
   */
  async keepWhole(email: string, globId: string): Promise<Result<SizeCheck>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<SizeCheck>> => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      if (actor.value.role === 'qa' && glob.type !== 'sub') return forbidden('QA members can only decide subs');
      const check = await tx.getSizeCheck(globId);
      if (check === null || !check.flagged) return invalidInput(`${globId} is not flagged oversized`);
      if (glob.status !== 'planning') return invalidInput(`${globId} has started, so the flag can no longer be answered`);
      if (check.decision !== null) return ok(check);
      const now = this.deps.clock.now();
      const decided: SizeCheck = { ...check, decision: 'kept_whole', decidedBy: email, decidedAt: now, updatedAt: now };
      await tx.upsertSizeCheck(decided);
      return ok(decided);
    });
    if (result.ok) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: result.value.boardId, globId });
    return result;
  }

  /** The board's threshold, its bounds and its history, for members (board settings). */
  async view(email: string, boardId: number): Promise<Result<SizeThresholdView>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      return ok({ current: await tx.getSizeThreshold(boardId), bounds: SIZE_BOUNDS, history: await tx.listSizeThresholdChanges(boardId) });
    });
  }

  /**
   * One hourly run: the outcomes of merged globs that have a size check (their outcome final, 14 days after the merge),
   * each recorded once and moving the threshold by the rule in `size-check.ts`. Reads the outcomes the intake-outcome job
   * records (spec, Intake) and the glob's own events.
   */
  async learn(boardId: number): Promise<SizeThresholdResult> {
    const read = await this.deps.store.transaction(async (tx) => {
      const [outcomes, checks, globs, changes, events] = await Promise.all([
        tx.listGlobOutcomes(boardId),
        tx.listSizeChecks(boardId),
        tx.listGlobs(boardId, {}),
        tx.listSizeThresholdChanges(boardId),
        tx.listBoardEvents(boardId, EPOCH, SIZE_EVENT_TYPES),
      ]);
      return { outcomes, checks, globs, recorded: new Set(changes.map((c) => c.globId)), events };
    });
    const byGlob = new Map<string, DomainEvent[]>();
    for (const e of read.events) byGlob.set(e.globId, [...(byGlob.get(e.globId) ?? []), e]);
    const checks = new Map(read.checks.map((c) => [c.globId, c]));
    const categories = new Map(read.globs.map((g) => [g.id, g.category]));
    const range = prRangeOf(
      read.outcomes.flatMap((o) => {
        const hours = prHoursOf(byGlob.get(o.globId) ?? []);
        return hours === null ? [] : [hours];
      }),
    );
    const due = read.outcomes
      .filter((o) => o.final && checks.has(o.globId) && !read.recorded.has(o.globId) && categories.get(o.globId) !== 'bug')
      .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.globId.localeCompare(b.globId));
    const changes: SizeThresholdResult['changes'][number][] = [];
    for (const outcome of due) {
      const events = byGlob.get(outcome.globId) ?? [];
      const found = sizeOutcomeOf(
        {
          globId: outcome.globId,
          flagged: checks.get(outcome.globId)?.flagged === true,
          outcome,
          failedRuns: events.filter((e) => e.type === 'RunFailed').length,
          prHours: prHoursOf(events),
          split: events.some((e) => e.type === 'GlobSplit'),
          splitAfterStart: splitAfterStartOf(events),
        },
        range,
      );
      if (found === null) continue;
      const change = await this.record(boardId, found.outcome, outcome.globId, found.evidence);
      if (change !== null) changes.push(change);
    }
    if (changes.some((c) => c.from.maxTasks !== c.to.maxTasks || c.from.maxParts !== c.to.maxParts))
      this.deps.notifier.publish({ kind: 'board.changed', boardId });
    const threshold = await this.deps.store.transaction((tx) => tx.getSizeThreshold(boardId));
    return { kind: 'size_threshold', threshold, changes };
  }

  /** Records one outcome and moves the threshold in one transaction under the board's job lock. Null when already recorded. */
  private async record(boardId: number, outcome: SizeOutcome, globId: string, evidence: string): Promise<SizeThresholdResult['changes'][number] | null> {
    return this.deps.store.transaction(async (tx) => {
      await tx.lockBoardJob(boardId, 'size_threshold');
      const from: SizeThreshold = await tx.getSizeThreshold(boardId);
      const to = nextThreshold(outcome, from);
      const inserted = await tx.insertSizeThresholdChange({ boardId, at: this.deps.clock.now(), from, to, outcome, globId, evidence });
      if (!inserted) return null;
      const moved = to.maxTasks !== from.maxTasks || to.maxParts !== from.maxParts;
      // The lock makes a concurrent run wait, so a lost write is a bug, not a race to retry.
      if (moved && !(await tx.setSizeThreshold(boardId, from, to))) throw new Error(`Board ${boardId}'s size threshold changed during the learning run`);
      return { globId, outcome, from, to };
    });
  }
}
