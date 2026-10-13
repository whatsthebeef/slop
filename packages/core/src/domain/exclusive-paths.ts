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

/** Headings whose section lists what the glob changes (a mention elsewhere, in prose, predicts nothing). */
const CHANGE_HEADING = /^#{1,6}\s*(tasks?|files?|files to change|changes?)\b/i;

/**
 * The parts of a plan that name changes: the sections under a Tasks or Files heading, up to the next heading of the same
 * or a higher level. A plan with no headings at all (a one-line summary or a short request) is all of it one statement
 * of what changes, so it counts whole; a structured plan with no such section names none.
 */
const changeSections = (plan: string): string => {
  if (!/^#{1,6}\s/m.test(plan)) return plan;
  const kept: string[] = [];
  let level = 0;
  for (const line of plan.split('\n')) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading !== null) {
      const depth = (heading[1] ?? '').length;
      if (CHANGE_HEADING.test(line)) {
        level = depth;
        continue;
      }
      if (level > 0 && depth <= level) level = 0;
    }
    if (level > 0) kept.push(line);
  }
  return kept.join('\n');
};

/**
 * Whether a glob's plan says it will change an exclusive path: inside a Tasks or Files section it names one (the literal
 * directory of an exclusive glob) or a migration ("migration", "schema", "drizzle"). Prose elsewhere in the plan doesn't
 * count, as a plan that only talks about a path isn't going to change it. Slop can't know before the work is done, so
 * this is the hint for holding a glob that hasn't started.
 */
export const namesExclusivePath = (policy: MergePolicy, plan: string): boolean => {
  const globs = policy.exclusivePaths ?? [];
  if (globs.length === 0) return false;
  const named = changeSections(plan);
  if (SCHEMA_WORDS.test(named)) return true;
  return globs.some((glob) => {
    const directory = literalDirectory(glob);
    return directory.length >= 3 && named.includes(directory);
  });
};

/** Whether a plan's Tasks or Files sections name the file (a mention in prose elsewhere predicts nothing). */
export const plannedChangesName = (plan: string, path: string): boolean => changeSections(plan).includes(path);

/** Adds holds to a glob's, one per awaited glob; an existing hold (even an overridden one) is kept as it is. */
export const mergeImplied = (
  existing: readonly ImpliedAfter[] | undefined,
  added: readonly ImpliedAfter[],
): ImpliedAfter[] => {
  const kept = [...(existing ?? [])];
  for (const hold of added) if (!kept.some((k) => k.id === hold.id)) kept.push(hold);
  return kept;
};
