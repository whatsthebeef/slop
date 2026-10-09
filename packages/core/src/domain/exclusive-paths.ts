import { matchesGlob } from './sub-gate.js';
import type { MergePolicy } from './merge-policy.js';
import type { ImpliedAfter } from './types.js';

/** At most this many paths are kept on a hold or a clash: enough to say why. */
export const MAX_HOLD_PATHS = 5;

/** The files that fall under one of the policy's exclusive path globs. */
export const exclusiveFiles = (policy: MergePolicy, files: readonly string[]): string[] => {
  const globs = policy.exclusivePaths ?? [];
  return files.filter((file) => globs.some((glob) => matchesGlob(file, glob)));
};

/** The directory a path glob names before its first wildcard: `apps/server/drizzle/**` gives `apps/server/drizzle`. */
const literalDirectory = (glob: string): string => {
  const literal = glob.trim().split(/[*?]/)[0] ?? '';
  return literal.replace(/\/+$/, '');
};

const SCHEMA_WORDS = /\b(migrations?|schema|drizzle)\b/i;

/**
 * Whether a glob's plan says it will change an exclusive path: it names one (the literal directory of an exclusive
 * glob) or a migration ("migration", "schema", "drizzle"). Slop can't know before the work is done, so this is the
 * hint for holding a glob that hasn't started.
 */
export const namesExclusivePath = (policy: MergePolicy, plan: string): boolean => {
  const globs = policy.exclusivePaths ?? [];
  if (globs.length === 0) return false;
  if (SCHEMA_WORDS.test(plan)) return true;
  return globs.some((glob) => {
    const directory = literalDirectory(glob);
    return directory.length >= 3 && plan.includes(directory);
  });
};

/** Adds holds to a glob's, one per awaited glob; an existing hold (even an overridden one) is kept as it is. */
export const mergeImplied = (
  existing: readonly ImpliedAfter[] | undefined,
  added: readonly ImpliedAfter[],
): ImpliedAfter[] => {
  const kept = [...(existing ?? [])];
  for (const hold of added) if (!kept.some((k) => k.id === hold.id)) kept.push(hold);
  return kept;
};
