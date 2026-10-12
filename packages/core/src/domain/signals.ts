import type { EffectState } from './effect-check.js';
import { isInvestigateEvent } from './events.js';
import type { DomainEvent, JsonValue } from './events.js';
import { CHOICE_DISCUSSION_MIN_RETURNS, CHOICE_MIN_GLOBS, CHOICE_MIN_RETURNS, CHOICE_USAGE_WINDOW_DAYS } from './choice-usage.js';
import type { ChoiceActivity } from './choice-usage.js';
import { REVIEW_GUIDE_AREA } from './code-review.js';
import { missingCoreAreas, MISSING_DOC_MIN_DAYS, MISSING_DOC_MIN_MERGED_GLOBS, MISSING_DOC_RERAISE_DAYS } from './core-docs.js';
import { FINDING_CLASS_DESCRIPTIONS } from './findings.js';
import { globIdInText } from './ids.js';
import { KNOWLEDGE_PAGE_FEEDBACK_DAYS, KNOWLEDGE_PAGE_FEEDBACK_MIN, KNOWLEDGE_PAGE_GUIDE_NAME } from './knowledge-page.js';
import type { KnowledgePageVerdict } from './knowledge-page.js';
import type { FindingClass, ReviewFinding } from './findings.js';
import type { LearningType } from './kb.js';
import { isFalsePositive } from './review-feedback.js';
import type { ReviewFeedback } from './review-feedback.js';
import type { ArtifactKind, Provenance } from './knowledge.js';
import type { SlopType, Status } from './types.js';
import type { SizeOutcome, SizeThreshold } from './size-check.js';
import type { SubLimitOutcome } from './sub-limit.js';

/**
 * Mined signals (spec, self-improvement: "Signals slop mines"): figures slop computes from its own
 * events, artifacts and review findings that say an agent instruction or a document is missing
 * something. Pure: the mining service builds a `BoardActivity` and turns crossed thresholds into
 * mined KB items; the effect check reuses `perGlob` to compare globs before and after a change.
 */

/** How far back the weekly mining run looks. */
export const SIGNAL_WINDOW_DAYS = 28;

export const SIGNAL_KINDS = [
  'finding',
  'plan_amended',
  'plan_edited_rerun',
  'review_cap',
  'tester_loops',
  'failure',
  'run_superseded',
  'sub_converted',
  'ci_after_local',
  'dependency',
  'review_false_positive',
  'missing_doc',
  'choice_in_use',
  'knowledge_page',
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * `affected` of `eligible` units (globs, or runs for run signals) and the rate between them;
 * `count` is how many occurrences there were (findings, failures, failed commits).
 */
export interface SignalFigures {
  readonly affected: number;
  readonly eligible: number;
  readonly rate: number;
  readonly count: number;
}

/** The signal a mined KB item was raised for, with the figures behind it (refreshed while the item is open). */
export interface KbSignal {
  readonly key: string;
  readonly kind: SignalKind;
  /** The agent whose instructions it points at; null for a missing document. */
  readonly agent: string | null;
  readonly label: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly figures: SignalFigures;
  /** The affected globs (at most `MAX_SIGNAL_GLOBS`). */
  readonly globIds: readonly string[];
  /** Quoted examples with their glob IDs (at most `MAX_SIGNAL_EXAMPLES`). */
  readonly examples: readonly string[];
  readonly measuredAt: string;
}

export const MAX_SIGNAL_GLOBS = 20;
export const MAX_SIGNAL_EXAMPLES = 5;

/** A board glob as the signals see it. */
export interface ActivityGlob {
  readonly id: string;
  readonly type: SlopType;
  readonly status: Status;
  readonly createdAt: string;
}

/** Artifact kinds whose content the signals read (rounds in local reviews, line changes in plans). */
export const ARTIFACT_KINDS_WITH_CONTENT: readonly ArtifactKind[] = ['local_review', 'implementation_plan'];

/** An artifact version without its content, except for `ARTIFACT_KINDS_WITH_CONTENT`. */
export interface ArtifactMeta {
  readonly id: number;
  readonly globId: string;
  readonly kind: ArtifactKind;
  readonly label: string;
  readonly version: number;
  readonly commitSha: string | null;
  readonly provenance: Provenance;
  readonly createdAt: string;
  readonly content: string | null;
}

/** The dependencies a merged glob's commit added to one manifest (fetched from the code host by the server). */
export interface ManifestChange {
  readonly globId: string;
  readonly sha: string;
  readonly path: string;
  readonly dependencies: readonly string[];
}

/** A merge to the base branch in the window: the commits whose manifests are checked. */
export interface MergedCommit {
  readonly globId: string;
  readonly sha: string;
}

/** Everything the signals read for one board and window. */
export interface BoardActivity {
  readonly window: { readonly from: string; readonly to: string };
  readonly globs: readonly ActivityGlob[];
  /** Events in the window, oldest first. */
  readonly events: readonly DomainEvent[];
  /** Artifact versions created in the window, oldest first. */
  readonly artifacts: readonly ArtifactMeta[];
  /** Review findings created in the window. */
  readonly findings: readonly ReviewFinding[];
  /** What people said about the independent reviewer's inline comments, created in the window. */
  readonly reviewFeedback: readonly ReviewFeedback[];
  /** Null when the manifests weren't fetched (no code host): the dependency signal isn't measured. */
  readonly manifestChanges: readonly ManifestChange[] | null;
  /** The board's documents, to tell whether a dependency is mentioned anywhere. */
  readonly documents: readonly { readonly name: string; readonly area?: string | null; readonly content: string }[];
  /** Submitted learnings' globs and agent-set versions (for `globAgentSetVersion`). */
  readonly learnings: readonly { readonly globIds: readonly string[]; readonly agentSetVersion: number | null }[];
  /** The window's end is `window.to`; absent (no way to read the documents' areas): `missing_doc` isn't measured. */
  readonly documentAreasKnown?: boolean;
  /** The board's choices with what usage recording counted over `CHOICE_USAGE_WINDOW_DAYS`; absent: `choice_in_use` isn't measured. */
  readonly choices?: readonly ChoiceActivity[];
  /** The knowledge page's Pin / Not key verdicts from the last `KNOWLEDGE_PAGE_FEEDBACK_DAYS` days; absent: `knowledge_page` isn't measured. */
  readonly knowledgePageFeedback?: readonly KnowledgePageVerdictActivity[];
}

/** One verdict on a decision, with what it has in common with others: the model's area for its entry, else the decision's scope. */
export interface KnowledgePageVerdictActivity {
  readonly globId: string;
  readonly title: string;
  readonly verdict: KnowledgePageVerdict;
  readonly at: string;
  /** The area of the page entry the decision is behind; null when none (the scope stands in). */
  readonly area: string | null;
  readonly scope: string;
}

/** One signal key's figures for a window, before the thresholds are applied. */
export interface Tally {
  readonly key: string;
  readonly label: string;
  /** Units counted for the rate: globs, or runs for run signals. */
  readonly eligible: number;
  readonly affected: number;
  readonly count: number;
  readonly affectedGlobs: ReadonlySet<string>;
  readonly examples: readonly string[];
  /** Words the statement adds for this key (e.g. which reviews found it). */
  readonly context?: string;
}

export interface Measurement {
  readonly key: string;
  readonly kind: SignalKind;
  readonly label: string;
  readonly figures: SignalFigures;
  readonly globIds: readonly string[];
  readonly examples: readonly string[];
  /** Whether the figures cross the signal's threshold. */
  readonly crosses: boolean;
  /** Words the statement adds for this key (`Tally.context`). */
  readonly context?: string;
}

export interface SignalDefinition {
  readonly kind: SignalKind;
  readonly agent: string | null;
  readonly type: LearningType;
  /** A hint for routing (the agent file or document it most likely belongs in). */
  readonly suggestedTarget: string | null;
  /** The threshold, described for the spec and the evidence. */
  readonly threshold: string;
  readonly measure: (activity: BoardActivity) => Measurement[];
  /** Whether one glob counts toward the key's rate, and whether it is affected (effect checks). */
  readonly perGlob: (activity: BoardActivity, globId: string, key: string) => { readonly eligible: boolean; readonly affected: boolean };
  readonly statement: (measurement: Measurement) => string;
  /** How long a rejected or suppressed item stays quiet before it may be raised again (default `SIGNAL_QUIET_MS`). */
  readonly quietMs?: number;
  /** How much its rate must grow to be raised again after that (default `SIGNAL_RERAISE_FACTOR`). */
  readonly reraiseFactor?: number;
  /** Raised once per key: never again whatever became of its item (a rejected one stays rejected). */
  readonly once?: boolean;
}

// ---------------------------------------------------------------------------
// Reading event data

const field = (event: DomainEvent, key: string): JsonValue | undefined => event.data[key];
const text = (event: DomainEvent, key: string): string | null => {
  const value = field(event, key);
  return typeof value === 'string' ? value : null;
};
const whole = (value: JsonValue | undefined): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

const rateOf = (affected: number, eligible: number): number =>
  eligible === 0 ? 0 : Math.round((affected / eligible) * 1000) / 1000;

const cut = (value: string, length: number): string => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

const add = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};

/** Whether two commit SHAs name the same commit; either may be a short SHA (at least 7 characters). */
export const sameCommit = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
};

/**
 * A failed `BuildCompleted` that s15t7's red-base rule marked inherited from the base branch (`inheritedFrom`):
 * the glob's own change didn't break it, so it isn't counted against local checks.
 */
export const inheritedFromBase = (event: DomainEvent): boolean => typeof field(event, 'inheritedFrom') === 'string';

/** Why a superseded run ended: recorded as `cause` from now on, inferred from its transaction's events for history. */
export const supersededCause = (ended: DomainEvent, events: readonly DomainEvent[]): string => {
  const recorded = text(ended, 'cause');
  if (recorded !== null) return recorded;
  // Events written by the same transition share its glob and time.
  const together = events.filter((e) => e.globId === ended.globId && e.at === ended.at && e !== ended);
  const pickedUp = together.find((e) => e.type === 'PickedUp');
  if (pickedUp !== undefined) return field(pickedUp, 'takeOver') === true ? 'take_over' : 'pick_up';
  if (together.some((e) => e.type === 'PRClosed')) return 'pr_closed';
  if (together.some((e) => e.type === 'GlobDeleted')) return 'deleted';
  // Starting again is the only other transition that ends a live run as superseded.
  return 'start_again';
};

/** Superseded causes the run signal counts: someone had to step in. */
const STEPPED_IN = new Set(['take_over', 'start_again']);

/**
 * A failure reason with its specifics removed, so the same failure on different globs gets the same
 * key: lower case, without URLs, IDs, SHAs or numbers, at most 80 characters.
 */
export const normaliseFailure = (reason: string): string =>
  reason
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, ' ')
    .replace(globIdInText(), ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();

/**
 * The highest review round a local review's headings name (`## Review (round 3)`), or 0. Only headings count:
 * prose such as "deferred to round 3" doesn't say how many rounds ran.
 */
export const reviewRounds = (content: string): number => {
  let max = 0;
  for (const match of content.matchAll(/^##.*\bround\s+(\d{1,2})\b/gim)) max = Math.max(max, Number(match[1]));
  return max;
};

/** Share of the larger version's lines that changed between two versions of a plan (non-blank lines, any order). */
export const lineChange = (before: string, after: string): number => {
  const lines = (content: string) =>
    content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  const a = lines(before);
  const b = lines(after);
  const larger = Math.max(a.length, b.length);
  if (larger === 0) return 0;
  const remaining = new Map<string, number>();
  for (const line of a) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let kept = 0;
  for (const line of b) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) {
      kept++;
      remaining.set(line, left - 1);
    }
  }
  return 1 - kept / larger;
};

/** `compute` once per activity: effect checks call `perGlob` for every glob and key of one activity. */
const memoised = <T extends object>(compute: (activity: BoardActivity) => T): ((activity: BoardActivity) => T) => {
  const cache = new WeakMap<BoardActivity, T>();
  return (activity) => {
    const cached = cache.get(activity);
    if (cached !== undefined) return cached;
    const value = compute(activity);
    cache.set(activity, value);
    return value;
  };
};

/** The activity's events and artifacts by glob, once per activity (`globAgentSetVersion` runs for every merged glob). */
const activityByGlob = memoised((activity: BoardActivity) => {
  const events = new Map<string, DomainEvent[]>();
  const artifacts = new Map<string, ArtifactMeta[]>();
  const add = <T>(map: Map<string, T[]>, globId: string, value: T) => {
    const list = map.get(globId);
    if (list === undefined) map.set(globId, [value]);
    else list.push(value);
  };
  for (const e of activity.events) add(events, e.globId, e);
  for (const a of activity.artifacts) add(artifacts, a.globId, a);
  return { events, artifacts };
});

/**
 * The agent-set version a glob ran with: its commits' `Slop-Agent-Set` trailer, else the highest version on
 * its artifacts, failures or learnings, else null (unknown: left out of agent-file effect windows).
 */
export const globAgentSetVersion = (activity: BoardActivity, globId: string): number | null => {
  const highest = (values: readonly (number | null)[]): number | null => {
    const known = values.filter((v): v is number => v !== null);
    return known.length === 0 ? null : Math.max(...known);
  };
  const { events: byGlob, artifacts } = activityByGlob(activity);
  const events = byGlob.get(globId) ?? [];
  const trailer = highest(events.filter((e) => e.type === 'CommitPushed').map((e) => whole(field(e, 'agentSetVersion'))));
  if (trailer !== null) return trailer;
  return highest([
    ...(artifacts.get(globId) ?? []).map((a) => a.provenance.agentSetVersion),
    ...events.filter((e) => e.type === 'RunFailed' || e.type === 'StatusChanged').map((e) => whole(field(e, 'agentSetVersion'))),
    ...activity.learnings.filter((l) => l.globIds.includes(globId)).map((l) => l.agentSetVersion),
  ]);
};

// ---------------------------------------------------------------------------
// The signals

const WINDOW_WORDS = 'in the last 4 weeks';

interface Spec {
  readonly kind: SignalKind;
  readonly agent: string | null;
  readonly type: LearningType;
  readonly suggestedTarget: string | null;
  readonly threshold: string;
  /** The globs that count toward a key's rate (for keyed signals, the same for every key). */
  readonly eligibleGlobs: (activity: BoardActivity) => ReadonlySet<string>;
  readonly tallies: (activity: BoardActivity) => Tally[];
  readonly crosses: (tally: Tally) => boolean;
  readonly statement: (measurement: Measurement) => string;
  readonly quietMs?: number;
  readonly reraiseFactor?: number;
  readonly once?: boolean;
}

const define = (spec: Spec): SignalDefinition => {
  const tallies = memoised(spec.tallies);
  const eligibleGlobs = memoised(spec.eligibleGlobs);
  return {
    kind: spec.kind,
    agent: spec.agent,
    type: spec.type,
    suggestedTarget: spec.suggestedTarget,
    threshold: spec.threshold,
    statement: spec.statement,
    ...(spec.quietMs !== undefined && { quietMs: spec.quietMs }),
    ...(spec.reraiseFactor !== undefined && { reraiseFactor: spec.reraiseFactor }),
    ...(spec.once === true && { once: true }),
    measure: (activity) =>
      tallies(activity).map((t) => ({
        key: t.key,
        kind: spec.kind,
        label: t.label,
        figures: { affected: t.affected, eligible: t.eligible, rate: rateOf(t.affected, t.eligible), count: t.count },
        globIds: [...t.affectedGlobs].sort().slice(0, MAX_SIGNAL_GLOBS),
        examples: t.examples.slice(0, MAX_SIGNAL_EXAMPLES),
        crosses: spec.crosses(t),
        ...(t.context !== undefined && { context: t.context }),
      })),
    perGlob: (activity, globId, key) => ({
      eligible: eligibleGlobs(activity).has(globId),
      affected: tallies(activity).find((t) => t.key === key)?.affectedGlobs.has(globId) ?? false,
    }),
  };
};

/** Globs counted per key: the key's affected globs, examples and occurrences. */
class Tallies {
  private readonly keys = new Map<string, { label: string; globs: Set<string>; examples: string[]; count: number }>();
  hit(key: string, label: string, globId: string, example: string | null, count = 1): void {
    const entry = this.keys.get(key) ?? { label, globs: new Set<string>(), examples: [], count: 0 };
    entry.globs.add(globId);
    entry.count += count;
    if (example !== null) entry.examples.push(example);
    this.keys.set(key, entry);
  }
  /** One tally per key over `eligible` units (globs unless given). */
  done(eligible: number): Tally[] {
    return [...this.keys.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, e]) => ({ key, label: e.label, eligible, affected: e.globs.size, count: e.count, affectedGlobs: e.globs, examples: e.examples }));
  }
}

/** Globs with a local review in the window (reviewed globs). */
const reviewedGlobs = (activity: BoardActivity): Set<string> =>
  new Set([
    ...activity.artifacts.filter((a) => a.kind === 'local_review').map((a) => a.globId),
    ...activity.findings.map((f) => f.globId),
  ]);

/** Classified findings that count: IN-SCOPE, with a class other than `other`. */
const counted = (f: ReviewFinding): f is ReviewFinding & { class: FindingClass } =>
  f.state === 'classified' && f.class !== null && f.class !== 'other' && f.severity === 'in_scope';

const classLabel = (c: FindingClass): string => FINDING_CLASS_DESCRIPTIONS[c];

const finding = define({
  kind: 'finding',
  agent: 'implementer',
  type: 'agent-behaviour',
  suggestedTarget: 'agents/implementer.md',
  threshold: 'at least 3 globs and 25% of reviewed globs',
  eligibleGlobs: (activity) => new Set([...reviewedGlobs(activity), ...activity.findings.map((f) => f.globId)]),
  tallies: (activity) => {
    const eligible = new Set([...reviewedGlobs(activity), ...activity.findings.map((f) => f.globId)]);
    const tallies = new Tallies();
    for (const f of activity.findings) {
      if (!counted(f)) continue;
      const key = `finding:${f.class}`;
      tallies.hit(key, classLabel(f.class), f.globId, `${f.globId}: ${cut(f.text, 160)}`);
    }
    return tallies.done(eligible.size);
  },
  crosses: (t) => t.affected >= 3 && rateOf(t.affected, t.eligible) >= 0.25,
  statement: (m) =>
    `Local reviews keep finding ${m.label} in the implementer's changes: ${String(m.figures.affected)} of ${String(m.figures.eligible)} reviewed globs ${WINDOW_WORDS}.`,
});

/** Globs with an implementation record in the window: the latest version of each. */
const recordedGlobs = (activity: BoardActivity): Map<string, ArtifactMeta[]> => {
  const records = new Map<string, ArtifactMeta[]>();
  for (const a of activity.artifacts) {
    if (a.kind === 'implementation_plan') add(records, a.globId, a);
  }
  return records;
};

/** The lines under a record's `## Deviations` heading, without blanks or "None". */
export const deviationLines = (record: string): string[] => {
  const section = /^##\s+Deviations[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(record)?.[1] ?? '';
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^[-*\s]*(none|nothing)\.?$/i.test(l));
};

const planAmended = define({
  kind: 'plan_amended',
  agent: 'investigator',
  type: 'agent-behaviour',
  suggestedTarget: 'agents/investigator.md',
  threshold: 'at least 3 globs and 25% of globs with a record (3 or more lines under its Deviations)',
  eligibleGlobs: (activity) => new Set(recordedGlobs(activity).keys()),
  tallies: (activity) => {
    const records = recordedGlobs(activity);
    const tallies = new Tallies();
    for (const [globId, versions] of records) {
      const last = versions.at(-1);
      if (last === undefined) continue;
      const deviations = deviationLines(last.content ?? '');
      if (deviations.length >= 3) {
        tallies.hit('plan_amended', 'implementation records with many deviations from the plan', globId, `${globId}: ${String(deviations.length)} lines of deviations`);
      }
    }
    return tallies.done(records.size);
  },
  crosses: (t) => t.affected >= 3 && rateOf(t.affected, t.eligible) >= 0.25,
  statement: (m) =>
    `Implementations keep deviating from the plan the investigator chose: ${String(m.figures.affected)} of ${String(m.figures.eligible)} globs with a record ${WINDOW_WORDS}.`,
});

/** plan.md v1 (written at creation or backfilled from the summary) is the baseline, not an edit. */
const isPlanBaseline = (e: DomainEvent): boolean => text(e, 'kind') === 'plan' && field(e, 'version') === 1;

/** Per glob: whether a run ended (failed or superseded) and was run again, and whether the plan was edited in between. */
const reruns = (activity: BoardActivity): Map<string, { edited: boolean; example: string | null }> => {
  const byGlob = new Map<string, DomainEvent[]>();
  for (const e of activity.events) add(byGlob, e.globId, e);
  const result = new Map<string, { edited: boolean; example: string | null }>();
  for (const [globId, events] of byGlob) {
    let ended = false;
    let edit: string | null = null;
    for (const e of events) {
      // An investigate-only run is not an attempt at the glob.
      if (isInvestigateEvent(e)) continue;
      const endsRun = (e.type === 'RunFailed' && field(e, 'ignored') !== true) || (e.type === 'RunEnded' && text(e, 'outcome') === 'superseded');
      if (endsRun) {
        ended = true;
        edit = null;
      } else if (ended && e.type === 'FieldsChanged' && field(e, 'summary') !== undefined) {
        edit ??= 'the plan summary';
      } else if (ended && e.type === 'ArtifactAdded' && !isPlanBaseline(e) && (text(e, 'kind') === 'plan' || text(e, 'kind') === 'attachment')) {
        edit ??= text(e, 'kind') === 'plan' ? 'plan.md' : 'an attachment';
      } else if (ended && e.type === 'RunTriggered' && field(e, 'fired') === undefined) {
        // The next run was queued: a rerun.
        const before = result.get(globId);
        result.set(globId, {
          edited: (before?.edited ?? false) || edit !== null,
          example: before?.example ?? (edit === null ? null : `${globId}: ${edit} edited before the run on ${e.at.slice(0, 10)}`),
        });
        ended = false;
        edit = null;
      }
    }
  }
  return result;
};

const planEditedRerun = define({
  kind: 'plan_edited_rerun',
  agent: 'investigator',
  type: 'agent-behaviour',
  suggestedTarget: 'agents/investigator.md',
  threshold: 'at least 2 globs',
  eligibleGlobs: (activity) => new Set(reruns(activity).keys()),
  tallies: (activity) => {
    const runs = reruns(activity);
    const tallies = new Tallies();
    for (const [globId, r] of runs) if (r.edited) tallies.hit('plan_edited_rerun', 'plans edited before a rerun', globId, r.example);
    return tallies.done(runs.size);
  },
  crosses: (t) => t.affected >= 2,
  statement: (m) =>
    `The plan had to be edited before a failed or superseded run was run again: ${String(m.figures.affected)} of ${String(m.figures.eligible)} rerun globs ${WINDOW_WORDS}.`,
});

/** Each reviewed glob's latest local review (its stats, when recorded, and the rounds it mentions). */
const latestReviews = (activity: BoardActivity): Map<string, ArtifactMeta> => {
  const latest = new Map<string, ArtifactMeta>();
  for (const a of activity.artifacts) if (a.kind === 'local_review') latest.set(a.globId, a);
  return latest;
};

/** Without recorded stats only rounds above every tier's cap but the highest are certain: 3 rounds. */
const PARSED_ROUND_CAP = 3;

/** Non-super globs' latest local reviews: a super keeps one review across its strands, with rounds per strand. */
const cappedReviews = (activity: BoardActivity): Map<string, ArtifactMeta> => {
  const supers = new Set(activity.globs.filter((g) => g.type === 'super').map((g) => g.id));
  return new Map([...latestReviews(activity)].filter(([globId]) => !supers.has(globId)));
};

const reviewCap = define({
  kind: 'review_cap',
  agent: 'implementer',
  type: 'agent-behaviour',
  suggestedTarget: 'agents/implementer.md',
  threshold: 'at least 3 globs and 30% of reviewed globs (supers left out)',
  eligibleGlobs: (activity) => new Set(cappedReviews(activity).keys()),
  tallies: (activity) => {
    const reviews = cappedReviews(activity);
    const tallies = new Tallies();
    for (const [globId, review] of reviews) {
      const stats = review.provenance.reviewStats;
      // One round at a cap of one says nothing: only caps of 2 or more count.
      const atCap =
        stats !== undefined
          ? stats.maxReviewRounds >= 2 && stats.reviewRounds >= stats.maxReviewRounds
          : reviewRounds(review.content ?? '') >= PARSED_ROUND_CAP;
      const rounds = stats?.reviewRounds ?? reviewRounds(review.content ?? '');
      if (atCap) tallies.hit('review_cap', 'review cycles that hit the round cap', globId, `${globId}: ${String(rounds)} review rounds`);
    }
    return tallies.done(reviews.size);
  },
  crosses: (t) => t.affected >= 3 && rateOf(t.affected, t.eligible) >= 0.3,
  statement: (m) =>
    `Review cycles keep running to the round cap, so the implementer's changes need several rounds of fixes: ${String(m.figures.affected)} of ${String(m.figures.eligible)} reviewed globs ${WINDOW_WORDS}.`,
});

const testerLoops = define({
  kind: 'tester_loops',
  agent: 'implementer',
  type: 'agent-behaviour',
  suggestedTarget: 'agents/implementer.md',
  threshold: 'at least 3 globs with a FAIL → fix loop and 30% of globs with recorded review stats',
  eligibleGlobs: (activity) => new Set([...latestReviews(activity)].filter(([, r]) => r.provenance.reviewStats !== undefined).map(([id]) => id)),
  tallies: (activity) => {
    const withStats = [...latestReviews(activity)].filter(([, r]) => r.provenance.reviewStats !== undefined);
    const tallies = new Tallies();
    for (const [globId, review] of withStats) {
      const loops = review.provenance.reviewStats?.testFailRounds ?? 0;
      if (loops >= 1) tallies.hit('tester_loops', 'tester FAIL → fix loops', globId, `${globId}: ${String(loops)} FAIL → fix loops`, loops);
    }
    return tallies.done(withStats.length);
  },
  crosses: (t) => t.affected >= 3 && rateOf(t.affected, t.eligible) >= 0.3,
  statement: (m) =>
    `The tester keeps failing the implementer's first attempt: ${String(m.figures.affected)} of ${String(m.figures.eligible)} globs with review stats had a FAIL → fix loop ${WINDOW_WORDS}.`,
});

/** Failure reports: a run's RunFailed (not a superseded run's) or an interactive session's failure (row 18). */
const failures = (activity: BoardActivity): { globId: string; reason: string }[] =>
  activity.events.flatMap((e) => {
    const reason = text(e, 'reason');
    if (reason === null) return [];
    if (e.type === 'RunFailed' && field(e, 'ignored') !== true && !isInvestigateEvent(e)) return [{ globId: e.globId, reason }];
    if (e.type === 'StatusChanged' && text(e, 'to') === 'failed') return [{ globId: e.globId, reason }];
    return [];
  });

const failure = define({
  kind: 'failure',
  agent: 'orchestrator',
  type: 'agent-behaviour',
  suggestedTarget: 'agents/orchestrator.md',
  threshold: 'at least 3 failures with the same normalised reason',
  eligibleGlobs: (activity) => new Set(failures(activity).map((f) => f.globId)),
  tallies: (activity) => {
    const all = failures(activity);
    const tallies = new Tallies();
    for (const f of all) {
      const normalised = normaliseFailure(f.reason);
      if (normalised === '') continue;
      tallies.hit(`failure:${normalised}`, normalised, f.globId, `${f.globId}: ${cut(f.reason, 160)}`);
    }
    // The rate is over all failures: how much of the failing this reason is.
    return tallies.done(all.length).map((t) => ({ ...t, eligible: all.length, affected: t.count }));
  },
  crosses: (t) => t.count >= 3,
  statement: (m) =>
    `Runs keep failing for the same reason ("${m.label}"): ${String(m.figures.count)} failures on ${String(m.globIds.length)} globs ${WINDOW_WORDS}.`,
});

const HOUR_MS = 60 * 60 * 1000;

/** A run's length for an example: hours, or days past two days. */
const duration = (ms: number): string => {
  const hours = Math.round(ms / HOUR_MS);
  return hours >= 48 ? `${String(Math.round(hours / 24))} days` : hours >= 1 ? `${String(hours)}h` : 'under an hour';
};

/**
 * What a superseded run's example says beyond its cause: how long it had run (from its RunTriggered), and the
 * last reason the glob recorded while it ran (a failure or a failed merge, say).
 */
const supersededDetail = (ended: DomainEvent, events: readonly DomainEvent[]): string => {
  const runId = text(ended, 'runId');
  const ofGlob = events.filter((e) => e.globId === ended.globId && e.at <= ended.at);
  const triggered = runId === null ? undefined : ofGlob.find((e) => e.type === 'RunTriggered' && text(e, 'runId') === runId);
  const during = triggered === undefined ? [] : ofGlob.filter((e) => e.at >= triggered.at && e !== ended);
  const reason = during.map((e) => text(e, 'reason')).filter((r): r is string => r !== null).at(-1);
  return [
    ...(triggered === undefined ? [] : [` after ${duration(Date.parse(ended.at) - Date.parse(triggered.at))}`]),
    ...(reason === undefined ? [] : [` (last reason: ${cut(reason, 100)})`]),
  ].join('');
};

/** Ended routine runs, and which of them someone superseded by taking over or starting again (with the example's detail). */
const endedRuns = (activity: BoardActivity): { globId: string; stepIn: string | null; at: string; detail: string }[] =>
  activity.events.flatMap((e) => {
    if (isInvestigateEvent(e)) return [];
    if (e.type === 'RunFailed' && field(e, 'ignored') !== true) return [{ globId: e.globId, stepIn: null, at: e.at, detail: '' }];
    if (e.type !== 'RunEnded') return [];
    const cause = text(e, 'outcome') === 'superseded' ? supersededCause(e, activity.events) : null;
    const stepIn = cause !== null && STEPPED_IN.has(cause) ? cause : null;
    return [{ globId: e.globId, stepIn, at: e.at, detail: stepIn === null ? '' : supersededDetail(e, activity.events) }];
  });

const runSuperseded = define({
  kind: 'run_superseded',
  agent: 'orchestrator',
  type: 'agent-behaviour',
  suggestedTarget: 'agents/orchestrator.md',
  threshold: 'at least 3 runs and 20% of ended routine runs',
  eligibleGlobs: (activity) => new Set(endedRuns(activity).map((r) => r.globId)),
  tallies: (activity) => {
    const runs = endedRuns(activity);
    const tallies = new Tallies();
    for (const r of runs) {
      if (r.stepIn === null) continue;
      tallies.hit('run_superseded', 'routine runs ending in a take-over or start again', r.globId, `${r.globId}: ${r.stepIn.replace('_', ' ')} on ${r.at.slice(0, 10)}${r.detail}`);
    }
    // Run signal: the units are runs, not globs.
    return tallies.done(runs.length).map((t) => ({ ...t, affected: t.count }));
  },
  crosses: (t) => t.count >= 3 && rateOf(t.count, t.eligible) >= 0.2,
  statement: (m) =>
    `Routine runs keep ending with someone taking over or starting again: ${String(m.figures.affected)} of ${String(m.figures.eligible)} ended routine runs ${WINDOW_WORDS}.`,
});

/** Subs the sub gate judged in the window, and the ones it turned into sames. */
const gatedSubs = (activity: BoardActivity): Map<string, string | null> => {
  const subs = new Map<string, string | null>();
  for (const e of activity.events) {
    if (e.type === 'SubReviewCompleted') {
      const failed = field(e, 'passed') === false ? (text(e, 'reason') ?? 'failed the sub gate') : null;
      subs.set(e.globId, subs.get(e.globId) ?? failed);
    } else if (e.type === 'FieldsChanged') {
      const type = field(e, 'type');
      if (type !== null && typeof type === 'object' && !Array.isArray(type) && 'to' in type && type.to === 'same' && subs.has(e.globId)) {
        subs.set(e.globId, subs.get(e.globId) ?? 'converted to a same');
      }
    }
  }
  return subs;
};

const subConverted = define({
  kind: 'sub_converted',
  agent: 'orchestrator',
  type: 'agent-behaviour',
  suggestedTarget: 'agents/orchestrator.md',
  threshold: 'at least 3 and 30% of gated subs',
  eligibleGlobs: (activity) => new Set(gatedSubs(activity).keys()),
  tallies: (activity) => {
    const subs = gatedSubs(activity);
    const tallies = new Tallies();
    for (const [globId, reason] of subs) if (reason !== null) tallies.hit('sub_converted', 'subs converted to sames by the sub gate', globId, `${globId}: ${cut(reason, 120)}`);
    return tallies.done(subs.size);
  },
  crosses: (t) => t.affected >= 3 && rateOf(t.affected, t.eligible) >= 0.3,
  statement: (m) =>
    `Subs keep being converted to sames because they are too big or touch sensitive paths: ${String(m.figures.affected)} of ${String(m.figures.eligible)} gated subs ${WINDOW_WORDS}.`,
});

/**
 * A failed commit for an example: its SHA and the failing check from the event's `failure` summary (s15t7), or null
 * without one. A failure with neither that nor `inheritedFrom` wasn't compared with the base branch: it may be the base's.
 */
interface FailedCommit {
  readonly sha: string;
  readonly failure: string | null;
}

/** A glob's failed commits as an example, noting once when some weren't compared with the base branch. */
const failedCommits = (globId: string, commits: readonly FailedCommit[]): string => {
  const shas = commits.map((c) => `${c.sha.slice(0, 7)}${c.failure === null ? '' : ` (${cut(c.failure, 120)})`}`);
  const unchecked = commits.some((c) => c.failure === null) ? '; not compared with the base branch, so possibly inherited from a red base' : '';
  return `${globId}: CI failed on ${shas.join(', ')}${unchecked}`;
};

/** Failed commits (glob, sha) whose local checks had passed: a local review of that commit, or a routine's push. */
const ciAfterLocal = (activity: BoardActivity): { builds: Set<string>; failed: Map<string, FailedCommit[]> } => {
  const builds = new Set<string>();
  const failed = new Map<string, FailedCommit[]>();
  const reviewed = activity.artifacts.filter((a) => a.kind === 'local_review');
  const routinePushes = activity.events.filter((e) => e.type === 'CommitPushed' && text(e, 'runId') !== null);
  for (const e of activity.events) {
    if (e.type !== 'BuildCompleted') continue;
    builds.add(e.globId);
    const sha = text(e, 'sha');
    // Failures inherited from a red base (s15t7) are the base's, not the glob's.
    if (field(e, 'passed') !== false || sha === null || inheritedFromBase(e)) continue;
    // BuildCompleted repeats on every refresh: one per (glob, sha).
    if (failed.get(e.globId)?.some((f) => f.sha === sha) === true) continue;
    const review = reviewed.find((a) => a.globId === e.globId && sameCommit(a.commitSha, sha));
    const pushed = routinePushes.some((p) => p.globId === e.globId && text(p, 'sha') === sha);
    if (review !== undefined || pushed) add(failed, e.globId, { sha, failure: text(e, 'failure') });
  }
  return { builds, failed };
};

const ciAfterLocalSignal = define({
  kind: 'ci_after_local',
  agent: 'orchestrator',
  type: 'agent-behaviour',
  suggestedTarget: 'build_test_lint',
  threshold: 'at least 2 globs and 10% of globs with builds',
  eligibleGlobs: (activity) => ciAfterLocal(activity).builds,
  tallies: (activity) => {
    const { builds, failed } = ciAfterLocal(activity);
    const tallies = new Tallies();
    for (const [globId, commits] of failed) {
      tallies.hit('ci_after_local', 'CI failing after local checks passed', globId, failedCommits(globId, commits), commits.length);
    }
    return tallies.done(builds.size);
  },
  crosses: (t) => t.affected >= 2 && rateOf(t.affected, t.eligible) >= 0.1,
  statement: (m) =>
    `CI keeps failing on commits whose local checks passed (a local review of the commit, or a routine's push): ${String(m.figures.affected)} of ${String(m.figures.eligible)} globs with builds ${WINDOW_WORDS}.`,
});

/** Whether a board document mentions a dependency by name. */
const mentioned = (activity: BoardActivity, name: string): boolean => {
  const needle = name.toLowerCase();
  return activity.documents.some((d) => d.content.toLowerCase().includes(needle));
};

const dependency = define({
  kind: 'dependency',
  agent: null,
  type: 'gotcha',
  suggestedTarget: 'a conventions document for the new dependencies',
  threshold: 'any dependency a merged glob added that no board document mentions',
  eligibleGlobs: (activity) => new Set((activity.manifestChanges ?? []).map((m) => m.globId)),
  tallies: (activity) => {
    if (activity.manifestChanges === null) return [];
    const merged = new Set(activity.manifestChanges.map((m) => m.globId));
    const tallies = new Tallies();
    for (const change of activity.manifestChanges) {
      for (const name of change.dependencies) {
        if (mentioned(activity, name)) continue;
        tallies.hit(`dependency:${name}`, name, change.globId, `${change.globId}: added ${name} to ${change.path}`);
      }
    }
    return tallies.done(merged.size);
  },
  crosses: (t) => t.affected >= 1,
  statement: (m) => `New dependencies have no conventions yet: ${m.label}. Document how the project uses them.`,
});

/** Globs whose independent review in the window had findings: the ones that could be told they were wrong. */
const independentlyReviewedGlobs = (activity: BoardActivity): Set<string> =>
  new Set(
    activity.artifacts
      .filter((a) => a.kind === 'independent_review' && (a.provenance.independentReview?.findings ?? 0) > 0)
      .map((a) => a.globId),
  );

const reviewFalsePositive = define({
  kind: 'review_false_positive',
  agent: null,
  type: 'pattern',
  suggestedTarget: `the review guide (area ${REVIEW_GUIDE_AREA}): what the independent reviewer should stop flagging`,
  threshold: 'at least 3 globs with the same category of finding marked wrong',
  eligibleGlobs: independentlyReviewedGlobs,
  tallies: (activity) => {
    const tallies = new Tallies();
    for (const f of activity.reviewFeedback) {
      // A plain resolve says nothing about whether the finding was right.
      if (!isFalsePositive(f.verdict)) continue;
      tallies.hit(`review_false_positive:${f.category}`, f.category, f.globId, `${f.globId}: ${cut(f.title, 160)} (${f.path})`);
    }
    return tallies.done(independentlyReviewedGlobs(activity).size);
  },
  crosses: (t) => t.affected >= 3,
  statement: (m) =>
    `People keep marking the independent reviewer's ${m.label} findings as wrong: ${String(m.figures.affected)} of ${String(m.figures.eligible)} reviewed globs ${WINDOW_WORDS}.`,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Globs that have merged: work globs past their merge (reviewing, signed off). */
const mergedGlobs = (activity: BoardActivity): ActivityGlob[] => activity.globs.filter((g) => g.status === 'reviewing' || g.status === 'signed_off');

/**
 * The core areas with no document, once the board is old enough to have had one: its oldest glob is at least
 * `MISSING_DOC_MIN_DAYS` old (the board's age; slop doesn't record when a document went missing) and it has
 * `MISSING_DOC_MIN_MERGED_GLOBS` merged globs. Empty when the documents' areas weren't read.
 */
const missingDocAreas = (activity: BoardActivity): string[] => {
  if (activity.documentAreasKnown !== true) return [];
  const merged = mergedGlobs(activity);
  const oldest = activity.globs.reduce<number>((min, g) => Math.min(min, Date.parse(g.createdAt)), Infinity);
  const old = Date.parse(activity.window.to) - oldest >= MISSING_DOC_MIN_DAYS * DAY_MS;
  if (!old || merged.length < MISSING_DOC_MIN_MERGED_GLOBS) return [];
  return missingCoreAreas(activity.documents.map((d) => ({ area: d.area ?? null })));
};

const missingDoc = define({
  kind: 'missing_doc',
  agent: null,
  type: 'pattern',
  suggestedTarget: 'a new document for the missing area (/kb-bootstrap proposes it)',
  threshold: `a core area (build, conventions, architecture) with no document, on a board at least ${String(MISSING_DOC_MIN_DAYS)} days old with ${String(MISSING_DOC_MIN_MERGED_GLOBS)} merged globs`,
  eligibleGlobs: (activity) => new Set(mergedGlobs(activity).map((g) => g.id)),
  tallies: (activity) =>
    missingDocAreas(activity).map((area) => ({
      key: `missing_doc:${area}`,
      label: `no ${area} document`,
      eligible: 1,
      affected: 1,
      count: 1,
      affectedGlobs: new Set<string>(),
      examples: [],
      context: area,
    })),
  crosses: () => true,
  // Raised again only after 60 days, and then whatever the rate (it is always 1).
  quietMs: MISSING_DOC_RERAISE_DAYS * DAY_MS,
  reraiseFactor: 1,
  statement: (m) => `This board has no ${m.context ?? 'core'} document; run /kb-bootstrap to propose one.`,
});

/** A choice's statement as a label, cut to one short line. */
const choiceLabel = (statement: string): string => cut(statement, 120);

const choiceInUseSignal = define({
  kind: 'choice_in_use',
  agent: null,
  type: 'pattern',
  suggestedTarget: 'the document area closest to the choice (routing decides)',
  threshold: `a current choice returned at least ${String(CHOICE_MIN_RETURNS)} times (${String(CHOICE_DISCUSSION_MIN_RETURNS)} from discussion) on at least ${String(CHOICE_MIN_GLOBS)} globs in ${String(CHOICE_USAGE_WINDOW_DAYS)} days that no document covers`,
  // The rate's denominator: the globs that were handed any choice.
  eligibleGlobs: (activity) => new Set((activity.choices ?? []).flatMap((c) => c.globIds)),
  tallies: (activity) => {
    const eligible = new Set((activity.choices ?? []).flatMap((c) => c.globIds)).size;
    return (activity.choices ?? [])
      .filter((c) => c.current && !c.covered && c.sourceKind !== 'kb_item' && c.returns > 0)
      .map((c): Tally => ({
        key: `choice_in_use:${String(c.id)}`,
        label: choiceLabel(c.statement),
        eligible,
        affected: c.globIds.length,
        count: c.returns,
        affectedGlobs: new Set(c.globIds),
        examples: [`Quote: "${cut(c.quote, 200)}" (${c.sourceLabel})`, `Returned ${String(c.returns)} times on ${String(c.globIds.length)} globs.`],
        context: c.sourceKind,
      }));
  },
  crosses: (t) => {
    const needed = t.context === 'inbox' ? CHOICE_DISCUSSION_MIN_RETURNS : CHOICE_MIN_RETURNS;
    return t.count >= needed && t.affected >= CHOICE_MIN_GLOBS;
  },
  statement: (m) => `A choice agents keep relying on is in no document: "${m.label}" (used by ${m.globIds.join(', ')}). Make it standing guidance.`,
  once: true,
});

/** The word the area part of a `knowledge_page` key uses: no colon, so the key still splits into kind, area and verdict. */
const verdictArea = (v: KnowledgePageVerdictActivity): string => (v.area ?? `scope ${v.scope}`).replace(/:/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

const knowledgePageSignal = define({
  kind: 'knowledge_page',
  agent: null,
  type: 'pattern',
  suggestedTarget: KNOWLEDGE_PAGE_GUIDE_NAME,
  threshold: `${String(KNOWLEDGE_PAGE_FEEDBACK_MIN)} or more Pin / Not key verdicts in ${String(KNOWLEDGE_PAGE_FEEDBACK_DAYS)} days the same way about decisions in the same area (or, with none, the same scope)`,
  eligibleGlobs: (activity) => new Set((activity.knowledgePageFeedback ?? []).map((v) => v.globId)),
  tallies: (activity) => {
    const verdicts = activity.knowledgePageFeedback ?? [];
    const tallies = new Tallies();
    for (const v of [...verdicts].sort((a, b) => b.at.localeCompare(a.at) || a.globId.localeCompare(b.globId))) {
      const area = verdictArea(v);
      tallies.hit(`knowledge_page:${area}:${v.verdict}`, `${v.verdict === 'pin' ? 'pinned' : 'not key'}: ${area}`, v.globId, `${v.verdict === 'pin' ? 'Pinned' : 'Not key'}: "${cut(v.title, 120)}" (${v.globId}, ${v.at.slice(0, 10)})`);
    }
    return tallies.done(new Set(verdicts.map((v) => v.globId)).size);
  },
  crosses: (t) => t.affected >= KNOWLEDGE_PAGE_FEEDBACK_MIN,
  reraiseFactor: 1,
  statement: (m) => {
    const [, area = '', verdict = ''] = m.key.split(':');
    return `Admins and product owners marked ${String(m.figures.affected)} decisions about ${area} as ${verdict === 'pin' ? 'key' : 'not key'} in the last ${String(KNOWLEDGE_PAGE_FEEDBACK_DAYS)} days (${m.globIds.join(', ')}). Say so in the knowledge page guide.`;
  },
});

/** Every mined signal, in the order the spec lists them. */
export const SIGNALS: readonly SignalDefinition[] = [
  finding,
  planAmended,
  planEditedRerun,
  reviewCap,
  testerLoops,
  failure,
  runSuperseded,
  subConverted,
  ciAfterLocalSignal,
  dependency,
  reviewFalsePositive,
  missingDoc,
  choiceInUseSignal,
  knowledgePageSignal,
];

export const signalKindOf = (key: string): SignalKind | null => {
  const kind = key.split(':')[0];
  return SIGNAL_KINDS.find((k) => k === kind) ?? null;
};

export const signalDefinition = (key: string): SignalDefinition | null => {
  const kind = signalKindOf(key);
  return SIGNALS.find((s) => s.kind === kind) ?? null;
};

/** Every signal's measurements for the activity's window. */
export const measureSignals = (activity: BoardActivity): Measurement[] => SIGNALS.flatMap((s) => s.measure(activity));

/** Whether a glob counts toward a signal key's rate and is affected by it (for effect checks); false for unknown keys. */
export const perGlob = (activity: BoardActivity, globId: string, key: string): { eligible: boolean; affected: boolean } =>
  signalDefinition(key)?.perGlob(activity, globId, key) ?? { eligible: false, affected: false };

// ---------------------------------------------------------------------------
// Re-raise state and board jobs

/**
 * One row per board and signal key (`kb_signals`), so a signal isn't raised again every week: the item it
 * last raised, its last figures, and how many runs in a row it has been below its threshold.
 */
export interface KbSignalState {
  readonly boardId: number;
  readonly key: string;
  readonly itemId: string | null;
  readonly lastFigures: SignalFigures | null;
  readonly lastMeasuredAt: string | null;
  readonly raisedAt: string | null;
  readonly belowThresholdRuns: number;
}

/** A rejected or suppressed signal stays quiet this long, then needs this much more than its rate at rejection. */
export const SIGNAL_QUIET_MS = 12 * 7 * 24 * 60 * 60 * 1000;
export const SIGNAL_RERAISE_FACTOR = 1.5;

/** Per-board background jobs of the self-improvement pipeline (`board_jobs`). */
export const BOARD_JOBS = ['mining', 'consolidation', 'effect_check', 'sub_limit', 'intake_outcome', 'size_threshold'] as const;
export type BoardJobName = (typeof BOARD_JOBS)[number];

export type BoardJobResult =
  | {
      readonly kind: 'mining';
      /** Signal keys measured (with any eligible activity), and how many crossed their threshold. */
      readonly measured: number;
      readonly crossed: number;
      readonly raised: readonly string[];
      readonly refreshed: readonly string[];
    }
  | {
      readonly kind: 'consolidation';
      /** Open items compared (settled statements, newest first). */
      readonly candidates: number;
      /** Pairs the model proposed (after dropping kept-apart pairs), pairs it verified as the same fact with both quotes. */
      readonly proposed: number;
      readonly verified: number;
      /** Each merge: the item closed and the item it was merged into. */
      readonly merged: readonly { readonly id: string; readonly into: string }[];
      /**
       * Pairs left alone for an unusable answer, a failed call or an item that changed meanwhile, and pairs already
       * answered this run (merged together, or asked as another pair after a merge).
       */
      readonly skipped: number;
      /**
       * Pairs not verified again: an earlier run found them not the same fact and neither item's statement, type or
       * target has changed since.
       * The ones proposed anyway, or on an `unchanged` run every such pair among the candidates. Absent on runs
       * recorded before consolidation remembered pairs.
       */
      readonly alreadyChecked?: number;
      /** No candidate-pair call: the candidates (their statements, types and targets) were as the last run left them. */
      readonly unchanged?: boolean;
      /** Open items flagged stale this run, and flags cleared (new evidence). */
      readonly flaggedStale: number;
      readonly clearedStale: number;
    }
  | {
      readonly kind: 'effect_check';
      /** Approved items still watching after the run (their partial figures refreshed). */
      readonly watching: number;
      /** Checks that reached a verdict this run, with it. */
      readonly decided: readonly { readonly id: string; readonly state: EffectState }[];
      /** Revise-or-revert items raised. */
      readonly raised: readonly string[];
    }
  | {
      readonly kind: 'sub_limit';
      /** The board's limit after the run. */
      readonly limit: number;
      /** Outcomes recorded this run, each with the limit before and after it. */
      readonly changes: readonly { readonly globId: string; readonly outcome: SubLimitOutcome; readonly from: number; readonly to: number }[];
      /** Bug references the model was asked about, and those left for the next run (AI unavailable or no usable answer yet). */
      readonly asked: number;
      readonly waiting: number;
      /** Bug references skipped this run after `MAX_ANSWER_ATTEMPTS` asks without a usable answer (absent when none). */
      readonly gaveUp?: number;
    }
  | {
      readonly kind: 'intake_outcome';
      /** Snapshots rebuilt for globs that had none, and snapshots whose embedding was filled. */
      readonly backfilled: number;
      readonly embedded: number;
      /** Outcomes recorded for merged globs, and earlier ones refreshed once 14 days had passed. */
      readonly recorded: number;
      readonly refreshed: number;
    }
  | {
      readonly kind: 'size_threshold';
      /** The board's size threshold after the run. */
      readonly threshold: SizeThreshold;
      /** Outcomes recorded this run, each with the threshold before and after it. */
      readonly changes: readonly { readonly globId: string; readonly outcome: SizeOutcome; readonly from: SizeThreshold; readonly to: SizeThreshold }[];
      /** Size records written this run and the calibration moves they made (absent when none). */
      readonly calibration?: { readonly records: number; readonly moves: readonly { readonly globId: string; readonly cause: string }[] };
    }
  /**
   * The job didn't run because its AI was unavailable; the last run stands and the next hourly check tries again.
   * `failures`: the failed runs in a row before the skip, kept for the next failure's backoff (absent when none).
   */
  | { readonly kind: 'skipped'; readonly reason: string; readonly failures?: number }
  | {
      readonly kind: 'failed';
      readonly error: string;
      /**
       * When it failed, and how many runs in a row have failed: the next try waits longer after each
       * (`failedRetryMs`). Absent on failures recorded before the backoff.
       */
      readonly at?: string;
      readonly failures?: number;
    };

/** A board job's last run, and its lease while one server runs it (`runningUntil`). */
export interface BoardJob {
  readonly boardId: number;
  readonly job: BoardJobName;
  readonly lastRunAt: string | null;
  readonly lastResult: BoardJobResult | null;
  readonly runningUntil: string | null;
}

/** A board job as the Knowledge page reads it: `running` says whether its lease is held, by the server's clock. */
export interface BoardJobStatus extends BoardJob {
  readonly running: boolean;
}
