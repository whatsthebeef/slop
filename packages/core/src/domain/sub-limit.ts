import type { DomainEvent, JsonValue } from './events.js';
import type { Glob } from './types.js';

/**
 * The learned sub size limit (spec, Sub review): subs changing more lines than the board's limit convert to sames,
 * and slop moves the limit with outcomes. A sub converted for its size that merged unchanged raises it; a sub that
 * passed the gate and needed fixes after merging lowers it. Each move is a fixed step of 250, within the bounds;
 * the sub's changed lines are recorded as evidence but don't size the step.
 */
export const SUB_LIMIT_MIN = 200;
export const SUB_LIMIT_MAX = 5000;
export const SUB_LIMIT_STEP = 250;
/** How long after a sub's merge a needed fix (a sign-off label asking for changes, a bug blaming it) counts. */
export const SUB_LIMIT_WINDOW_DAYS = 14;

export const SUB_LIMIT_OUTCOMES = ['merged_unchanged', 'needed_fixes'] as const;
export type SubLimitOutcome = (typeof SUB_LIMIT_OUTCOMES)[number];

/** Why the gate converted a sub: its size, or a sensitive path. Null when it passed. */
export type SubGateCause = 'size' | 'sensitive';

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
}

export type NewSubLimitChange = Omit<SubLimitChange, 'id'>;

/** The board's limit, its bounds and its history (newest first), for board settings. */
export interface SubLimitView {
  readonly current: number;
  readonly bounds: { readonly min: number; readonly max: number; readonly step: number };
  readonly history: readonly SubLimitChange[];
}

/**
 * A sub converted for its size merged unchanged: `min(5000, L + 250)`. Never lowers a limit set above the bounds
 * before the limit was learned.
 */
export const raisedLimit = (limit: number): number =>
  Math.max(limit, Math.min(SUB_LIMIT_MAX, limit + SUB_LIMIT_STEP));

/**
 * A sub that passed the gate needed fixes: `max(200, L − 250)`. Never raises a limit set below the bounds.
 */
export const loweredLimit = (limit: number): number =>
  Math.min(limit, Math.max(SUB_LIMIT_MIN, limit - SUB_LIMIT_STEP));

export const nextLimit = (outcome: SubLimitOutcome, limit: number): number =>
  outcome === 'merged_unchanged' ? raisedLimit(limit) : loweredLimit(limit);

/** The gate's reason for a size conversion; events recorded before `changedLines` and `cause` carry only this. */
const SIZE_REASON = /Changes (\d+) lines \(limit (\d+)\)/;

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
    data.cause === 'size' || data.cause === 'sensitive'
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
      readonly bug: { readonly id: string; readonly title: string; readonly summary: string };
    };

export interface SubLimitFacts {
  /** The board's `SUB_LIMIT_EVENT_TYPES` events, oldest first, from well before `mergedSince` (gates precede merges). */
  readonly events: readonly DomainEvent[];
  /** The board's globs: the subs and any bugs naming them. */
  readonly globs: readonly Glob[];
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
 * - passed, and a bug created within the window names it in its title or summary: a `bug_reference`, which counts only
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
    .filter((g) => g.category === 'bug')
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
      if (!namesGlob(`${bug.title}\n${bug.summary}`, globId)) continue;
      candidates.push({
        kind: 'bug_reference',
        globId,
        title: glob?.title ?? globId,
        at: bug.createdAt,
        changedLines: gate.changedLines,
        mergeSha,
        bug: { id: bug.id, title: bug.title, summary: bug.summary },
      });
    }
  }
  return candidates.sort((a, b) => a.at.localeCompare(b.at) || a.globId.localeCompare(b.globId));
};

/** A bug's text as the model sees it and its quote is checked against. */
export const bugText = (bug: { readonly title: string; readonly summary: string }): string =>
  `${bug.title}\n\n${bug.summary}`;
