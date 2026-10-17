import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';

/**
 * A board's merge policy: which paths clash when two globs change them at once. One knowledge row (kind
 * `merge_policy`, name `merge-policy`) that changes only through an approved KB item, and is checked on every write
 * and read: it decides which globs hold for each other.
 *
 * - `exclusivePaths`: path globs that only one open glob may change at a time (e.g. a migrations directory).
 * - `sizeIgnoredPaths`: path globs left out when a sub's size is measured (read by the sub gate, not here).
 * - `rolloutPaths`: path globs whose change usually needs a person after the merge (infrastructure, server settings):
 *   a merge touching one with no `## Rollout` in its implementation record is flagged (`rolloutPathsOf` has the defaults).
 * - `riskPaths`: path globs a board adds to the built-in risk paths (`riskPathsOf`): a change touching one is always a
 *   same, never a sub (infrastructure, IAM, builds, rollout scripts, a board's own agent settings).
 * - `specPaths`: path globs of the repo's spec and guide (product behaviour docs). The post-merge knowledge pass
 *   files a sub when a merge changes behaviour they describe and the PR didn't update them; a board with none gets
 *   fact learnings only.
 * - `subGateCheck`: the name of the check run a sub waits for before slop applies the policy and merges it
 *   (`subGateCheckOf` has the default). A board whose repo still reports a differently named gate sets it here.
 *
 * `{}` is a valid policy: it exists, and nothing is configured.
 */
export interface MergePolicy {
  readonly exclusivePaths?: readonly string[];
  readonly sizeIgnoredPaths?: readonly string[];
  readonly rolloutPaths?: readonly string[];
  readonly riskPaths?: readonly string[];
  readonly specPaths?: readonly string[];
  readonly subGateCheck?: string;
}

/** The check a sub waits for when the policy names none: the repo's `checks` workflow, which runs on every PR. */
export const DEFAULT_SUB_GATE_CHECK = 'checks';

/** The gate check's name: the policy's own, or the default when it has none. */
export const subGateCheckOf = (policy: { readonly subGateCheck?: string } | null | undefined): string =>
  policy?.subGateCheck !== undefined && policy.subGateCheck !== '' ? policy.subGateCheck : DEFAULT_SUB_GATE_CHECK;

/**
 * The rollout paths a board gets when its policy lists none: what the image deploy alone doesn't ship. Drizzle
 * migrations run on server start and workflows deploy with the merge, so neither is a default; a board can still list
 * them in its policy. A path only triggers the rollout check (a model reads the diff): `config.ts` needs a person only
 * when a setting has no default or is production-only.
 */
export const DEFAULT_ROLLOUT_PATHS: readonly string[] = ['infra/**', 'apps/server/src/config.ts'];

/** The path globs whose merge asks for a rollout: the policy's own list, or the defaults when it has none. */
export const rolloutPathsOf = (policy: { readonly rolloutPaths?: readonly string[] } | null | undefined): readonly string[] =>
  policy?.rolloutPaths !== undefined && policy.rolloutPaths.length > 0 ? policy.rolloutPaths : DEFAULT_ROLLOUT_PATHS;

/**
 * The paths a board always gets as risk paths: a change here is infrastructure, IAM, a build or a rollout script, so it
 * is a same (a person reviews it) and usually needs steps after the merge. A board adds its own with `riskPaths`
 * (e.g. its agent settings); `rolloutPaths` count as risk paths too.
 */
export const DEFAULT_RISK_PATHS: readonly string[] = [
  '**/stacks/**',
  '**/*.properties',
  'buildspec*.yml',
  'infra/iam/**',
  'scripts/rollout/**',
  '.github/workflows/**',
];

/** The risk path globs: the defaults, the policy's `rolloutPaths` and its `riskPaths`, without repeats. */
export const riskPathsOf = (
  policy: { readonly rolloutPaths?: readonly string[]; readonly riskPaths?: readonly string[] } | null | undefined,
): readonly string[] => [...new Set([...DEFAULT_RISK_PATHS, ...(policy?.rolloutPaths ?? []), ...(policy?.riskPaths ?? [])])];

/** Where the workflow reporting `check` lives by convention (`checks` in `checks.yml`); the default's file for a name that isn't a plain file name. */
export const subGateWorkflowPath = (check: string): string =>
  `.github/workflows/${/^[\w.-]+$/.test(check) ? check : DEFAULT_SUB_GATE_CHECK}.yml`;

/** The one row's name. */
export const MERGE_POLICY_NAME = 'merge-policy';
/** Longest path glob, in characters. */
export const MERGE_POLICY_PATH_MAX = 200;
/** Most globs in one list. */
export const MERGE_POLICY_PATHS_MAX = 50;
/** Longest gate check name, in characters. */
export const MERGE_POLICY_CHECK_MAX = 100;

const KEYS = ['exclusivePaths', 'sizeIgnoredPaths', 'rolloutPaths', 'riskPaths', 'specPaths', 'subGateCheck'] as const;
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

const checkName = (policy: Record<string, unknown>): Result<string | undefined> => {
  const value = policy.subGateCheck;
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string') return invalidInput('subGateCheck must be a check name (a string)');
  const name = value.trim();
  if (name === '') return invalidInput('subGateCheck must not be empty');
  if (name.length > MERGE_POLICY_CHECK_MAX) return invalidInput(`subGateCheck is longer than ${MERGE_POLICY_CHECK_MAX} characters`);
  if (/[\0\r\n]/.test(name)) return invalidInput('subGateCheck must be one line (no newlines or NUL)');
  return ok(name);
};

/** Checks an already-parsed value: an object with only the known keys: path-glob lists and the gate check's name. */
export const checkMergePolicy = (value: unknown): Result<MergePolicy> => {
  if (!isRecord(value)) return invalidInput('The merge policy must be a JSON object');
  const unknown = Object.keys(value).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return invalidInput(`The merge policy has unknown keys: ${unknown.join(', ')}`);
  const exclusive = pathList(value, 'exclusivePaths');
  if (!exclusive.ok) return exclusive;
  const ignored = pathList(value, 'sizeIgnoredPaths');
  if (!ignored.ok) return ignored;
  const rollout = pathList(value, 'rolloutPaths');
  if (!rollout.ok) return rollout;
  const risk = pathList(value, 'riskPaths');
  if (!risk.ok) return risk;
  const spec = pathList(value, 'specPaths');
  if (!spec.ok) return spec;
  const gate = checkName(value);
  if (!gate.ok) return gate;
  return ok({
    ...(exclusive.value === undefined ? {} : { exclusivePaths: exclusive.value }),
    ...(ignored.value === undefined ? {} : { sizeIgnoredPaths: ignored.value }),
    ...(rollout.value === undefined ? {} : { rolloutPaths: rollout.value }),
    ...(risk.value === undefined ? {} : { riskPaths: risk.value }),
    ...(spec.value === undefined ? {} : { specPaths: spec.value }),
    ...(gate.value === undefined ? {} : { subGateCheck: gate.value }),
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
      ...(policy.rolloutPaths === undefined ? {} : { rolloutPaths: policy.rolloutPaths }),
      ...(policy.riskPaths === undefined ? {} : { riskPaths: policy.riskPaths }),
      ...(policy.subGateCheck === undefined ? {} : { subGateCheck: policy.subGateCheck }),
    },
    null,
    2,
  )}\n`;
