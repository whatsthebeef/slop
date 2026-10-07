import { LLM_WAITING_PREFIX } from './kb.js';
import { markdownHeadings } from './sections.js';

/**
 * Review findings (spec, self-improvement signals): local reviews and CodeRabbit inline comments
 * are split into findings, and each finding is classified into a fixed class, so they can be
 * counted per glob, commit and agent-set version.
 */
export const FINDING_SOURCES = ['local_review', 'coderabbit'] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

export const FINDING_SEVERITIES = ['in_scope', 'suggestion', 'unknown'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** A finding's classification. */
export const FINDING_STATES = ['pending', 'classified', 'failed'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

/** A review source's splitting into findings. */
export const REVIEW_SOURCE_STATES = ['pending', 'split', 'failed'] as const;
export type ReviewSourceState = (typeof REVIEW_SOURCE_STATES)[number];

export const REVIEW_SOURCE_KINDS = ['local_review', 'coderabbit_comment'] as const;
export type ReviewSourceKind = (typeof REVIEW_SOURCE_KINDS)[number];

/** Countable classes beat free labels: new ones are added here when `other` notes cluster. */
export const FINDING_CLASSES = [
  'missing-test',
  'weak-test',
  'unhandled-error',
  'edge-case',
  'concurrency',
  'security',
  'input-validation',
  'timeout-resource',
  'performance',
  'logic-error',
  'ui-state',
  'migration-schema',
  'spec-drift',
  'convention',
  'dead-code-comments',
  'dependency',
  'scope',
  'other',
] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

/** One line per class, used in the classifier prompt and in the UI's tooltips. */
export const FINDING_CLASS_DESCRIPTIONS: Readonly<Record<FindingClass, string>> = {
  'missing-test': 'new or changed behaviour without a test',
  'weak-test': "tests that are order- or timing-dependent, test implementation details or don't assert the behaviour",
  'unhandled-error': "an error path that isn't handled, is swallowed or loses its context",
  'edge-case': 'empty, missing, duplicate or boundary values',
  concurrency: 'races, unconditional writes, missing locks or idempotency',
  security: 'injection, authorisation, CSRF, secrets or personal data',
  'input-validation': 'unvalidated input at a boundary',
  'timeout-resource': 'missing deadlines or timeouts, leaks, unbounded loads',
  performance: 'N+1, missing index, needless work',
  'logic-error': 'wrong logic in new code that no other class covers',
  'ui-state': 'stale or wrong data shown, broken interaction',
  'migration-schema': 'journal, idempotency, schema drift',
  'spec-drift': 'spec or docs disagree with the code',
  convention: "a departure from the board's conventions, layering or type rules",
  'dead-code-comments': 'dead code, misplaced or stale comments, leftover debugging',
  dependency: 'unexpected manifest or lockfile changes, vulnerable dependencies',
  scope: 'an unmet acceptance criterion or a change outside scope',
  other: 'none of the above',
};

/** A review waiting to be split into findings, or already split: a local review artifact or one CodeRabbit comment. */
export interface ReviewSource {
  readonly id: number;
  readonly boardId: number;
  readonly globId: string;
  readonly kind: ReviewSourceKind;
  /** Local reviews: the artifact (version) the text is read from. */
  readonly artifactId: number | null;
  /** CodeRabbit comments: `coderabbit:<comment id>`, so a redelivery isn't stored twice. */
  readonly externalId: string | null;
  readonly commitSha: string | null;
  readonly agentSetVersion: number | null;
  /** CodeRabbit comments only: the comment's text (local reviews are read from their artifact). */
  readonly content: string | null;
  readonly path: string | null;
  readonly line: string | null;
  readonly state: ReviewSourceState;
  /** Failed split attempts (LLM errors, unusable answers, timeouts). */
  readonly attempts: number;
  /** Retry backoff, or a claimed source's lease. */
  readonly processAfter: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly version: number;
}

export type NewReviewSource = Omit<ReviewSource, 'id' | 'state' | 'attempts' | 'processAfter' | 'error' | 'version'>;

export interface ReviewFinding {
  readonly id: number;
  readonly boardId: number;
  readonly globId: string;
  readonly sourceId: number;
  readonly source: FindingSource;
  readonly commitSha: string | null;
  readonly agentSetVersion: number | null;
  readonly severity: FindingSeverity;
  /** The review round it was reported in, when the review says. */
  readonly round: number | null;
  readonly path: string | null;
  /** A line or a range (`256-268`). */
  readonly line: string | null;
  readonly text: string;
  /** Dedupes a finding repeated across versions and rounds of a glob's reviews (`fingerprint`). */
  readonly fingerprint: string;
  readonly class: FindingClass | null;
  /** The classifier's one line on what specifically is wrong (for `other`, what the class would be). */
  readonly classNote: string | null;
  readonly state: FindingState;
  readonly attempts: number;
  readonly processAfter: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly classifiedAt: string | null;
  readonly version: number;
}

export type NewFinding = Omit<
  ReviewFinding,
  'id' | 'class' | 'classNote' | 'state' | 'attempts' | 'processAfter' | 'error' | 'createdAt' | 'classifiedAt' | 'version'
>;

/** A finding as `splitReview` (or the split model) reports it, before it is stored. */
export interface SplitFinding {
  readonly severity: FindingSeverity;
  readonly round: number | null;
  readonly path: string | null;
  readonly line: string | null;
  readonly text: string;
}

/** The longest finding text kept; longer items are cut. */
export const FINDING_TEXT_LIMIT = 4_000;

/** "IN-SCOPE", "In scope (3)", "Suggestions:", "**SUGGESTIONS**". */
const SECTION = /^(in[- ]scope|suggestions?)$/i;
/** Sections that compile earlier items rather than report new ones. */
const COMPILED = /potential adjustments|deferred|known, accepted/i;
const ROUND = /round\s+(\d+)/i;
const ITEM = /^(?:\d+\.|[-*])\s+/;
const FENCE = /^\s*(```|~~~)/;
/** A leading `**[path:line, other]**` (or `**[path:line and other]**`) naming where the finding is. */
const LOCATION = /^\*\*\[([^\]]+)\]\*\*/;

const sectionName = (heading: string): string =>
  heading
    .replace(/[*_`]/g, '')
    .replace(/\s*[(:[].*$/, '')
    .trim();

const location = (text: string): { path: string | null; line: string | null } => {
  const match = LOCATION.exec(text);
  const first = match?.[1]?.split(/[,;]|\s+and\s+/)[0]?.replace(/`/g, '').trim() ?? '';
  if (first === '' || /\s/.test(first)) return { path: null, line: null };
  const parts = /^(.+?):(\d+(?:-\d+)?)$/.exec(first);
  if (parts === null) return { path: first, line: null };
  return { path: parts[1] ?? null, line: parts[2] ?? null };
};

/** The lines of one list item: its first line without the marker, then its continuation lines without their common indent. */
const itemText = (first: string, continuation: readonly string[]): string => {
  const indents = continuation.filter((l) => l.trim() !== '').map((l) => /^\s*/.exec(l)?.[0].length ?? 0);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return [first.replace(ITEM, ''), ...continuation.map((l) => l.slice(indent))]
    .join('\n')
    .trim()
    .slice(0, FINDING_TEXT_LIMIT);
};

/**
 * Splits a change_reviewer review document into findings: the top-level list items (and their
 * indented continuation lines) under its IN-SCOPE and SUGGESTIONS headings, with the round from
 * the nearest earlier "round n" heading and the location from a leading `**[path:line]**`. Tables
 * (round status tables restating earlier items) and sections that compile earlier items
 * (potential adjustments, deferred, known and accepted) are skipped. `structured` is false when
 * the document has no such heading: free-form reviews need the split model instead.
 */
export const splitReview = (markdown: string): { structured: boolean; findings: SplitFinding[] } => {
  const lines = markdown.split(/\r?\n/);
  const headings = markdownHeadings(markdown);
  const findings: SplitFinding[] = [];
  let structured = false;
  headings.forEach((heading, index) => {
    const name = sectionName(heading.text);
    if (!SECTION.test(name)) return;
    structured = true;
    const before = headings.slice(0, index);
    // An enclosing section (a lower-level heading above it) that only compiles earlier items.
    let level = heading.level;
    for (const h of [...before].reverse()) {
      if (h.level >= level) continue;
      if (COMPILED.test(h.text)) return;
      level = h.level;
    }
    const roundHeading = [...before].reverse().find((h) => ROUND.test(h.text));
    const roundMatch = roundHeading === undefined ? null : ROUND.exec(roundHeading.text);
    const round = roundMatch === null ? null : Number(roundMatch[1]);
    const severity: FindingSeverity = /^in/i.test(name) ? 'in_scope' : 'suggestion';
    const end = headings.slice(index + 1).find((h) => h.level <= heading.level)?.line ?? lines.length;
    let fenced = false;
    let current: { first: string; continuation: string[] } | null = null;
    const flush = () => {
      if (current === null) return;
      const text = itemText(current.first, current.continuation);
      if (text !== '') findings.push({ severity, round, ...location(text), text });
      current = null;
    };
    for (let i = heading.line + 1; i < end; i++) {
      const line = lines[i] ?? '';
      if (FENCE.test(line)) {
        fenced = !fenced;
        if (current !== null) current.continuation.push(line);
        continue;
      }
      if (fenced) {
        if (current !== null) current.continuation.push(line);
      } else if (ITEM.test(line)) {
        flush();
        current = { first: line, continuation: [] };
      } else if (current !== null && (line.trim() === '' || /^\s/.test(line))) {
        current.continuation.push(line);
      } else if (line.trim() !== '') {
        // Anything else at column 0 (a paragraph, a table, a subheading) ends the item.
        flush();
      }
    }
    flush();
  });
  return { structured, findings };
};

/**
 * What identifies a finding across versions and rounds of a glob's reviews: lower case, without
 * markdown markers or the line numbers of a leading `[path:line]` (the path is kept), whitespace
 * collapsed, the first 300 characters.
 */
export const fingerprint = (text: string): string =>
  text
    .toLowerCase()
    .replace(/^\s*(\*\*)?\[([^\]]*)\]/, (_match, _bold, inner: string) => `[${inner.replace(/:\d+(?:-\d+)?/g, '')}]`)
    .replace(/[*`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

/**
 * A CodeRabbit inline comment's severity, from its label: the first non-empty line before its
 * first `<details>` (often in `_..._`, so not `\b`). The rest of the body, its suggested code and
 * agent prompt included, is ignored, so a "critical section" in the text doesn't make it in scope.
 */
export const coderabbitSeverity = (body: string): FindingSeverity => {
  const cut = body.indexOf('<details>');
  const label = (cut < 0 ? body : body.slice(0, cut)).split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  if (label.includes('Potential issue') || /(?<![a-z])critical(?![a-z])/i.test(label)) return 'in_scope';
  if (label.includes('Refactor suggestion') || /(?<![a-z])nitpick/i.test(label) || label.includes('🧹')) return 'suggestion';
  return 'unknown';
};

/** A CodeRabbit inline comment's finding text: up to its first `<details>` (the agent prompt and committable suggestion). */
export const coderabbitText = (body: string): string => {
  const cut = body.indexOf('<details>');
  return (cut < 0 ? body : body.slice(0, cut)).trim().slice(0, FINDING_TEXT_LIMIT);
};

/** A glob's findings as the glob view shows them: no fingerprint, version or queue fields but state and error. */
export type FindingView = Omit<ReviewFinding, 'boardId' | 'globId' | 'sourceId' | 'fingerprint' | 'attempts' | 'processAfter' | 'version'>;

export interface GlobFindings {
  readonly findings: readonly FindingView[];
  /** Classified findings per class, most first. `total` includes findings of unknown severity. */
  readonly byClass: readonly { readonly class: FindingClass; readonly total: number; readonly inScope: number; readonly suggestions: number }[];
  /** Findings still waiting to be classified, and those it gave up on. */
  readonly pending: number;
  readonly failed: number;
  /** Reviews still waiting to be split, and those it gave up on. */
  readonly sources: { readonly pending: number; readonly failed: number };
  /** Why processing is stalled while the AI is unavailable (a pending review's or finding's reason), else null. */
  readonly waiting: string | null;
}

/** The glob view's summary of a glob's findings and review sources. */
export const globFindings = (findings: readonly ReviewFinding[], sources: readonly ReviewSource[]): GlobFindings => {
  const counts = new Map<FindingClass, { total: number; inScope: number; suggestions: number }>();
  for (const f of findings) {
    if (f.state !== 'classified' || f.class === null) continue;
    const c = counts.get(f.class) ?? { total: 0, inScope: 0, suggestions: 0 };
    counts.set(f.class, {
      total: c.total + 1,
      inScope: c.inScope + (f.severity === 'in_scope' ? 1 : 0),
      suggestions: c.suggestions + (f.severity === 'suggestion' ? 1 : 0),
    });
  }
  return {
    findings: findings.map(
      (f): FindingView => ({
        id: f.id,
        source: f.source,
        commitSha: f.commitSha,
        agentSetVersion: f.agentSetVersion,
        severity: f.severity,
        round: f.round,
        path: f.path,
        line: f.line,
        text: f.text,
        class: f.class,
        classNote: f.classNote,
        state: f.state,
        error: f.error,
        createdAt: f.createdAt,
        classifiedAt: f.classifiedAt,
      }),
    ),
    byClass: [...counts.entries()]
      .map(([cls, c]) => ({ class: cls, ...c }))
      .sort((a, b) => b.total - a.total || FINDING_CLASSES.indexOf(a.class) - FINDING_CLASSES.indexOf(b.class)),
    pending: findings.filter((f) => f.state === 'pending').length,
    failed: findings.filter((f) => f.state === 'failed').length,
    sources: {
      pending: sources.filter((s) => s.state === 'pending').length,
      failed: sources.filter((s) => s.state === 'failed').length,
    },
    waiting:
      [...sources, ...findings]
        .find((item) => item.state === 'pending' && item.error?.startsWith(LLM_WAITING_PREFIX) === true)
        ?.error?.slice(LLM_WAITING_PREFIX.length) ?? null,
  };
};
