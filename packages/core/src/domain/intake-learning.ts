import type { DomainEvent } from './events.js';
import type { ReviewStats } from './knowledge.js';
import { markdownHeadings } from './sections.js';
import { gateVerdictOf, namesGlob } from './sub-limit.js';
import { inheritedFromBase } from './signals.js';
import { CATEGORIES, SLOP_TYPES } from './types.js';
import type { Category, SlopType } from './types.js';

/**
 * Learned task categorisation (spec, Intake): every glob keeps a frozen snapshot of what intake saw and decided when it was
 * created, merged globs get an outcome, and intake is shown the nearest past snapshots, corrected ones first. Pure: the
 * store, the embedder and the jobs are in the services.
 */

/** Bumped whenever the intake prompt changes, so accuracy can be read per prompt. v1 is the prompt before examples, v2 the prompt with them, v3 the broader sub definition. */
export const INTAKE_PROMPT_VERSION = 3;

/** Intake's own confidence in the category it chose. */
export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** Where the glob was created from; `backfill` snapshots were rebuilt afterwards from the glob's plan. */
export const SNAPSHOT_SOURCES = ['mcp', 'web', 'api', 'backfill'] as const;
export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

/** An outcome is final this long after the merge; before that it is refreshed. */
export const OUTCOME_FINAL_DAYS = 14;
/** The nearest snapshots intake reads, and how many of them it shows (corrected ones first). */
export const EXAMPLE_POOL = 15;
export const EXAMPLE_LIMIT = 5;
/** The nearest examples whose categories must agree for intake to be sure. */
export const DISAGREE_WINDOW = 3;
/** An example's request is cut to this many characters in the prompt. */
export const EXAMPLE_EXCERPT = 280;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Plan features

export const AREAS = ['migration', 'server', 'web', 'cli', 'llm', 'infra', 'catalog'] as const;
export type Area = (typeof AREAS)[number];

export interface PlanFeatures {
  /** Checkbox lines, and the lines under a Tasks heading. */
  readonly tasks: number;
  /** "Done when" lines (including the bullets under a bare "Done when:"). */
  readonly doneWhenLines: number;
  /** Sections with text but no task line of their own (the spec's prose, as opposed to its work list). */
  readonly untaskedSections: number;
  readonly areas: readonly Area[];
  /** Path-like tokens the plan names. */
  readonly filePaths: readonly string[];
  readonly words: number;
}

const AREA_PATTERNS: readonly (readonly [Area, RegExp])[] = [
  ['migration', /\bmigrations?\b|\bdrizzle\b|\bschema change/i],
  ['server', /apps\/server|\bserver\b|\bendpoints?\b|\broutes?\b|\bstore\b/i],
  ['web', /apps\/web|\bweb\b|\bUI\b|\bcard\b|\bpage\b|\breact\b/i],
  ['cli', /\bcli\b|\bsstor\b/i],
  ['llm', /\bllm\b|\bprompts?\b|\bmodels?\b|\bbedrock\b|\bembedd/i],
  ['infra', /\binfra\/|\bterraform\b|\bcdk\b|\bdockerfile\b|\bpipelines?\b/i],
  ['catalog', /\bcatalog\b/i],
];

const CHECKBOX_LINE = /^\s*[-*+]\s+\[[ xX]\]\s+\S/;
/** A top-level list line: under a Tasks heading, each is a task whether or not it has a checkbox. */
const LIST_LINE = /^ {0,1}(?:[-*+]|\d+[.)])\s+\S/;
const TASKS_HEADING = /^tasks?\b/i;
const DONE_WHEN = /^\s*(?:[-*+]\s+)?(?:\*\*)?done when\b/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const PATH_TOKEN = /(?:[\w.@-]+\/)+[\w.-]*\w\.\w{1,8}\b/g;
/** Sections that are context rather than work: never counted as untasked. */
const CONTEXT_HEADINGS = /^(goal|summary|context|background|overview|why|notes?|risks?|constraints?|acceptance|done when|out of scope|assumptions?)\b/i;
const MAX_PATHS = 30;

/**
 * Which lines of the plan are tasks: `- [ ]` checkbox lines anywhere, and list lines under a Tasks heading (or a
 * heading inside one). Numbered lines under any other heading (an investigation list) are not tasks.
 */
const taskLineFlags = (plan: string): boolean[] => {
  const lines = plan.split(/\r?\n/);
  const flags = lines.map((l) => CHECKBOX_LINE.test(l));
  const stack: { level: number; tasks: boolean }[] = [];
  const headings = markdownHeadings(plan);
  let next = 0;
  for (let i = 0; i < lines.length; i++) {
    const heading = headings[next];
    if (heading !== undefined && heading.line === i) {
      next++;
      while ((stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
      stack.push({ level: heading.level, tasks: TASKS_HEADING.test(heading.text) });
      continue;
    }
    if (!flags[i] && stack.some((h) => h.tasks) && LIST_LINE.test(lines[i] ?? '')) flags[i] = true;
  }
  return flags;
};

/**
 * The plan's sections (level 2 and below) with text and no task: context (Evidence, Why, Notes, an investigation list)
 * rather than work. A split carries them into its parts and never makes one a part of its own.
 */
export const contextSectionList = (plan: string): { readonly heading: string; readonly body: string }[] => {
  const lines = plan.split(/\r?\n/);
  const flags = taskLineFlags(plan);
  const all = markdownHeadings(plan);
  const found: { heading: string; body: string }[] = [];
  for (const heading of all.filter((h) => h.level >= 2)) {
    const next = all.find((h) => h.line > heading.line && h.level <= heading.level);
    const end = next?.line ?? lines.length;
    const body = lines.slice(heading.line + 1, end);
    if (body.some((l) => l.trim() !== '') && !flags.slice(heading.line + 1, end).some(Boolean)) {
      found.push({ heading: heading.text, body: body.join('\n').trim() });
    }
  }
  return found;
};

/** The context sections that count as prose of the spec: `contextSectionList` less the ones that are only framing. */
export const untaskedSectionList = (plan: string): { readonly heading: string; readonly body: string }[] =>
  contextSectionList(plan).filter((s) => !CONTEXT_HEADINGS.test(s.heading));

export const extractPlanFeatures = (plan: string): PlanFeatures => {
  const lines = plan.split(/\r?\n/);
  const tasks = taskLineFlags(plan).filter(Boolean).length;

  let doneWhenLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!DONE_WHEN.test(line)) continue;
    doneWhenLines++;
    // A bare "Done when:" introduces the bullets that follow it.
    if (/done when\W*$/i.test(line.replace(/\*\*/g, '').trim())) {
      for (let j = i + 1; j < lines.length && BULLET.test(lines[j] ?? ''); j++) {
        doneWhenLines++;
        i = j;
      }
    }
  }

  const untaskedSections = untaskedSectionList(plan).length;

  const areas = AREA_PATTERNS.filter(([, pattern]) => pattern.test(plan)).map(([area]) => area);
  const filePaths = [...new Set(plan.match(PATH_TOKEN) ?? [])].slice(0, MAX_PATHS);
  const words = plan.split(/\s+/).filter((w) => w !== '').length;
  return { tasks, doneWhenLines, untaskedSections, areas, filePaths, words };
};

// ---------------------------------------------------------------------------
// Snapshot and outcome

/** What was chosen when the glob was created (after the person's edits), and how intake got there. */
export interface IntakeDecisions {
  readonly type: SlopType;
  readonly category: Category;
  readonly group: string | null;
  readonly environment: string | null;
  /** Null when intake didn't run (a glob created with a title) or the model gave none. */
  readonly categoryConfidence: Confidence | null;
  readonly reason: string | null;
  readonly model: string | null;
  readonly promptVersion: number | null;
}

/** What the caller knows about the intake run that proposed a glob; passed through `GlobService.create`. */
export interface IntakeRecord {
  readonly request: string;
  readonly source: SnapshotSource;
  readonly categoryConfidence: Confidence | null;
  readonly reason: string | null;
  readonly model: string | null;
  readonly promptVersion: number | null;
  /** The globs whose examples intake was shown. */
  readonly examples: readonly string[];
}

/** One row of the frozen record: never edited (a plan rewritten before start adds the next version). */
export interface IntakeSnapshot {
  readonly globId: string;
  readonly version: number;
  readonly boardId: number;
  readonly request: string;
  readonly title: string;
  readonly summary: string;
  readonly plan: string;
  readonly creator: string;
  readonly source: SnapshotSource;
  readonly decisions: IntakeDecisions;
  readonly features: PlanFeatures;
  readonly examples: readonly string[];
  readonly backfilled: boolean;
  readonly createdAt: string;
}

export interface FieldCorrection<T extends string> {
  readonly from: T;
  readonly to: T;
  readonly by: string | null;
  readonly at: string;
}

export interface GlobOutcome {
  readonly globId: string;
  readonly snapshotVersion: number;
  readonly boardId: number;
  readonly mergedAt: string;
  readonly recordedAt: string;
  /** True once 14 days have passed since the merge: the outcome is no longer refreshed. */
  readonly final: boolean;
  readonly corrections: {
    /** The first change of category or type a person made after creation (null: kept as intake chose). */
    readonly category: FieldCorrection<Category> | null;
    readonly type: FieldCorrection<SlopType> | null;
    /** A sub the gate converted to a same, and why. */
    readonly subConverted: 'size' | 'sensitive' | null;
    readonly split: boolean;
  };
  /** The sub gate's changed-line count; null when the glob never went through it. */
  readonly size: { readonly changedLines: number | null };
  readonly review: {
    readonly rounds: number | null;
    readonly maxRounds: number | null;
    readonly testFailRounds: number | null;
    readonly findingsBySeverity: Readonly<Record<string, number>>;
    readonly findingsByClass: Readonly<Record<string, number>>;
  };
  /** Failed builds of the glob's own (those inherited from a red base are left out). */
  readonly tests: { readonly ciFailures: number };
  readonly effort: { readonly calendarHours: number | null };
  /** Bug globs created within 14 days of the merge that name this glob. */
  readonly postMerge: { readonly fixGlobs: readonly string[] };
}

export const OUTCOME_EVENT_TYPES = ['GlobCreated', 'FieldsChanged', 'Merged', 'GlobSplit', 'SubReviewCompleted', 'BuildCompleted'] as const;

/** A finding's severity and class, all `collectOutcome` reads of the glob's review findings. */
export interface FindingFacts {
  readonly severity: string;
  readonly class: string | null;
}

export interface OutcomeInput {
  readonly snapshot: IntakeSnapshot;
  /** The glob's own events (`OUTCOME_EVENT_TYPES`), oldest first. */
  readonly events: readonly DomainEvent[];
  readonly mergedAt: string;
  readonly now: string;
  /** From the latest local review; null when it had none. */
  readonly reviewStats: ReviewStats | null;
  readonly findings: readonly FindingFacts[];
  /** The board's bug globs (id, title, summary, createdAt) the post-merge fixes are found in. */
  readonly bugs: readonly { readonly id: string; readonly title: string; readonly summary: string; readonly createdAt: string }[];
}

const tally = (values: readonly (string | null)[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const v of values) if (v !== null) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
};

const changeOf = (value: unknown): { from: string; to: string } | null => {
  if (typeof value !== 'object' || value === null || !('from' in value) || !('to' in value)) return null;
  return typeof value.from === 'string' && typeof value.to === 'string' ? { from: value.from, to: value.to } : null;
};

/** Whether the outcome recorded at `existing` still needs (re)writing at `now`: never recorded, or not final and now final. */
export const outcomeDue = (mergedAt: string, existing: Pick<GlobOutcome, 'final'> | null, now: string): boolean =>
  existing === null || (!existing.final && Date.parse(now) >= Date.parse(mergedAt) + OUTCOME_FINAL_DAYS * DAY_MS);

export const collectOutcome = (input: OutcomeInput): GlobOutcome => {
  const { snapshot, events, mergedAt, now } = input;
  const mergedMs = Date.parse(mergedAt);
  let category: GlobOutcome['corrections']['category'] = null;
  let type: GlobOutcome['corrections']['type'] = null;
  let gate: DomainEvent | undefined;
  for (const e of events) {
    if (e.type === 'SubReviewCompleted') gate = e;
    if (e.type !== 'FieldsChanged' || e.at < snapshot.createdAt) continue;
    const c = changeOf(e.data.category);
    const t = changeOf(e.data.type);
    const toCategory = CATEGORIES.find((x) => x === c?.to);
    const toType = SLOP_TYPES.find((x) => x === t?.to);
    if (category === null && toCategory !== undefined && e.actor !== null)
      category = { from: snapshot.decisions.category, to: toCategory, by: e.actor, at: e.at };
    // The gate's own sub to same conversion has no actor: it is recorded as such, not as a person's correction.
    if (type === null && toType !== undefined && e.actor !== null)
      type = { from: snapshot.decisions.type, to: toType, by: e.actor, at: e.at };
  }
  const verdict = gate === undefined ? null : gateVerdictOf(gate);
  const subConverted =
    verdict !== null && !verdict.passed && snapshot.decisions.type === 'sub' ? (verdict.cause ?? 'sensitive') : null;
  // Failed builds the glob's own (a red base's are not), counted once per commit.
  const failedShas = new Set(
    events
      .filter((e) => e.type === 'BuildCompleted' && e.data.passed === false && !inheritedFromBase(e))
      .map((e) => (typeof e.data.sha === 'string' ? e.data.sha : e.at)),
  );
  const fixGlobs = input.bugs
    .filter((b) => {
      const created = Date.parse(b.createdAt);
      return created >= mergedMs && created <= mergedMs + OUTCOME_FINAL_DAYS * DAY_MS && namesGlob(`${b.title}\n${b.summary}`, snapshot.globId);
    })
    .map((b) => b.id);
  const createdMs = Date.parse(snapshot.createdAt);
  return {
    globId: snapshot.globId,
    snapshotVersion: snapshot.version,
    boardId: snapshot.boardId,
    mergedAt,
    recordedAt: now,
    final: Date.parse(now) >= mergedMs + OUTCOME_FINAL_DAYS * DAY_MS,
    corrections: {
      category,
      type,
      subConverted,
      split: events.some((e) => e.type === 'GlobSplit'),
    },
    size: { changedLines: verdict?.changedLines ?? null },
    review: {
      rounds: input.reviewStats?.reviewRounds ?? null,
      maxRounds: input.reviewStats?.maxReviewRounds ?? null,
      testFailRounds: input.reviewStats?.testFailRounds ?? null,
      findingsBySeverity: tally(input.findings.map((f) => f.severity)),
      findingsByClass: tally(input.findings.map((f) => f.class)),
    },
    tests: { ciFailures: failedShas.size },
    effort: { calendarHours: Number.isFinite(createdMs) && mergedMs >= createdMs ? Math.round(((mergedMs - createdMs) / HOUR_MS) * 10) / 10 : null },
    postMerge: { fixGlobs },
  };
};

// ---------------------------------------------------------------------------
// Examples for the prompt

/** Whether a person changed what intake chose (its category or type). */
export const wasCorrected = (outcome: GlobOutcome | null): boolean =>
  outcome !== null && (outcome.corrections.category !== null || outcome.corrections.type !== null);

export interface ExampleCandidate {
  readonly snapshot: IntakeSnapshot;
  readonly outcome: GlobOutcome | null;
  /** Cosine distance from the new request (0 is identical). */
  readonly distance: number;
}

export interface IntakeExample {
  readonly globId: string;
  readonly title: string;
  readonly request: string;
  /** The type and category the glob ended up with (a person's correction applied). */
  readonly type: SlopType;
  readonly category: Category;
  readonly corrected: boolean;
  /** What changed or happened, for the prompt and the card; null when nothing did. */
  readonly note: string | null;
  readonly distance: number;
}

const noteOf = (outcome: GlobOutcome | null): string | null => {
  if (outcome === null) return null;
  const parts: string[] = [];
  const { category, type, subConverted } = outcome.corrections;
  if (category !== null) parts.push(`category changed ${category.from} -> ${category.to}`);
  if (type !== null) parts.push(`type changed ${type.from} -> ${type.to}`);
  if (subConverted !== null) {
    const lines = outcome.size.changedLines;
    parts.push(`sub converted to same for ${subConverted === 'size' ? `size${lines === null ? '' : `, ${lines} lines`}` : 'a sensitive path'}`);
  }
  if (outcome.corrections.split) parts.push('split into parts');
  return parts.length === 0 ? null : parts.join('; ');
};

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= EXAMPLE_EXCERPT ? flat : `${flat.slice(0, EXAMPLE_EXCERPT - 1)}…`;
};

/**
 * The examples to show: of the `EXAMPLE_POOL` nearest, the corrected ones first (they hold what the team wanted over what
 * intake chose), then the rest, each group nearest first; at most `limit`. `candidates` need not be sorted.
 */
export const selectExamples = (candidates: readonly ExampleCandidate[], limit = EXAMPLE_LIMIT): IntakeExample[] => {
  const nearest = [...candidates].sort((a, b) => a.distance - b.distance).slice(0, EXAMPLE_POOL);
  const corrected = nearest.filter((c) => wasCorrected(c.outcome));
  const rest = nearest.filter((c) => !wasCorrected(c.outcome));
  return [...corrected, ...rest].slice(0, limit).map(({ snapshot, outcome, distance }) => ({
    globId: snapshot.globId,
    title: snapshot.title,
    request: excerpt(snapshot.request),
    type: outcome?.corrections.type?.to ?? snapshot.decisions.type,
    category: outcome?.corrections.category?.to ?? snapshot.decisions.category,
    corrected: wasCorrected(outcome),
    note: noteOf(outcome),
    distance,
  }));
};

/** Whether the nearest examples disagree about the category: intake is then unsure. */
export const examplesDisagree = (examples: readonly IntakeExample[]): boolean => {
  const nearest = [...examples].sort((a, b) => a.distance - b.distance).slice(0, DISAGREE_WINDOW);
  return new Set(nearest.map((e) => e.category)).size > 1;
};

/** The prompt block that shows examples; empty when there are none. */
export const examplesBlock = (examples: readonly IntakeExample[]): string =>
  examples.length === 0
    ? ''
    : [
        "Examples from this board's history (similar requests, corrected ones first; what they ended up as reflects the team's wishes):",
        ...examples.map(
          (e) => `- ${e.globId} "${e.request}" -> type ${e.type}, category ${e.category}${e.note === null ? '' : ` (${e.note})`}`,
        ),
      ].join('\n');

/** Whether the card asks the person to confirm the category: intake said low, or similar globs disagree. */
export const needsConfirmation = (confidence: Confidence | null, examples: readonly IntakeExample[]): boolean =>
  confidence === 'low' || examplesDisagree(examples);

// ---------------------------------------------------------------------------
// Accuracy

export interface AccuracyRow {
  readonly key: string;
  /** Merged globs with an outcome. */
  readonly merged: number;
  /** Of them, those whose category or type a person changed. */
  readonly corrected: number;
  /** corrected / merged; null when none merged. */
  readonly rate: number | null;
}

export interface MedianRow {
  readonly key: string;
  readonly merged: number;
  readonly medianChangedLines: number | null;
  readonly medianCalendarHours: number | null;
  readonly medianReviewRounds: number | null;
}

export interface IntakeAccuracy {
  readonly snapshots: number;
  readonly merged: number;
  readonly corrected: number;
  readonly byMonth: readonly AccuracyRow[];
  readonly byPromptVersion: readonly AccuracyRow[];
  /** Medians per `type/category` of the merged globs' final values. */
  readonly byKind: readonly MedianRow[];
}

const median = (values: readonly (number | null)[]): number | null => {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : (((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
};

const rowsOf = (groups: Map<string, boolean[]>): AccuracyRow[] =>
  [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, flags]) => {
      const corrected = flags.filter(Boolean).length;
      return { key, merged: flags.length, corrected, rate: flags.length === 0 ? null : corrected / flags.length };
    });

/** How often intake's category and type survived to the merge, by creation month and prompt version, and typical effort by kind. */
export const intakeAccuracy = (snapshots: readonly IntakeSnapshot[], outcomes: readonly GlobOutcome[]): IntakeAccuracy => {
  const byGlob = new Map(snapshots.map((s) => [s.globId, s]));
  const month = new Map<string, boolean[]>();
  const prompt = new Map<string, boolean[]>();
  const kinds = new Map<string, GlobOutcome[]>();
  let corrected = 0;
  let merged = 0;
  for (const outcome of outcomes) {
    const snapshot = byGlob.get(outcome.globId);
    // Backfilled snapshots hold no intake decision: nothing to be right or wrong about.
    if (snapshot === undefined || snapshot.backfilled) continue;
    merged++;
    const was = wasCorrected(outcome);
    if (was) corrected++;
    const m = snapshot.createdAt.slice(0, 7);
    month.set(m, [...(month.get(m) ?? []), was]);
    const v = snapshot.decisions.promptVersion === null ? 'none' : `v${snapshot.decisions.promptVersion}`;
    prompt.set(v, [...(prompt.get(v) ?? []), was]);
    const kind = `${outcome.corrections.type?.to ?? snapshot.decisions.type}/${outcome.corrections.category?.to ?? snapshot.decisions.category}`;
    kinds.set(kind, [...(kinds.get(kind) ?? []), outcome]);
  }
  return {
    snapshots: snapshots.length,
    merged,
    corrected,
    byMonth: rowsOf(month),
    byPromptVersion: rowsOf(prompt),
    byKind: [...kinds]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, list]) => ({
        key,
        merged: list.length,
        medianChangedLines: median(list.map((o) => o.size.changedLines)),
        medianCalendarHours: median(list.map((o) => o.effort.calendarHours)),
        medianReviewRounds: median(list.map((o) => o.review.rounds)),
      })),
  };
};
