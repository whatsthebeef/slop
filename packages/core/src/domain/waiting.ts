/**
 * "Waits for": a glob waits for other globs on its board to merge. What it waits for is derived from the dependency
 * globs' live state, so a deleted dependency or one sent back to Planning needs no bookkeeping: the glob just stays put.
 */
import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';
import type { EdgeKind, EdgeSource, Glob, ImpliedAfter } from './types.js';

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

/** Whether an implied edge blocks a start: only a learned `needs` does; predicted overlaps never do. */
const blocking = (edge: ImpliedAfter): boolean => edge.kind === 'needs' && edge.overridden !== true;

/** Every glob ID the glob needs (explicit `after`, then learned needs), without repeats: what blocks its start. */
export const dependencyIds = (glob: Dependent): string[] => [
  ...new Set([...(glob.after ?? []), ...(glob.impliedAfter ?? []).filter(blocking).map((i) => i.id)]),
];

/** One edge of a glob, in the shape the views and MCP show: kind, source and evidence. */
export interface Edge {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly source: EdgeSource;
  readonly paths: readonly string[];
  readonly evidence?: string;
  /** Set when a person chose Start now on it. */
  readonly overridden?: true;
}

/** Every edge of the glob: explicit needs, then the recorded implied and learned ones. An explicit need wins over a recorded edge to the same glob. */
export const edgesOf = (glob: Dependent): Edge[] => {
  const edges: Edge[] = (glob.after ?? []).map((id) => ({ id, kind: 'needs', source: 'explicit', paths: [] }));
  for (const i of glob.impliedAfter ?? []) {
    if (edges.some((e) => e.id === i.id)) continue;
    edges.push({
      id: i.id,
      kind: i.kind ?? 'overlaps',
      source: i.source ?? 'implied',
      paths: i.paths,
      ...(i.evidence === undefined ? {} : { evidence: i.evidence }),
      ...(i.overridden === true ? { overridden: true as const } : {}),
    });
  }
  return edges;
};

/** The globs this one overlaps (same files; only the merge order matters): never blocks a start. */
export const overlapIds = (glob: Dependent): string[] => edgesOf(glob).filter((e) => e.kind === 'overlaps').map((e) => e.id);

export interface AwaitedDependency {
  readonly id: string;
  readonly state: Exclude<DependencyState, 'merged'>;
  /** Why it waits, as shown on the glob: "Waits for s15t7 to merge", "Waits for s15t7, which was deleted", ... */
  readonly why: string;
}

const impliedFor = (glob: Dependent, id: string): ImpliedAfter | undefined =>
  (glob.impliedAfter ?? []).find((i) => i.id === id && i.overridden !== true && i.kind === 'needs');

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
    if (implied.source === 'learned') return `Waits for ${id}: ${implied.evidence ?? 'a run failed without it'}`;
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
export const refusalText = (awaited: readonly AwaitedDependency[]): string => `${waitSummary(awaited)} (use Start now)`;

/** Checks the IDs a glob is to overlap: on this board, not itself, without repeats. An overlap needs no cycle check: it never blocks. */
export const checkOverlaps = (
  selfId: string | null,
  ids: readonly string[],
  boardId: number,
  lookup: (id: string) => Glob | undefined,
): Result<string[]> => {
  const wanted = [...new Set(ids.map((i) => i.trim()).filter((i) => i !== ''))];
  if (wanted.length > MAX_AFTER) return invalidInput(`A glob can overlap at most ${MAX_AFTER} others`);
  for (const id of wanted) {
    if (id === selfId) return invalidInput('A glob cannot overlap itself');
    const other = lookup(id);
    if (other === undefined || other.boardId !== boardId) return invalidInput(`No glob ${id} on this board`);
  }
  return ok(wanted);
};

/** The edges a person set as overlaps, in the form stored beside `after`. */
export const explicitOverlaps = (ids: readonly string[]): ImpliedAfter[] =>
  ids.map((id) => ({ id, paths: [], kind: 'overlaps', source: 'explicit' }));

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

/**
 * Whether the dependency `dependencyId` of `glob` blocks it from starting: only needs edges do (`dependencyIds` holds
 * nothing else); overlaps never block.
 */
export const blocksStart = (glob: Dependent, dependencyId: string): boolean => dependencyIds(glob).includes(dependencyId);

/** One unmerged glob a glob is blocked by, `depth` links away (1 is a direct prerequisite). */
export interface BlockedBy {
  readonly id: string;
  readonly state: Exclude<DependencyState, 'merged'>;
  /** The glob's own status (planning, implementing, failed, pr_open, ...); null when it was deleted. */
  readonly status: Glob['status'] | null;
  readonly depth: number;
}

/** Everything unmerged ahead of a glob, nearest first, and which of it can be started now. */
export interface BlockingChain {
  readonly blockedBy: readonly BlockedBy[];
  /** The deepest glob in the chain that is in Planning with nothing unmerged ahead of it: what to start next. */
  readonly nextStartable: string | null;
}

export const NO_CHAIN: BlockingChain = { blockedBy: [], nextStartable: null };

/**
 * The glob's whole blocking chain: its unmerged prerequisites, what they wait for in turn, and so on. Merged globs are
 * skipped (and not walked past), a cycle is walked once, and `lookup` answers undefined for a deleted glob.
 */
export const blockingChain = (rootId: string, root: Dependent, lookup: (id: string) => Glob | undefined): BlockingChain => {
  const seen = new Set<string>([rootId]);
  const blockedBy: BlockedBy[] = [];
  const hasUnmergedAhead = new Set<string>();
  let level: { readonly id: string; readonly glob: Dependent }[] = [{ id: rootId, glob: root }];
  for (let depth = 1; level.length > 0; depth++) {
    const next: { id: string; glob: Dependent }[] = [];
    for (const parent of level) {
      for (const id of dependencyIds(parent.glob).filter((d) => blocksStart(parent.glob, d))) {
        const glob = lookup(id);
        const state = dependencyState(glob);
        if (state === 'merged') continue;
        hasUnmergedAhead.add(parent.id);
        if (seen.has(id)) continue;
        seen.add(id);
        blockedBy.push({ id, state, status: glob?.status ?? null, depth });
        if (glob !== undefined) next.push({ id, glob });
      }
    }
    level = next;
  }
  const startable = blockedBy.filter((b) => b.state === 'planning' && !hasUnmergedAhead.has(b.id));
  const deepest = Math.max(0, ...startable.map((b) => b.depth));
  return { blockedBy, nextStartable: startable.find((b) => b.depth === deepest)?.id ?? null };
};

/** "Blocked: 3 ahead, next: s15f38". */
export const chainSummary = (chain: BlockingChain): string =>
  `Blocked: ${chain.blockedBy.length} ahead${chain.nextStartable === null ? '' : `, next: ${chain.nextStartable}`}`;

/** The refusal for starting a glob with a chain ahead of it: the whole chain with each glob's state. */
export const chainRefusal = (chain: BlockingChain): string =>
  `${chainSummary(chain)} (${chain.blockedBy.map((b) => `${b.id} ${b.status ?? 'deleted'}`).join(', ')}; use Start now)`;

/** The note on a glob's card for an overlap: it may change the same files as `id`, so the later merge rebases. */
export const overlapNote = (edge: Edge): string =>
  `Overlaps ${edge.id}${edge.paths.length === 0 ? '' : `: both may change ${edge.paths.slice(0, 3).join(', ')}${edge.paths.length > 3 ? ' and more' : ''}`} (merge order only)`;
