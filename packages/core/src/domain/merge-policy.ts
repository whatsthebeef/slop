import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';

/**
 * A board's merge policy: which paths clash when two globs change them at once. One knowledge row (kind
 * `merge_policy`, name `merge-policy`) that changes only through an approved KB item, and is checked on every write
 * and read: it decides which globs hold for each other.
 *
 * - `exclusivePaths`: path globs that only one open glob may change at a time (e.g. a migrations directory).
 * - `sizeIgnoredPaths`: path globs left out when a sub's size is measured (read by the sub gate, not here).
 *
 * `{}` is a valid policy: it exists, and nothing is configured.
 */
export interface MergePolicy {
  readonly exclusivePaths?: readonly string[];
  readonly sizeIgnoredPaths?: readonly string[];
}

/** The one row's name. */
export const MERGE_POLICY_NAME = 'merge-policy';
/** Longest path glob, in characters. */
export const MERGE_POLICY_PATH_MAX = 200;
/** Most globs in one list. */
export const MERGE_POLICY_PATHS_MAX = 50;

const KEYS = ['exclusivePaths', 'sizeIgnoredPaths'] as const;
type PolicyKey = (typeof KEYS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pathList = (policy: Record<string, unknown>, key: PolicyKey): Result<readonly string[] | undefined> => {
  const value = policy[key];
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value)) return invalidInput(`${key} must be a list of path globs`);
  if (value.length > MERGE_POLICY_PATHS_MAX) return invalidInput(`${key} has more than ${MERGE_POLICY_PATHS_MAX} entries`);
  const paths: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') return invalidInput(`${key} must contain only strings`);
    const path = entry.trim();
    if (path === '') return invalidInput(`${key} has an empty entry`);
    if (path.length > MERGE_POLICY_PATH_MAX) return invalidInput(`${key} has an entry longer than ${MERGE_POLICY_PATH_MAX} characters`);
    if (/[\0\r\n]/.test(path)) return invalidInput(`${key} entries must be one line (no newlines or NUL)`);
    if (path.startsWith('/') || path.split('/').includes('..')) {
      return invalidInput(`${key} entry ${path} must be relative to the repo root, with no ..`);
    }
    if (!paths.includes(path)) paths.push(path);
  }
  return ok(paths);
};

/** Checks an already-parsed value: an object with only the known lists, each a list of plain path globs. */
export const checkMergePolicy = (value: unknown): Result<MergePolicy> => {
  if (!isRecord(value)) return invalidInput('The merge policy must be a JSON object');
  const unknown = Object.keys(value).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return invalidInput(`The merge policy has unknown keys: ${unknown.join(', ')}`);
  const exclusive = pathList(value, 'exclusivePaths');
  if (!exclusive.ok) return exclusive;
  const ignored = pathList(value, 'sizeIgnoredPaths');
  if (!ignored.ok) return ignored;
  return ok({
    ...(exclusive.value === undefined ? {} : { exclusivePaths: exclusive.value }),
    ...(ignored.value === undefined ? {} : { sizeIgnoredPaths: ignored.value }),
  });
};

/** Parses and checks a merge policy's text (JSON). */
export const parseMergePolicy = (text: string): Result<MergePolicy> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidInput('The merge policy is not valid JSON');
  }
  return checkMergePolicy(parsed);
};

/** The canonical text of a policy (exclusivePaths first, two-space JSON, trailing newline), so versions diff cleanly. */
export const renderMergePolicy = (policy: MergePolicy): string =>
  `${JSON.stringify(
    {
      ...(policy.exclusivePaths === undefined ? {} : { exclusivePaths: policy.exclusivePaths }),
      ...(policy.sizeIgnoredPaths === undefined ? {} : { sizeIgnoredPaths: policy.sizeIgnoredPaths }),
    },
    null,
    2,
  )}\n`;
