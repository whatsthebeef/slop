import type { DomainEvent, JsonValue } from './events.js';
import { fixOf, type Glob } from './types.js';

/**
 * The learned sub size limit (spec, Sub review): subs changing more lines than the board's limit convert to sames,
 * and slop moves the limit with outcomes. A sub converted for its size that merged unchanged raises it; a sub that
 * passed the gate and needed fixes after merging lowers it. The move is a step (500 to start) that grows x1.5 while
 * outcomes keep the same direction and halves on a reversal, scaled by how far the sub was from the limit and by how
 * recent the outcome is, within the bounds. A small sub that needed fixes says nothing about the size: it is a signal
 * for the board's risk areas instead.
 */
/**
 * A new board's limit, and the default of `boards.sub_max_changed_lines`. The limit is only a high backstop: the agents
 * escalate a sub to a same by judgement (`escalate_to_same`), and the gate converts one that is far larger than usual.
 */
export const SUB_LIMIT_DEFAULT = 5000;
export const SUB_LIMIT_MIN = 200;
export const SUB_LIMIT_MAX = 10_000;
/** The step a board starts with, and the default of `boards.sub_limit_step`. */
export const SUB_LIMIT_STEP = 500;
export const SUB_LIMIT_STEP_MIN = 100;
export const SUB_LIMIT_STEP_MAX = 2000;
/** The step grows by this factor after an outcome in the same direction as the last move, and shrinks by the other after a reversal. */
export const SUB_LIMIT_STEP_GROWTH = 1.5;
export const SUB_LIMIT_STEP_SHRINK = 0.5;
/** A move is rounded to this many lines. */
const MOVE_ROUNDING = 50;
/** The most a move is scaled up by how far the sub was from the limit. */
const MAX_DISTANCE_WEIGHT = 3;
/** The most a lowering is scaled up by how large the sub was. */
const MAX_LOWER_WEIGHT = 2;
/** One lowering takes at most this share of the limit. */
const MAX_LOWER_SHARE = 0.5;
/** The least an outcome older than the window counts. */
const MIN_RECENCY = 0.5;
/** A sub that needed fixes lowers the limit only when it changed at least this share of it; a smaller one says nothing about it. */
export const SUB_LIMIT_NEAR_SHARE = 0.5;
/** How long after a sub's merge a needed fix (a sign-off label asking for changes, a bug blaming it) counts. */
export const SUB_LIMIT_WINDOW_DAYS = 14;

export const SUB_LIMIT_OUTCOMES = ['merged_unchanged', 'needed_fixes'] as const;
export type SubLimitOutcome = (typeof SUB_LIMIT_OUTCOMES)[number];

/**
 * Why the gate converted a sub: its size, a sensitive path or a risk path. Null when it passed. Only `size` says anything
 * about the limit: the other two are rules about the paths, whatever the size.
 */
export type SubGateCause = 'size' | 'sensitive' | 'risk_path';

/** One outcome the learning recorded, with the limit before and after it (equal when the rule left it). */
export interface SubLimitChange {
  readonly id: number;
  readonly boardId: number;
  readonly at: string;
  readonly fromLines: number;
  readonly toLines: number;
  readonly outcome: SubLimitOutcome;
  /** The sub whose outcome it was. */
  readonly globId: string;
  /** The lines the sub changed; null when neither its gate verdict nor its merge commit gave a count. */
  readonly changedLines: number | null;
  /** Why, as plain text: the conversion and merge, the label's checklist item, or the bug's verified quote. */
  readonly evidence: string;
  /** The step the move used before weighting (`boards.sub_limit_step` after it); rows before steps were learned carry 250. */
  readonly step: number;
}

export type NewSubLimitChange = Omit<SubLimitChange, 'id'>;

/** The board's limit, its bounds and its history (newest first), for the Knowledge page's "What slop has learned". */
export interface SubLimitView {
  readonly current: number;
  /** `step` is the board's current step; `startStep` the one a board starts with. */
  readonly bounds: { readonly min: number; readonly max: number; readonly step: number; readonly startStep: number };
  readonly history: readonly SubLimitChange[];
}

const roundMove = (lines: number): number => Math.max(MOVE_ROUNDING, Math.round(lines / MOVE_ROUNDING) * MOVE_ROUNDING);

/**
 * A sub converted for its size merged unchanged: `min(10000, L + step)`. Never lowers a limit set above the bounds
 * before the limit was learned.
 */
export const raisedLimit = (limit: number, step: number = SUB_LIMIT_STEP): number =>
  Math.max(limit, Math.min(SUB_LIMIT_MAX, limit + step));

/**
 * A sub that passed the gate needed fixes: `max(200, L - step)`. Never raises a limit set below the bounds.
 */
export const loweredLimit = (limit: number, step: number = SUB_LIMIT_STEP): number =>
  Math.min(limit, Math.max(SUB_LIMIT_MIN, limit - step));

/** Whether a sub of `changedLines` was near `limit`: at least `SUB_LIMIT_NEAR_SHARE` of it. Unknown size isn't near. */
export const nearLimit = (changedLines: number | null, limit: number): boolean =>
  changedLines !== null && changedLines >= limit * SUB_LIMIT_NEAR_SHARE;

/** The limit after an outcome with the default step: a raise always, a lowering only for a sub near the limit. */
export const nextLimit = (outcome: SubLimitOutcome, limit: number, changedLines: number | null): number =>
  outcome === 'merged_unchanged' ? raisedLimit(limit) : nearLimit(changedLines, limit) ? loweredLimit(limit) : limit;

export type SubLimitDirection = 'raise' | 'lower';

/** A change row's direction: a recorded raise, or a lowering that moved the limit; null for a row that left it alone. */
export const directionOf = (change: Pick<SubLimitChange, 'outcome' | 'fromLines' | 'toLines'>): SubLimitDirection | null =>
  change.outcome === 'merged_unchanged' ? 'raise' : change.toLines < change.fromLines ? 'lower' : null;

/**
 * The step for the next move in `direction`: the board's step, grown x1.5 (cap 2000) when the last move had the same
 * direction and halved (floor 100) when it was the opposite one. With no earlier move it is the board's step as it is.
 * `history` is newest first.
 */
export const nextStep = (boardStep: number, history: readonly SubLimitChange[], direction: SubLimitDirection): number => {
  const last = history.map(directionOf).find((d) => d !== null) ?? null;
  if (last === null) return boardStep;
  return last === direction
    ? Math.min(SUB_LIMIT_STEP_MAX, Math.round(boardStep * SUB_LIMIT_STEP_GROWTH))
    : Math.max(SUB_LIMIT_STEP_MIN, Math.round(boardStep * SUB_LIMIT_STEP_SHRINK));
};

const DAY = 24 * 60 * 60 * 1000;

/** How much an outcome of `outcomeAt` still counts at `now`: fully within the window, then linearly down to half. */
export const recencyFactor = (outcomeAt: string, now: string): number => {
  const late = (Date.parse(now) - Date.parse(outcomeAt)) / DAY - SUB_LIMIT_WINDOW_DAYS;
  return Number.isFinite(late) && late > 0 ? Math.max(MIN_RECENCY, 1 - (late / SUB_LIMIT_WINDOW_DAYS) * (1 - MIN_RECENCY)) : 1;
};

/** How far off the sub was: a raise scales with its lines against the limit (up to 3), a lowering with its share of the limit (1 at the near share, up to 2 at the limit). */
export const distanceWeight = (direction: SubLimitDirection, changedLines: number | null, limit: number): number => {
  if (changedLines === null || limit <= 0) return 1;
  const share = changedLines / limit;
  return direction === 'raise'
    ? Math.min(MAX_DISTANCE_WEIGHT, Math.max(1, share))
    : Math.min(MAX_LOWER_WEIGHT, Math.max(1, share / SUB_LIMIT_NEAR_SHARE));
};

export interface SubLimitMove {
  readonly from: number;
  readonly to: number;
  /** The step used before weighting: the board's step after the move. */
  readonly step: number;
  readonly direction: SubLimitDirection | null;
  /** A sub that needed fixes while well under the limit: no size signal, a risk-area one. */
  readonly riskSignal: boolean;
}

/**
 * The move an outcome makes (pure). A raise for a sub merged unchanged, a lowering for a sub near the limit that needed
 * fixes, otherwise none: a sub of known size under `SUB_LIMIT_NEAR_SHARE` of the limit gives a risk-area signal.
 */
export const subLimitMove = (input: {
  readonly outcome: SubLimitOutcome;
  readonly limit: number;
  readonly changedLines: number | null;
  readonly boardStep: number;
  /** The board's recorded outcomes, newest first. */
  readonly history: readonly SubLimitChange[];
  /** When the outcome happened, and now. */
  readonly outcomeAt: string;
  readonly now: string;
}): SubLimitMove => {
  const { limit, changedLines } = input;
  const direction: SubLimitDirection | null =
    input.outcome === 'merged_unchanged' ? 'raise' : nearLimit(changedLines, limit) ? 'lower' : null;
  if (direction === null)
    return { from: limit, to: limit, step: input.boardStep, direction, riskSignal: changedLines !== null };
  const step = nextStep(input.boardStep, input.history, direction);
  const weighted = roundMove(step * distanceWeight(direction, changedLines, limit) * recencyFactor(input.outcomeAt, input.now));
  // One outcome never takes more than half the limit away.
  const move = direction === 'lower' ? Math.min(weighted, Math.max(MOVE_ROUNDING, Math.floor((limit * MAX_LOWER_SHARE) / MOVE_ROUNDING) * MOVE_ROUNDING)) : weighted;
  return {
    from: limit,
    to: direction === 'raise' ? raisedLimit(limit, move) : loweredLimit(limit, move),
    step,
    direction,
    riskSignal: false,
  };
};

/** The gate's reason for a size conversion; events recorded before `changedLines` and `cause` carry only this. */
const SIZE_REASON = /Changes (\d+) lines(?:, not counting [\d,]+ generated)? \(limit (\d+)\)/;

/** A `SubReviewCompleted` event's verdict, from its fields or (older events) its reason. */
export interface GateVerdict {
  readonly globId: string;
  readonly at: string;
  readonly sha: string;
  readonly passed: boolean;
  readonly cause: SubGateCause | null;
  /** Null for a passed sub recorded before line counts were. */
  readonly changedLines: number | null;
  readonly limit: number | null;
}

const numberOf = (value: JsonValue | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const stringOf = (value: JsonValue | undefined): string | null =>
  typeof value === 'string' ? value : null;

export const gateVerdictOf = (event: DomainEvent): GateVerdict => {
  const { data } = event;
  const passed = data.passed === true;
  const reason = stringOf(data.reason);
  const sized = reason === null ? null : SIZE_REASON.exec(reason);
  const cause: SubGateCause | null =
    data.cause === 'size' || data.cause === 'sensitive' || data.cause === 'risk_path'
      ? data.cause
      : passed
        ? null
        : sized !== null
          ? 'size'
          : 'sensitive';
  return {
    globId: event.globId,
    at: event.at,
    sha: stringOf(data.sha) ?? '',
    passed,
    cause,
    changedLines: numberOf(data.changedLines) ?? (sized === null ? null : Number(sized[1])),
    limit: numberOf(data.limit) ?? (sized === null ? null : Number(sized[2])),
  };
};

/** The events the learning reads. */
export const SUB_LIMIT_EVENT_TYPES = [
  'SubReviewCompleted',
  'Merged',
  'CommitPushed',
  'LabelChanged',
] as const;

/** An outcome to record, or a bug to ask the model about first. */
export type SubLimitCandidate =
  | {
      readonly kind: 'merged_unchanged';
      readonly globId: string;
      /** When the outcome happened: the merge. */
      readonly at: string;
      readonly changedLines: number;
      readonly evidence: string;
    }
  | {
      readonly kind: 'needed_fixes';
      readonly globId: string;
      /** When the label asked for changes. */
      readonly at: string;
      readonly changedLines: number | null;
      readonly mergeSha: string;
      readonly evidence: string;
    }
  | {
      readonly kind: 'bug_reference';
      readonly globId: string;
      readonly title: string;
      /** When the bug was created. */
      readonly at: string;
      readonly changedLines: number | null;
      readonly mergeSha: string;
      readonly bug: { readonly id: string; readonly title: string; readonly plan: string };
    };

export interface SubLimitFacts {
  /** The board's `SUB_LIMIT_EVENT_TYPES` events, oldest first, from well before `mergedSince` (gates precede merges). */
  readonly events: readonly DomainEvent[];
  /** The board's globs: the subs and any bugs naming them. */
  readonly globs: readonly Glob[];
  /** The bugs' plan.md text by glob ID: what a bug says beyond its title. */
  readonly plans: ReadonlyMap<string, string>;
  /** Outcomes already recorded, as `outcomeKey`s: each sub's outcome is learned from once. */
  readonly recorded: ReadonlySet<string>;
  /** Only subs merged at or after this are considered. */
  readonly mergedSince: string;
  readonly now: string;
}

export const outcomeKey = (globId: string, outcome: SubLimitOutcome): string =>
  `${globId}:${outcome}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const windowEnd = (mergedAt: string): number =>
  Date.parse(mergedAt) + SUB_LIMIT_WINDOW_DAYS * DAY_MS;

/** Whether `text` names glob `id` as a whole ID (s15t1 isn't named by "s15t10"). */
export const namesGlob = (text: string, id: string): boolean =>
  new RegExp(`(^|[^a-z0-9])${id.replace(/[^a-z0-9]/gi, '')}($|[^a-z0-9])`, 'i').test(text);

const short = (sha: string): string => sha.slice(0, 7);

/** A label's move to `added` (a reviewer asked for changes), with its first checklist item. */
const labelAdded = (event: DomainEvent): string | null => {
  if (event.type !== 'LabelChanged' || event.data.to !== 'added') return null;
  const label = stringOf(event.data.label) ?? 'A sign-off label';
  const items = Array.isArray(event.data.items) ? event.data.items : [];
  const first = items.find((i): i is string => typeof i === 'string' && i.trim() !== '');
  return first === undefined
    ? `${label} review asked for changes`
    : `${label} review asked for changes: "${first.trim()}"`;
};

/**
 * The outcomes the board's recent subs show, oldest first (pure). For each sub merged since `mergedSince`, through
 * the gate verdict it merged on:
 * - converted for its size, then merged with no commit after the conversion (pushes from superseded runs aside) and no
 *   sign-off label moved to `added`, once it is signed off or its window has passed: `merged_unchanged`;
 * - passed, and within the window after its merge a sign-off label moved to `added`: `needed_fixes`;
 * - passed, and a bug created within the window names it in its title or plan.md: a `bug_reference`, which counts only
 *   when the model confirms it with a verified quote (the service asks). A sub with a label outcome isn't asked about.
 */
export const subLimitCandidates = (facts: SubLimitFacts): SubLimitCandidate[] => {
  const now = Date.parse(facts.now);
  const byGlob = new Map<string, DomainEvent[]>();
  for (const e of facts.events) {
    const list = byGlob.get(e.globId);
    if (list === undefined) byGlob.set(e.globId, [e]);
    else list.push(e);
  }
  const globs = new Map(facts.globs.map((g) => [g.id, g]));
  const bugs = facts.globs
    .filter((g) => fixOf(g))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const candidates: SubLimitCandidate[] = [];
  for (const [globId, events] of byGlob) {
    // The first merge after a gate verdict; the verdict it merged on is the last one before it (a failed merge sends
    // a sub back through the gate). Events are oldest first, so one scan finds both.
    let gateEvent: DomainEvent | undefined;
    let merge: DomainEvent | undefined;
    for (const e of events) {
      if (e.type === 'SubReviewCompleted') gateEvent = e;
      else if (e.type === 'Merged' && gateEvent !== undefined) {
        merge = e;
        break;
      }
    }
    if (merge === undefined || gateEvent === undefined || merge.at < facts.mergedSince) continue;
    const mergedAt = merge.at;
    const gate = gateVerdictOf(gateEvent);
    const mergeSha = stringOf(merge.data.sha) ?? '';
    const glob = globs.get(globId);
    if (!gate.passed) {
      if (
        gate.cause !== 'size' ||
        gate.changedLines === null ||
        facts.recorded.has(outcomeKey(globId, 'merged_unchanged'))
      )
        continue;
      const pushed = events.some(
        (e) =>
          e.type === 'CommitPushed' &&
          e.at > gate.at &&
          e.at <= mergedAt &&
          e.data.sha !== gate.sha &&
          e.data.fromSupersededRun !== true,
      );
      const changesAsked = events.some((e) => e.at > gate.at && labelAdded(e) !== null);
      if (pushed || changesAsked) continue;
      // Merged unchanged means its review passed too: decided once it is signed off, or when the window has passed.
      if (glob?.status !== 'signed_off' && now < windowEnd(mergedAt)) continue;
      candidates.push({
        kind: 'merged_unchanged',
        globId,
        at: mergedAt,
        changedLines: gate.changedLines,
        evidence: `Converted at ${short(gate.sha)} for changing ${gate.changedLines} lines (limit ${gate.limit ?? 'unknown'}), then merged as ${short(mergeSha)} with no further commits and no changes asked in review`,
      });
      continue;
    }
    if (facts.recorded.has(outcomeKey(globId, 'needed_fixes'))) continue;
    const end = windowEnd(mergedAt);
    const label = events.find(
      (e) => e.at > mergedAt && Date.parse(e.at) <= end && labelAdded(e) !== null,
    );
    if (label !== undefined) {
      candidates.push({
        kind: 'needed_fixes',
        globId,
        at: label.at,
        changedLines: gate.changedLines,
        mergeSha,
        evidence: labelAdded(label) ?? '',
      });
      continue;
    }
    for (const bug of bugs) {
      if (bug.id === globId || bug.createdAt <= mergedAt || Date.parse(bug.createdAt) > end)
        continue;
      const plan = facts.plans.get(bug.id) ?? '';
      if (!namesGlob(`${bug.title}\n${plan}`, globId)) continue;
      candidates.push({
        kind: 'bug_reference',
        globId,
        title: glob?.title ?? globId,
        at: bug.createdAt,
        changedLines: gate.changedLines,
        mergeSha,
        bug: { id: bug.id, title: bug.title, plan },
      });
    }
  }
  return candidates.sort((a, b) => a.at.localeCompare(b.at) || a.globId.localeCompare(b.globId));
};

/** A bug's text as the model sees it and its quote is checked against. */
export const bugText = (bug: { readonly title: string; readonly plan: string }): string => `${bug.title}\n\n${bug.plan}`;
