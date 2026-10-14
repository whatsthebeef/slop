/**
 * The group as a view: a group is only the label on its globs, so everything here is derived from the globs that carry it
 * (no status, branch, run or sign-off of its own). Pure: `GroupService` reads the globs and relations and passes them in.
 */
import { normaliseGroup } from './group.js';
import { hasMerged, isActive, isMet, toState } from './relations.js';
import type { Holding, ToState } from './relations.js';
import type { Glob, Relation, RelationGate, RelationSource, RelationUntil, SlopType, Status } from './types.js';
import type { Move } from './whose-move.js';

/** The name `POST /groups/backfill` already answers to; a group can't be called that. */
export const RESERVED_GROUP_NAMES: readonly string[] = ['backfill'];

/** One glob of a group as the service read it. */
export interface GroupMember {
  readonly glob: Glob;
  readonly move: Move;
  /** The glob's own relations and the state of each `to` (the board list's facts). */
  readonly relations: readonly Relation[];
  readonly states: ReadonlyMap<string, ToState>;
  /** What still holds the glob back (its unmet relations). */
  readonly holding: readonly Holding[];
}

export interface GroupGlobRow {
  readonly id: string;
  readonly title: string;
  readonly status: Status;
  readonly type: SlopType;
  readonly updatedAt: string;
  readonly move: Move;
  /** What holds the glob back, with whom (a glob or a decision) and the gate. */
  readonly holding: readonly Holding[];
}

export interface GroupRelationRow {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly toTitle: string | null;
  readonly toIsDecision: boolean;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
  readonly state: ToState;
  readonly reason: string | null;
  readonly source: RelationSource;
  /** Still holds `from` back. */
  readonly holding: boolean;
  /** `to` is a work glob outside the group (a move between groups never touches relations, so this is how they show). */
  readonly crosses: boolean;
}

/** An open decision: one that holds a glob of the group, or one that is itself in the group. */
export interface GroupDecisionRow {
  readonly id: string;
  readonly title: string;
  /** The group's globs it holds back. */
  readonly holdsBack: readonly string[];
}

export interface GroupProgress {
  /** Work globs that have merged (reviewing or signed off). */
  readonly merged: number;
  /** Work globs in the group; deleted globs aren't there, decisions aren't counted. */
  readonly total: number;
}

export interface GroupView {
  readonly name: string;
  readonly progress: GroupProgress;
  /** Work globs by status. */
  readonly counts: Readonly<Partial<Record<Status, number>>>;
  readonly globs: readonly GroupGlobRow[];
  /** Holding ones first. */
  readonly relations: readonly GroupRelationRow[];
  readonly decisions: readonly GroupDecisionRow[];
  readonly lastActivityAt: string | null;
}

/** A line of the board's groups list. */
export interface GroupSummary {
  readonly name: string;
  readonly progress: GroupProgress;
  /** Work globs that haven't merged: the card shows progress when there is more than one. */
  readonly open: number;
  readonly counts: Readonly<Partial<Record<Status, number>>>;
  readonly lastActivityAt: string | null;
}

const isDecisionGlob = (g: Glob): boolean => g.category === 'decision';

/** Whether a glob's group is `name`, by the board's name matching. */
export const inGroup = (glob: Pick<Glob, 'group'>, name: string): boolean => glob.group !== null && normaliseGroup(glob.group) === normaliseGroup(name);

const latest = (times: readonly string[]): string | null => times.reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);

const countBy = (globs: readonly Glob[]): Partial<Record<Status, number>> => {
  const counts: Partial<Record<Status, number>> = {};
  for (const g of globs) counts[g.status] = (counts[g.status] ?? 0) + 1;
  return counts;
};

const progressOf = (work: readonly Glob[]): GroupProgress => ({ merged: work.filter(hasMerged).length, total: work.length });

/**
 * The groups of a board's globs, by name. Names match ignoring case and separators; a group shows under its most common
 * spelling (the first alphabetically on a tie). Decision globs carry groups too but aren't work: they don't count in progress.
 * Sorted: groups with open work first, then by latest activity.
 */
export const groupSummaries = (globs: readonly Glob[]): GroupSummary[] => {
  const byKey = new Map<string, Glob[]>();
  for (const g of globs) {
    if (g.group === null || normaliseGroup(g.group) === '') continue;
    const key = normaliseGroup(g.group);
    byKey.set(key, [...(byKey.get(key) ?? []), g]);
  }
  const summaries = [...byKey.values()].map((members): GroupSummary => {
    const work = members.filter((g) => !isDecisionGlob(g));
    const spellings = new Map<string, number>();
    for (const g of members) if (g.group !== null) spellings.set(g.group, (spellings.get(g.group) ?? 0) + 1);
    const name = [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))[0]?.[0] ?? '';
    const progress = progressOf(work);
    return { name, progress, open: progress.total - progress.merged, counts: countBy(work), lastActivityAt: latest(members.map((g) => g.updatedAt)) };
  });
  return summaries.sort((a, b) => Number(b.open > 0) - Number(a.open > 0) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.name.localeCompare(b.name, 'en'));
};

/**
 * One group's view from its members (work and decision globs carrying the label). `titles` names the globs the relations
 * point at beyond the members.
 */
export const groupView = (
  name: string,
  members: readonly GroupMember[],
  titles: ReadonlyMap<string, { readonly title: string; readonly decision: boolean }> = new Map(),
): GroupView => {
  const work = members.filter((m) => !isDecisionGlob(m.glob));
  const memberIds = new Set(members.map((m) => m.glob.id));
  const titleOf = (id: string): { readonly title: string; readonly decision: boolean } | null => {
    const member = members.find((m) => m.glob.id === id);
    return member === undefined ? (titles.get(id) ?? null) : { title: member.glob.title, decision: isDecisionGlob(member.glob) };
  };

  const relations = work
    .flatMap((m) =>
      m.relations.filter(isActive).flatMap((r): GroupRelationRow[] => {
        const state = m.states.get(r.to) ?? 'missing';
        if (state === 'missing') return [];
        const to = titleOf(r.to) ?? m.holding.find((h) => h.relationId === r.id) ?? null;
        const toTitle = to === null ? null : 'title' in to ? to.title : to.toTitle;
        const toIsDecision = to === null ? false : 'decision' in to ? to.decision : to.toIsDecision;
        return [
          {
            id: r.id,
            from: r.from,
            to: r.to,
            toTitle,
            toIsDecision,
            gate: r.gate,
            until: r.until,
            state,
            reason: r.reason,
            source: r.source,
            holding: !isMet(r, state),
            crosses: !toIsDecision && !memberIds.has(r.to),
          },
        ];
      }),
    )
    .sort((a, b) => Number(b.holding) - Number(a.holding) || a.from.localeCompare(b.from, 'en', { numeric: true }) || a.to.localeCompare(b.to, 'en', { numeric: true }));

  // Open decisions: those holding a glob of the group, and the group's own decision globs that are still open.
  const held = new Map<string, { title: string; holdsBack: string[] }>();
  for (const m of work) {
    for (const h of m.holding) {
      if (!h.toIsDecision) continue;
      const entry = held.get(h.to) ?? { title: h.toTitle ?? h.to, holdsBack: [] };
      if (!entry.holdsBack.includes(m.glob.id)) entry.holdsBack.push(m.glob.id);
      held.set(h.to, entry);
    }
  }
  for (const m of members) {
    if (!isDecisionGlob(m.glob) || held.has(m.glob.id)) continue;
    const state = toState(m.glob);
    if (state === 'open' || state === 'planning') held.set(m.glob.id, { title: m.glob.title, holdsBack: [] });
  }
  const decisions = [...held].map(([id, d]): GroupDecisionRow => ({ id, title: d.title, holdsBack: d.holdsBack })).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

  return {
    name,
    progress: progressOf(work.map((m) => m.glob)),
    counts: countBy(work.map((m) => m.glob)),
    globs: work
      .map(({ glob, move, holding }): GroupGlobRow => ({ id: glob.id, title: glob.title, status: glob.status, type: glob.type, updatedAt: glob.updatedAt, move, holding }))
      .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })),
    relations,
    decisions,
    lastActivityAt: latest(members.map((m) => m.glob.updatedAt)),
  };
};

/** How long a merged glob of the group still shows in a neighbour's context. */
export const GROUP_CONTEXT_MERGED_DAYS = 14;
/** The most neighbours the context lists (open ones first); `more` says how many were left out. */
export const GROUP_CONTEXT_MAX_GLOBS = 12;
const PLAN_LINE_CHARS = 160;

export interface GroupContextGlob {
  readonly id: string;
  readonly title: string;
  readonly status: Status;
  /** The first line of the glob's plan that says something (headings and list markers dropped), cut short. */
  readonly plan: string;
}

export interface GroupContextDecision {
  readonly id: string;
  readonly title: string;
  /** The group's globs it holds back (empty for one that is only in the group). */
  readonly holdsBack: readonly string[];
}

/** What a run learns about its neighbours: the group's other open or recently merged globs and its open decisions. */
export interface GroupContext {
  readonly name: string;
  readonly progress: GroupProgress;
  readonly globs: readonly GroupContextGlob[];
  /** Neighbours left out of `globs` (beyond the cap). */
  readonly more: number;
  readonly decisions: readonly GroupContextDecision[];
}

/** The first meaningful line of a plan, for a one-line summary. */
export const planLine = (plan: string | null): string => {
  for (const raw of (plan ?? '').split('\n')) {
    if (/^\s*-{3,}\s*$/.test(raw)) continue;
    const line = raw.replace(/^\s*(?:#+|[-*>]|\d+\.)\s*(?:\[[ xX]\]\s*)?/, '').trim();
    if (line === '') continue;
    return line.length > PLAN_LINE_CHARS ? `${line.slice(0, PLAN_LINE_CHARS - 1)}…` : line;
  }
  return '';
};

/**
 * The group section of `get_context` for `glob`: its group's other work globs that are open or merged in the last
 * `GROUP_CONTEXT_MERGED_DAYS` days, and the open decisions (those holding a glob of the group, and the group's own).
 * `null` when the glob has no group or has no such neighbours. `members` is every glob carrying the group (including `glob`),
 * `relations` their relations, `plans` the plan text by glob ID, `others` the decision globs outside the group those relations point at.
 */
export const groupContext = (
  glob: Glob,
  members: readonly Glob[],
  relations: readonly Relation[],
  plans: ReadonlyMap<string, string>,
  others: readonly Glob[],
  now: string,
): GroupContext | null => {
  if (glob.group === null || normaliseGroup(glob.group) === '') return null;
  const work = members.filter((g) => !isDecisionGlob(g));
  const cutoff = new Date(new Date(now).getTime() - GROUP_CONTEXT_MERGED_DAYS * 86_400_000).toISOString();
  const neighbours = work
    .filter((g) => g.id !== glob.id && (!hasMerged(g) || g.updatedAt >= cutoff))
    .sort((a, b) => Number(hasMerged(a)) - Number(hasMerged(b)) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  const held = new Map<string, string[]>();
  const byId = new Map([...others, ...members].map((g) => [g.id, g]));
  const workIds = new Set(work.map((g) => g.id));
  for (const r of relations) {
    const to = byId.get(r.to);
    // A decision outside the group still shows when it holds a glob of the group.
    if (!isActive(r) || !workIds.has(r.from) || to === undefined || !isDecisionGlob(to) || isMet(r, toState(to))) continue;
    held.set(r.to, [...(held.get(r.to) ?? []), r.from]);
  }
  for (const g of members) {
    if (!isDecisionGlob(g) || held.has(g.id)) continue;
    const state = toState(g);
    if (state === 'open' || state === 'planning') held.set(g.id, []);
  }
  const decisions = [...held]
    .map(([id, holdsBack]): GroupContextDecision => ({
      id,
      title: byId.get(id)?.title ?? id,
      holdsBack: [...new Set(holdsBack)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  if (neighbours.length === 0 && decisions.length === 0) return null;
  return {
    name: glob.group,
    progress: progressOf(work),
    globs: neighbours
      .slice(0, GROUP_CONTEXT_MAX_GLOBS)
      .map((g): GroupContextGlob => ({ id: g.id, title: g.title, status: g.status, plan: planLine(plans.get(g.id) ?? null) })),
    more: Math.max(0, neighbours.length - GROUP_CONTEXT_MAX_GLOBS),
    decisions,
  };
};
