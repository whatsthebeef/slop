import type { DecisionAttributes } from './attributes.js';

/** Group names compare ignoring case, surrounding space and the separators `_`, `-` and whitespace. */
export const normaliseGroup = (s: string): string => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

const MAX_GROUP_WORDS = 4;

/**
 * The group a split's parts share when the original has none: a short name from its title (the words before the first colon,
 * without a trailing "1/2"), lower-cased and hyphenated. An existing group with the same normalised name is reused as is.
 * Null when the title has no usable words.
 */
export const groupFromTitle = (title: string, existing: readonly string[]): string | null => {
  const head = (title.split(':')[0] ?? '').replace(/\b\d+\/\d+\b/g, ' ');
  const words = head.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  const name = words.slice(0, MAX_GROUP_WORDS).join('-');
  return existing.find((g) => normaliseGroup(g) === normaliseGroup(name)) ?? name;
};

/** What the backfill needs of a glob: its place in a split comes from its title and its edges. */
export interface GroupableGlob {
  readonly id: string;
  readonly title: string;
  readonly group: string | null;
  /** IDs it needs or overlaps: edges between split parts. */
  readonly linked: readonly string[];
}

export interface GroupProposal {
  readonly id: string;
  readonly group: string;
}

/** A split names its parts "<original title> N/M: <part title>"; the original may be cut short with "…". */
const PART_TITLE = /^(.*?)\s+(\d+)\/(\d+):\s/u;

const splitPartOf = (title: string): { readonly base: string; readonly of: string } | null => {
  const match = PART_TITLE.exec(title);
  if (match === null || match[1] === undefined || match[3] === undefined) return null;
  const base = match[1].replace(/…$/u, '').trim();
  return base === '' ? null : { base, of: match[3] };
};

/**
 * Groups for the parts of splits among `globs` (the board's open ones): globs whose titles carry "N/M:" with the same original
 * title and M are one split, and a part also joins a linked part of a split of the same size whose original title extends or
 * shortens its own (a cut-short title). A split already holding a group gives that group to its group-less parts; otherwise the
 * group is named from the original title as `groupFromTitle` does, reusing an `existing` group of that name. Globs outside any
 * split, and splits of one visible part, get no proposal.
 */
export const proposeSplitGroups = (globs: readonly GroupableGlob[], existing: readonly string[]): GroupProposal[] => {
  const parts = globs.flatMap((glob) => {
    const part = splitPartOf(glob.title);
    return part === null ? [] : [{ glob, ...part }];
  });
  const root = new Map(parts.map((p) => [p.glob.id, p.glob.id]));
  const find = (id: string): string => {
    const parent = root.get(id) ?? id;
    return parent === id ? id : find(parent);
  };
  const union = (a: string, b: string): void => {
    root.set(find(a), find(b));
  };
  const same = (a: { readonly base: string; readonly of: string }, b: { readonly base: string; readonly of: string }): boolean => {
    if (a.of !== b.of) return false;
    const [x, y] = [normaliseGroup(a.base), normaliseGroup(b.base)];
    return x.startsWith(y) || y.startsWith(x);
  };
  for (const a of parts) {
    for (const b of parts) {
      if (a.glob.id >= b.glob.id) continue;
      const sameOriginal = normaliseGroup(a.base) === normaliseGroup(b.base) && a.of === b.of;
      if (sameOriginal || (a.glob.linked.includes(b.glob.id) && same(a, b))) union(a.glob.id, b.glob.id);
    }
  }
  const clusters = new Map<string, typeof parts>();
  for (const p of parts) clusters.set(find(p.glob.id), [...(clusters.get(find(p.glob.id)) ?? []), p]);
  const proposals: GroupProposal[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const held = members.flatMap((m) => (m.glob.group === null ? [] : [m.glob.group]))[0];
    const shortest = members.map((m) => m.base).reduce((a, b) => (b.length < a.length ? b : a));
    const group = held ?? groupFromTitle(shortest, existing);
    if (group === null) continue;
    for (const m of members) if (m.glob.group === null) proposals.push({ id: m.glob.id, group });
  }
  return proposals.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
};

/**
 * The group a decision glob starts in, so the board's group filter and chips work for decisions as for work: a learning
 * (submitted or mined) takes its routed target's name (`build_test_lint`, `orchestrator.md`),
 * a hotspot decision is in `hotspots`, and any other takes the group of the work glob its scope names, when it has one.
 */
export const decisionGroup = (attributes: DecisionAttributes, scopeGlobGroup: string | null): string | null => {
  const { origin } = attributes;
  if (origin.kind === 'hotspot') return 'hotspots';
  if (origin.kind === 'submitted' || origin.kind === 'mined') {
    const name = attributes.target?.routed?.name ?? null;
    if (name !== null && name.trim() !== '') return name.trim();
  }
  return scopeGlobGroup;
};
