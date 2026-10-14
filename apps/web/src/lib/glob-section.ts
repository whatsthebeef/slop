import { LABEL_NAMES } from '@slop/core';
import type { LabelName } from '@slop/core';

/** The parts of a glob's page a link can open it at (`?section=<name>`). */
export const GLOB_SECTIONS = [
  'plan',
  'artifacts',
  'findings',
  'labels',
  'related',
  'escalation',
  'conflict',
  'size',
  'deploys',
  'environments',
  'tests',
  'choices',
  'decision',
  'assessment',
  'actions',
  'human-steps',
] as const;

export type GlobSection = (typeof GLOB_SECTIONS)[number];

/** Where a link into a glob points: a section, and for `artifacts` an artifact (and the label of an attachment or review). */
export interface GlobTarget {
  section?: GlobSection;
  artifact?: string;
  label?: string;
}

/** What a glob page opens at, read from its URL; a missing or unknown section is null (the top of the page). */
export interface ParsedGlobTarget {
  section: GlobSection | null;
  artifact: string | null;
  label: string | null;
}

const isSection = (name: string): name is GlobSection => GLOB_SECTIONS.some((s) => s === name);

/** Other names a link may use for a section: `rollout` is what people call the Human steps section, `prerequisites` was the Dependencies section's id (now Related); `runs` and `pr` are carried by the Activity log under the actions. */
const SECTION_ALIASES: Readonly<Record<string, GlobSection>> = {
  prerequisites: 'related',
  rollout: 'human-steps',
  runs: 'actions',
  pr: 'actions',
};

const sectionOf = (name: string): GlobSection | null => (isSection(name) ? name : (SECTION_ALIASES[name] ?? null));

const nonEmpty = (value: string | null): string | null => (value === null || value === '' ? null : value);

/** Reads `section`, `artifact` and `label` from a URL's search params. Unknown sections are ignored; aliases (`rollout`) read as their section. */
export const parseGlobTarget = (search: URLSearchParams): ParsedGlobTarget => {
  const section = nonEmpty(search.get('section'));
  return {
    section: section === null ? null : sectionOf(section),
    artifact: nonEmpty(search.get('artifact')),
    label: nonEmpty(search.get('label')),
  };
};

/** The sign-off label a link asks to open: `?section=labels&label=CR` with no artifact; an unknown label is null. */
export const labelToOpen = (target: ParsedGlobTarget): LabelName | null => {
  if (target.section !== 'labels' || target.artifact !== null || target.label === null) return null;
  return LABEL_NAMES.find((name) => name === target.label) ?? null;
};

/** The query string for a target, with a leading `?`, or '' when it has nothing to say. */
export const globQuery = (target: GlobTarget = {}): string => {
  const params = new URLSearchParams();
  if (target.section !== undefined) params.set('section', target.section);
  if (target.artifact !== undefined) params.set('artifact', target.artifact);
  if (target.label !== undefined && target.label !== '') params.set('label', target.label);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
};

/** A glob's page path, `/boards/:b/globs/:id`, with the target's query. */
export const globPath = (boardId: number, globId: string, target: GlobTarget = {}): string =>
  `/boards/${String(boardId)}/globs/${encodeURIComponent(globId)}${globQuery(target)}`;

/** The target a page's search params describe, to pass on to another glob URL. */
export const globTargetOf = (search: URLSearchParams): GlobTarget => {
  const { section, artifact, label } = parseGlobTarget(search);
  return {
    ...(section === null ? {} : { section }),
    ...(artifact === null ? {} : { artifact }),
    ...(label === null ? {} : { label }),
  };
};

/** A link through the board's `?glob=<id>` redirect, which carries the target on to the glob's page. */
export const boardGlobHref = (boardId: number, globId: string, target: GlobTarget = {}): string => {
  const query = globQuery(target);
  return `/boards/${String(boardId)}?glob=${encodeURIComponent(globId)}${query === '' ? '' : `&${query.slice(1)}`}`;
};
