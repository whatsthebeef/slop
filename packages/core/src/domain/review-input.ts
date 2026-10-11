import { estimateTokens } from './search.js';
import { isSkippedPath } from './independent-review.js';

/**
 * What the independent reviewer is given (spec, Input and Level 1): the change's diff without lockfiles, generated
 * files and ignored paths, a short plan summary, and a per-file history briefing. Pure: the service fetches, this shapes.
 */

export interface SkippedFile {
  readonly path: string;
  readonly reason: 'lockfile-or-generated' | 'ignored' | 'binary';
}

export interface FilteredDiff {
  /** The diff of the files the reviewer reads, followed by one line naming what was left out (when anything was). */
  readonly diff: string;
  /** The files kept, in diff order. */
  readonly files: readonly string[];
  readonly skipped: readonly SkippedFile[];
}

/** How many skipped names the note under the diff lists; the rest are counted. */
const SKIPPED_NAMES_SHOWN = 20;

const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const BINARY = /^(Binary files .* differ|GIT binary patch)$/m;

/** The path a `diff --git` section is about (its new path, or the old one for a deletion). */
const sectionPath = (header: string, lines: readonly string[]): string | null => {
  const match = GIT_HEADER.exec(header);
  if (match === null) return null;
  const deleted = lines.some((line) => line === '+++ /dev/null');
  return (deleted ? match[1] : match[2]) ?? null;
};

/**
 * Keeps the sections of a git unified diff that hold code to review. Lockfiles and generated output
 * (`isSkippedPath`), the board's ignored paths and binary files are left out and named in one closing line, so the
 * reviewer knows they exist but never reads them. A diff with no `diff --git` sections is returned unchanged.
 */
export const filterDiff = (diff: string, ignored: readonly RegExp[] = []): FilteredDiff => {
  const lines = diff.split('\n');
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ')) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  if (sections.length === 0) return { diff, files: [], skipped: [] };

  const kept: string[] = [];
  const files: string[] = [];
  const skipped: SkippedFile[] = [];
  for (const section of sections) {
    const [header = '', ...rest] = section;
    const path = sectionPath(header, rest);
    if (path === null) continue;
    if (isSkippedPath(path)) skipped.push({ path, reason: 'lockfile-or-generated' });
    else if (ignored.some((pattern) => pattern.test(path)))
      skipped.push({ path, reason: 'ignored' });
    else if (BINARY.test(section.join('\n'))) skipped.push({ path, reason: 'binary' });
    else {
      kept.push(section.join('\n').replace(/\n+$/, ''));
      files.push(path);
    }
  }

  const note =
    skipped.length === 0
      ? ''
      : `\n[not shown: ${skipped
          .slice(0, SKIPPED_NAMES_SHOWN)
          .map((file) => file.path)
          .join(
            ', ',
          )}${skipped.length > SKIPPED_NAMES_SHOWN ? `, and ${skipped.length - SKIPPED_NAMES_SHOWN} more` : ''} (lockfiles, generated, ignored or binary)]`;
  return { diff: `${kept.join('\n')}${note}`, files, skipped };
};

/** The most the plan summary may hold: it frames the review, it is not the whole plan. */
export const PLAN_SUMMARY_LIMIT = 4_000;

const checkbox = /^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?)?/;

/**
 * What the change is meant to do: the glob's title and summary, then the plan's "Done when" lines (a line holds its
 * own, whether a list item or a sentence), without the rest of the plan.
 */
export const planSummary = (
  glob: { readonly title: string; readonly summary: string },
  plan: string | null,
): string => {
  const doneWhen = (plan ?? '')
    .split('\n')
    .filter((line) => /done when/i.test(line))
    .map((line) => line.replace(checkbox, '').trim());
  const parts = [
    glob.title,
    glob.summary.trim(),
    doneWhen.length === 0 ? '' : `Done when:\n${doneWhen.map((line) => `- ${line}`).join('\n')}`,
  ];
  return parts
    .filter((part) => part !== '')
    .join('\n\n')
    .slice(0, PLAN_SUMMARY_LIMIT);
};

/** One earlier merged change to a file. */
export interface FileChange {
  readonly globId: string | null;
  readonly title: string;
  readonly date: string;
  /** The stored "why": its Files line and summary. */
  readonly summary: string;
}

export interface FileDecision {
  readonly globId: string | null;
  readonly statement: string;
  readonly date: string;
  /** True for a decision a newer one replaced: shown as history. */
  readonly superseded: boolean;
}

/** What slopmux knows about one touched file from earlier work. */
export interface FileHistory {
  readonly path: string;
  /** Newest first. */
  readonly changes: readonly FileChange[];
  /** Earlier review findings and failing test runs, each one line. */
  readonly problems: readonly string[];
  readonly decisions: readonly FileDecision[];
}

/** "A few thousand tokens" (spec): the whole briefing stays within this. */
export const HISTORY_BRIEFING_TOKENS = 3_000;
export const HISTORY_CHANGES_PER_FILE = 4;
export const HISTORY_PROBLEMS_PER_FILE = 4;
export const HISTORY_DECISIONS_PER_FILE = 3;
const CHANGE_TEXT_LIMIT = 400;
const LINE_LIMIT = 300;

const clip = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

const day = (iso: string): string => iso.slice(0, 10);

const renderFile = (file: FileHistory): string => {
  const out = [`### ${file.path}`];
  for (const change of file.changes.slice(0, HISTORY_CHANGES_PER_FILE)) {
    const who = change.globId === null ? '' : `${change.globId} `;
    out.push(
      `- Changed ${day(change.date)} by ${who}"${clip(change.title, 120)}": ${clip(change.summary, CHANGE_TEXT_LIMIT)}`,
    );
  }
  for (const problem of file.problems.slice(0, HISTORY_PROBLEMS_PER_FILE))
    out.push(`- Past problem: ${clip(problem, LINE_LIMIT)}`);
  for (const decision of file.decisions.slice(0, HISTORY_DECISIONS_PER_FILE)) {
    const label = decision.superseded ? 'Superseded decision (history only)' : 'Decision';
    out.push(
      `- ${label} ${day(decision.date)}${decision.globId === null ? '' : ` (${decision.globId})`}: ${clip(decision.statement, LINE_LIMIT)}`,
    );
  }
  return out.join('\n');
};

const hasHistory = (file: FileHistory): boolean =>
  file.changes.length + file.problems.length + file.decisions.length > 0;

/**
 * The Level 1 briefing: for each touched file with history, its recent changes (newest first), past problems and
 * the decisions behind it, within `HISTORY_BRIEFING_TOKENS`. Files are taken in the order given (the diff's), and
 * the line at the end says how many were left out for space. Empty when no file has any history.
 */
export const renderHistoryBriefing = (
  files: readonly FileHistory[],
  tokenBudget: number = HISTORY_BRIEFING_TOKENS,
): string => {
  const withHistory = files.filter(hasHistory);
  if (withHistory.length === 0) return '';
  const blocks: string[] = [];
  let used = 0;
  for (const file of withHistory) {
    const block = renderFile(file);
    const cost = estimateTokens(block);
    if (blocks.length > 0 && used + cost > tokenBudget) break;
    blocks.push(block);
    used += cost;
  }
  const left = withHistory.length - blocks.length;
  const note =
    left === 0
      ? ''
      : `\n\n(History for ${left} more changed ${left === 1 ? 'file' : 'files'} left out to keep this short.)`;
  return `## History of the changed files\n\nWhat earlier work on these files recorded. Use it to spot a change that undoes an earlier fix or ignores a decision; it is background, not part of the diff.\n\n${blocks.join('\n\n')}${note}`;
};
