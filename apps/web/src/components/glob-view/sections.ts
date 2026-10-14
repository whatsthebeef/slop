import type { GlobSection } from '@/lib/glob-section';

/**
 * The sections of the glob view in the order they are rendered, by their `data-section` id
 * (the ids `?section=` deep links use). A new section is a new file plus one entry here.
 */
export const GLOB_VIEW_SECTIONS: readonly GlobSection[] = [
  'conflict',
  'escalation',
  'labels',
  'related',
  'size',
  'actions',
  'plan',
  'decision',
  'deploys',
  'environments',
  'tests',
  'artifacts',
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
