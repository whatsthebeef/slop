import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';

/**
 * A board's local-run spec: the commands sstor runs in a session's server window (`build`, then
 * `launch`). It is one knowledge row (kind `local_run`, name `local-run`) that changes only through an
 * approved KB item, and is checked on every write and read: sstor executes it on developers' machines.
 */
export interface LocalRun {
  readonly build?: string;
  readonly launch: string;
}

/** The one row's name. */
export const LOCAL_RUN_NAME = 'local-run';
/** Longest command, in characters. */
export const LOCAL_RUN_COMMAND_MAX = 2000;

const KEYS: readonly string[] = ['build', 'launch'];

/** Whether a value is a plain object (not an array or null). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const command = (spec: Record<string, unknown>, key: 'build' | 'launch'): Result<string | undefined> => {
  const value = spec[key];
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string') return invalidInput(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') return invalidInput(`${key} is empty`);
  if (trimmed.length > LOCAL_RUN_COMMAND_MAX) return invalidInput(`${key} is longer than ${LOCAL_RUN_COMMAND_MAX} characters`);
  // One shell line each: a newline could hide a second command from whoever reviews the diff.
  if (/[\0\r\n]/.test(trimmed)) return invalidInput(`${key} must be one line (no newlines or NUL)`);
  return ok(trimmed);
};

/** Checks an already-parsed value: an object with `launch` and optionally `build`, nothing else. */
export const checkLocalRun = (value: unknown): Result<LocalRun> => {
  if (!isRecord(value)) return invalidInput('The local-run spec must be a JSON object');
  const unknown = Object.keys(value).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0) return invalidInput(`The local-run spec has unknown keys: ${unknown.join(', ')}`);
  const build = command(value, 'build');
  if (!build.ok) return build;
  const launch = command(value, 'launch');
  if (!launch.ok) return launch;
  if (launch.value === undefined) return invalidInput('The local-run spec needs launch');
  return ok(build.value === undefined ? { launch: launch.value } : { build: build.value, launch: launch.value });
};

/** Parses and checks a local-run spec's text (JSON). */
export const parseLocalRun = (text: string): Result<LocalRun> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidInput('The local-run spec is not valid JSON');
  }
  return checkLocalRun(parsed);
};

/** The canonical text of a spec (build first, two-space JSON, trailing newline), so versions diff cleanly. */
export const renderLocalRun = (spec: LocalRun): string =>
  `${JSON.stringify(spec.build === undefined ? { launch: spec.launch } : { build: spec.build, launch: spec.launch }, null, 2)}\n`;
