import type { GlobSection } from '@/lib/glob-section';

/**
 * The sections of the glob view in the order they are rendered, by their `data-section` id
 * (the ids `?section=` deep links use). A new section is a new file plus one entry here.
 */
export const GLOB_VIEW_SECTIONS: readonly GlobSection[] = [
  'conflict',
  'escalation',
  'labels',
  'size',
  'actions',
  'plan',
  'decision',
  'deploys',
  'environments',
  'tests',
  'artifacts',
  'related',
  'human-steps',
  'choices',
  'assessment',
  'findings',
];

/**
 * A decision glob's order: the Decide block first (the way work globs lead with sign-off), the Human steps after the
 * assessments.
 */
export const DECISION_VIEW_SECTIONS: readonly GlobSection[] = [
  'decision',
  'conflict',
  'escalation',
  'labels',
  'related',
  'size',
  'actions',
  'plan',
  'deploys',
  'environments',
  'tests',
  'artifacts',
  'choices',
  'assessment',
  'findings',
  'human-steps',
];

/**
 * The order the glob view renders: while a step is due, the Human steps move to the top, like the Decide and review blocks
 * (after the conflict and escalation notices; a decision glob keeps its Decide block first). Otherwise the fixed order above.
 */
export const viewSections = (decision: boolean, stepsDue: boolean): readonly GlobSection[] => {
  const base = decision ? DECISION_VIEW_SECTIONS : GLOB_VIEW_SECTIONS;
  if (!stepsDue) return base;
  const rest = base.filter((name) => name !== 'human-steps');
  const at = rest.indexOf(decision ? 'decision' : 'escalation') + 1;
  return [...rest.slice(0, at), 'human-steps', ...rest.slice(at)];
};
