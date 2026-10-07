/**
 * Failed-check explanations and the red-base rule: a glob whose head fails the same check with the same first error
 * as the base branch's head is red because of the base, not its own change. Pure functions, no I/O.
 */
import type { BaseChecks, CheckFailure, InheritedFailure } from './types.js';

/** The first error line of a failure: what two failures are compared by (case and surrounding space ignored). */
export const firstError = (failure: CheckFailure): string => (failure.lines[0] ?? '').trim().toLowerCase();

/** The same check failing the same way. Failures with no error line never match: nothing says they're alike. */
export const sameFailure = (a: CheckFailure, b: CheckFailure): boolean =>
  a.name === b.name && firstError(a) !== '' && firstError(a) === firstError(b);

/** Whether a glob's failed head checks come from the base branch being red the same way. */
export const inheritedFailure = (
  failure: CheckFailure | undefined,
  base: BaseChecks | null | undefined,
  baseBranch: string,
): InheritedFailure | null => {
  if (failure === undefined || base == null || base.state !== 'failed' || base.failure === undefined) return null;
  return sameFailure(failure, base.failure) ? { base: baseBranch, since: base.since } : null;
};

const MAX_LINES = 6;
const MAX_LINE_LENGTH = 240;
const ERROR_LINE = /error|fail|✖|✘|✗|not ok|assertion|cannot find|is missing|exception|exit code [1-9]/i;

/**
 * Picks the lines worth showing from the tail of a job log: the first few error-looking lines, else the last few
 * non-empty ones. Timestamps and ANSI colour codes are removed.
 */
export const failureLines = (log: string): string[] => {
  const clean = log
    .split('\n')
    .map((line) =>
      line
        // eslint-disable-next-line no-control-regex -- ANSI escape sequences in CI logs
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')
        .replace(/^##\[(?:error|warning)\]/, '')
        .trim(),
    )
    .filter((line) => line !== '');
  const errors = clean.filter((line) => ERROR_LINE.test(line));
  const picked = errors.length > 0 ? errors.slice(0, MAX_LINES) : clean.slice(-MAX_LINES);
  return picked.map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line));
};

/** One line for a card: `Type check: <first error>`, or just the name when no error line is known. */
export const failureSummary = (failure: CheckFailure): string => {
  const step = failure.step === null || failure.step === failure.name ? '' : ` (${failure.step})`;
  const first = failure.lines[0];
  return first === undefined ? `${failure.name}${step} failed` : `${failure.name}${step}: ${first}`;
};

/** What a base-branch check result changed. */
export interface BaseChecksChange {
  readonly next: BaseChecks;
  /** Whether the stored result differs from before (so the board is told). */
  readonly changed: boolean;
  /** The base was red and is green now: globs that failed on it should be brought up to date. */
  readonly turnedGreen: boolean;
}

/**
 * Records the latest completed check result for the base branch head. `merged` is the glob named by the head
 * commit's subject. While the base stays red, `since` and `redAt` keep naming the glob that broke it.
 */
export const recordBaseChecks = (
  previous: BaseChecks | null | undefined,
  result: { sha: string; passed: boolean; failure: CheckFailure | null; merged: string | null },
  now: string,
): BaseChecksChange => {
  const wasRed = previous?.state === 'failed';
  const next: BaseChecks = result.passed
    ? { sha: result.sha, state: 'passed', since: null, checkedAt: now }
    : {
        sha: result.sha,
        state: 'failed',
        ...(result.failure !== null && { failure: result.failure }),
        // Still red: the glob that broke it stays named, unless the new head is the first to name one.
        since: wasRed ? (previous.since ?? result.merged) : result.merged,
        redAt: wasRed ? (previous.redAt ?? now) : now,
        checkedAt: now,
      };
  const changed =
    previous == null ||
    previous.sha !== next.sha ||
    previous.state !== next.state ||
    previous.since !== next.since ||
    firstErrorOf(previous.failure) !== firstErrorOf(next.failure);
  return { next, changed, turnedGreen: wasRed && result.passed };
};

const firstErrorOf = (failure: CheckFailure | undefined): string => (failure === undefined ? '' : firstError(failure));
