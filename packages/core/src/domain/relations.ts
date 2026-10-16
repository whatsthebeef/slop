/**
 * Relations: one glob held back by another. `from` can't pass `gate` (start, merge, sign off) until `to` reaches `until`
 * (merged, decided, done, signed off). What is held is derived from the other glob's live state, so a deleted `to` or one sent back
 * to Planning needs no bookkeeping beyond the rule below: a deleted `to` releases the gate, a `to` back in Planning holds it.
 *
 * Pure: the service reads the rows and the live state of every `to` and passes them in as `RelationFacts`.
 */
import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';
import { isActionAttributes, isDecisionAttributes } from './attributes.js';
import { RELATION_GATES, RELATION_UNTILS } from './types.js';
import type { Glob, Relation, RelationGate, RelationKind, RelationPatch, RelationSource, RelationUntil } from './types.js';

/**
 * Where the glob a relation points at stands. `merged`: Reviewing (a super that merged and continues is still `open`).
 * `signed_off`: signed off. `decided`: a decision glob whose outcome was accept, reject or closed (not needs work). `done`: an action glob a
 * person finished (done or dismissed).
 * `planning`: not started, or sent back to Planning. `missing`: deleted (or never on this board). `rollout`: merged, but
 * work steps that hold back its dependants are still open.
 */
export type ToState = 'open' | 'merged' | 'planning' | 'missing' | 'rollout' | 'decided' | 'done' | 'signed_off';

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
  if (glob.category === 'action') {
    const outcome = isActionAttributes(glob.attributes) ? glob.attributes.outcome : null;
    if (outcome !== null || glob.status === 'signed_off') return 'done';
    return 'planning';
  }
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

/** The sources a person, an agent or an old split set: an `after`/`needs` list replaces these and leaves inferred and learned ones. */
export const isExplicit = (r: Pick<Relation, 'source'>): boolean => r.source === 'person' || r.source === 'agent' || r.source === 'split';

/** Whether the gate this relation guards is open: lifted, `to` gone, or `to` has reached `until`. */
export const isMet = (r: Relation, state: ToState): boolean => {
  if (lifted(r) || state === 'missing') return true;
  switch (r.until) {
    case 'merged':
      return state === 'merged' || state === 'signed_off' || state === 'decided';
    case 'decided':
      return state === 'decided' || state === 'signed_off';
    case 'done':
      return state === 'done';
    case 'signed_off':
      return state === 'signed_off' || state === 'done';
  }
};

/** What a relation to this glob waits for by default: a decision's outcome, an action's completion, or a merge. */
export const defaultUntil = (target: Pick<Glob, 'category'>): RelationUntil =>
  target.category === 'decision' ? 'decided' : target.category === 'action' ? 'done' : 'merged';

/** What a glob's relations and the state of each `to` say; passed to the machine in place of the old `dependencies` map. */
export interface RelationFacts {
  /** The relations that start at this glob (every gate). */
  readonly relations: readonly Relation[];
  /** The state of each `to` (a missing entry reads as deleted). */
  readonly states: ReadonlyMap<string, ToState>;
  /**
   * The `to` ids on another board than the holder. Text built from the facts (refusals, the `Waiting` event note, failure reasons) is
   * viewer-independent and stored, so it names these as "a glob on another board" and never prints the id or where it stands.
   */
  readonly external?: ReadonlySet<string>;
}

export const NO_RELATIONS: RelationFacts = { relations: [], states: new Map() };

/** A relation that still holds something back, with where `to` stands. */
export interface Unmet {
  readonly relation: Relation;
  readonly state: ToState;
  /** `to` is on another board: its id and state stay out of any text. */
  readonly external?: boolean;
}

/** What text says in place of the id of a glob on another board. */
export const OTHER_BOARD_GLOB = 'a glob on another board';

/** The relations of one gate that still hold (not lifted, `to` not there yet), in the order they were made. */
export const unmet = (facts: RelationFacts, gate: RelationGate): Unmet[] =>
  facts.relations
    .filter((r) => r.gate === gate)
    .flatMap((relation) => {
      const state = facts.states.get(relation.to) ?? 'missing';
      if (isMet(relation, state)) return [];
      return facts.external?.has(relation.to) === true ? [{ relation, state, external: true }] : [{ relation, state }];
    });

/** Every active start relation of a glob, whether or not it is met: what the glob starts after. */
export const startIds = (relations: readonly Relation[]): string[] => [
  ...new Set(relations.filter((r) => r.gate === 'start' && !lifted(r)).map((r) => r.to)),
];

// ---------------------------------------------------------------------------
// Words

export const GATE_WORDS: Readonly<Record<RelationGate, string>> = { start: 'start', merge: 'merge', sign_off: 'sign off' };
/** `merged` also waits for the rollout (a merged glob's open rollout steps keep it holding), so it reads "merged and rolled out". */
export const UNTIL_WORDS: Readonly<Record<RelationUntil, string>> = { merged: 'merged and rolled out', decided: 'decided', done: 'done', signed_off: 'signed off' };

/** Accepts `rolled_out` as another way to write `until: 'merged'` (the wire value stays `merged`); null for anything else. */
export const normaliseUntil = (value: string): RelationUntil | null => {
  const v = value.trim().toLowerCase();
  if (v === 'rolled_out' || v === 'merged_and_rolled_out') return 'merged';
  return (RELATION_UNTILS as readonly string[]).includes(v) ? (v as RelationUntil) : null;
};

/** "can't start until s15f82 is merged": what one relation says, for a refusal or a row. */
export const holdWords = (r: Pick<Relation, 'gate' | 'to' | 'until'>, external = false): string =>
  `can't ${GATE_WORDS[r.gate]} until ${external ? OTHER_BOARD_GLOB : r.to} is ${UNTIL_WORDS[r.until]}`;

/** Why one unmet relation holds, as shown on the glob: "Waits for s15t7 to merge", "Waits for s15t7: <reason>", ... */
export const waitNote = ({ relation, state, external }: Unmet): string => {
  const { reason, source } = relation;
  const to = external === true ? OTHER_BOARD_GLOB : relation.to;
  if (external === true && relation.gate === 'start' && relation.until === 'merged') return `Waits for ${to} to merge`;
  if (relation.gate === 'start' && relation.until === 'merged') {
    if (state === 'open' && reason !== null && (source === 'learned' || source === 'inferred')) return `Waits for ${to}: ${reason}`;
    switch (state) {
      case 'planning':
        return `Waits for ${to} to merge (it is in Planning)`;
      case 'rollout':
        return `Waits for the rollout of ${to} to be done (it has merged; its rollout steps are open)`;
      default:
        return `Waits for ${to} to merge`;
    }
  }
  const tail = reason === null ? '' : `: ${reason}`;
  return `Waits for ${to} to be ${UNTIL_WORDS[relation.until]} before it can ${GATE_WORDS[relation.gate]}${tail}`;
};

// ---------------------------------------------------------------------------
// What a glob still waits for before it starts: the start gate's wording, for refusals and the pick-up warning

/** The states a view shows for a held start relation. */
/** `question`: not a relation but an open start question (see `questions.ts`). */
export type AwaitedState = 'open' | 'planning' | 'rollout' | 'question';

export interface AwaitedDependency {
  readonly id: string;
  readonly state: AwaitedState;
  /** `id` is on another board: texts built from it name "a glob on another board" instead. */
  readonly external?: boolean;
  /** Why it waits, as shown on the glob: "Waits for s15t7 to merge", ... */
  readonly why: string;
}

const awaitedState = (state: ToState): AwaitedState => (state === 'planning' || state === 'rollout' ? state : 'open');

/** What the glob still waits for before it can start: its unmet start relations, one line each. */
export const awaitedOf = (facts: RelationFacts): AwaitedDependency[] =>
  unmet(facts, 'start').map((u) => ({
    id: u.relation.to,
    state: awaitedState(u.state),
    ...(u.external === true && { external: true }),
    why: waitNote(u),
  }));

/** What stored or shown text calls a waited-for glob: its id, or a stub for one on another board. */
export const awaitedName = (a: Pick<AwaitedDependency, 'id' | 'external'>): string => (a.external === true ? OTHER_BOARD_GLOB : a.id);
/** The ids an event records for what a glob waits for (a stub for each glob on another board). */
export const awaitedNames = (awaited: readonly Pick<AwaitedDependency, 'id' | 'external'>[]): string[] => awaited.map(awaitedName);

/** One line for a glob that waits: "Waits for s15t7 to merge", joined for several. */
export const waitSummary = (awaited: readonly AwaitedDependency[]): string => awaited.map((a) => a.why).join('; ');

/** The warning for starting or picking up a glob that still waits. */
export const pickUpWarning = (awaited: readonly AwaitedDependency[]): string | null =>
  awaited.length === 0
    ? null
    : `${awaited.map(awaitedName).join(', ')} hasn't merged yet; this branch lacks ${awaited.length === 1 ? 'its' : 'their'} changes`;

/** What a glob waits for, in a form that reads in a refusal: "Waits for s15t7 to merge (use Start now)". */
export const refusalText = (awaited: readonly AwaitedDependency[]): string => `${waitSummary(awaited)} (use Start now)`;

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
  /** Absent means `waits`. */
  readonly kind?: RelationKind;
  /** The group it is set for, when it is one of a group-wide decision's relations. */
  readonly group?: string | null;
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
  group: n.group ?? null,
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
      group: n.group ?? null,
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
const REACHED: Readonly<Record<RelationUntil, number>> = { merged: 1, decided: 1, done: 1, signed_off: 2 };

/** The relation as the question "can `from` pass `gate`?" depending on "has `to` reached `until`?". */
export interface RelationDraft {
  readonly from: string;
  readonly to: string;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
}

/**
 * Whether adding `draft` would close a cycle. Nodes are (glob, milestone): a glob's later milestone depends on its earlier
 * ones and on the relations of that gate, so a glob that merges only after another has merged, which in turn starts after
 * the first has merged, is no cycle, while two globs each waiting to start for the other to merge is. Lifted relations
 * don't count.
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

/** Most relation rows a cycle check reads beyond the glob's own board. */
export const RELATION_UNIVERSE_CAP = 1000;

/**
 * The relations a cycle check must see: `base` (the glob's board) plus everything reachable forward from `targets`, across boards.
 * A cycle through a new edge needs a path from its `to` back to its `from`, and that path may run through other boards even when
 * the edge itself is local. Over `RELATION_UNIVERSE_CAP` rows beyond the base it refuses rather than guesses. Every relation
 * writer uses it under the instance-wide relations lock.
 */
export const relationUniverse = async (
  listFrom: (ids: string[]) => Promise<readonly Relation[]>,
  base: readonly Relation[],
  targets: readonly string[],
): Promise<Result<Relation[]>> => {
  const rows = new Map(base.map((r) => [r.id, r]));
  const seen = new Set<string>();
  let frontier = [...new Set(targets)];
  let added = 0;
  while (frontier.length > 0) {
    const batch = frontier.filter((id) => !seen.has(id));
    for (const id of batch) seen.add(id);
    frontier = [];
    if (batch.length === 0) break;
    for (const r of await listFrom(batch)) {
      frontier.push(r.to);
      if (rows.has(r.id)) continue;
      rows.set(r.id, r);
      added++;
      if (added > RELATION_UNIVERSE_CAP) return invalidInput('the relation graph is too large to check');
    }
  }
  return ok([...rows.values()]);
};

/**
 * Checks a relation a person, an agent or slop wants to add: not to itself, `to` exists (on any board: the caller checks that
 * the actor may view it), within the limit for the glob and gate, and no cycle. `board` is every relation in play (the glob's
 * board plus the forward closure of `to`, read under the relations lock), `lookup` finds any glob by ID. `_boardId` is kept
 * so existing callers compile; it no longer limits `to` to one board.
 */
export const checkRelation = (
  draft: RelationDraft,
  _boardId: number,
  board: readonly Relation[],
  lookup: (id: string) => Pick<Glob, 'boardId'> | undefined,
): Result<null> => {
  if (draft.from === draft.to) return invalidInput('A glob cannot wait for itself');
  if (lookup(draft.to) === undefined) return invalidInput(`No glob ${draft.to}`);
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
// What holds a glob back, as the views and whose-move read it

/** The other board's side of a cross-board relation. `hidden`: the viewer is not a member of that board, so the glob's id and title are left out. */
export interface ExternalGlob {
  readonly boardId: number;
  readonly boardName: string | null;
  readonly hidden: boolean;
}

/** What a holding or a relation row says about the glob it points at. */
export interface TitleInfo {
  readonly title: string;
  readonly decision: boolean;
  /** An action glob (absent: not one). */
  readonly action?: boolean;
}

/** One unmet relation of a glob, with where `to` stands: the board list and the glob read carry these as `holding`. */
export interface Holding {
  readonly relationId: string;
  readonly to: string;
  /** The title of `to`; null when it was deleted (a deleted `to` doesn't hold, so this is rare) or unknown. */
  readonly toTitle: string | null;
  /** Whether `to` is a decision glob: whose-move says "waiting on decision s15k190". */
  readonly toIsDecision: boolean;
  /** Whether `to` is an action glob: whose-move says "waiting on action s15a3". Absent from older servers. */
  readonly toIsAction?: boolean;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
  readonly state: ToState;
  readonly reason: string | null;
  readonly source: RelationSource;
  /** Set when `to` is on another board: its name, and whether the viewer may not see it (then `to` is `another board` and `toTitle` null). */
  readonly external?: ExternalGlob;
}

/**
 * Every relation of a glob that still holds something back (any gate), in the order they were made. `titles` and `decisions`
 * come from the globs the relations point at (the service reads them: one `getGlobs` for the ones the list doesn't carry).
 */
export const holdingOf = (
  facts: RelationFacts,
  titles: ReadonlyMap<string, TitleInfo>,
): Holding[] => {
  // Start gates first, then merge, then sign-off: the order a glob meets them.
  return RELATION_GATES.flatMap((gate) => unmet(facts, gate)).map(({ relation: r, state }): Holding => {
    const to = titles.get(r.to);
    return {
      relationId: r.id,
      to: r.to,
      toTitle: to?.title ?? null,
      toIsDecision: to?.decision ?? false,
      toIsAction: to?.action ?? false,
      gate: r.gate,
      until: r.until,
      state,
      reason: r.reason,
      source: r.source,
    };
  });
};

/** Whether the glob's merge is held back right now: a merge that would have started waits for a `merge` relation. */
export const isMergeHeld = (glob: Pick<Glob, 'status' | 'mergeHold' | 'mergeMode' | 'type' | 'pr'>): boolean =>
  glob.status === 'pr_open' &&
  glob.mergeHold != null &&
  glob.mergeHold.sha === glob.pr?.headSha &&
  (glob.mergeMode === 'when_green' || glob.type === 'sub');

/**
 * Whether a relation of this shape makes sense: `decided` only waits for a decision glob and `done` only for an action glob
 * (a work glob has neither outcome), a decision glob is never the one held back (it has no gate a relation could guard), and
 * an action is held back only at its start (it can't be done until what builds its script has merged).
 */
export const checkRelationShape = (
  from: Pick<Glob, 'id' | 'category'>,
  draft: Pick<RelationDraft, 'to' | 'until'> & { readonly gate?: RelationGate },
  to: Pick<Glob, 'category'>,
): Result<null> => {
  if (from.category === 'decision') {
    return invalidInput(`${from.id} is a decision: human work can hold other globs back, but it is not held back`);
  }
  if (from.category === 'action' && (draft.gate ?? 'start') !== 'start') {
    return invalidInput(`${from.id} is an action: it can only wait before it is done (a start relation)`);
  }
  if (draft.until === 'decided' && to.category !== 'decision') return invalidInput(`${draft.to} is not a decision, so nothing can wait for it to be decided`);
  if (draft.until === 'done' && to.category !== 'action') return invalidInput(`${draft.to} is not an action, so nothing can wait for it to be done`);
  if (to.category === 'action' && draft.until !== 'done') return invalidInput(`${draft.to} is an action: wait for it to be done`);
  return ok(null);
};

// ---------------------------------------------------------------------------
// The grouped view of a glob's relations (the glob read, `get_glob`)

/** A relation of another glob that waits for this one: what this glob holds back. */
export interface HeldBack {
  readonly relationId: string;
  readonly from: string;
  readonly fromTitle: string | null;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
  readonly reason: string | null;
  readonly source: RelationSource;
  /** Set when `from` is on another board (see `Holding.external`). */
  readonly external?: ExternalGlob;
}

/** How a relation of this glob stopped holding: its `to` reached `until` or was deleted, or a person dismissed or overrode it. */
export type DoneHow = 'met' | 'deleted' | 'dismissed' | 'overridden';

/** A relation of this glob that no longer holds. */
export interface DoneRelation {
  readonly relationId: string;
  readonly to: string;
  readonly toTitle: string | null;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
  readonly reason: string | null;
  readonly source: RelationSource;
  readonly how: DoneHow;
}

/** One side of a supersession: the glob that supersedes this one, or one this glob supersedes. */
export interface Supersession {
  readonly id: string;
  readonly title: string | null;
  readonly reason: string | null;
  readonly source: RelationSource;
  /** The relation's ID, so it can be dismissed. */
  readonly relationId?: string;
  /** Set when the other glob is on a board the viewer can't see (then `id` is `another board` and `title` null). */
  readonly hidden?: boolean;
  readonly external?: ExternalGlob;
}

/** The glob's relations in three groups: what holds it back now, what it holds back, and what no longer holds. */
export interface RelationsView {
  readonly holding: readonly Holding[];
  readonly holdsBack: readonly HeldBack[];
  readonly done: readonly DoneRelation[];
  /** The glob that supersedes this one (absent from older servers; null: none). */
  readonly supersededBy?: Supersession | null;
  /** The globs this one supersedes. */
  readonly supersedes?: readonly Supersession[];
  /** How many relations on other boards the viewer can't see wait for this glob. */
  readonly waitedOnByOtherBoards?: number;
}

/** The relations of the glob that no longer hold, with how each stopped (dismissals and overrides first, then met and deleted). */
export const doneOf = (
  facts: RelationFacts,
  titles: ReadonlyMap<string, TitleInfo>,
): DoneRelation[] =>
  facts.relations.flatMap((r): DoneRelation[] => {
    const state = facts.states.get(r.to) ?? 'missing';
    const how: DoneHow | null = r.dismissedAt !== null ? 'dismissed' : r.overriddenAt !== null ? 'overridden' : !isMet(r, state) ? null : state === 'missing' ? 'deleted' : 'met';
    if (how === null) return [];
    return [{ relationId: r.id, to: r.to, toTitle: titles.get(r.to)?.title ?? null, gate: r.gate, until: r.until, reason: r.reason, source: r.source, how }];
  });
