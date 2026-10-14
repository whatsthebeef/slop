/**
 * Relations: one glob held back by another. `from` can't pass `gate` (start, merge, sign off) until `to` reaches `until`
 * (merged, decided, signed off). What is held is derived from the other glob's live state, so a deleted `to` or one sent back
 * to Planning needs no bookkeeping beyond the rule below: a deleted `to` releases the gate, a `to` back in Planning holds it.
 *
 * Pure: the service reads the rows and the live state of every `to` and passes them in as `RelationFacts`.
 */
import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';
import { isDecisionAttributes } from './attributes.js';
import type { EdgeKind, EdgeSource, Glob, Relation, RelationGate, RelationPatch, RelationSource, RelationUntil } from './types.js';

/**
 * Where the glob a relation points at stands. `merged`: Reviewing (a super that merged and continues is still `open`).
 * `signed_off`: signed off. `decided`: a decision glob whose outcome was accept, reject or closed (not needs work).
 * `planning`: not started, or sent back to Planning. `missing`: deleted (or never on this board). `rollout`: merged, but
 * work steps that hold back its dependants are still open.
 */
export type ToState = 'open' | 'merged' | 'planning' | 'missing' | 'rollout' | 'decided' | 'signed_off';

/** At most this many relations per glob and gate. */
export const MAX_RELATIONS = 20;
/** The old name of the same limit (people's `needs`/`after` lists). */
export const MAX_AFTER = MAX_RELATIONS;

const NOT_HELD: ReadonlySet<string> = new Set();

/** The decision outcomes that count as the decision having been made. */
const DECIDED_OUTCOMES: ReadonlySet<string> = new Set(['accept', 'accept_with_edits', 'reject', 'closed']);

/** The state of a `to` glob; `held` holds the globs whose open work steps hold back their dependants. */
export const toState = (glob: Glob | null | undefined, held: ReadonlySet<string> = NOT_HELD): ToState => {
  if (glob === null || glob === undefined) return 'missing';
  if (glob.category === 'decision') {
    const outcome = isDecisionAttributes(glob.attributes) ? glob.attributes.outcome : null;
    if (glob.status === 'signed_off') return 'signed_off';
    if (outcome !== null && DECIDED_OUTCOMES.has(outcome.kind)) return 'decided';
    return glob.status === 'planning' ? 'planning' : 'open';
  }
  if (glob.status === 'signed_off') return held.has(glob.id) ? 'rollout' : 'signed_off';
  if (glob.status === 'reviewing') return held.has(glob.id) ? 'rollout' : 'merged';
  return glob.status === 'planning' ? 'planning' : 'open';
};

/** Whether the glob has merged: Reviewing or signed off (a super that merged and continues is still open). */
export const hasMerged = (glob: Glob): boolean => glob.status === 'reviewing' || glob.status === 'signed_off';

/** A relation that has stopped holding by a person's choice: dismissed, or overridden by Start now. */
const lifted = (r: Relation): boolean => r.dismissedAt !== null || r.overriddenAt !== null;

/** Whether the relation still counts (it was neither dismissed nor overridden), whether or not its gate is open yet. */
export const isActive = (r: Relation): boolean => !lifted(r);

/** The sources a person, an agent or a split set: an `after`/`needs` list replaces these and leaves inferred and learned ones. */
export const isExplicit = (r: Pick<Relation, 'source'>): boolean => r.source === 'person' || r.source === 'agent' || r.source === 'split';

/** Whether the gate this relation guards is open: lifted, `to` gone, or `to` has reached `until`. */
export const isMet = (r: Relation, state: ToState): boolean => {
  if (lifted(r) || state === 'missing') return true;
  switch (r.until) {
    case 'merged':
      return state === 'merged' || state === 'signed_off' || state === 'decided';
    case 'decided':
      return state === 'decided' || state === 'signed_off';
    case 'signed_off':
      return state === 'signed_off';
  }
};

/** What a glob's relations and the state of each `to` say; passed to the machine in place of the old `dependencies` map. */
export interface RelationFacts {
  /** The relations that start at this glob (every gate). */
  readonly relations: readonly Relation[];
  /** The state of each `to` (a missing entry reads as deleted). */
  readonly states: ReadonlyMap<string, ToState>;
}

export const NO_RELATIONS: RelationFacts = { relations: [], states: new Map() };

/** A relation that still holds something back, with where `to` stands. */
export interface Unmet {
  readonly relation: Relation;
  readonly state: ToState;
}

/** The relations of one gate that still hold (not lifted, `to` not there yet), in the order they were made. */
export const unmet = (facts: RelationFacts, gate: RelationGate): Unmet[] =>
  facts.relations
    .filter((r) => r.gate === gate)
    .flatMap((relation) => {
      const state = facts.states.get(relation.to) ?? 'missing';
      return isMet(relation, state) ? [] : [{ relation, state }];
    });

/** The relations of one gate that are held back by a deleted `to`: released, with the note kept. */
export const releasedByDeletion = (facts: RelationFacts, gate: RelationGate): Relation[] =>
  facts.relations.filter((r) => r.gate === gate && !lifted(r) && (facts.states.get(r.to) ?? 'missing') === 'missing');

/** Every active start relation of a glob, whether or not it is met: what the glob starts after. */
export const startIds = (relations: readonly Relation[]): string[] => [
  ...new Set(relations.filter((r) => r.gate === 'start' && !lifted(r)).map((r) => r.to)),
];

// ---------------------------------------------------------------------------
// Words

export const GATE_WORDS: Readonly<Record<RelationGate, string>> = { start: 'start', merge: 'merge', sign_off: 'sign off' };
export const UNTIL_WORDS: Readonly<Record<RelationUntil, string>> = { merged: 'merged', decided: 'decided', signed_off: 'signed off' };

/** "can't start until s15f82 is merged": what one relation says, for a refusal or a row. */
export const holdWords = (r: Pick<Relation, 'gate' | 'to' | 'until'>): string =>
  `can't ${GATE_WORDS[r.gate]} until ${r.to} is ${UNTIL_WORDS[r.until]}`;

/** Why one unmet relation holds, as shown on the glob: "Waits for s15t7 to merge", "Waits for s15t7: <reason>", ... */
export const waitNote = ({ relation, state }: Unmet): string => {
  const { to, reason, source } = relation;
  if (relation.gate === 'start' && relation.until === 'merged') {
    if (state === 'open' && reason !== null && (source === 'learned' || source === 'inferred')) return `Waits for ${to}: ${reason}`;
    switch (state) {
      case 'planning':
        return `Waits for ${to} to merge (it is in Planning)`;
      case 'rollout':
        return `Waits for the rollout of ${to} to be done (it has merged)`;
      default:
        return `Waits for ${to} to merge`;
    }
  }
  const tail = reason === null ? '' : `: ${reason}`;
  return `Waits for ${to} to be ${UNTIL_WORDS[relation.until]} before it can ${GATE_WORDS[relation.gate]}${tail}`;
};

// ---------------------------------------------------------------------------
// Adapter for the views that still read "what the glob waits for" (until the whose-move work replaces them)

/** The states a view shows for a held start relation. */
export type AwaitedState = 'open' | 'planning' | 'rollout';

export interface AwaitedDependency {
  readonly id: string;
  readonly state: AwaitedState;
  /** Why it waits, as shown on the glob: "Waits for s15t7 to merge", ... */
  readonly why: string;
}

const awaitedState = (state: ToState): AwaitedState => (state === 'planning' || state === 'rollout' ? state : 'open');

/** What the glob still waits for before it can start: its unmet start relations, one line each. */
export const awaitedOf = (facts: RelationFacts): AwaitedDependency[] =>
  unmet(facts, 'start').map((u) => ({ id: u.relation.to, state: awaitedState(u.state), why: waitNote(u) }));

/** One line for a glob that waits: "Waits for s15t7 to merge", joined for several. */
export const waitSummary = (awaited: readonly AwaitedDependency[]): string => awaited.map((a) => a.why).join('; ');

/** The warning for starting or picking up a glob that still waits. */
export const pickUpWarning = (awaited: readonly AwaitedDependency[]): string | null =>
  awaited.length === 0
    ? null
    : `${awaited.map((a) => a.id).join(', ')} hasn't merged yet; this branch lacks ${awaited.length === 1 ? 'its' : 'their'} changes`;

/** What a glob waits for, in a form that reads in a refusal: "Waits for s15t7 to merge (use Start now)". */
export const refusalText = (awaited: readonly AwaitedDependency[]): string => `${waitSummary(awaited)} (use Start now)`;

/** One edge of a glob in the shape the views show: kind, source and evidence. Only needs are edges now; overlaps are not shown. */
export interface Edge {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly source: EdgeSource;
  readonly paths: readonly string[];
  readonly evidence?: string;
  /** Set when a person chose Start now on it. */
  readonly overridden?: true;
  /** Set when a person dismissed it as not a dependency (with the plan hash then). */
  readonly dismissedPlanHash?: string;
}

const EDGE_SOURCE: Readonly<Record<Relation['source'], EdgeSource>> = {
  person: 'explicit',
  split: 'explicit',
  agent: 'explicit',
  inferred: 'inferred',
  learned: 'learned',
};

/** The start relations of a glob as edges, for the views that still show them. */
export const edgesOfRelations = (relations: readonly Relation[]): Edge[] =>
  relations
    .filter((r) => r.gate === 'start')
    .map((r) => ({
      id: r.to,
      kind: 'needs',
      source: EDGE_SOURCE[r.source],
      paths: r.evidence,
      ...(r.reason === null ? {} : { evidence: r.reason }),
      ...(r.overriddenAt !== null || r.dismissedAt !== null ? { overridden: true as const } : {}),
      ...(r.dismissedPlanHash === null ? {} : { dismissedPlanHash: r.dismissedPlanHash }),
    }));

// ---------------------------------------------------------------------------
// Writes: what the service changes on a glob's relations in one transaction

/** A relation to add (the service gives it an ID, the board and `from`). */
export interface NewRelation {
  readonly to: string;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
  readonly reason: string | null;
  readonly evidence: readonly string[];
  readonly source: RelationSource;
}

/** The changes to one glob's relations. Every relation write bumps the glob's version and logs an event on it. */
export interface RelationWrite {
  readonly add: readonly NewRelation[];
  readonly update: readonly { readonly id: string; readonly patch: RelationPatch }[];
  readonly remove: readonly string[];
  /** Notes for the log (an inferred need dropped for a cycle), with the plan hash the inference was made on. */
  readonly notes?: { readonly lines: readonly string[]; readonly planHash: string };
}

export const NO_WRITE: RelationWrite = { add: [], update: [], remove: [] };

export const isEmptyWrite = (w: RelationWrite): boolean =>
  w.add.length === 0 && w.update.length === 0 && w.remove.length === 0 && (w.notes?.lines.length ?? 0) === 0;

/** A relation that is not stored yet, for checking (cycles, limits) a write before it is made. */
export const draftOf = (boardId: number, from: string, n: NewRelation, now = ''): Relation => ({
  id: `draft:${from}:${n.to}:${n.gate}`,
  boardId,
  from,
  ...n,
  dismissedAt: null,
  dismissedPlanHash: null,
  overriddenAt: null,
  createdAt: now,
});

/** The relations of a glob after a write, and the rows it inserts (with the IDs `newId` gave them). */
export const applyWrite = (
  current: readonly Relation[],
  write: RelationWrite,
  made: { readonly boardId: number; readonly from: string; readonly now: string; readonly newId: () => string },
): { readonly relations: Relation[]; readonly inserted: Relation[] } => {
  const inserted = write.add.map(
    (n): Relation => ({
      id: made.newId(),
      boardId: made.boardId,
      from: made.from,
      ...n,
      dismissedAt: null,
      dismissedPlanHash: null,
      overriddenAt: null,
      createdAt: made.now,
    }),
  );
  const patched = current
    .filter((r) => !write.remove.includes(r.id))
    .map((r) => {
      const change = write.update.find((u) => u.id === r.id);
      return change === undefined ? r : { ...r, ...change.patch };
    });
  return { relations: [...patched, ...inserted], inserted };
};

// ---------------------------------------------------------------------------
// Start now

/** What Start now changes on the relations: the inferred and learned start relations still holding are overridden. */
export interface RelationEdit {
  readonly id: string;
  readonly overriddenAt: string;
}

export const overrideEdits = (relations: readonly Relation[], now: string): RelationEdit[] =>
  relations
    .filter((r) => r.gate === 'start' && !lifted(r) && (r.source === 'inferred' || r.source === 'learned'))
    .map((r) => ({ id: r.id, overriddenAt: now }));

// ---------------------------------------------------------------------------
// Cycles

/** The milestones of a glob's life, in order: a relation's gate is the milestone held back, `until` the one waited for. */
const MILESTONE: Readonly<Record<RelationGate, number>> = { start: 0, merge: 1, sign_off: 2 };
const REACHED: Readonly<Record<RelationUntil, number>> = { merged: 1, decided: 1, signed_off: 2 };

/** The relation as the question "can `from` pass `gate`?" depending on "has `to` reached `until`?". */
export interface RelationDraft {
  readonly from: string;
  readonly to: string;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
}

/**
 * Whether adding `draft` would close a cycle. Nodes are (glob, milestone): a glob's later milestone depends on its earlier
 * ones and on the relations of that gate, so a split (part 1 starts after part 0 merged, part 0 signs off after part 1
 * merged) is no cycle, while two globs each waiting to start for the other to merge is. Lifted relations don't count.
 */
export const wouldCycle = (relations: readonly Relation[], draft: RelationDraft): boolean => {
  const byFrom = new Map<string, Relation[]>();
  for (const r of relations) if (!lifted(r)) byFrom.set(r.from, [...(byFrom.get(r.from) ?? []), r]);
  const target = `${draft.from}|${MILESTONE[draft.gate]}`;
  const seen = new Set<string>();
  const stack: [string, number][] = [[draft.to, REACHED[draft.until]]];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    const key = `${node[0]}|${node[1]}`;
    if (key === target) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    if (node[1] > 0) stack.push([node[0], node[1] - 1]);
    for (const r of byFrom.get(node[0]) ?? []) if (MILESTONE[r.gate] === node[1]) stack.push([r.to, REACHED[r.until]]);
  }
  return false;
};

/**
 * Checks a relation a person, an agent or slop wants to add: not to itself, `to` on this board, within the limit for the
 * glob and gate, and no cycle. `board` is every relation of the board (read under the board's relation lock), `lookup` finds
 * any glob's board by ID.
 */
export const checkRelation = (
  draft: RelationDraft,
  boardId: number,
  board: readonly Relation[],
  lookup: (id: string) => Pick<Glob, 'boardId'> | undefined,
): Result<null> => {
  if (draft.from === draft.to) return invalidInput('A glob cannot wait for itself');
  const other = lookup(draft.to);
  if (other === undefined || other.boardId !== boardId) return invalidInput(`No glob ${draft.to} on this board`);
  const same = board.filter((r) => r.from === draft.from && r.gate === draft.gate && r.to !== draft.to && !lifted(r));
  if (same.length >= MAX_RELATIONS) return invalidInput(`A glob can have at most ${MAX_RELATIONS} relations for one gate`);
  if (wouldCycle(board, draft)) {
    return invalidInput(`${draft.to} already waits for ${draft.from}, so ${draft.from} ${holdWords(draft)}: that would be a cycle`);
  }
  return ok(null);
};

/** Whether `from` starts after `target`, directly or through others (active start relations only). */
export const startReaches = (relations: readonly Relation[], from: string, target: string): boolean => {
  const next = new Map<string, string[]>();
  for (const r of relations) if (r.gate === 'start' && !lifted(r)) next.set(r.from, [...(next.get(r.from) ?? []), r.to]);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const to of next.get(id) ?? []) {
      if (to === target) return true;
      stack.push(to);
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// Blocking chain (everything unmerged ahead of a glob)

/** One unmerged glob a glob is blocked by, `depth` links away (1 is a direct prerequisite). */
export interface BlockedBy {
  readonly id: string;
  readonly state: AwaitedState;
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
 * The glob's whole blocking chain: its unmet start relations, what those globs wait for in turn, and so on. Met ones are
 * skipped (and not walked past), a cycle is walked once, and `lookup` answers undefined for a deleted glob.
 */
export const blockingChain = (
  rootId: string,
  relationsOf: (id: string) => readonly Relation[],
  lookup: (id: string) => Glob | undefined,
  held: ReadonlySet<string> = NOT_HELD,
): BlockingChain => {
  const seen = new Set<string>([rootId]);
  const blockedBy: BlockedBy[] = [];
  const hasUnmergedAhead = new Set<string>();
  let level: string[] = [rootId];
  for (let depth = 1; level.length > 0; depth++) {
    const next: string[] = [];
    for (const parent of level) {
      for (const r of relationsOf(parent).filter((x) => x.gate === 'start')) {
        const glob = lookup(r.to);
        const state = toState(glob, held);
        if (isMet(r, state)) continue;
        hasUnmergedAhead.add(parent);
        if (seen.has(r.to)) continue;
        seen.add(r.to);
        blockedBy.push({ id: r.to, state: awaitedState(state), status: glob?.status ?? null, depth });
        next.push(r.to);
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
