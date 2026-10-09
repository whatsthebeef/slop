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

/** Steps GitHub or the workflow runs before the project's own commands: job set-up, service containers, checkout, tool set-up, install. */
const SETUP_STEP = /^(set up job|initialize containers|run actions\/(checkout|setup-[\w-]+|cache)\b|run pnpm\/action-setup\b|set up |install\b|pnpm install\b)/i;
/** Log lines that name an outage when no step is known: a pull limit, a lost runner, an unreachable registry. */
const SETUP_LINE = /toomanyrequests|rate limit exceeded|failed to pull image|lost communication with the server|runner has received a shutdown signal|unable to resolve action|ECONNRESET|ETIMEDOUT|EAI_AGAIN|503 service unavailable/i;
/** An install that fails because of the change itself (the lockfile or a version that doesn't exist), not an outage. */
const INSTALL_CODE_ERROR = /lockfile|ERR_PNPM_(OUTDATED|NO_MATCHING|FROZEN|UNSUPPORTED|PEER)/i;

/**
 * Whether a failed check broke before the project's own steps ran (an outage in CI's setup, not the change): the
 * failed step is job set-up, a service container, checkout, tool set-up or install, or, when no step is known, the log
 * names an outage. Anything else (Lint, Type check, Test, an unknown step) is a code failure.
 */
export const isSetupFailure = (failure: CheckFailure): boolean => {
  const text = failure.lines.join('\n');
  if (failure.step === null) return SETUP_LINE.test(text);
  if (!SETUP_STEP.test(failure.step.trim())) return false;
  return !(/^(install\b|pnpm install\b)/i.test(failure.step.trim()) && INSTALL_CODE_ERROR.test(text));
};

const MAX_LINES = 6;
const MAX_LINE_LENGTH = 240;
const ERROR_LINE = /error|fail|✖|✘|✗|not ok|assertion|cannot find|is missing|exception|exit code [1-9]/i;

const POST_JOB_CLEANUP = /Post job cleanup\.\s*$/;
const PROCESS_COMPLETED = /^Process completed with exit code \d+\.?$/i;

/**
 * The job's own steps: everything from the first "Post job cleanup." line on is dropped. GitHub prints service
 * container logs (Postgres startup and shutdown) after it, and they would otherwise bury or mimic the real error.
 */
export const jobOwnLog = (log: string): string => {
  const lines = log.split('\n');
  const cleanup = lines.findIndex((line) => POST_JOB_CLEANUP.test(line.trim()));
  return cleanup === -1 ? log : lines.slice(0, cleanup).join('\n');
};

/**
 * Picks the lines worth showing from the tail of a job log: the first few lines GitHub marks `##[error]`, else the
 * first error-looking ones, else the last few non-empty ones. The bare `Process completed with exit code N.` line
 * comes after the others, as a last resort. Timestamps, ANSI colour codes and the marker are removed.
 */
export const failureLines = (log: string): string[] => {
  const clean = jobOwnLog(log)
    .split('\n')
    .map((raw) => {
      const line = raw
        // eslint-disable-next-line no-control-regex -- ANSI escape sequences in CI logs
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')
        .trim();
      const marked = /^##\[error\]/.test(line);
      return { text: line.replace(/^##\[(?:error|warning)\]/, '').trim(), marked };
    })
    .filter((line) => line.text !== '');
  const completed = clean.filter((line) => PROCESS_COMPLETED.test(line.text));
  const rest = clean.filter((line) => !PROCESS_COMPLETED.test(line.text));
  const marked = rest.filter((line) => line.marked);
  const errors = marked.length > 0 ? marked : rest.filter((line) => ERROR_LINE.test(line.text));
  const picked =
    errors.length + completed.length > 0
      ? [...errors, ...completed].slice(0, MAX_LINES)
      : clean.slice(-MAX_LINES);
  return picked.map(({ text }) => (text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH - 1)}…` : text));
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
