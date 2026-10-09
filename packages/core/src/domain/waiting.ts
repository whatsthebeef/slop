/**
 * "Waits for": a glob waits for other globs on its board to merge. What it waits for is derived from the dependency
 * globs' live state, so a deleted dependency or one sent back to Planning needs no bookkeeping: the glob just stays put.
 */
import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';
import type { Glob, ImpliedAfter } from './types.js';

/**
 * `merged`: reviewing or signed off (a super that merged and continues is still `open`). `planning`: not started, or sent
 * back to Planning. `missing`: deleted (or never on this board).
 */
export type DependencyState = 'open' | 'merged' | 'planning' | 'missing';

export const MAX_AFTER = 20;

export const dependencyState = (glob: Glob | null | undefined): DependencyState => {
  if (glob === null || glob === undefined) return 'missing';
  if (glob.status === 'reviewing' || glob.status === 'signed_off') return 'merged';
  return glob.status === 'planning' ? 'planning' : 'open';
};

/** The fields of a glob that say what it waits for. */
export type Dependent = Pick<Glob, 'after' | 'impliedAfter'>;

/** Every glob ID the glob waits for, explicit ones first, without repeats. */
export const dependencyIds = (glob: Dependent): string[] => [
  ...new Set([...(glob.after ?? []), ...(glob.impliedAfter ?? []).filter((i) => i.overridden !== true).map((i) => i.id)]),
];

export interface AwaitedDependency {
  readonly id: string;
  readonly state: Exclude<DependencyState, 'merged'>;
  /** Why it waits, as shown on the glob: "Waits for s15t7 to merge", "Waits for s15t7, which was deleted", ... */
  readonly why: string;
}

const impliedFor = (glob: Dependent, id: string): ImpliedAfter | undefined =>
  (glob.impliedAfter ?? []).find((i) => i.id === id && i.overridden !== true);

/** What the glob still waits for: its unmerged dependencies, with the reason for each. */
export const waitingFor = (glob: Dependent, states: ReadonlyMap<string, DependencyState>): AwaitedDependency[] => {
  const waiting: AwaitedDependency[] = [];
  for (const id of dependencyIds(glob)) {
    const state = states.get(id) ?? 'missing';
    if (state === 'merged') continue;
    waiting.push({ id, state, why: waitNote(id, state, impliedFor(glob, id)) });
  }
  return waiting;
};

export const waitNote = (id: string, state: Exclude<DependencyState, 'merged'>, implied?: ImpliedAfter): string => {
  if (implied !== undefined && state === 'open') {
    return `Waits for ${id}: both may change ${implied.paths.slice(0, 3).join(', ')}${implied.paths.length > 3 ? ' and more' : ''}`;
  }
  switch (state) {
    case 'missing':
      return `Waits for ${id}, which was deleted`;
    case 'planning':
      return `Waits for ${id} to merge (it is in Planning)`;
    case 'open':
      return `Waits for ${id} to merge`;
  }
};

/** One line for a glob that waits: "Waits for s15t7 to merge", joined for several. */
export const waitSummary = (awaited: readonly AwaitedDependency[]): string => awaited.map((a) => a.why).join('; ');

/** The warning for starting or picking up a glob that still waits. */
export const pickUpWarning = (awaited: readonly AwaitedDependency[]): string | null =>
  awaited.length === 0
    ? null
    : `${awaited.map((a) => a.id).join(', ')} hasn't merged yet; this branch lacks ${awaited.length === 1 ? 'its' : 'their'} changes`;

/** What a glob waits for, in a form that reads in a refusal: "s15t7 to merge". */
export const refusalText = (awaited: readonly AwaitedDependency[]): string => `${waitSummary(awaited)} (use Start anyway)`;

/**
 * Checks the IDs a glob is to wait for. `lookup` finds any glob by ID (the dependencies and what they wait for in turn).
 * Returns the IDs to store: on this board, not self, no cycle, merged ones dropped, without repeats.
 */
export const checkAfter = (
  selfId: string | null,
  ids: readonly string[],
  boardId: number,
  lookup: (id: string) => Glob | undefined,
): Result<string[]> => {
  const wanted = [...new Set(ids.map((i) => i.trim()).filter((i) => i !== ''))];
  if (wanted.length > MAX_AFTER) return invalidInput(`A glob can wait for at most ${MAX_AFTER} others`);
  const kept: string[] = [];
  for (const id of wanted) {
    if (id === selfId) return invalidInput('A glob cannot wait for itself');
    const dep = lookup(id);
    if (dep === undefined || dep.boardId !== boardId) return invalidInput(`No glob ${id} on this board`);
    if (dependencyState(dep) === 'merged') continue;
    if (selfId !== null && reaches(id, selfId, lookup)) {
      return invalidInput(`${id} already waits for ${selfId}, so ${selfId} cannot wait for ${id}`);
    }
    kept.push(id);
  }
  return ok(kept);
};

/** Whether `from` waits (directly or through others) for `target`. */
export const reaches = (from: string, target: string, lookup: (id: string) => Glob | undefined): boolean => {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const glob = lookup(id);
    if (glob === undefined) continue;
    for (const next of dependencyIds(glob)) {
      if (next === target) return true;
      stack.push(next);
    }
  }
  return false;
};

/** Whether `glob` waits for `id` (explicitly or by an implied hold). */
export const waitsFor = (glob: Dependent, id: string): boolean => dependencyIds(glob).includes(id);
